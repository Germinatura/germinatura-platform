create or replace function public.list_managed_seller_closeouts(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.has_permission('closeouts.manage') then
    raise exception using errcode = '42501', message = 'CLOSEOUT_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_LIMIT';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(item) order by item.created_at desc, item.id desc)
    from (
      select
        closeout.id,
        closeout.seller_id,
        profile.display_name as seller_name,
        profile.email as seller_email,
        closeout.location_id,
        location.name as location_name,
        closeout.period_start,
        closeout.period_end,
        closeout.status,
        closeout.confirmed_sales_count,
        closeout.confirmed_sales_total_cents,
        closeout.payment_count,
        closeout.payment_total_cents,
        closeout.payment_difference_cents,
        closeout.stock_difference_units,
        closeout.justification,
        closeout.created_at,
        closeout.reopened_at,
        closeout.reopen_reason
      from public.seller_closeouts closeout
      join public.profiles profile on profile.id = closeout.seller_id
      join public.stock_locations location on location.id = closeout.location_id
      order by closeout.created_at desc, closeout.id desc
      limit p_limit
    ) item
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_managed_seller_closeouts(integer)
from public, anon, authenticated, service_role;
grant execute on function public.list_managed_seller_closeouts(integer) to authenticated;

comment on function public.list_managed_seller_closeouts(integer) is
  'Returns recent immutable closeout summaries with operational labels to closeout managers only.';
