-- PAY-009a: finance reviews seller shifts (open drawers for cash refunds, closed counts and divergences).
create function public.list_seller_shifts(p_status public.seller_shift_status default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_SHIFT_FILTER';
  end if;
  return coalesce((
    select jsonb_agg(private.seller_shift_summary(page.id) || jsonb_build_object(
        'seller_id', page.seller_id, 'seller_name', page.seller_name, 'location_name', page.location_name)
      order by page.open_first, page.opened_at desc, page.id)
    from (
      select shift.id, shift.seller_id, shift.opened_at, (shift.status <> 'OPEN') as open_first,
        coalesce(nullif(btrim(profile.display_name), ''), profile.email) as seller_name, location.name as location_name
      from public.seller_shifts shift
      join public.profiles profile on profile.id = shift.seller_id
      join public.stock_locations location on location.id = shift.location_id
      where p_status is null or shift.status = p_status
      order by (shift.status <> 'OPEN'), shift.opened_at desc, shift.id
      limit p_limit
    ) page
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_seller_shifts(public.seller_shift_status, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_seller_shifts(public.seller_shift_status, integer) to authenticated;
comment on function public.list_seller_shifts(public.seller_shift_status, integer) is
  'Finance-only review of seller shifts: open drawers first, then the latest closes with their divergence.';
