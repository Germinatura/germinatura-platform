insert into public.permissions (key, description) values
  ('inventory.count.own', 'Contar e acompanhar o próprio estoque')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id from public.roles role cross join public.permissions permission
where role.key in ('ADMIN', 'VENDEDOR', 'ESTOQUE') and permission.key = 'inventory.count.own'
on conflict do nothing;

create type public.inventory_count_status as enum ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED');

create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  status public.inventory_count_status not null default 'PENDING_APPROVAL',
  observation text not null check (char_length(observation) between 4 and 500 and observation = btrim(observation)),
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  decided_by uuid references public.profiles(id) on delete restrict,
  decision_reason text check (decision_reason is null or (char_length(decision_reason) between 4 and 500 and decision_reason = btrim(decision_reason))),
  correlation_id uuid not null unique,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint inventory_count_state_valid check (
    (status = 'PENDING_APPROVAL' and decided_by is null and decision_reason is null and decided_at is null)
    or (status in ('APPLIED', 'REJECTED', 'CANCELLED') and decided_by is not null and decision_reason is not null and decided_at is not null)
  )
);

create table public.inventory_count_items (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.inventory_counts(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  expected_on_hand_quantity bigint not null check (expected_on_hand_quantity between 0 and 9007199254740991),
  expected_reserved_quantity bigint not null check (expected_reserved_quantity between 0 and expected_on_hand_quantity),
  counted_on_hand_quantity bigint not null check (counted_on_hand_quantity between 0 and 9007199254740991),
  difference_quantity bigint generated always as (counted_on_hand_quantity - expected_on_hand_quantity) stored,
  movement_id uuid unique references public.stock_movements(id) on delete restrict,
  constraint inventory_count_item_product_unique unique (count_id, product_id)
);

create index inventory_counts_location_created_idx on public.inventory_counts(location_id, created_at desc, id desc);
create index inventory_counts_pending_created_idx on public.inventory_counts(created_at desc, id desc) where status = 'PENDING_APPROVAL';

alter table public.inventory_counts enable row level security;
alter table public.inventory_count_items enable row level security;
revoke all on table public.inventory_counts, public.inventory_count_items from public, anon, authenticated, service_role;
grant select on table public.inventory_counts, public.inventory_count_items to authenticated;
create policy inventory_counts_read on public.inventory_counts for select to authenticated using (
  (select public.has_permission('inventory.manage')) or submitted_by = (select auth.uid())
  or exists (select 1 from public.stock_locations l where l.id = inventory_counts.location_id and l.seller_id = (select auth.uid()))
);
create policy inventory_count_items_read on public.inventory_count_items for select to authenticated using (
  exists (select 1 from public.inventory_counts c where c.id = inventory_count_items.count_id)
);

create or replace function private.record_inventory_count_event(p_count_id uuid, p_action text, p_actor uuid, p_correlation uuid, p_payload jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values(p_action,p_actor,'inventory_count',p_count_id::text,p_correlation,p_payload);
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
  values(p_action,'inventory_count',p_count_id::text,p_payload||jsonb_build_object('count_id',p_count_id,'correlation_id',p_correlation));
end; $$;

create or replace function private.record_inventory_count_adjustment(p_count_id uuid,p_item_id uuid,p_location_id uuid,p_product_id uuid,p_delta bigint,p_actor uuid,p_reason text,p_correlation uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid; v_type public.stock_movement_type;
begin
  if p_delta = 0 then return null; end if;
  v_type := case when p_delta > 0 then 'AJUSTE_POSITIVO'::public.stock_movement_type else 'AJUSTE_NEGATIVO'::public.stock_movement_type end;
  insert into public.stock_movements(movement_type,from_location_id,to_location_id,actor_id,reason,correlation_id,source_type,source_id)
  values(v_type,case when p_delta < 0 then p_location_id end,case when p_delta > 0 then p_location_id end,p_actor,p_reason,p_correlation,'inventory_count',p_count_id::text)
  returning id into v_id;
  insert into public.stock_movement_items(movement_id,product_id,quantity) values(v_id,p_product_id,abs(p_delta));
  update public.inventory_count_items set movement_id=v_id where id=p_item_id;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values('inventory.movement.created',p_actor,'stock_movement',v_id::text,p_correlation,jsonb_build_object('movement_type',v_type,'product_id',p_product_id,'quantity',abs(p_delta),'inventory_count_id',p_count_id));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
  values('inventory.movement.created','stock_movement',v_id::text,jsonb_build_object('movement_id',v_id,'movement_type',v_type,'product_id',p_product_id,'quantity',abs(p_delta),'inventory_count_id',p_count_id,'correlation_id',p_correlation));
  return v_id;
end; $$;

create or replace function private.can_count_location(p_location_id uuid,p_actor uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select public.has_permission('inventory.manage') or (
    public.has_permission('inventory.count.own') and exists(
      select 1 from public.stock_locations l where l.id=p_location_id and l.seller_id=p_actor and l.location_type='SELLER' and l.active
    )
  );
$$;

create or replace function public.submit_inventory_count(p_location_id uuid,p_items jsonb,p_observation text,p_idempotency_key text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=auth.uid(); v_location uuid:=p_location_id; v_claim record; v_scope text; v_count uuid:=gen_random_uuid(); v_result jsonb; v_input_count integer;
begin
  if v_actor is null or (not public.has_permission('inventory.count.own') and not public.has_permission('inventory.manage')) then raise exception using errcode='42501',message='INVENTORY_COUNT_REQUIRED'; end if;
  if v_location is null then select id into v_location from public.stock_locations where seller_id=v_actor and location_type='SELLER' and active; end if;
  if v_location is null or not private.can_count_location(v_location,v_actor) then raise exception using errcode='42501',message='INVENTORY_COUNT_LOCATION_FORBIDDEN'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 200 or p_observation is null or char_length(btrim(p_observation)) not between 4 and 500 or p_observation<>btrim(p_observation) or p_correlation_id is null then raise exception using errcode='22023',message='INVALID_INVENTORY_COUNT'; end if;
  begin
    select count(*) into v_input_count from jsonb_to_recordset(p_items) as x(product_id uuid,expected_on_hand_quantity bigint,expected_reserved_quantity bigint,counted_on_hand_quantity bigint)
    where x.product_id is not null and x.expected_on_hand_quantity between 0 and 9007199254740991 and x.expected_reserved_quantity between 0 and x.expected_on_hand_quantity and x.counted_on_hand_quantity between 0 and 9007199254740991;
  exception when others then raise exception using errcode='22023',message='INVALID_INVENTORY_COUNT'; end;
  if v_input_count<>jsonb_array_length(p_items) or v_input_count<>(select count(distinct x.product_id) from jsonb_to_recordset(p_items) as x(product_id uuid)) then raise exception using errcode='22023',message='INVALID_INVENTORY_COUNT'; end if;
  v_scope:=private.build_idempotency_scope('inventory','submit_count',v_actor);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('location_id',v_location,'items',p_items,'observation',p_observation));
  if not v_claim.is_new then if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if; return v_claim.stored_result; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as x(product_id uuid) where not exists(select 1 from public.products p where p.id=x.product_id and p.active)) then raise exception using errcode='P0001',message='PRODUCT_NOT_FOUND'; end if;
  perform 1 from public.inventory_balances b join jsonb_to_recordset(p_items) as x(product_id uuid,expected_on_hand_quantity bigint,expected_reserved_quantity bigint,counted_on_hand_quantity bigint) on x.product_id=b.product_id where b.location_id=v_location order by b.product_id for update of b;
  if (select count(*) from public.inventory_balances b join jsonb_to_recordset(p_items) as x(product_id uuid,expected_on_hand_quantity bigint,expected_reserved_quantity bigint,counted_on_hand_quantity bigint) on x.product_id=b.product_id where b.location_id=v_location and b.on_hand_quantity=x.expected_on_hand_quantity and b.reserved_quantity=x.expected_reserved_quantity)<>v_input_count then raise exception using errcode='P0001',message='INVENTORY_COUNT_STALE'; end if;
  insert into public.inventory_counts(id,location_id,observation,submitted_by,correlation_id) values(v_count,v_location,p_observation,v_actor,p_correlation_id);
  insert into public.inventory_count_items(count_id,product_id,expected_on_hand_quantity,expected_reserved_quantity,counted_on_hand_quantity)
  select v_count,x.product_id,x.expected_on_hand_quantity,x.expected_reserved_quantity,x.counted_on_hand_quantity from jsonb_to_recordset(p_items) as x(product_id uuid,expected_on_hand_quantity bigint,expected_reserved_quantity bigint,counted_on_hand_quantity bigint);
  v_result:=jsonb_build_object('count_id',v_count,'status','PENDING_APPROVAL','correlation_id',p_correlation_id);
  perform private.record_inventory_count_event(v_count,'inventory.count.submitted',v_actor,p_correlation_id,jsonb_build_object('location_id',v_location,'item_count',v_input_count));
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'inventory_count',v_count::text); return v_result;
end; $$;

create or replace function public.resolve_inventory_count(p_count_id uuid,p_action text,p_reason text,p_idempotency_key text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=auth.uid(); v_count public.inventory_counts%rowtype; v_claim record; v_scope text; v_item record; v_status public.inventory_count_status; v_result jsonb; v_adjustments integer:=0;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if p_action not in ('APPROVE','REJECT','CANCEL') or p_reason is null or char_length(btrim(p_reason)) not between 4 and 500 or p_reason<>btrim(p_reason) or p_correlation_id is null then raise exception using errcode='22023',message='INVALID_INVENTORY_COUNT_DECISION'; end if;
  select * into v_count from public.inventory_counts where id=p_count_id;
  if not found then raise exception using errcode='P0001',message='INVENTORY_COUNT_NOT_FOUND'; end if;
  if (p_action='CANCEL' and (v_count.submitted_by<>v_actor or (not public.has_permission('inventory.count.own') and not public.has_permission('inventory.manage')))) or (p_action in ('APPROVE','REJECT') and not public.has_permission('inventory.manage')) then raise exception using errcode='42501',message='INVENTORY_COUNT_DECISION_FORBIDDEN'; end if;
  v_scope:=private.build_idempotency_scope('inventory','resolve_count',v_actor);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('count_id',p_count_id,'action',p_action,'reason',p_reason));
  if not v_claim.is_new then if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if; return v_claim.stored_result; end if;
  select * into v_count from public.inventory_counts where id=p_count_id for update;
  if v_count.status<>'PENDING_APPROVAL' then raise exception using errcode='P0001',message='INVENTORY_COUNT_ALREADY_RESOLVED'; end if;
  if p_action='APPROVE' then
    perform 1 from public.inventory_balances b join public.inventory_count_items i on i.product_id=b.product_id and i.count_id=v_count.id where b.location_id=v_count.location_id order by b.product_id for update of b;
    if exists(select 1 from public.inventory_count_items i left join public.inventory_balances b on b.location_id=v_count.location_id and b.product_id=i.product_id where i.count_id=v_count.id and (b.id is null or b.on_hand_quantity<>i.expected_on_hand_quantity or b.reserved_quantity<>i.expected_reserved_quantity)) then raise exception using errcode='P0001',message='INVENTORY_COUNT_STALE'; end if;
    if exists(select 1 from public.inventory_count_items i where i.count_id=v_count.id and i.counted_on_hand_quantity<i.expected_reserved_quantity) then raise exception using errcode='P0001',message='INVENTORY_COUNT_RESERVED_CONFLICT'; end if;
    for v_item in select i.* from public.inventory_count_items i where i.count_id=v_count.id order by i.product_id loop
      if v_item.difference_quantity<>0 then
        update public.inventory_balances set on_hand_quantity=v_item.counted_on_hand_quantity where location_id=v_count.location_id and product_id=v_item.product_id;
        perform private.record_inventory_count_adjustment(v_count.id,v_item.id,v_count.location_id,v_item.product_id,v_item.difference_quantity,v_actor,p_reason,p_correlation_id);
        v_adjustments:=v_adjustments+1;
      end if;
    end loop;
    v_status:='APPLIED';
  else
    v_status:=case when p_action='REJECT' then 'REJECTED'::public.inventory_count_status else 'CANCELLED'::public.inventory_count_status end;
  end if;
  update public.inventory_counts set status=v_status,decided_by=v_actor,decision_reason=p_reason,decided_at=now() where id=v_count.id;
  v_result:=jsonb_build_object('count_id',v_count.id,'status',v_status,'adjustment_count',v_adjustments,'correlation_id',p_correlation_id);
  perform private.record_inventory_count_event(v_count.id,'inventory.count.'||lower(v_status::text),v_actor,p_correlation_id,jsonb_build_object('status',v_status,'adjustment_count',v_adjustments,'reason',p_reason));
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'inventory_count',v_count.id::text); return v_result;
end; $$;

create or replace function public.get_inventory_count_context(p_location_id uuid default null,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare v_actor uuid:=auth.uid(); v_location uuid:=p_location_id; v_locations jsonb; v_balances jsonb; v_counts jsonb; v_movements jsonb; v_next uuid;
begin
  if v_actor is null or (not public.has_permission('inventory.count.own') and not public.has_permission('inventory.manage')) then raise exception using errcode='42501',message='INVENTORY_COUNT_REQUIRED'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception using errcode='22023',message='INVALID_PAGE_LIMIT'; end if;
  if v_location is null then
    select id into v_location from public.stock_locations where seller_id=v_actor and location_type='SELLER' and active;
    if v_location is null and public.has_permission('inventory.manage') then select id into v_location from public.stock_locations where location_type='CENTRAL' and active order by created_at,id limit 1; end if;
  end if;
  if v_location is null then raise exception using errcode='P0001',message='STOCK_LOCATION_NOT_FOUND'; end if;
  if not private.can_count_location(v_location,v_actor) then raise exception using errcode='42501',message='INVENTORY_COUNT_LOCATION_FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'location_type',l.location_type) order by l.name),'[]'::jsonb) into v_locations from public.stock_locations l where l.active and (public.has_permission('inventory.manage') or l.id=v_location);
  select coalesce(jsonb_agg(jsonb_build_object('product_id',b.product_id,'product_name',p.name,'product_sku',p.sku,'on_hand_quantity',b.on_hand_quantity,'reserved_quantity',b.reserved_quantity,'available_quantity',b.available_quantity) order by p.name),'[]'::jsonb) into v_balances from public.inventory_balances b join public.products p on p.id=b.product_id where b.location_id=v_location and p.active;
  with page as (select c.* from public.inventory_counts c where (public.has_permission('inventory.manage') or c.location_id=v_location) and (p_cursor is null or c.created_at<(select created_at from public.inventory_counts where id=p_cursor) or (c.created_at=(select created_at from public.inventory_counts where id=p_cursor) and c.id<p_cursor)) order by c.created_at desc,c.id desc limit p_limit+1), shown as(select * from page order by created_at desc,id desc limit p_limit)
  select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('location_name',l.name,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',i.product_id,'product_name',p.name,'product_sku',p.sku,'expected_on_hand_quantity',i.expected_on_hand_quantity,'expected_reserved_quantity',i.expected_reserved_quantity,'counted_on_hand_quantity',i.counted_on_hand_quantity,'difference_quantity',i.difference_quantity,'movement_id',i.movement_id) order by p.name),'[]'::jsonb) from public.inventory_count_items i join public.products p on p.id=i.product_id where i.count_id=s.id)) order by s.created_at desc,s.id desc),'[]'::jsonb),case when (select count(*) from page)>p_limit then(select id from shown order by created_at,id limit 1) end into v_counts,v_next from shown s join public.stock_locations l on l.id=s.location_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'movement_type',m.movement_type,'reason',m.reason,'created_at',m.created_at,'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',mi.product_id,'product_name',p.name,'quantity',mi.quantity) order by p.name),'[]'::jsonb) from public.stock_movement_items mi join public.products p on p.id=mi.product_id where mi.movement_id=m.id)) order by m.created_at desc,m.id desc),'[]'::jsonb) into v_movements from (select * from public.stock_movements where from_location_id=v_location or to_location_id=v_location order by created_at desc,id desc limit 20) m;
  return jsonb_build_object('selected_location_id',v_location,'locations',v_locations,'balances',v_balances,'counts',v_counts,'movements',v_movements,'next_cursor',v_next);
end; $$;

revoke all on function private.record_inventory_count_event(uuid,text,uuid,uuid,jsonb), private.record_inventory_count_adjustment(uuid,uuid,uuid,uuid,bigint,uuid,text,uuid), private.can_count_location(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.submit_inventory_count(uuid,jsonb,text,text,uuid), public.resolve_inventory_count(uuid,text,text,text,uuid), public.get_inventory_count_context(uuid,uuid,integer) from public, anon;
grant execute on function public.submit_inventory_count(uuid,jsonb,text,text,uuid), public.resolve_inventory_count(uuid,text,text,text,uuid), public.get_inventory_count_context(uuid,uuid,integer) to authenticated;
