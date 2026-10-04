insert into public.permissions (key, description) values
  ('inventory.transfer.own', 'Solicitar e decidir transferências do próprio estoque')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role cross join public.permissions permission
where role.key in ('ADMIN', 'VENDEDOR') and permission.key = 'inventory.transfer.own'
on conflict do nothing;

create type public.seller_stock_transfer_status as enum ('REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED');

create table public.seller_stock_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  from_location_id uuid not null references public.stock_locations(id) on delete restrict,
  to_location_id uuid not null references public.stock_locations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity bigint not null check (quantity between 1 and 9007199254740991),
  status public.seller_stock_transfer_status not null default 'REQUESTED',
  requested_by uuid not null references public.profiles(id) on delete restrict,
  decided_by uuid references public.profiles(id) on delete restrict,
  request_reason text not null check (char_length(request_reason) between 4 and 500 and request_reason = btrim(request_reason)),
  decision_reason text check (decision_reason is null or (char_length(decision_reason) between 4 and 500 and decision_reason = btrim(decision_reason))),
  transfer_movement_id uuid unique references public.stock_movements(id) on delete restrict,
  correlation_id uuid not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_stock_transfer_locations_differ check (from_location_id <> to_location_id),
  constraint seller_stock_transfer_resolution_valid check (
    (status = 'REQUESTED' and decided_by is null and decided_at is null and transfer_movement_id is null)
    or (status = 'ACCEPTED' and decided_by is not null and decided_at is not null and transfer_movement_id is not null)
    or (status in ('REJECTED', 'CANCELLED') and decided_by is not null and decided_at is not null and transfer_movement_id is null)
  )
);

create index seller_stock_transfer_actor_idx on public.seller_stock_transfer_requests (requested_by, created_at desc, id desc);
create index seller_stock_transfer_source_idx on public.seller_stock_transfer_requests (from_location_id, created_at desc, id desc);
create index seller_stock_transfer_created_idx on public.seller_stock_transfer_requests (created_at desc, id desc);
create trigger seller_stock_transfer_requests_set_updated_at before update on public.seller_stock_transfer_requests
for each row execute function private.set_updated_at();

alter table public.seller_stock_transfer_requests enable row level security;
revoke all on table public.seller_stock_transfer_requests from public, anon, authenticated, service_role;
grant select on table public.seller_stock_transfer_requests to authenticated;
create policy seller_stock_transfer_participant_read on public.seller_stock_transfer_requests
for select to authenticated using (
  requested_by = (select auth.uid())
  or exists (select 1 from public.stock_locations location where location.id = from_location_id and location.seller_id = (select auth.uid()))
  or (select public.has_permission('inventory.manage'))
);

create or replace function private.execute_seller_stock_transfer(
  p_from_location_id uuid, p_to_location_id uuid, p_product_id uuid, p_quantity bigint,
  p_actor_id uuid, p_reason text, p_correlation_id uuid
) returns jsonb language plpgsql set search_path = '' as $$
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
  if not found or v_from.available_quantity < p_quantity then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;
  select * into strict v_to from public.inventory_balances where location_id = p_to_location_id and product_id = p_product_id;
  if v_to.on_hand_quantity + p_quantity > 9007199254740991 then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;
  update public.inventory_balances set on_hand_quantity = on_hand_quantity - p_quantity where id = v_from.id;
  update public.inventory_balances set on_hand_quantity = on_hand_quantity + p_quantity where id = v_to.id;
  v_movement_id := private.record_inventory_effect(
    'TRANSFERENCIA', p_from_location_id, p_to_location_id, p_product_id,
    p_quantity, p_actor_id, p_reason, p_correlation_id
  );
  return jsonb_build_object(
    'movement_id', v_movement_id,
    'from_on_hand_quantity', v_from.on_hand_quantity - p_quantity,
    'to_on_hand_quantity', v_to.on_hand_quantity + p_quantity
  );
end;
$$;

revoke all on function private.execute_seller_stock_transfer(uuid, uuid, uuid, bigint, uuid, text, uuid)
from public, anon, authenticated, service_role;

create or replace function public.request_seller_stock_transfer(
  p_from_location_id uuid, p_product_id uuid, p_quantity bigint, p_reason text,
  p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_to_location_id uuid;
  v_claim record;
  v_request_id uuid;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('inventory.transfer.own') then
    raise exception using errcode = '42501', message = 'SELLER_TRANSFER_REQUIRED';
  end if;
  if p_quantity is null or p_quantity not between 1 and 9007199254740991 then raise exception using errcode = '22023', message = 'INVALID_QUANTITY'; end if;
  if p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then raise exception using errcode = '22023', message = 'INVALID_REASON'; end if;
  if p_correlation_id is null then raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('inventory', 'seller-transfer-request', v_actor_id), p_idempotency_key,
    jsonb_build_object('from_location_id', p_from_location_id, 'product_id', p_product_id, 'quantity', p_quantity, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select id into v_to_location_id from public.stock_locations where seller_id = v_actor_id and location_type = 'SELLER' and active;
  if v_to_location_id is null then raise exception using errcode = 'P0001', message = 'SELLER_LOCATION_NOT_FOUND'; end if;
  if not exists (select 1 from public.stock_locations where id = p_from_location_id and location_type = 'SELLER' and active and seller_id <> v_actor_id) then
    raise exception using errcode = '22023', message = 'INVALID_TRANSFER_SOURCE';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and active) then raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND'; end if;
  if coalesce((select available_quantity from public.inventory_balances where location_id = p_from_location_id and product_id = p_product_id), 0) < p_quantity then
    raise exception using errcode = 'P0001', message = 'STOCK_CONFLICT';
  end if;
  insert into public.seller_stock_transfer_requests (
    from_location_id, to_location_id, product_id, quantity, requested_by, request_reason, correlation_id
  ) values (p_from_location_id, v_to_location_id, p_product_id, p_quantity, v_actor_id, p_reason, p_correlation_id)
  returning id into v_request_id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('inventory.seller_transfer.requested', v_actor_id, 'seller_stock_transfer_request', v_request_id::text, p_correlation_id,
    jsonb_build_object('from_location_id', p_from_location_id, 'to_location_id', v_to_location_id, 'product_id', p_product_id, 'quantity', p_quantity));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('inventory.seller_transfer.requested', 'seller_stock_transfer_request', v_request_id::text,
    jsonb_build_object('request_id', v_request_id, 'from_location_id', p_from_location_id, 'requested_by', v_actor_id, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('request_id', v_request_id, 'status', 'REQUESTED', 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_stock_transfer_request', v_request_id::text);
  return v_result;
end;
$$;

create or replace function public.resolve_seller_stock_transfer(
  p_request_id uuid, p_action text, p_reason text, p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_request public.seller_stock_transfer_requests%rowtype;
  v_claim record;
  v_transfer jsonb := '{}'::jsonb;
  v_status public.seller_stock_transfer_status;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('inventory.transfer.own') then raise exception using errcode = '42501', message = 'SELLER_TRANSFER_REQUIRED'; end if;
  if p_action is null or p_action not in ('ACCEPT', 'REJECT', 'CANCEL') then raise exception using errcode = '22023', message = 'INVALID_TRANSFER_ACTION'; end if;
  if p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then raise exception using errcode = '22023', message = 'INVALID_REASON'; end if;
  if p_correlation_id is null then raise exception using errcode = '22023', message = 'INVALID_CORRELATION_ID'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('inventory', 'seller-transfer-resolve', v_actor_id), p_idempotency_key,
    jsonb_build_object('request_id', p_request_id, 'action', p_action, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_request from public.seller_stock_transfer_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'TRANSFER_REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'REQUESTED' then raise exception using errcode = 'P0001', message = 'TRANSFER_REQUEST_ALREADY_RESOLVED'; end if;
  if p_action = 'CANCEL' then
    if v_request.requested_by <> v_actor_id and not public.has_permission('inventory.manage') then raise exception using errcode = '42501', message = 'TRANSFER_REQUEST_FORBIDDEN'; end if;
    v_status := 'CANCELLED';
  else
    if not exists (select 1 from public.stock_locations where id = v_request.from_location_id and seller_id = v_actor_id and active)
      and not public.has_permission('inventory.manage') then raise exception using errcode = '42501', message = 'TRANSFER_REQUEST_FORBIDDEN'; end if;
    v_status := case when p_action = 'ACCEPT' then 'ACCEPTED'::public.seller_stock_transfer_status else 'REJECTED'::public.seller_stock_transfer_status end;
  end if;
  if v_status = 'ACCEPTED' then
    if not exists (
      select 1 from public.stock_locations
      where id = v_request.from_location_id and location_type = 'SELLER' and active
    ) or not exists (
      select 1 from public.stock_locations
      where id = v_request.to_location_id and location_type = 'SELLER' and active
    ) then
      raise exception using errcode = 'P0001', message = 'SELLER_LOCATION_NOT_FOUND';
    end if;
    perform set_config('request.idempotency_key', p_idempotency_key, true);
    v_transfer := private.execute_seller_stock_transfer(v_request.from_location_id, v_request.to_location_id, v_request.product_id, v_request.quantity, v_actor_id, p_reason, p_correlation_id);
  end if;
  update public.seller_stock_transfer_requests set status = v_status, decided_by = v_actor_id,
    decision_reason = p_reason, decided_at = now(), transfer_movement_id = case when v_status = 'ACCEPTED' then (v_transfer ->> 'movement_id')::uuid else null end
  where id = p_request_id;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('inventory.seller_transfer.' || lower(v_status::text), v_actor_id, 'seller_stock_transfer_request', p_request_id::text, p_correlation_id,
    jsonb_build_object('status', v_status, 'movement_id', v_transfer ->> 'movement_id'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('inventory.seller_transfer.' || lower(v_status::text), 'seller_stock_transfer_request', p_request_id::text,
    jsonb_build_object('request_id', p_request_id, 'status', v_status, 'movement_id', v_transfer ->> 'movement_id', 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('request_id', p_request_id, 'status', v_status, 'movement_id', v_transfer ->> 'movement_id', 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_stock_transfer_request', p_request_id::text);
  return v_result;
end;
$$;

create or replace function public.get_my_seller_stock_transfers(
  p_cursor uuid default null,
  p_limit integer default 20
)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_own_location_id uuid;
  v_cursor_created_at timestamptz;
  v_requests jsonb;
  v_options jsonb;
  v_next_cursor uuid;
begin
  if v_actor_id is null or not public.has_permission('inventory.transfer.own') then raise exception using errcode = '42501', message = 'SELLER_TRANSFER_REQUIRED'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception using errcode = '22023', message = 'INVALID_TRANSFER_QUERY'; end if;
  select id into v_own_location_id from public.stock_locations where seller_id = v_actor_id and location_type = 'SELLER' and active;
  if p_cursor is not null then
    select request.created_at into v_cursor_created_at
    from public.seller_stock_transfer_requests request
    join public.stock_locations source on source.id = request.from_location_id
    where request.id = p_cursor
      and (public.has_permission('inventory.manage') or request.requested_by = v_actor_id or source.seller_id = v_actor_id);
    if v_cursor_created_at is null then raise exception using errcode = '22023', message = 'INVALID_TRANSFER_QUERY'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'from_location_id', page.from_location_id, 'from_location_name', page.from_location_name,
    'to_location_id', page.to_location_id, 'to_location_name', page.to_location_name,
    'product_id', page.product_id, 'product_name', page.product_name, 'product_sku', page.product_sku,
    'quantity', page.quantity, 'status', page.status, 'requested_by', page.requested_by,
    'request_reason', page.request_reason, 'decision_reason', page.decision_reason,
    'movement_id', page.transfer_movement_id, 'created_at', page.created_at, 'decided_at', page.decided_at
  ) order by page.created_at desc, page.id desc), '[]'::jsonb) into v_requests
  from (
    select request.*, source.name as from_location_name, destination.name as to_location_name,
      product.name as product_name, product.sku as product_sku
    from public.seller_stock_transfer_requests request
    join public.stock_locations source on source.id = request.from_location_id
    join public.stock_locations destination on destination.id = request.to_location_id
    join public.products product on product.id = request.product_id
    where (public.has_permission('inventory.manage') or request.requested_by = v_actor_id or source.seller_id = v_actor_id)
      and (p_cursor is null or (request.created_at, request.id) < (v_cursor_created_at, p_cursor))
    order by request.created_at desc, request.id desc
    limit p_limit + 1
  ) page;
  if jsonb_array_length(v_requests) > p_limit then
    v_next_cursor := (v_requests -> (p_limit - 1) ->> 'id')::uuid;
    v_requests := v_requests - p_limit;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'from_location_id', source.id, 'from_location_name', source.name,
    'product_id', product.id, 'product_name', product.name, 'product_sku', product.sku,
    'available_quantity', balance.available_quantity
  ) order by source.name, product.name), '[]'::jsonb) into v_options
  from public.stock_locations source
  join public.inventory_balances balance on balance.location_id = source.id and balance.available_quantity > 0
  join public.products product on product.id = balance.product_id and product.active
  where source.location_type = 'SELLER' and source.active and source.seller_id <> v_actor_id;
  return jsonb_build_object('own_location_id', v_own_location_id, 'requests', v_requests, 'options', v_options, 'next_cursor', v_next_cursor);
end;
$$;

revoke all on function public.request_seller_stock_transfer(uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.resolve_seller_stock_transfer(uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_my_seller_stock_transfers(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.request_seller_stock_transfer(uuid, uuid, bigint, text, text, uuid) to authenticated;
grant execute on function public.resolve_seller_stock_transfer(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.get_my_seller_stock_transfers(uuid, integer) to authenticated;

comment on table public.seller_stock_transfer_requests is 'Seller-to-seller stock requests; stock moves atomically only when the source seller accepts.';
