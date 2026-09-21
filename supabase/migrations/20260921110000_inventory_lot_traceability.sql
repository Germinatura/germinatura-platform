-- Trace each configured product from its lot origin through locations and final consumption.
alter table public.inventory_lots alter column receipt_id drop not null;
alter table public.inventory_lots alter column total_cost_cents drop not null;
alter table public.inventory_lots drop constraint inventory_lots_total_cost_cents_check;
alter table public.inventory_lots add constraint inventory_lots_total_cost_cents_check
  check (total_cost_cents is null or total_cost_cents between 1 and 9007199254740991);
alter table public.inventory_lots add column origin_type text not null default 'PURCHASE_RECEIPT';
alter table public.inventory_lots add column origin_id text;
alter table public.inventory_lots add constraint inventory_lots_origin_valid check (
  origin_type in ('PURCHASE_RECEIPT','STOCK_MOVEMENT_ITEM','TRACEABILITY_BASELINE')
  and (origin_id is null or (char_length(origin_id) between 1 and 128 and origin_id=btrim(origin_id)))
  and ((origin_type='PURCHASE_RECEIPT' and receipt_id is not null and (origin_id is null or origin_id=receipt_id::text))
    or (origin_type<>'PURCHASE_RECEIPT' and receipt_id is null and origin_id is not null))
);
alter table public.inventory_lots add constraint inventory_lots_origin_unique unique(origin_type,origin_id);

create function private.default_purchase_lot_origin()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.receipt_id is not null then
    new.origin_type:='PURCHASE_RECEIPT';
    new.origin_id:=coalesce(new.origin_id,new.receipt_id::text);
  end if;
  return new;
end;
$$;
create trigger inventory_lots_default_purchase_origin before insert on public.inventory_lots
for each row execute function private.default_purchase_lot_origin();

create table public.inventory_lot_balances (
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  on_hand_quantity bigint not null default 0 check(on_hand_quantity between 0 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key(lot_id,location_id)
);
create index inventory_lot_balances_location_idx on public.inventory_lot_balances(location_id,lot_id);
create trigger inventory_lot_balances_set_updated_at before update on public.inventory_lot_balances
for each row execute function private.set_updated_at();

create table public.inventory_lot_cost_states (
  lot_id uuid primary key references public.inventory_lots(id) on delete restrict,
  consumed_quantity bigint not null default 0 check(consumed_quantity between 0 and 9007199254740991),
  consumed_cost_cents bigint check(consumed_cost_cents is null or consumed_cost_cents between 0 and 9007199254740991),
  updated_at timestamptz not null default now()
);
create trigger inventory_lot_cost_states_set_updated_at before update on public.inventory_lot_cost_states
for each row execute function private.set_updated_at();

create table public.stock_movement_lot_allocations (
  id uuid primary key default gen_random_uuid(),
  movement_item_id uuid not null references public.stock_movement_items(id) on delete restrict,
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  quantity bigint not null check(quantity between 1 and 9007199254740991),
  allocated_cost_cents bigint check(allocated_cost_cents is null or allocated_cost_cents between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  unique(movement_item_id,lot_id)
);
create index stock_movement_lot_allocations_lot_idx on public.stock_movement_lot_allocations(lot_id,created_at,id);
create trigger stock_movement_lot_allocations_immutable before update or delete on public.stock_movement_lot_allocations
for each row execute function private.prevent_immutable_record_change();

alter table public.inventory_lot_balances enable row level security;
alter table public.inventory_lot_cost_states enable row level security;
alter table public.stock_movement_lot_allocations enable row level security;
revoke all on public.inventory_lot_balances,public.inventory_lot_cost_states,public.stock_movement_lot_allocations from public,anon,authenticated,service_role;
grant select on public.inventory_lot_balances,public.inventory_lot_cost_states,public.stock_movement_lot_allocations to authenticated;
create policy inventory_lot_balances_manager_read on public.inventory_lot_balances for select to authenticated
using ((select public.has_permission('inventory.manage')));
create policy stock_movement_lot_allocations_manager_read on public.stock_movement_lot_allocations for select to authenticated
using ((select public.has_permission('inventory.manage')));
create policy inventory_lot_cost_states_manager_read on public.inventory_lot_cost_states for select to authenticated
using ((select public.has_permission('inventory.manage')));
create policy inventory_lots_inventory_manager_read on public.inventory_lots for select to authenticated
using ((select public.has_permission('inventory.manage')));

create function private.consume_lot_cost(p_lot_id uuid,p_quantity bigint)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_lot public.inventory_lots%rowtype; v_state public.inventory_lot_cost_states%rowtype; v_new_quantity bigint; v_new_cost bigint;
begin
  select * into strict v_lot from public.inventory_lots where id=p_lot_id;
  select * into strict v_state from public.inventory_lot_cost_states where lot_id=p_lot_id for update;
  v_new_quantity:=v_state.consumed_quantity+p_quantity;
  if v_new_quantity>v_lot.received_quantity then raise exception using errcode='P0001',message='LOT_COST_CONFLICT'; end if;
  if v_lot.total_cost_cents is null then
    update public.inventory_lot_cost_states set consumed_quantity=v_new_quantity where lot_id=p_lot_id;
    return null;
  end if;
  -- Allocate from the remaining cost, so reversing an older consumption after a
  -- newer one cannot make the next allocation negative or lose cents.
  v_new_cost:=floor(((v_lot.total_cost_cents-v_state.consumed_cost_cents)::numeric*p_quantity)
    /(v_lot.received_quantity-v_state.consumed_quantity))::bigint;
  update public.inventory_lot_cost_states set consumed_quantity=v_new_quantity,
    consumed_cost_cents=v_state.consumed_cost_cents+v_new_cost where lot_id=p_lot_id;
  return v_new_cost;
end;
$$;

create function private.restore_lot_cost(p_lot_id uuid,p_quantity bigint,p_cost bigint)
returns void language plpgsql security definer set search_path='' as $$
declare v_state public.inventory_lot_cost_states%rowtype;
begin
  select * into strict v_state from public.inventory_lot_cost_states where lot_id=p_lot_id for update;
  if v_state.consumed_quantity<p_quantity or (p_cost is not null and (v_state.consumed_cost_cents is null or v_state.consumed_cost_cents<p_cost)) then
    raise exception using errcode='P0001',message='LOT_COST_CONFLICT';
  end if;
  update public.inventory_lot_cost_states set consumed_quantity=consumed_quantity-p_quantity,
    consumed_cost_cents=case when p_cost is null then null else consumed_cost_cents-p_cost end where lot_id=p_lot_id;
end;
$$;

create function private.apply_lot_physical(p_lot_id uuid,p_from uuid,p_to uuid,p_quantity bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_from is not null then
    update public.inventory_lot_balances set on_hand_quantity=on_hand_quantity-p_quantity
    where lot_id=p_lot_id and location_id=p_from and on_hand_quantity>=p_quantity;
    if not found then raise exception using errcode='P0001',message='LOT_STOCK_CONFLICT'; end if;
  end if;
  if p_to is not null then
    insert into public.inventory_lot_balances(lot_id,location_id,on_hand_quantity) values(p_lot_id,p_to,p_quantity)
    on conflict(lot_id,location_id) do update set on_hand_quantity=public.inventory_lot_balances.on_hand_quantity+excluded.on_hand_quantity;
  end if;
end;
$$;

create function private.trace_stock_movement_item()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_movement public.stock_movements%rowtype; v_original public.stock_movements%rowtype;
  v_remaining bigint:=new.quantity; v_take bigint; v_cost bigint; v_total bigint:=0;
  v_row record; v_lot_id uuid; v_lot_code text;
begin
  select * into strict v_movement from public.stock_movements where id=new.movement_id;
  if v_movement.movement_type in ('ENTRADA_COMPRA','RESERVA','LIBERACAO_RESERVA') then return new; end if;

  -- Reversing an earlier positive adjustment removes current physical units.
  -- Those original units may already have been sold or lost, so allocate the
  -- compensating negative adjustment from the lots actually still on hand.
  if v_movement.reversal_of is not null then
    select * into strict v_original from public.stock_movements where id=v_movement.reversal_of;
  end if;
  if v_movement.reversal_of is not null and v_original.movement_type<>'AJUSTE_POSITIVO' then
    for v_row in select allocation.* from public.stock_movement_lot_allocations allocation
      join public.stock_movement_items item on item.id=allocation.movement_item_id
      where item.movement_id=v_original.id and item.product_id=new.product_id order by allocation.lot_id
    loop
      perform private.apply_lot_physical(v_row.lot_id,v_movement.from_location_id,v_movement.to_location_id,v_row.quantity);
      if v_original.movement_type in ('VENDA','PERDA','VENCIMENTO','AJUSTE_NEGATIVO') and v_movement.to_location_id is not null then
        perform private.restore_lot_cost(v_row.lot_id,v_row.quantity,v_row.allocated_cost_cents);
      elsif v_movement.movement_type in ('VENDA','PERDA','VENCIMENTO','AJUSTE_NEGATIVO') and v_movement.from_location_id is not null then
        v_cost:=private.consume_lot_cost(v_row.lot_id,v_row.quantity);
      else v_cost:=v_row.allocated_cost_cents;
      end if;
      insert into public.stock_movement_lot_allocations(movement_item_id,lot_id,quantity,allocated_cost_cents)
      values(new.id,v_row.lot_id,v_row.quantity,coalesce(v_cost,v_row.allocated_cost_cents));
      v_total:=v_total+v_row.quantity;
    end loop;
    if v_total<>new.quantity then raise exception using errcode='P0001',message='LOT_REVERSAL_CONFLICT'; end if;
    return new;
  end if;

  if v_movement.from_location_id is null then
    v_lot_id:=gen_random_uuid(); v_lot_code:='MOV-'||upper(substr(replace(new.id::text,'-',''),1,12));
    insert into public.inventory_lots(id,receipt_id,product_id,lot_code,received_quantity,total_cost_cents,origin_type,origin_id)
    values(v_lot_id,null,new.product_id,v_lot_code,new.quantity,null,'STOCK_MOVEMENT_ITEM',new.id::text);
    insert into public.inventory_lot_cost_states(lot_id,consumed_quantity,consumed_cost_cents) values(v_lot_id,0,null);
    perform private.apply_lot_physical(v_lot_id,null,v_movement.to_location_id,new.quantity);
    insert into public.stock_movement_lot_allocations(movement_item_id,lot_id,quantity,allocated_cost_cents)
    values(new.id,v_lot_id,new.quantity,null);
    return new;
  end if;

  for v_row in select balance.lot_id,balance.on_hand_quantity
    from public.inventory_lot_balances balance join public.inventory_lots lot on lot.id=balance.lot_id
    where balance.location_id=v_movement.from_location_id and lot.product_id=new.product_id and balance.on_hand_quantity>0
    order by lot.expires_on nulls last,lot.created_at,lot.id for update of balance
  loop
    exit when v_remaining=0; v_take:=least(v_remaining,v_row.on_hand_quantity);
    perform private.apply_lot_physical(v_row.lot_id,v_movement.from_location_id,v_movement.to_location_id,v_take);
    if v_movement.movement_type in ('VENDA','PERDA','VENCIMENTO','AJUSTE_NEGATIVO') then v_cost:=private.consume_lot_cost(v_row.lot_id,v_take); else v_cost:=null; end if;
    insert into public.stock_movement_lot_allocations(movement_item_id,lot_id,quantity,allocated_cost_cents)
    values(new.id,v_row.lot_id,v_take,v_cost);
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_remaining<>0 then raise exception using errcode='P0001',message='LOT_STOCK_CONFLICT'; end if;
  return new;
end;
$$;

create trigger stock_movement_items_trace_lots after insert on public.stock_movement_items
for each row execute function private.trace_stock_movement_item();

create function private.initialize_purchase_lot()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_receipt public.purchase_receipts%rowtype; v_item_id uuid; v_location uuid;
begin
  if new.origin_type<>'PURCHASE_RECEIPT' then return new; end if;
  select * into strict v_receipt from public.purchase_receipts where id=new.receipt_id;
  select item.id,movement.to_location_id into strict v_item_id,v_location
  from public.stock_movement_items item join public.stock_movements movement on movement.id=item.movement_id
  where item.movement_id=v_receipt.movement_id and item.product_id=new.product_id;
  insert into public.inventory_lot_balances(lot_id,location_id,on_hand_quantity) values(new.id,v_location,new.received_quantity);
  insert into public.inventory_lot_cost_states(lot_id,consumed_quantity,consumed_cost_cents)
  values(new.id,0,case when new.total_cost_cents is null then null else 0 end);
  insert into public.stock_movement_lot_allocations(movement_item_id,lot_id,quantity,allocated_cost_cents)
  values(v_item_id,new.id,new.received_quantity,new.total_cost_cents);
  return new;
end;
$$;
create trigger inventory_lots_initialize_purchase after insert on public.inventory_lots
for each row execute function private.initialize_purchase_lot();

-- Existing environments start with an explicit, cost-unknown baseline. New receipts retain purchase provenance.
with inserted as (
  insert into public.inventory_lots(receipt_id,product_id,lot_code,received_quantity,total_cost_cents,origin_type,origin_id)
  select null,balance.product_id,'BASE-'||upper(substr(replace(balance.location_id::text,'-',''),1,6))||'-'||upper(substr(replace(balance.product_id::text,'-',''),1,6)),
    balance.on_hand_quantity,null,'TRACEABILITY_BASELINE',balance.location_id::text||':'||balance.product_id::text
  from public.inventory_balances balance
  where balance.on_hand_quantity>0 returning id,origin_id,received_quantity
)
insert into public.inventory_lot_balances(lot_id,location_id,on_hand_quantity)
select inserted.id,split_part(inserted.origin_id,':',1)::uuid,inserted.received_quantity from inserted;
insert into public.inventory_lot_cost_states(lot_id,consumed_quantity,consumed_cost_cents)
select id,0,null from public.inventory_lots where origin_type='TRACEABILITY_BASELINE'
on conflict(lot_id) do nothing;
-- Historical purchase lots remain documentary: their untraced remaining quantity
-- cannot be inferred safely. The baseline represents the current physical balance.
insert into public.inventory_lot_cost_states(lot_id,consumed_quantity,consumed_cost_cents)
select id,0,case when total_cost_cents is null then null else 0 end
from public.inventory_lots where origin_type='PURCHASE_RECEIPT'
on conflict(lot_id) do nothing;

create view public.inventory_lot_positions with (security_invoker=true) as
select lot.id as lot_id,lot.lot_code,lot.origin_type,lot.product_id,product.sku as product_sku,product.name as product_name,
  balance.location_id,location.name as location_name,balance.on_hand_quantity,lot.manufactured_on,lot.expires_on,
  lot.received_quantity,lot.total_cost_cents,state.consumed_quantity,state.consumed_cost_cents,lot.created_at
from public.inventory_lots lot join public.products product on product.id=lot.product_id
join public.inventory_lot_balances balance on balance.lot_id=lot.id
join public.stock_locations location on location.id=balance.location_id
join public.inventory_lot_cost_states state on state.lot_id=lot.id;
create view public.inventory_lot_history with (security_invoker=true) as
select allocation.id,allocation.lot_id,allocation.quantity,allocation.allocated_cost_cents,
  movement.id as movement_id,movement.movement_type,movement.from_location_id,movement.to_location_id,
  movement.source_type,movement.source_id,movement.reason,movement.created_at
from public.stock_movement_lot_allocations allocation
join public.stock_movement_items item on item.id=allocation.movement_item_id
join public.stock_movements movement on movement.id=item.movement_id;
create function public.search_inventory_lot_positions(p_query text,p_cursor_lot uuid,p_cursor_location uuid,p_limit integer)
returns setof public.inventory_lot_positions language sql stable security invoker set search_path='' as $$
  select position.* from public.inventory_lot_positions position
  where (p_query is null or position.lot_code ilike '%'||p_query||'%' or position.product_name ilike '%'||p_query||'%'
    or position.product_sku ilike '%'||p_query||'%' or position.location_name ilike '%'||p_query||'%')
    and (p_cursor_lot is null or (position.lot_id,position.location_id)<(p_cursor_lot,p_cursor_location))
  order by position.lot_id desc,position.location_id desc limit least(greatest(p_limit,1),21);
$$;
revoke all on public.inventory_lot_positions,public.inventory_lot_history from public,anon,authenticated,service_role;
grant select on public.inventory_lot_positions,public.inventory_lot_history to authenticated;
revoke all on function public.search_inventory_lot_positions(text,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.search_inventory_lot_positions(text,uuid,uuid,integer) to authenticated;

revoke all on function private.consume_lot_cost(uuid,bigint),private.restore_lot_cost(uuid,bigint,bigint),
  private.apply_lot_physical(uuid,uuid,uuid,bigint),private.trace_stock_movement_item(),private.initialize_purchase_lot(),
  private.default_purchase_lot_origin()
from public,anon,authenticated,service_role;

comment on table public.stock_movement_lot_allocations is 'Immutable lot and real-cost allocation for each traced stock movement item.';
comment on view public.inventory_lot_positions is 'Current physical lot positions; aggregate reservations remain authoritative at product/location level.';
