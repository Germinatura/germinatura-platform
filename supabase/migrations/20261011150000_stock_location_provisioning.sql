-- INV-002 (go-live gap found on 01/10/2026): no migration created the central stock location or a seller's own
-- location; they existed only in the local seed. A greenfield production would have nowhere to receive,
-- distribute or sell stock. The central location now comes with the schema, and granting the seller role
-- provisions the seller's location (reactivating it if it exists). Revoking the role keeps the location and its
-- history; access is still decided by roles and permissions.

insert into public.stock_locations (location_type, name)
select 'CENTRAL', 'Estoque central'
where not exists (select 1 from public.stock_locations where location_type = 'CENTRAL');

create function private.ensure_seller_location(p_seller_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_location_id uuid;
  v_name text;
begin
  select id into v_location_id from public.stock_locations where seller_id = p_seller_id for update;
  if found then
    update public.stock_locations set active = true, updated_at = now() where id = v_location_id and not active;
    return v_location_id;
  end if;
  select left('Estoque de ' || coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1)), 120) into v_name
  from public.profiles where id = p_seller_id;
  insert into public.stock_locations (location_type, name, seller_id)
  values ('SELLER', btrim(coalesce(v_name, 'Estoque do vendedor')), p_seller_id)
  on conflict (seller_id) do nothing
  returning id into v_location_id;
  if v_location_id is null then
    select id into v_location_id from public.stock_locations where seller_id = p_seller_id;
  end if;
  return v_location_id;
end;
$$;

create function private.provision_seller_location()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.roles where id = new.role_id and key = 'VENDEDOR') then
    perform private.ensure_seller_location(new.user_id);
  end if;
  return new;
end;
$$;
create trigger user_roles_seller_location after insert on public.user_roles
for each row execute function private.provision_seller_location();

-- Sellers already granted before this migration.
select private.ensure_seller_location(user_role.user_id)
from public.user_roles user_role
join public.roles role on role.id = user_role.role_id and role.key = 'VENDEDOR'
where not exists (select 1 from public.stock_locations location where location.seller_id = user_role.user_id);

revoke all on function private.ensure_seller_location(uuid) from public, anon, authenticated, service_role;
revoke all on function private.provision_seller_location() from public, anon, authenticated, service_role;
