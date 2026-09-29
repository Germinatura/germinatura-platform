-- ADR 0010, PAY-004 and PAY-007: finance view of recent Payment Links and provider refund requests, for the
-- Financeiro › Pagamentos online screen. Read-only; every action on them goes through the audited RPCs.
create function public.list_payment_link_activity_admin(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_REQUIRED';
  end if;
  if p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_FILTER';
  end if;
  return jsonb_build_object(
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'charge_id', charge.id, 'sale_id', charge.sale_id, 'order_number', charge.order_number,
        'amount_cents', charge.amount_cents, 'status', charge.status, 'error_code', charge.error_code,
        'paid_transaction_id', charge.paid_transaction_id,
        'checkout_url', charge.checkout_url, 'sale_status', sale.status, 'sale_channel', sale.channel,
        'requested_by_name', coalesce(nullif(btrim(requester.display_name), ''), requester.email),
        'inactivation_pending', charge.inactivation_requested_at is not null and charge.inactivated_at is null,
        'inactivated_at', charge.inactivated_at, 'created_at', charge.created_at, 'updated_at', charge.updated_at
      ) order by charge.created_at desc, charge.id)
      from (select * from public.payment_link_charges order by created_at desc, id limit p_limit) charge
      join public.sales sale on sale.id = charge.sale_id
      join public.profiles requester on requester.id = charge.requested_by
    ), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'refund_id', refund.id, 'transaction_id', refund.transaction_id, 'charge_id', refund.charge_id,
        'sale_id', refund.sale_id, 'amount_cents', refund.amount_cents, 'reason', refund.reason,
        'status', refund.status, 'error_code', refund.error_code,
        'requested_by_name', coalesce(nullif(btrim(requester.display_name), ''), requester.email),
        'created_at', refund.created_at, 'confirmed_at', refund.confirmed_at
      ) order by refund.created_at desc, refund.id)
      from (select * from public.payment_link_refund_requests order by created_at desc, id limit p_limit) refund
      join public.profiles requester on requester.id = refund.requested_by
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.list_payment_link_activity_admin(integer) from public, anon, authenticated, service_role;
grant execute on function public.list_payment_link_activity_admin(integer) to authenticated;
