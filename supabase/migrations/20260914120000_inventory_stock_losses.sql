insert into public.permissions (key, description) values
  ('inventory.loss.own', 'Registrar e cancelar perdas do próprio estoque')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id from public.roles role cross join public.permissions permission
where role.key in ('ADMIN', 'VENDEDOR') and permission.key = 'inventory.loss.own'
on conflict do nothing;

create type public.stock_loss_reason as enum ('DAMAGED', 'EXPIRED', 'MISSING', 'AUTHORIZED_CONSUMPTION', 'OPERATIONAL_ERROR', 'OTHER');
create type public.stock_loss_status as enum ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED');

create table public.stock_loss_settings (
  singleton boolean primary key default true check (singleton),
  approval_threshold_quantity bigint check (approval_threshold_quantity is null or approval_threshold_quantity between 0 and 9007199254740991),
  updated_at timestamptz,
  updated_by uuid references public.profiles(id) on delete restrict
);
insert into public.stock_loss_settings (singleton, approval_threshold_quantity) values (true, null);

create table public.stock_loss_reports (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity bigint not null check (quantity between 1 and 9007199254740991),
  reason public.stock_loss_reason not null,
  observation text not null check (char_length(observation) between 4 and 500 and observation = btrim(observation)),
  photo_path text check (photo_path is null or (char_length(photo_path) between 1 and 500 and photo_path = btrim(photo_path))),
  status public.stock_loss_status not null,
  reported_by uuid not null references public.profiles(id) on delete restrict,
  decided_by uuid references public.profiles(id) on delete restrict,
  decision_reason text check (decision_reason is null or (char_length(decision_reason) between 4 and 500 and decision_reason = btrim(decision_reason))),
  hold_movement_id uuid unique references public.stock_movements(id) on delete restrict,
  movement_id uuid unique references public.stock_movements(id) on delete restrict,
  correlation_id uuid not null unique,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint stock_loss_state_valid check (
    (status = 'PENDING_APPROVAL' and hold_movement_id is not null and decided_by is null and decision_reason is null and movement_id is null and decided_at is null)
    or (status = 'APPLIED' and decided_by is not null and decision_reason is not null and movement_id is not null and decided_at is not null)
    or (status in ('REJECTED', 'CANCELLED') and hold_movement_id is not null and decided_by is not null and decision_reason is not null and movement_id is not null and decided_at is not null)
  )
);
create index stock_loss_reports_reported_created_idx on public.stock_loss_reports (reported_by, created_at desc, id desc);
create index stock_loss_reports_status_created_idx on public.stock_loss_reports (status, created_at desc, id desc);

alter table public.stock_loss_settings enable row level security;
alter table public.stock_loss_reports enable row level security;
revoke all on table public.stock_loss_settings, public.stock_loss_reports from public, anon, authenticated, service_role;
grant select on table public.stock_loss_settings, public.stock_loss_reports to authenticated;
create policy stock_loss_settings_read on public.stock_loss_settings for select to authenticated using (true);
create policy stock_loss_reports_read on public.stock_loss_reports for select to authenticated
using (reported_by = (select auth.uid()) or (select public.has_permission('inventory.manage')));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stock-loss-photos', 'stock-loss-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
create policy stock_loss_photos_read on storage.objects for select to authenticated
using (bucket_id='stock-loss-photos' and (owner_id=(select auth.uid())::text or (select public.has_permission('inventory.manage'))));
create policy stock_loss_photos_insert on storage.objects for insert to authenticated
with check (bucket_id='stock-loss-photos' and owner_id=(select auth.uid())::text and (storage.foldername(name))[1]=(select auth.uid())::text and lower(storage.extension(name)) in ('jpg','jpeg','png','webp'));

create or replace function private.record_stock_loss_movement(p_report_id uuid,p_type public.stock_movement_type,p_location_id uuid,p_product_id uuid,p_quantity bigint,p_actor uuid,p_reason text,p_correlation uuid)
returns uuid language plpgsql set search_path='' as $$
declare v_id uuid;
begin
  insert into public.stock_movements(movement_type,from_location_id,actor_id,reason,correlation_id,source_type,source_id)
  values(p_type,p_location_id,p_actor,p_reason,p_correlation,'stock_loss_report',p_report_id::text) returning id into v_id;
  insert into public.stock_movement_items(movement_id,product_id,quantity) values(v_id,p_product_id,p_quantity);
  return v_id;
end; $$;

create or replace function private.record_stock_loss_event(p_report_id uuid,p_action text,p_actor uuid,p_correlation uuid,p_payload jsonb)
returns void language plpgsql set search_path='' as $$
begin
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
  values(p_action,p_actor,'stock_loss_report',p_report_id::text,p_correlation,p_payload);
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
  values(p_action,'stock_loss_report',p_report_id::text,p_payload||jsonb_build_object('report_id',p_report_id,'correlation_id',p_correlation));
end; $$;

create or replace function public.report_stock_loss(p_product_id uuid,p_quantity bigint,p_reason text,p_observation text,p_photo_path text,p_idempotency_key text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_location uuid; v_threshold bigint; v_claim record; v_scope text; v_report uuid:=gen_random_uuid(); v_hold uuid; v_movement uuid; v_status public.stock_loss_status; v_result jsonb;
begin
  if v_actor is null or not public.has_permission('inventory.loss.own') then raise exception using errcode='42501',message='STOCK_LOSS_REQUIRED'; end if;
  if p_product_id is null or p_quantity not between 1 and 9007199254740991 or p_reason is null or p_reason not in ('DAMAGED','EXPIRED','MISSING','AUTHORIZED_CONSUMPTION','OPERATIONAL_ERROR','OTHER') or p_observation is null or char_length(btrim(p_observation)) not between 4 and 500 or p_observation<>btrim(p_observation) or p_correlation_id is null then raise exception using errcode='22023',message='INVALID_STOCK_LOSS'; end if;
  if p_photo_path is not null and (char_length(p_photo_path) not between 1 and 500 or p_photo_path<>btrim(p_photo_path)) then raise exception using errcode='22023',message='INVALID_STOCK_LOSS_PHOTO'; end if;
  v_scope:=private.build_idempotency_scope('inventory','report_loss',v_actor);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('product_id',p_product_id,'quantity',p_quantity,'reason',p_reason,'observation',p_observation,'photo_path',p_photo_path));
  if not v_claim.is_new then if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if; return v_claim.stored_result; end if;
  select id into v_location from public.stock_locations where seller_id=v_actor and location_type='SELLER' and active;
  if v_location is null then raise exception using errcode='P0001',message='SELLER_LOCATION_NOT_FOUND'; end if;
  if not exists(select 1 from public.products where id=p_product_id and active) then raise exception using errcode='P0001',message='PRODUCT_NOT_FOUND'; end if;
  if p_photo_path is not null and not exists(select 1 from storage.objects where bucket_id='stock-loss-photos' and name=p_photo_path and owner_id=v_actor::text and (storage.foldername(name))[1]=v_actor::text) then raise exception using errcode='P0001',message='STOCK_LOSS_PHOTO_NOT_FOUND'; end if;
  select approval_threshold_quantity into v_threshold from public.stock_loss_settings where singleton;
  perform 1 from public.inventory_balances where location_id=v_location and product_id=p_product_id for update;
  if not found or (select available_quantity from public.inventory_balances where location_id=v_location and product_id=p_product_id)<p_quantity then raise exception using errcode='P0001',message='STOCK_CONFLICT'; end if;
  if v_threshold is null or p_quantity>v_threshold then
    update public.inventory_balances set reserved_quantity=reserved_quantity+p_quantity where location_id=v_location and product_id=p_product_id;
    v_hold:=private.record_stock_loss_movement(v_report,'RESERVA',v_location,p_product_id,p_quantity,v_actor,'Bloqueio para aprovação de perda',p_correlation_id);
    v_status:='PENDING_APPROVAL';
    insert into public.stock_loss_reports(id,location_id,product_id,quantity,reason,observation,photo_path,status,reported_by,hold_movement_id,correlation_id) values(v_report,v_location,p_product_id,p_quantity,p_reason::public.stock_loss_reason,p_observation,p_photo_path,v_status,v_actor,v_hold,p_correlation_id);
  else
    update public.inventory_balances set on_hand_quantity=on_hand_quantity-p_quantity where location_id=v_location and product_id=p_product_id;
    v_movement:=private.record_stock_loss_movement(v_report,'PERDA',v_location,p_product_id,p_quantity,v_actor,p_observation,p_correlation_id);
    v_status:='APPLIED';
    insert into public.stock_loss_reports(id,location_id,product_id,quantity,reason,observation,photo_path,status,reported_by,decided_by,decision_reason,movement_id,correlation_id,decided_at) values(v_report,v_location,p_product_id,p_quantity,p_reason::public.stock_loss_reason,p_observation,p_photo_path,v_status,v_actor,v_actor,'Aplicação automática pelo limite configurado',v_movement,p_correlation_id,now());
  end if;
  v_result:=jsonb_build_object('report_id',v_report,'status',v_status,'movement_id',v_movement,'correlation_id',p_correlation_id);
  perform private.record_stock_loss_event(v_report,'inventory.loss.reported',v_actor,p_correlation_id,jsonb_build_object('status',v_status,'quantity',p_quantity,'reason',p_reason,'hold_movement_id',v_hold,'movement_id',v_movement));
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'stock_loss_report',v_report::text); return v_result;
end; $$;

create or replace function public.resolve_stock_loss(p_report_id uuid,p_action text,p_reason text,p_idempotency_key text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_report public.stock_loss_reports%rowtype; v_claim record; v_scope text; v_movement uuid; v_status public.stock_loss_status; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if p_action not in ('APPROVE','REJECT','CANCEL') or p_reason is null or char_length(btrim(p_reason)) not between 4 and 500 or p_reason<>btrim(p_reason) or p_correlation_id is null then raise exception using errcode='22023',message='INVALID_STOCK_LOSS_DECISION'; end if;
  select * into v_report from public.stock_loss_reports where id=p_report_id;
  if not found then raise exception using errcode='P0001',message='STOCK_LOSS_NOT_FOUND'; end if;
  if (p_action='CANCEL' and (v_report.reported_by<>v_actor or not public.has_permission('inventory.loss.own'))) or (p_action in ('APPROVE','REJECT') and not public.has_permission('inventory.manage')) then raise exception using errcode='42501',message='STOCK_LOSS_DECISION_FORBIDDEN'; end if;
  v_scope:=private.build_idempotency_scope('inventory','resolve_loss',v_actor);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('report_id',p_report_id,'action',p_action,'reason',p_reason));
  if not v_claim.is_new then if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if; return v_claim.stored_result; end if;
  select * into v_report from public.stock_loss_reports where id=p_report_id for update;
  if v_report.status<>'PENDING_APPROVAL' then raise exception using errcode='P0001',message='STOCK_LOSS_ALREADY_RESOLVED'; end if;
  perform 1 from public.inventory_balances where location_id=v_report.location_id and product_id=v_report.product_id for update;
  if not found or (select reserved_quantity from public.inventory_balances where location_id=v_report.location_id and product_id=v_report.product_id)<v_report.quantity then raise exception using errcode='P0001',message='STOCK_CONFLICT'; end if;
  if p_action='APPROVE' then
    update public.inventory_balances set reserved_quantity=reserved_quantity-v_report.quantity,on_hand_quantity=on_hand_quantity-v_report.quantity where location_id=v_report.location_id and product_id=v_report.product_id and on_hand_quantity>=v_report.quantity;
    if not found then raise exception using errcode='P0001',message='STOCK_CONFLICT'; end if;
    v_status:='APPLIED'; v_movement:=private.record_stock_loss_movement(v_report.id,'PERDA',v_report.location_id,v_report.product_id,v_report.quantity,v_actor,p_reason,p_correlation_id);
  else
    update public.inventory_balances set reserved_quantity=reserved_quantity-v_report.quantity where location_id=v_report.location_id and product_id=v_report.product_id;
    v_status:=case when p_action='REJECT' then 'REJECTED'::public.stock_loss_status else 'CANCELLED'::public.stock_loss_status end;
    v_movement:=private.record_stock_loss_movement(v_report.id,'LIBERACAO_RESERVA',v_report.location_id,v_report.product_id,v_report.quantity,v_actor,p_reason,p_correlation_id);
  end if;
  update public.stock_loss_reports set status=v_status,decided_by=v_actor,decision_reason=p_reason,movement_id=v_movement,decided_at=now() where id=v_report.id;
  v_result:=jsonb_build_object('report_id',v_report.id,'status',v_status,'movement_id',v_movement,'correlation_id',p_correlation_id);
  perform private.record_stock_loss_event(v_report.id,'inventory.loss.'||lower(v_status::text),v_actor,p_correlation_id,jsonb_build_object('status',v_status,'movement_id',v_movement,'reason',p_reason));
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'stock_loss_report',v_report.id::text); return v_result;
end; $$;

create or replace function public.configure_stock_loss_threshold(p_threshold bigint,p_reason text,p_idempotency_key text,p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_claim record; v_scope text; v_result jsonb;
begin
  if v_actor is null or not public.has_permission('inventory.manage') then raise exception using errcode='42501',message='INVENTORY_MANAGE_REQUIRED'; end if;
  if p_threshold is not null and p_threshold not between 0 and 9007199254740991 or p_reason is null or char_length(btrim(p_reason)) not between 4 and 500 or p_reason<>btrim(p_reason) or p_correlation_id is null then raise exception using errcode='22023',message='INVALID_STOCK_LOSS_SETTINGS'; end if;
  v_scope:=private.build_idempotency_scope('inventory','configure_loss_threshold',v_actor);
  select * into v_claim from private.claim_idempotency(v_scope,p_idempotency_key,jsonb_build_object('threshold',p_threshold,'reason',p_reason));
  if not v_claim.is_new then if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if; return v_claim.stored_result; end if;
  update public.stock_loss_settings set approval_threshold_quantity=p_threshold,updated_at=now(),updated_by=v_actor where singleton;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata) values('inventory.loss.settings.updated',v_actor,'stock_loss_settings','singleton',p_correlation_id,jsonb_build_object('approval_threshold_quantity',p_threshold,'reason',p_reason));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload) values('inventory.loss.settings.updated','stock_loss_settings','singleton',jsonb_build_object('approval_threshold_quantity',p_threshold,'correlation_id',p_correlation_id));
  v_result:=jsonb_build_object('approval_threshold_quantity',p_threshold,'updated_at',now()); perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'stock_loss_settings','singleton'); return v_result;
end; $$;

create or replace function public.get_stock_losses(p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare v_actor uuid:=auth.uid(); v_own uuid; v_reports jsonb; v_options jsonb; v_next uuid; v_threshold bigint;
begin
  if v_actor is null or (not public.has_permission('inventory.loss.own') and not public.has_permission('inventory.manage')) then raise exception using errcode='42501',message='STOCK_LOSS_REQUIRED'; end if;
  if p_limit not between 1 and 50 then raise exception using errcode='22023',message='INVALID_PAGE_LIMIT'; end if;
  select id into v_own from public.stock_locations where seller_id=v_actor and location_type='SELLER' and active;
  select approval_threshold_quantity into v_threshold from public.stock_loss_settings where singleton;
  with page as (select r.*,l.name location_name,p.name product_name,p.sku product_sku from public.stock_loss_reports r join public.stock_locations l on l.id=r.location_id join public.products p on p.id=r.product_id where (public.has_permission('inventory.manage') or r.reported_by=v_actor) and (p_cursor is null or r.created_at<(select created_at from public.stock_loss_reports where id=p_cursor) or (r.created_at=(select created_at from public.stock_loss_reports where id=p_cursor) and r.id<p_cursor)) order by r.created_at desc,r.id desc limit p_limit+1), shown as (select * from page order by created_at desc,id desc limit p_limit)
  select coalesce(jsonb_agg(to_jsonb(shown) order by created_at desc,id desc),'[]'::jsonb),
    case when (select count(*) from page)>p_limit then (select id from shown order by created_at,id limit 1) else null end
  into v_reports,v_next from shown;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',b.product_id,'product_name',p.name,'product_sku',p.sku,'available_quantity',b.available_quantity) order by p.name),'[]'::jsonb) into v_options from public.inventory_balances b join public.products p on p.id=b.product_id where b.location_id=v_own and p.active and b.available_quantity>0;
  return jsonb_build_object('own_location_id',v_own,'approval_threshold_quantity',v_threshold,'reports',v_reports,'options',v_options,'next_cursor',v_next);
end; $$;

revoke all on function private.record_stock_loss_movement(uuid,public.stock_movement_type,uuid,uuid,bigint,uuid,text,uuid), private.record_stock_loss_event(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.report_stock_loss(uuid,bigint,text,text,text,text,uuid), public.resolve_stock_loss(uuid,text,text,text,uuid), public.configure_stock_loss_threshold(bigint,text,text,uuid), public.get_stock_losses(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.report_stock_loss(uuid,bigint,text,text,text,text,uuid), public.resolve_stock_loss(uuid,text,text,text,uuid), public.configure_stock_loss_threshold(bigint,text,text,uuid), public.get_stock_losses(uuid,integer) to authenticated;
comment on table public.stock_loss_reports is 'Loss reports hold stock while approval is pending and resolve only through audited transactional functions.';
