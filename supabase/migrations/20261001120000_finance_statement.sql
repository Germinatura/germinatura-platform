-- Spec 5.8 (FIN-006): consolidated statement that classifies automatic entries (sales, fees, settlements,
-- refunds, supplier payments) and manual entries on the same categories and treasury accounts.
-- It is a read model over the immutable ledgers; nothing is stored or rewritten.

create function private.finance_statement_rows(p_from date, p_to date)
returns table (
  occurred_on date, source text, source_id uuid, category public.finance_category, account public.finance_account,
  amount_cents bigint, description text, reference text
)
language sql stable security definer set search_path = '' as $$
  with sale_ledger as (
    select entry.*, (entry.created_at at time zone 'America/Sao_Paulo')::date as day,
      case
        when exists (select 1 from public.raffle_numbers number where number.sale_id = entry.sale_id) then 'RIFA'
        when sale.channel = 'PDV' then 'VENDA_PDV'
        when sale.channel = 'PORTAL' then 'VENDA_ONLINE'
        else 'RESERVA'
      end::public.finance_category as revenue_category,
      attempt.integration_channel,
      exists (select 1 from public.financial_ledger_entries settled
        where settled.payment_attempt_id = entry.payment_attempt_id and settled.entry_type = 'SETTLEMENT') as settled
    from public.financial_ledger_entries entry
    join public.sales sale on sale.id = entry.sale_id
    join public.payment_attempts attempt on attempt.id = entry.payment_attempt_id
    where entry.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
      and entry.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  )
  -- Revenue lands where the money is: PicPay receivables or the physical cash drawer.
  select day, 'SALE', id, revenue_category,
    case when entry_type = 'CASH_RECEIPT' then 'DINHEIRO_FISICO' else 'RECEBIVEIS_PICPAY' end::public.finance_account,
    amount_cents, case when entry_type = 'CASH_RECEIPT' then 'Venda recebida em dinheiro' else 'Venda a receber no PicPay' end,
    sale_id::text
  from sale_ledger where entry_type in ('RECEIVABLE_PICPAY', 'CASH_RECEIPT')
  union all
  select day, 'SALE', id, 'TAXAS', 'RECEBIVEIS_PICPAY', amount_cents, 'Taxa do meio de pagamento', sale_id::text
  from sale_ledger where entry_type = 'FEE'
  union all
  select day, 'SALE', id, 'AJUSTE', 'RECEBIVEIS_PICPAY', amount_cents, 'Divergência de conciliação', sale_id::text
  from sale_ledger where entry_type = 'DIVERGENCE'
  union all
  -- A settlement is a treasury transfer: it leaves the receivables and reaches the PicPay account.
  select day, 'SALE', id, null, 'RECEBIVEIS_PICPAY', -amount_cents, 'Liquidação de recebível', sale_id::text
  from sale_ledger where entry_type = 'SETTLEMENT'
  union all
  select day, 'SALE', id, null, 'PICPAY_EMPRESAS', amount_cents, 'Liquidação de recebível', sale_id::text
  from sale_ledger where entry_type = 'SETTLEMENT'
  union all
  select day, 'SALE', id, 'REEMBOLSO',
    case
      when metadata ->> 'refund_method' = 'CASH_DRAWER' then 'DINHEIRO_FISICO'
      when settled or integration_channel = 'DINHEIRO' then 'PICPAY_EMPRESAS'
      else 'RECEBIVEIS_PICPAY'
    end::public.finance_account,
    amount_cents, 'Estorno de venda', sale_id::text
  from sale_ledger where entry_type = 'REFUND'
  union all
  select settlement.effective_on, 'PAYABLE', settlement.id, 'FORNECEDOR',
    case when settlement.payment_method ilike '%dinheiro%' then 'DINHEIRO_FISICO' else 'PICPAY_EMPRESAS' end::public.finance_account,
    case when settlement.entry_type = 'SETTLEMENT' then -settlement.amount_cents else settlement.amount_cents end,
    case when settlement.entry_type = 'SETTLEMENT' then 'Pagamento a fornecedor' else 'Reversão de pagamento a fornecedor' end,
    settlement.reference
  from public.purchase_payable_settlements settlement
  where settlement.effective_on between p_from and p_to
  union all
  select entry.occurred_on, 'MANUAL', entry.id, entry.category, effect.account,
    case when entry.kind = 'REVERSAL' then -effect.amount_cents else effect.amount_cents end,
    entry.description, entry.reference
  from public.finance_manual_entries entry
  left join public.finance_manual_entries original on original.id = entry.reversal_of
  cross join lateral private.finance_manual_entry_effects(case when entry.kind = 'REVERSAL' then original else entry end) effect
  where entry.occurred_on between p_from and p_to;
$$;

create function public.finance_statement(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE_FILTER';
  end if;
  return (
    with statement as (select * from private.finance_statement_rows(p_from, p_to))
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'occurred_on', row.occurred_on, 'source', row.source, 'source_id', row.source_id, 'category', row.category,
          'account', row.account, 'amount_cents', row.amount_cents, 'description', row.description, 'reference', row.reference)
        order by row.occurred_on, row.source, row.source_id, row.account) from statement row), '[]'::jsonb),
      'totals', jsonb_build_object(
        -- Transfers (no category) move money between accounts and are neither inflow nor outflow.
        'inflow_cents', coalesce((select sum(amount_cents) from statement where category is not null and amount_cents > 0), 0),
        'outflow_cents', coalesce((select -sum(amount_cents) from statement where category is not null and amount_cents < 0), 0),
        'by_account', coalesce((select jsonb_object_agg(account, total) from (
          select account, sum(amount_cents) as total from statement group by account) grouped), '{}'::jsonb),
        'by_category', coalesce((select jsonb_object_agg(category, total) from (
          select category, sum(amount_cents) as total from statement where category is not null group by category) grouped), '{}'::jsonb)))
  );
end;
$$;

revoke all on function private.finance_statement_rows(date, date) from public, anon, authenticated, service_role;
revoke all on function public.finance_statement(date, date) from public, anon, authenticated, service_role;
grant execute on function public.finance_statement(date, date) to authenticated;
comment on function public.finance_statement(date, date) is
  'Consolidated São Paulo period statement of automatic and manual entries by category and treasury account.';

-- Treasury transfers move money between accounts; like the statement, they are neither inflow nor outflow.
create or replace function public.list_finance_entries(
  p_from date, p_to date, p_category public.finance_category default null, p_account public.finance_account default null,
  p_cursor uuid default null, p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cursor public.finance_manual_entries%rowtype;
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE_FILTER';
  end if;
  if p_cursor is not null then
    select * into v_cursor from public.finance_manual_entries where id = p_cursor;
    if not found then
      raise exception using errcode = '22023', message = 'INVALID_FINANCE_CURSOR';
    end if;
  end if;
  select array_agg(page.id order by page.occurred_on desc, page.created_at desc, page.id desc) into v_ids from (
    select entry.id, entry.occurred_on, entry.created_at from public.finance_manual_entries entry
    where entry.occurred_on between p_from and p_to
      and (p_category is null or entry.category = p_category)
      and (p_account is null or entry.account = p_account or entry.counter_account = p_account)
      and (p_cursor is null or (entry.occurred_on, entry.created_at, entry.id) < (v_cursor.occurred_on, v_cursor.created_at, v_cursor.id))
    order by entry.occurred_on desc, entry.created_at desc, entry.id desc
    limit p_limit + 1
  ) page;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.finance_manual_entry_json(id) order by ordinality)
      from unnest(v_ids) with ordinality id where ordinality <= p_limit), '[]'::jsonb),
    'next_cursor', case when coalesce(array_length(v_ids, 1), 0) > p_limit then v_ids[p_limit] end,
    'totals', (
      with effects as (
        select effect.account, entry.category,
          case when entry.kind = 'REVERSAL' then -effect.amount_cents else effect.amount_cents end as amount_cents
        from public.finance_manual_entries entry
        left join public.finance_manual_entries original on original.id = entry.reversal_of
        cross join lateral private.finance_manual_entry_effects(
          case when entry.kind = 'REVERSAL' then original else entry end) effect
        where entry.occurred_on between p_from and p_to
          and (p_category is null or entry.category = p_category)
          and (p_account is null or effect.account = p_account)
      )
      select jsonb_build_object(
        'inflow_cents', coalesce(sum(amount_cents) filter (where category is not null and amount_cents > 0), 0),
        'outflow_cents', coalesce(-sum(amount_cents) filter (where category is not null and amount_cents < 0), 0),
        'by_account', coalesce((select jsonb_object_agg(account, total) from (
          select account, sum(amount_cents) as total from effects group by account) grouped), '{}'::jsonb),
        'by_category', coalesce((select jsonb_object_agg(category, total) from (
          select category, sum(amount_cents) as total from effects where category is not null group by category) grouped), '{}'::jsonb))
      from effects));
end;
$$;
