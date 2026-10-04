-- NOTIF-005 (spec 4.7), revised 01/10/2026: a new product is announced once, when it is active, published and
-- available to buy or reserve for the first time. Availability is the Portal's: positive available stock at the
-- active central location (public.portal_availability). Distribution to seller locations does not count.
-- Publishing with zero stock does not use up the announcement; the first availability afterwards does. Once
-- announced, later restocks follow only the "avise-me" rule (catalog.product.back_in_stock).

-- Positive available central stock for one product (same rule as public.portal_availability).
create function private.product_available_in_catalog(p_product_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.inventory_balances balance
    join public.stock_locations location on location.id = balance.location_id
    where balance.product_id = p_product_id and balance.available_quantity > 0
      and location.location_type = 'CENTRAL' and location.active);
$$;

-- Both triggers serialize on the product before reading the other side, so a publication and a stock entry
-- committed concurrently cannot both miss the announcement; broadcast_notices keeps it to one.
create function private.announce_new_product_if_ready(p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.broadcast_notices where source_type = 'PRODUCT' and source_id = p_product_id) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('new-product-broadcast:' || p_product_id, 0));
  if exists (select 1 from public.products where id = p_product_id and active and published)
    and private.product_available_in_catalog(p_product_id) then
    perform private.queue_broadcast_once('PRODUCT', p_product_id, 'catalog.product.published', 'product');
  end if;
end;
$$;

create or replace function private.emit_product_published()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.active and new.published and (tg_op = 'INSERT' or not (old.active and old.published)) then
    perform private.announce_new_product_if_ready(new.id);
  end if;
  return new;
end;
$$;

create function private.emit_product_first_available()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.available_quantity > 0 and (tg_op = 'INSERT' or old.available_quantity <= 0)
    and exists (select 1 from public.stock_locations where id = new.location_id and location_type = 'CENTRAL' and active) then
    perform private.announce_new_product_if_ready(new.product_id);
  end if;
  return new;
end;
$$;
create trigger inventory_balances_new_product after insert or update of on_hand_quantity, reserved_quantity on public.inventory_balances
for each row execute function private.emit_product_first_available();

revoke all on function private.product_available_in_catalog(uuid) from public, anon, authenticated, service_role;
revoke all on function private.announce_new_product_if_ready(uuid) from public, anon, authenticated, service_role;
revoke all on function private.emit_product_first_available() from public, anon, authenticated, service_role;
