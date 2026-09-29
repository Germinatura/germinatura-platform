-- RES-004: Portal reservations are held at the single active central location; customers never pick
-- (nor can read) stock locations. The schema already allows only one active central location.
create function public.default_reservation_location()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_permission('reservations.manage.own') then
    raise exception using errcode = '42501', message = 'COMMERCIAL_RESERVATION_FORBIDDEN';
  end if;
  select array_agg(id) into v_ids from public.stock_locations where active and location_type = 'CENTRAL';
  if coalesce(array_length(v_ids, 1), 0) <> 1 then
    raise exception using errcode = 'P0001', message = 'RESERVATION_LOCATION_UNAVAILABLE';
  end if;
  return v_ids[1];
end;
$$;
revoke all on function public.default_reservation_location() from public, anon, authenticated, service_role;
grant execute on function public.default_reservation_location() to authenticated;
comment on function public.default_reservation_location() is 'The single active central location where Portal reservations are held.';
