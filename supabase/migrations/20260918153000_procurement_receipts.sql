-- A receipt is one inspected order line. Multiple receipts may fulfill one line,
-- and each receipt has exactly one lot, stock entry and payable obligation.
alter table public.purchase_orders drop constraint purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in ('OPEN','PARTIALLY_RECEIVED','RECEIVED','CANCELLED'));
alter table public.purchase_orders drop constraint purchase_order_cancellation_valid;
alter table public.purchase_orders add constraint purchase_order_cancellation_valid check (
  (status in ('OPEN','PARTIALLY_RECEIVED','RECEIVED') and cancelled_by is null and cancellation_reason is null and cancelled_at is null)
  or (status='CANCELLED' and cancelled_by is not null and cancelled_at is not null and char_length(cancellation_reason) between 4 and 500)
);

create table public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders(id) on delete restrict,
  order_item_id uuid not null references public.purchase_order_items(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity bigint not null check (quantity between 1 and 9007199254740991),
  received_on date not null,
  base_cost_cents bigint not null check (base_cost_cents between 1 and 9007199254740991),
  allocated_extra_cents bigint not null check (allocated_extra_cents between 0 and 9007199254740991),
  total_cost_cents bigint generated always as (base_cost_cents + allocated_extra_cents) stored,
  movement_id uuid not null unique references public.stock_movements(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (char_length(reason) between 4 and 500 and reason=btrim(reason)),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint purchase_receipt_total_safe check (base_cost_cents + allocated_extra_cents <= 9007199254740991)
);
create index purchase_receipts_order_created_idx on public.purchase_receipts(order_id,created_at desc,id desc);
create index purchase_receipts_order_item_idx on public.purchase_receipts(order_item_id);

create table public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.purchase_receipts(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  lot_code text not null check (char_length(lot_code) between 2 and 100 and lot_code=btrim(lot_code)),
  manufactured_on date,
  expires_on date,
  received_quantity bigint not null check (received_quantity between 1 and 9007199254740991),
  total_cost_cents bigint not null check (total_cost_cents between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  constraint inventory_lot_dates_valid check (manufactured_on is null or expires_on is null or manufactured_on < expires_on)
);
create index inventory_lots_product_code_idx on public.inventory_lots(product_id,lot_code);
create index inventory_lots_expiry_idx on public.inventory_lots(expires_on) where expires_on is not null;

-- The sales ledger is bound to sale/payment IDs. Procurement obligations stay
-- separate and immutable so an expense cannot masquerade as a sale receipt.
create table public.purchase_payable_entries (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.purchase_receipts(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  amount_cents bigint not null check (amount_cents between 1 and 9007199254740991),
  payment_method text not null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
create index purchase_payable_entries_supplier_idx on public.purchase_payable_entries(supplier_id,created_at desc);

create trigger purchase_receipts_immutable before update or delete on public.purchase_receipts
for each row execute function private.prevent_immutable_record_change();
create trigger inventory_lots_immutable before update or delete on public.inventory_lots
for each row execute function private.prevent_immutable_record_change();
create trigger purchase_payable_entries_immutable before update or delete on public.purchase_payable_entries
for each row execute function private.prevent_immutable_record_change();

alter table public.purchase_receipts enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.purchase_payable_entries enable row level security;
create policy purchase_receipts_read on public.purchase_receipts for select to authenticated
using ((select public.has_permission('procurement.manage')));
create policy inventory_lots_read on public.inventory_lots for select to authenticated
using ((select public.has_permission('procurement.manage')));
create policy purchase_payable_entries_read on public.purchase_payable_entries for select to authenticated
using ((select public.has_permission('procurement.manage')));
create policy purchase_payable_entries_finance_read on public.purchase_payable_entries for select to authenticated
using ((select public.has_permission('finance.manage')));
revoke all on public.purchase_receipts,public.inventory_lots,public.purchase_payable_entries from public,anon,authenticated,service_role;
grant select on public.purchase_receipts,public.inventory_lots,public.purchase_payable_entries to authenticated;

create view public.purchase_order_item_progress with (security_invoker=true) as
select item.order_id,item.id as order_item_id,item.quantity as ordered_quantity,
  coalesce(sum(receipt.quantity),0)::bigint as received_quantity
from public.purchase_order_items item
left join public.purchase_receipts receipt on receipt.order_item_id=item.id
group by item.order_id,item.id,item.quantity;
revoke all on public.purchase_order_item_progress from public,anon,authenticated,service_role;
grant select on public.purchase_order_item_progress to authenticated;

create function private.prevent_cancellation_after_receipt() returns trigger language plpgsql set search_path='' as $$
begin
  if old.status='OPEN' and new.status='CANCELLED'
    and exists(select 1 from public.purchase_receipts where order_id=old.id) then
    raise exception using errcode='P0001',message='PURCHASE_ORDER_ALREADY_RECEIVED';
  end if;
  return new;
end;
$$;
create trigger purchase_order_receipt_cancellation_guard before update of status on public.purchase_orders
for each row execute function private.prevent_cancellation_after_receipt();
revoke all on function private.prevent_cancellation_after_receipt() from public,anon,authenticated,service_role;

create function public.receive_purchase_order_item(
  p_order_id uuid,p_order_item_id uuid,p_quantity bigint,p_received_on date,
  p_lot_code text,p_manufactured_on date,p_expires_on date,p_reason text,
  p_idempotency_key text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();
  v_claim record;
  v_order public.purchase_orders%rowtype;
  v_item public.purchase_order_items%rowtype;
  v_product public.products%rowtype;
  v_central uuid;
  v_balance public.inventory_balances%rowtype;
  v_prior_quantity bigint;
  v_prior_base bigint;
  v_base bigint;
  v_extra bigint;
  v_allocated bigint;
  v_receipt_id uuid:=gen_random_uuid();
  v_movement_id uuid:=gen_random_uuid();
  v_lot_id uuid;
  v_payable_id uuid;
  v_ordered_quantity numeric;
  v_received_quantity numeric;
  v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('procurement.manage') then raise exception using errcode='42501',message='PROCUREMENT_MANAGE_FORBIDDEN'; end if;
  if p_order_id is null or p_order_item_id is null or p_quantity is null or p_quantity not between 1 and 9007199254740991
    or p_received_on is null or p_received_on > (now() at time zone 'America/Sao_Paulo')::date
    or p_lot_code is not null and (p_lot_code<>btrim(p_lot_code) or char_length(p_lot_code) not between 2 and 100)
    or p_manufactured_on is not null and p_manufactured_on>p_received_on
    or p_expires_on is not null and p_expires_on<=p_received_on
    or p_manufactured_on is not null and p_expires_on is not null and p_manufactured_on>=p_expires_on
    or p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 4 and 500
    or p_correlation_id is null then
    raise exception using errcode='22023',message='INVALID_PURCHASE_RECEIPT';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('procurement','receipt_create',v_actor),p_idempotency_key,
    jsonb_build_object('order_id',p_order_id,'order_item_id',p_order_item_id,'quantity',p_quantity,
      'received_on',p_received_on,'lot_code',p_lot_code,'manufactured_on',p_manufactured_on,
      'expires_on',p_expires_on,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;

  select * into v_order from public.purchase_orders where id=p_order_id for update;
  if not found then raise exception using errcode='P0002',message='PURCHASE_ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('OPEN','PARTIALLY_RECEIVED') then raise exception using errcode='P0001',message='PURCHASE_ORDER_NOT_OPEN'; end if;
  select * into v_item from public.purchase_order_items where id=p_order_item_id and order_id=p_order_id;
  if not found then raise exception using errcode='P0002',message='PURCHASE_ITEM_NOT_FOUND'; end if;
  select * into v_product from public.products where id=v_item.product_id for update;
  if v_product.tracks_lots and p_lot_code is null then raise exception using errcode='22023',message='LOT_CODE_REQUIRED'; end if;
  select coalesce(sum(quantity),0),coalesce(sum(base_cost_cents),0) into v_prior_quantity,v_prior_base
    from public.purchase_receipts where order_item_id=p_order_item_id;
  if p_quantity>v_item.quantity-v_prior_quantity then raise exception using errcode='P0001',message='PURCHASE_QUANTITY_EXCEEDED'; end if;
  if p_quantity>9007199254740991/v_item.unit_cost_cents then raise exception using errcode='22023',message='INVALID_PURCHASE_RECEIPT'; end if;
  v_base:=p_quantity*v_item.unit_cost_cents;
  select coalesce(sum(base_cost_cents),0) into v_prior_base from public.purchase_receipts where order_id=p_order_id;
  v_extra:=v_order.freight_cents+v_order.other_cost_cents;
  v_allocated:=floor(((v_prior_base+v_base)::numeric*v_extra)/v_order.items_subtotal_cents)::bigint
    - floor((v_prior_base::numeric*v_extra)/v_order.items_subtotal_cents)::bigint;
  if v_base+v_allocated>9007199254740991 then raise exception using errcode='22023',message='INVALID_PURCHASE_RECEIPT'; end if;

  select id into v_central from public.stock_locations where location_type='CENTRAL' and active for update;
  if v_central is null then raise exception using errcode='P0001',message='CENTRAL_STOCK_UNAVAILABLE'; end if;
  insert into public.inventory_balances(location_id,product_id) values(v_central,v_item.product_id)
    on conflict(location_id,product_id) do nothing;
  select * into v_balance from public.inventory_balances where location_id=v_central and product_id=v_item.product_id for update;
  if v_balance.on_hand_quantity>9007199254740991-p_quantity then raise exception using errcode='P0001',message='STOCK_OVERFLOW'; end if;
  update public.inventory_balances set on_hand_quantity=on_hand_quantity+p_quantity where id=v_balance.id;
  insert into public.stock_movements(id,movement_type,to_location_id,actor_id,reason,correlation_id,source_type,source_id)
    values(v_movement_id,'ENTRADA_COMPRA',v_central,v_actor,p_reason,p_correlation_id,'purchase_receipt',v_receipt_id::text);
  insert into public.stock_movement_items(movement_id,product_id,quantity) values(v_movement_id,v_item.product_id,p_quantity);
  insert into public.purchase_receipts(id,order_id,order_item_id,product_id,quantity,received_on,base_cost_cents,
    allocated_extra_cents,movement_id,actor_id,reason,correlation_id)
    values(v_receipt_id,p_order_id,p_order_item_id,v_item.product_id,p_quantity,p_received_on,v_base,
      v_allocated,v_movement_id,v_actor,p_reason,p_correlation_id);
  insert into public.inventory_lots(receipt_id,product_id,lot_code,manufactured_on,expires_on,received_quantity,total_cost_cents)
    values(v_receipt_id,v_item.product_id,coalesce(p_lot_code,'REC-'||left(replace(v_receipt_id::text,'-',''),16)),
      p_manufactured_on,p_expires_on,p_quantity,v_base+v_allocated) returning id into v_lot_id;
  insert into public.purchase_payable_entries(receipt_id,supplier_id,amount_cents,payment_method,actor_id,correlation_id)
    values(v_receipt_id,v_order.supplier_id,v_base+v_allocated,v_order.payment_method,v_actor,p_correlation_id)
    returning id into v_payable_id;
  select coalesce(sum(quantity),0) into v_ordered_quantity from public.purchase_order_items where order_id=p_order_id;
  select coalesce(sum(quantity),0) into v_received_quantity from public.purchase_receipts where order_id=p_order_id;
  update public.purchase_orders set status=case when v_received_quantity=v_ordered_quantity then 'RECEIVED' else 'PARTIALLY_RECEIVED' end
    where id=p_order_id;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values('inventory.movement.created',v_actor,'stock_movement',v_movement_id::text,p_correlation_id,
      jsonb_build_object('movement_type','ENTRADA_COMPRA','product_id',v_item.product_id,'quantity',p_quantity,
        'from_location_id',null,'to_location_id',v_central,'reversal_of',null,
        'source_type','purchase_receipt','source_id',v_receipt_id));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('inventory.movement.created','stock_movement',v_movement_id::text,
      jsonb_build_object('movement_id',v_movement_id,'movement_type','ENTRADA_COMPRA',
        'product_id',v_item.product_id,'quantity',p_quantity,'correlation_id',p_correlation_id,
        'source_type','purchase_receipt','source_id',v_receipt_id));
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values('procurement.receipt.created',v_actor,'purchase_receipt',v_receipt_id::text,p_correlation_id,
      jsonb_build_object('reason',p_reason,'order_id',p_order_id,'item_id',p_order_item_id,'quantity',p_quantity,
        'base_cost_cents',v_base,'allocated_extra_cents',v_allocated,'lot_id',v_lot_id,'movement_id',v_movement_id,'payable_id',v_payable_id));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('procurement.receipt.created','purchase_receipt',v_receipt_id::text,
      jsonb_build_object('order_id',p_order_id,'receipt_id',v_receipt_id,'movement_id',v_movement_id,
        'payable_id',v_payable_id,'correlation_id',p_correlation_id));
  v_result:=jsonb_build_object('id',v_receipt_id,'orderId',p_order_id,'quantity',p_quantity,
    'baseCostCents',v_base,'allocatedExtraCents',v_allocated,'totalCostCents',v_base+v_allocated,
    'lotId',v_lot_id,'movementId',v_movement_id,'payableId',v_payable_id,'correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'purchase_receipt',v_receipt_id::text);
  return v_result;
end;
$$;
revoke all on function public.receive_purchase_order_item(uuid,uuid,bigint,date,text,date,date,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.receive_purchase_order_item(uuid,uuid,bigint,date,text,date,date,text,text,uuid)
  to authenticated;
