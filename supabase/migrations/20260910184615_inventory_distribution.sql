create or replace function public.distribute_stock(
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_product_id uuid,
  p_quantity bigint,
  p_reason text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_correlation_id uuid;
begin
  if auth.uid() is null or not public.has_permission('inventory.manage') then
    raise exception using errcode = '42501', message = 'INVENTORY_MANAGE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.stock_locations
    where id = p_from_location_id and active and location_type = 'CENTRAL'
  ) then
    raise exception using errcode = '22023', message = 'DISTRIBUTION_SOURCE_MUST_BE_CENTRAL';
  end if;
  if not exists (
    select 1 from public.stock_locations
    where id = p_to_location_id and active and location_type = 'SELLER'
  ) then
    raise exception using errcode = '22023', message = 'DISTRIBUTION_DESTINATION_MUST_BE_SELLER';
  end if;

  v_result := public.transfer_stock(
    p_from_location_id,
    p_to_location_id,
    p_product_id,
    p_quantity,
    p_reason,
    p_idempotency_key,
    p_correlation_id
  );
  select correlation_id into strict v_correlation_id
  from public.stock_movements
  where id = (v_result ->> 'movement_id')::uuid;
  return v_result || jsonb_build_object('correlation_id', v_correlation_id);
end;
$$;

revoke all on function public.distribute_stock(uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.distribute_stock(uuid, uuid, uuid, bigint, text, text, uuid) to authenticated;

comment on function public.distribute_stock(uuid, uuid, uuid, bigint, text, text, uuid)
is 'Moves available stock from the active central location to an active seller location through the immutable transfer ledger.';
