create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  status text not null default 'OPEN' check (status in ('OPEN', 'CANCELLED')),
  ordered_on date not null,
  expected_on date,
  freight_cents bigint not null default 0 check (freight_cents between 0 and 9007199254740991),
  other_cost_cents bigint not null default 0 check (other_cost_cents between 0 and 9007199254740991),
  items_subtotal_cents bigint not null check (items_subtotal_cents between 1 and 9007199254740991),
  total_cents bigint generated always as (items_subtotal_cents + freight_cents + other_cost_cents) stored,
  payment_method text not null check (char_length(payment_method) between 2 and 80 and payment_method = btrim(payment_method)),
  proof_reference text check (proof_reference is null or (char_length(proof_reference) between 4 and 500 and proof_reference = btrim(proof_reference))),
  notes text check (notes is null or (char_length(notes) between 4 and 1000 and notes = btrim(notes))),
  created_by uuid not null references public.profiles(id) on delete restrict,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint purchase_order_dates_valid check (expected_on is null or expected_on >= ordered_on),
  constraint purchase_order_total_valid check (items_subtotal_cents + freight_cents + other_cost_cents <= 9007199254740991),
  constraint purchase_order_cancellation_valid check (
    (status = 'OPEN' and cancelled_by is null and cancellation_reason is null and cancelled_at is null)
    or (status = 'CANCELLED' and cancelled_by is not null and cancelled_at is not null and char_length(cancellation_reason) between 4 and 500)
  )
);

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name text not null,
  product_sku text not null,
  quantity bigint not null check (quantity between 1 and 9007199254740991),
  unit_cost_cents bigint not null check (unit_cost_cents between 1 and 9007199254740991),
  line_total_cents bigint generated always as (quantity * unit_cost_cents) stored,
  constraint purchase_order_items_unique unique (order_id, product_id),
  constraint purchase_order_items_total_valid check (quantity * unit_cost_cents <= 9007199254740991)
);

create index purchase_orders_created_idx on public.purchase_orders (created_at desc, id desc);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id, created_at desc);
create index purchase_order_items_product_idx on public.purchase_order_items (product_id);

create trigger purchase_order_items_immutable before update or delete on public.purchase_order_items
for each row execute function private.prevent_immutable_record_change();

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
create policy purchase_orders_read on public.purchase_orders for select to authenticated
using ((select public.has_permission('procurement.manage')));
create policy purchase_order_items_read on public.purchase_order_items for select to authenticated
using ((select public.has_permission('procurement.manage')));
create policy products_procurement_read on public.products for select to authenticated
using ((select public.has_permission('procurement.manage')));
revoke all on public.purchase_orders, public.purchase_order_items from public, anon, authenticated, service_role;
grant select on public.purchase_orders, public.purchase_order_items to authenticated;

create function public.create_purchase_order(
  p_supplier_id uuid, p_ordered_on date, p_expected_on date,
  p_freight_cents bigint, p_other_cost_cents bigint, p_payment_method text,
  p_proof_reference text, p_notes text, p_items jsonb, p_reason text,
  p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_supplier public.suppliers%rowtype;
  v_order public.purchase_orders%rowtype;
  v_claim record;
  v_item jsonb;
  v_product public.products%rowtype;
  v_product_id uuid;
  v_quantity bigint;
  v_unit_cost bigint;
  v_subtotal bigint := 0;
  v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('procurement.manage') then raise exception using errcode='42501', message='PROCUREMENT_MANAGE_FORBIDDEN'; end if;
  if p_supplier_id is null or p_ordered_on is null or (p_expected_on is not null and p_expected_on < p_ordered_on)
    or p_freight_cents is null or p_freight_cents not between 0 and 9007199254740991
    or p_other_cost_cents is null or p_other_cost_cents not between 0 and 9007199254740991
    or p_payment_method is null or btrim(p_payment_method) <> p_payment_method or char_length(p_payment_method) not between 2 and 80
    or (p_proof_reference is not null and (btrim(p_proof_reference) <> p_proof_reference or char_length(p_proof_reference) not between 4 and 500))
    or (p_notes is not null and (btrim(p_notes) <> p_notes or char_length(p_notes) not between 4 and 1000))
    or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100
    or p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 4 and 500
    or p_correlation_id is null then
    raise exception using errcode='22023', message='INVALID_PURCHASE_ORDER';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('procurement', 'order_create', v_actor), p_idempotency_key,
    jsonb_build_object('supplier_id', p_supplier_id, 'ordered_on', p_ordered_on, 'expected_on', p_expected_on,
      'freight_cents', p_freight_cents, 'other_cost_cents', p_other_cost_cents,
      'payment_method', p_payment_method, 'proof_reference', p_proof_reference, 'notes', p_notes,
      'items', p_items, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001', message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;

  -- Supplier deactivation uses UPDATE on a non-key column. FOR KEY SHARE would
  -- not serialize that transition with order creation.
  select * into v_supplier from public.suppliers where id=p_supplier_id for update;
  if not found or not v_supplier.active then raise exception using errcode='P0001', message='SUPPLIER_INACTIVE'; end if;

  foreach v_item in array (select array_agg(value) from jsonb_array_elements(p_items)) loop
    if jsonb_typeof(v_item) <> 'object' or v_item - 'productId' - 'quantity' - 'unitCostCents' <> '{}'::jsonb
      or jsonb_typeof(v_item->'productId') <> 'string' or (v_item->>'productId') !~ '^[0-9a-f-]{36}$'
      or jsonb_typeof(v_item->'quantity') <> 'number' or (v_item->>'quantity') !~ '^[0-9]+$'
      or jsonb_typeof(v_item->'unitCostCents') <> 'number' or (v_item->>'unitCostCents') !~ '^[0-9]+$' then
      raise exception using errcode='22023', message='INVALID_PURCHASE_ITEM';
    end if;
    v_product_id := (v_item->>'productId')::uuid;
    v_quantity := (v_item->>'quantity')::bigint;
    v_unit_cost := (v_item->>'unitCostCents')::bigint;
    if v_quantity < 1 or v_unit_cost < 1 or v_quantity > 9007199254740991 / v_unit_cost
      or v_subtotal > 9007199254740991 - (v_quantity * v_unit_cost) then
      raise exception using errcode='22023', message='INVALID_PURCHASE_ITEM';
    end if;
    v_subtotal := v_subtotal + v_quantity * v_unit_cost;
  end loop;
  if p_other_cost_cents > 9007199254740991 - p_freight_cents
    or v_subtotal > 9007199254740991 - p_freight_cents - p_other_cost_cents then
    raise exception using errcode='22023', message='INVALID_PURCHASE_ORDER';
  end if;

  insert into public.purchase_orders (supplier_id, ordered_on, expected_on, freight_cents, other_cost_cents,
    items_subtotal_cents, payment_method, proof_reference, notes, created_by)
  values (p_supplier_id, p_ordered_on, p_expected_on, p_freight_cents, p_other_cost_cents,
    v_subtotal, p_payment_method, p_proof_reference, p_notes, v_actor) returning * into v_order;

  -- A stable product lock order avoids deadlocks between multi-item orders.
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    v_product_id := (v_item->>'productId')::uuid;
    v_quantity := (v_item->>'quantity')::bigint;
    v_unit_cost := (v_item->>'unitCostCents')::bigint;
    select * into v_product from public.products where id=v_product_id for update;
    if not found or not v_product.active then raise exception using errcode='P0001', message='PRODUCT_INACTIVE'; end if;
    insert into public.purchase_order_items (order_id, product_id, product_name, product_sku, quantity, unit_cost_cents)
    values (v_order.id, v_product_id, v_product.name, v_product.sku, v_quantity, v_unit_cost);
  end loop;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('procurement.order.created', v_actor, 'purchase_order', v_order.id::text, p_correlation_id,
    jsonb_build_object('reason', p_reason, 'supplier', to_jsonb(v_supplier), 'order', to_jsonb(v_order), 'items', p_items));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('procurement.order.created', 'purchase_order', v_order.id::text,
    jsonb_build_object('order_id', v_order.id, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('id', v_order.id, 'status', v_order.status, 'totalCents', v_order.total_cents,
    'correlationId', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'purchase_order', v_order.id::text);
  return v_result;
end;
$$;

create function public.cancel_purchase_order(
  p_order_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.purchase_orders%rowtype;
  v_claim record;
  v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501', message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('procurement.manage') then raise exception using errcode='42501', message='PROCUREMENT_MANAGE_FORBIDDEN'; end if;
  if p_order_id is null or p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 4 and 500 or p_correlation_id is null then
    raise exception using errcode='22023', message='INVALID_PURCHASE_ORDER';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('procurement', 'order_cancel', v_actor), p_idempotency_key,
    jsonb_build_object('id', p_order_id, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001', message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_order from public.purchase_orders where id=p_order_id for update;
  if not found then raise exception using errcode='P0002', message='PURCHASE_ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'OPEN' then raise exception using errcode='P0001', message='PURCHASE_ORDER_NOT_OPEN'; end if;
  update public.purchase_orders set status='CANCELLED', cancelled_by=v_actor,
    cancellation_reason=p_reason, cancelled_at=now() where id=p_order_id returning * into v_order;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('procurement.order.cancelled', v_actor, 'purchase_order', p_order_id::text, p_correlation_id,
    jsonb_build_object('reason', p_reason, 'order', to_jsonb(v_order)));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('procurement.order.cancelled', 'purchase_order', p_order_id::text,
    jsonb_build_object('order_id', p_order_id, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('id', p_order_id, 'status', v_order.status, 'correlationId', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'purchase_order', p_order_id::text);
  return v_result;
end;
$$;

revoke all on function public.create_purchase_order(uuid,date,date,bigint,bigint,text,text,text,jsonb,text,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_purchase_order(uuid,date,date,bigint,bigint,text,text,text,jsonb,text,text,uuid) to authenticated;
revoke all on function public.cancel_purchase_order(uuid,text,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_purchase_order(uuid,text,text,uuid) to authenticated;

comment on table public.purchase_orders is 'Open or cancelled purchase commitments; no inventory or financial entry occurs before physical receipt.';
