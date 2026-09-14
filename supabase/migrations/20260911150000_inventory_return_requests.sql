insert into public.permissions (key, description) values
  ('inventory.return.own', 'Solicitar e cancelar devoluções do próprio estoque')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id from public.roles role cross join public.permissions permission
where role.key in ('ADMIN', 'VENDEDOR') and permission.key = 'inventory.return.own'
on conflict do nothing;

create type public.stock_return_status as enum ('REQUESTED', 'RECEIVED', 'REJECTED', 'CANCELLED');

create table public.stock_return_requests (
  id uuid primary key default gen_random_uuid(),
  from_location_id uuid not null references public.stock_locations(id) on delete restrict,
  to_location_id uuid not null references public.stock_locations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity bigint not null check (quantity between 1 and 9007199254740991),
  status public.stock_return_status not null default 'REQUESTED',
  requested_by uuid not null references public.profiles(id) on delete restrict,
  decided_by uuid references public.profiles(id) on delete restrict,
  request_reason text not null check (char_length(request_reason) between 4 and 500 and request_reason = btrim(request_reason)),
  decision_reason text check (decision_reason is null or (char_length(decision_reason) between 4 and 500 and decision_reason = btrim(decision_reason))),
  movement_id uuid unique references public.stock_movements(id) on delete restrict,
  correlation_id uuid not null unique,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint stock_return_locations_different check (from_location_id <> to_location_id),
  constraint stock_return_state_valid check (
    (status = 'REQUESTED' and decided_by is null and decision_reason is null and movement_id is null and decided_at is null)
    or (status = 'RECEIVED' and decided_by is not null and decision_reason is not null and movement_id is not null and decided_at is not null)
    or (status in ('REJECTED', 'CANCELLED') and decided_by is not null and decision_reason is not null and movement_id is null and decided_at is not null)
  )
);

create index stock_return_requests_requested_by_created_idx on public.stock_return_requests (requested_by, created_at desc, id desc);
create index stock_return_requests_status_created_idx on public.stock_return_requests (status, created_at desc, id desc);

alter table public.stock_return_requests enable row level security;
revoke all on table public.stock_return_requests from public, anon, authenticated, service_role;
grant select on table public.stock_return_requests to authenticated;
create policy stock_return_requests_participant_read on public.stock_return_requests for select to authenticated
using (requested_by = (select auth.uid()) or (select public.has_permission('inventory.manage')));

create or replace function private.execute_stock_return(
  p_request_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_product_id uuid,
  p_quantity bigint,
  p_actor_id uuid,
  p_reason text,
  p_correlation_id uuid
) returns uuid language plpgsql set search_path = '' as $$
declare
  v_from public.inventory_balances%rowtype;
  v_to public.inventory_balances%rowtype;
  v_movement_id uuid;
begin
  insert into public.inventory_balances (location_id, product_id) values (p_to_location_id, p_product_id)
  on conflict (location_id, product_id) do nothing;
  perform 1 from public.inventory_balances
    where location_id in (p_from_location_id, p_to_location_id) and product_id = p_product_id
    order by location_id for update;
  select * into v_from from public.inventory_balances where location_id = p_from_location_id and product_id = p_product_id;
  if not found or v_from.available_quantity < p_quantity then raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT'; end if;
  select * into strict v_to from public.inventory_balances where location_id = p_to_location_id and product_id = p_product_id;
  if v_to.on_hand_quantity + p_quantity > 9007199254740991 then raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT'; end if;
  update public.inventory_balances set on_hand_quantity = on_hand_quantity - p_quantity where id = v_from.id;
  update public.inventory_balances set on_hand_quantity = on_hand_quantity + p_quantity where id = v_to.id;
  insert into public.stock_movements (movement_type, from_location_id, to_location_id, actor_id, reason, correlation_id, source_type, source_id)
    values ('TRANSFERENCIA', p_from_location_id, p_to_location_id, p_actor_id, p_reason, p_correlation_id, 'stock_return_request', p_request_id::text)
    returning id into v_movement_id;
  insert into public.stock_movement_items (movement_id, product_id, quantity) values (v_movement_id, p_product_id, p_quantity);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('inventory.movement.created', p_actor_id, 'stock_movement', v_movement_id::text, p_correlation_id,
      jsonb_build_object('movement_type','TRANSFERENCIA','product_id',p_product_id,'quantity',p_quantity,'from_location_id',p_from_location_id,'to_location_id',p_to_location_id,'return_request_id',p_request_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('inventory.movement.created','stock_movement',v_movement_id::text,
      jsonb_build_object('movement_id',v_movement_id,'movement_type','TRANSFERENCIA','product_id',p_product_id,'quantity',p_quantity,'correlation_id',p_correlation_id,'return_request_id',p_request_id));
  return v_movement_id;
end;
$$;
revoke all on function private.execute_stock_return(uuid,uuid,uuid,uuid,bigint,uuid,text,uuid) from public, anon, authenticated, service_role;

create or replace function public.request_stock_return(
  p_product_id uuid, p_quantity bigint, p_reason text, p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_from_location_id uuid; v_to_location_id uuid;
  v_scope text; v_claim record; v_request_id uuid; v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('inventory.return.own') then raise exception using errcode = '42501', message = 'STOCK_RETURN_REQUIRED'; end if;
  if p_quantity is null or p_quantity not between 1 and 9007199254740991 then raise exception using errcode = '22023', message = 'INVALID_QUANTITY'; end if;
  if p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then raise exception using errcode = '22023', message = 'INVALID_REASON'; end if;
  if p_correlation_id is null then raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID'; end if;
  v_scope := private.build_idempotency_scope('inventory','return-request',v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('product_id',p_product_id,'quantity',p_quantity,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select id into v_from_location_id from public.stock_locations where seller_id = v_actor_id and location_type = 'SELLER' and active;
  if v_from_location_id is null then raise exception using errcode = 'P0001', message = 'SELLER_LOCATION_NOT_FOUND'; end if;
  select id into v_to_location_id from public.stock_locations where location_type = 'CENTRAL' and active order by id limit 1;
  if v_to_location_id is null then raise exception using errcode = 'P0001', message = 'CENTRAL_LOCATION_NOT_FOUND'; end if;
  if not exists (select 1 from public.products where id = p_product_id and active) then raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND'; end if;
  if not exists (select 1 from public.inventory_balances where location_id = v_from_location_id and product_id = p_product_id and available_quantity >= p_quantity) then raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT'; end if;
  insert into public.stock_return_requests (from_location_id,to_location_id,product_id,quantity,requested_by,request_reason,correlation_id)
    values (v_from_location_id,v_to_location_id,p_product_id,p_quantity,v_actor_id,p_reason,p_correlation_id) returning id into v_request_id;
  insert into public.audit_logs (action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values ('inventory.return.requested',v_actor_id,'stock_return_request',v_request_id::text,p_correlation_id,jsonb_build_object('product_id',p_product_id,'quantity',p_quantity,'from_location_id',v_from_location_id,'to_location_id',v_to_location_id));
  insert into public.outbox_events (topic,aggregate_type,aggregate_id,payload)
    values ('inventory.return.requested','stock_return_request',v_request_id::text,jsonb_build_object('request_id',v_request_id,'product_id',p_product_id,'quantity',p_quantity,'correlation_id',p_correlation_id));
  v_result := jsonb_build_object('request_id',v_request_id,'status','REQUESTED','correlation_id',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'stock_return_request',v_request_id::text);
  return v_result;
end;
$$;

create or replace function public.resolve_stock_return(
  p_request_id uuid, p_action text, p_reason text, p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_request public.stock_return_requests%rowtype;
  v_scope text; v_claim record; v_status public.stock_return_status; v_movement_id uuid; v_result jsonb;
begin
  if v_actor_id is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if p_action is null or p_action not in ('RECEIVE','REJECT','CANCEL') then raise exception using errcode = '22023', message = 'INVALID_RETURN_ACTION'; end if;
  if p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then raise exception using errcode = '22023', message = 'INVALID_REASON'; end if;
  if p_correlation_id is null then raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID'; end if;
  if p_action = 'CANCEL' then
    if not public.has_permission('inventory.return.own') then raise exception using errcode = '42501', message = 'STOCK_RETURN_REQUIRED'; end if;
  elsif not public.has_permission('inventory.manage') then raise exception using errcode = '42501', message = 'INVENTORY_MANAGE_REQUIRED'; end if;
  v_scope := private.build_idempotency_scope('inventory','return-resolve',v_actor_id);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('request_id',p_request_id,'action',p_action,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_request from public.stock_return_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'RETURN_REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'REQUESTED' then raise exception using errcode = 'P0001', message = 'RETURN_REQUEST_ALREADY_RESOLVED'; end if;
  if p_action = 'CANCEL' and v_request.requested_by <> v_actor_id then raise exception using errcode = '42501', message = 'RETURN_REQUEST_FORBIDDEN'; end if;
  if p_action = 'RECEIVE' then
    v_movement_id := private.execute_stock_return(v_request.id,v_request.from_location_id,v_request.to_location_id,v_request.product_id,v_request.quantity,v_actor_id,p_reason,p_correlation_id);
    v_status := 'RECEIVED';
  elsif p_action = 'REJECT' then v_status := 'REJECTED';
  else v_status := 'CANCELLED'; end if;
  update public.stock_return_requests set status=v_status,decided_by=v_actor_id,decision_reason=p_reason,movement_id=v_movement_id,decided_at=now() where id=v_request.id;
  insert into public.audit_logs (action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values ('inventory.return.'||lower(v_status::text),v_actor_id,'stock_return_request',v_request.id::text,p_correlation_id,jsonb_build_object('status',v_status,'movement_id',v_movement_id));
  insert into public.outbox_events (topic,aggregate_type,aggregate_id,payload)
    values ('inventory.return.'||lower(v_status::text),'stock_return_request',v_request.id::text,jsonb_build_object('request_id',v_request.id,'status',v_status,'movement_id',v_movement_id,'correlation_id',p_correlation_id));
  v_result := jsonb_build_object('request_id',v_request.id,'status',v_status,'movement_id',v_movement_id,'correlation_id',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'stock_return_request',v_request.id::text);
  return v_result;
end;
$$;

create or replace function public.get_stock_returns(p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_manager boolean; v_own_location_id uuid; v_cursor_created_at timestamptz;
  v_requests jsonb; v_options jsonb; v_next_cursor uuid;
begin
  v_manager := public.has_permission('inventory.manage');
  if v_actor_id is null or (not v_manager and not public.has_permission('inventory.return.own')) then raise exception using errcode = '42501', message = 'STOCK_RETURN_REQUIRED'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception using errcode = '22023', message = 'INVALID_RETURN_QUERY'; end if;
  select id into v_own_location_id from public.stock_locations where seller_id=v_actor_id and location_type='SELLER' and active;
  if p_cursor is not null then
    select created_at into v_cursor_created_at from public.stock_return_requests where id=p_cursor and (v_manager or requested_by=v_actor_id);
    if v_cursor_created_at is null then raise exception using errcode='22023',message='INVALID_RETURN_QUERY'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',page.id,'from_location_id',page.from_location_id,'from_location_name',page.from_location_name,
    'to_location_id',page.to_location_id,'to_location_name',page.to_location_name,'product_id',page.product_id,
    'product_name',page.product_name,'product_sku',page.product_sku,'quantity',page.quantity,'status',page.status,
    'requested_by',page.requested_by,'request_reason',page.request_reason,'decision_reason',page.decision_reason,
    'movement_id',page.movement_id,'created_at',page.created_at,'decided_at',page.decided_at
  ) order by page.created_at desc,page.id desc),'[]'::jsonb) into v_requests from (
    select request.*,source.name from_location_name,destination.name to_location_name,product.name product_name,product.sku product_sku
    from public.stock_return_requests request
    join public.stock_locations source on source.id=request.from_location_id
    join public.stock_locations destination on destination.id=request.to_location_id
    join public.products product on product.id=request.product_id
    where (v_manager or request.requested_by=v_actor_id)
      and (p_cursor is null or (request.created_at,request.id)<(v_cursor_created_at,p_cursor))
    order by request.created_at desc,request.id desc limit p_limit+1
  ) page;
  if jsonb_array_length(v_requests)>p_limit then v_next_cursor := (v_requests->(p_limit-1)->>'id')::uuid; v_requests := v_requests-p_limit; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',product.id,'product_name',product.name,'product_sku',product.sku,'available_quantity',balance.available_quantity) order by product.name),'[]'::jsonb)
    into v_options from public.inventory_balances balance join public.products product on product.id=balance.product_id and product.active
    where not v_manager and balance.location_id=v_own_location_id and balance.available_quantity>0;
  return jsonb_build_object('own_location_id',v_own_location_id,'requests',v_requests,'options',v_options,'next_cursor',v_next_cursor);
end;
$$;

revoke all on function public.request_stock_return(uuid,bigint,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.resolve_stock_return(uuid,text,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_stock_returns(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.request_stock_return(uuid,bigint,text,text,uuid) to authenticated;
grant execute on function public.resolve_stock_return(uuid,text,text,text,uuid) to authenticated;
grant execute on function public.get_stock_returns(uuid,integer) to authenticated;
comment on table public.stock_return_requests is 'Seller returns received by inventory; receipt creates one seller-to-central transfer instead of editing balances.';
