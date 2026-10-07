-- Spec 5.8 (FIN-002, FIN-006): the treasury balance of each account, from one authority.
--
-- private.finance_account_balances(p_as_of) is the only place where a balance is computed:
--   opening position + inflows − outflows + transfers received − transfers sent
-- over the same rows as the consolidated statement, from the opening day (start of day, São Paulo) to p_as_of.
-- Rows dated before the opening day are already inside the opening position and are not added again.
-- Every screen, API and report reads balances through it; none recomputes them.
--
-- The statement gains the opening rows (source OPENING, no category: never inflow, outflow, result or goal) and
-- names the nature of every row: RECEITA, DESPESA, TRANSFERENCIA_INTERNA, CONCILIACAO, ESTORNO or SALDO_ABERTURA.

-- Same rows as before, plus the opening position of the current version.
create or replace function private.finance_statement_rows(p_from date, p_to date)
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
  ),
  imported as (
    select line.id, line.occurred_on, line.movement, line.movement_label, line.amount_cents, import.number, line.line_number,
      current.resolution, current.category, current.counter_account
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where current.resolution in ('TRANSFERENCIA', 'CLASSIFICADA') and line.occurred_on between p_from and p_to
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
  where entry.occurred_on between p_from and p_to
  union all
  -- Imported lines name the movement, never the counterparty. Historical revenue keeps its bank origin.
  select occurred_on, 'IMPORT', id, category, 'PICPAY_EMPRESAS', amount_cents,
    case
      when movement = 'COFRINHO_GUARDADO' then 'Dinheiro guardado no Cofrinho'
      when movement = 'COFRINHO_RESGATADO' then 'Dinheiro resgatado do Cofrinho'
      when movement = 'RECEBIVEIS_VENDA' and resolution = 'CLASSIFICADA' then 'Recebíveis de venda (histórico do cutover)'
      when movement = 'RECEBIVEIS_VENDA' then 'Recebíveis de venda liquidados'
      when category = 'RECEITA_HISTORICA' then 'Extrato PicPay: ' || movement_label || ' (histórico do cutover)'
      else 'Extrato PicPay: ' || movement_label
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported
  union all
  select occurred_on, 'IMPORT', id, null, counter_account, -amount_cents,
    case movement
      when 'COFRINHO_GUARDADO' then 'Dinheiro guardado no Cofrinho'
      when 'COFRINHO_RESGATADO' then 'Dinheiro resgatado do Cofrinho'
      else 'Recebíveis de venda liquidados'
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported where resolution = 'TRANSFERENCIA'
  union all
  -- The opening position: money that already existed, never inflow or outflow.
  select position.as_of, 'OPENING', position.id, null, line.account, line.amount_cents, 'Saldo de abertura',
    'ABERTURA-V' || position.version
  from private.current_finance_opening_position() position
  join public.finance_opening_position_lines line on line.position_id = position.id
  where position.as_of between p_from and p_to and line.amount_cents <> 0;
$$;

-- The nature of a statement row, for people: what kind of money movement it is.
create function private.finance_statement_row_nature(
  p_source text, p_source_id uuid, p_category public.finance_category, p_amount_cents bigint
)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_source = 'OPENING' then 'SALDO_ABERTURA'
    when p_category is null and p_source = 'SALE' then 'CONCILIACAO'
    when p_category is null then 'TRANSFERENCIA_INTERNA'
    when p_category = 'REEMBOLSO' then 'ESTORNO'
    when p_source = 'PAYABLE' and p_amount_cents > 0 then 'ESTORNO'
    when p_source = 'MANUAL' and exists (select 1 from public.finance_manual_entries entry
      where entry.id = p_source_id and entry.kind = 'REVERSAL') then 'ESTORNO'
    when p_source = 'IMPORT' and exists (select 1 from public.picpay_statement_lines line
      where line.id = p_source_id and line.movement in ('PIX_ESTORNADO', 'PIX_DEVOLVIDO')) then 'ESTORNO'
    when p_amount_cents > 0 then 'RECEITA'
    else 'DESPESA'
  end;
$$;

create or replace function public.finance_statement(p_from date, p_to date)
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
          'account', row.account, 'amount_cents', row.amount_cents, 'description', row.description, 'reference', row.reference,
          'nature', private.finance_statement_row_nature(row.source, row.source_id, row.category, row.amount_cents))
        order by row.occurred_on, row.source, row.source_id, row.account) from statement row), '[]'::jsonb),
      'totals', jsonb_build_object(
        -- Transfers and the opening position (no category) are neither inflow nor outflow.
        'inflow_cents', coalesce((select sum(amount_cents) from statement where category is not null and amount_cents > 0), 0),
        'outflow_cents', coalesce((select -sum(amount_cents) from statement where category is not null and amount_cents < 0), 0),
        -- Movement of the period by account; the opening position is reported apart.
        'by_account', coalesce((select jsonb_object_agg(account, total) from (
          select account, sum(amount_cents) as total from statement where source <> 'OPENING' group by account) grouped), '{}'::jsonb),
        'opening_by_account', coalesce((select jsonb_object_agg(account, total) from (
          select account, sum(amount_cents) as total from statement where source = 'OPENING' group by account) grouped), '{}'::jsonb),
        'by_category', coalesce((select jsonb_object_agg(category, total) from (
          select category, sum(amount_cents) as total from statement where category is not null group by category) grouped), '{}'::jsonb)))
  );
end;
$$;

-- The single authority for balances. Accounts without movement come back with zero.
create function private.finance_account_balances(p_as_of date)
returns table (
  account public.finance_account, opening_cents bigint, inflow_cents bigint, outflow_cents bigint,
  transfer_in_cents bigint, transfer_out_cents bigint, balance_cents bigint
)
language sql stable security definer set search_path = '' as $$
  with bounds as (
    select coalesce((select as_of from private.current_finance_opening_position()), date '2020-01-01') as start_on
  ),
  statement as (
    select row.* from bounds
    cross join lateral private.finance_statement_rows(bounds.start_on, p_as_of) row
    where p_as_of >= bounds.start_on
  ),
  sums as (
    select statement.account,
      coalesce(sum(amount_cents) filter (where source = 'OPENING'), 0)::bigint as opening_cents,
      coalesce(sum(amount_cents) filter (where source <> 'OPENING' and category is not null and amount_cents > 0), 0)::bigint as inflow_cents,
      coalesce(-sum(amount_cents) filter (where source <> 'OPENING' and category is not null and amount_cents < 0), 0)::bigint as outflow_cents,
      coalesce(sum(amount_cents) filter (where source <> 'OPENING' and category is null and amount_cents > 0), 0)::bigint as transfer_in_cents,
      coalesce(-sum(amount_cents) filter (where source <> 'OPENING' and category is null and amount_cents < 0), 0)::bigint as transfer_out_cents
    from statement group by statement.account
  )
  select known.value, coalesce(sums.opening_cents, 0), coalesce(sums.inflow_cents, 0), coalesce(sums.outflow_cents, 0),
    coalesce(sums.transfer_in_cents, 0), coalesce(sums.transfer_out_cents, 0),
    coalesce(sums.opening_cents + sums.inflow_cents - sums.outflow_cents + sums.transfer_in_cents - sums.transfer_out_cents, 0)
  from unnest(enum_range(null::public.finance_account)) known(value)
  left join sums on sums.account = known.value
  order by known.value;
$$;

-- Imported statement lines up to p_as_of that carry no effect of their own, so a difference can be explained.
create function private.finance_statement_unapplied(p_as_of date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with bounds as (
    select coalesce((select as_of from private.current_finance_opening_position()), date '2020-01-01') as start_on
  ),
  lines as (
    select line.amount_cents,
      case
        when current.resolution is null or current.resolution = 'REABERTA' then 'pending'
        when current.resolution = 'JA_REGISTRADO' then 'already_recorded'
        when current.resolution = 'VINCULADA' then 'linked'
      end as kind
    from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    cross join bounds
    where line.occurred_on between bounds.start_on and p_as_of
  )
  select jsonb_build_object(
    'pending', jsonb_build_object('count', count(*) filter (where kind = 'pending'),
      'net_cents', coalesce(sum(amount_cents) filter (where kind = 'pending'), 0)),
    'already_recorded', jsonb_build_object('count', count(*) filter (where kind = 'already_recorded'),
      'net_cents', coalesce(sum(amount_cents) filter (where kind = 'already_recorded'), 0)),
    'linked', jsonb_build_object('count', count(*) filter (where kind = 'linked'),
      'net_cents', coalesce(sum(amount_cents) filter (where kind = 'linked'), 0)))
  from lines;
$$;

-- Balances for finance: every account, the free (PicPay Empresas), Cofrinho, available (free + Cofrinho),
-- receivables and physical cash figures. Receivables and cash are never part of the available balance.
create function public.finance_balances(p_as_of date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'America/Sao_Paulo')::date);
  v_position public.finance_opening_positions%rowtype;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  select * into v_position from private.current_finance_opening_position();
  if v_as_of > (now() at time zone 'America/Sao_Paulo')::date or (v_position.id is not null and v_as_of < v_position.as_of) then
    raise exception using errcode = '22023', message = 'INVALID_BALANCE_DATE';
  end if;
  return (
    with balances as (select * from private.finance_account_balances(v_as_of))
    select jsonb_build_object(
      'as_of', v_as_of,
      'opening', case when v_position.id is null then null else jsonb_build_object('id', v_position.id, 'version', v_position.version,
        'as_of', v_position.as_of, 'operating_since', v_position.operating_since) end,
      'accounts', (select jsonb_agg(jsonb_build_object('account', account, 'opening_cents', opening_cents, 'inflow_cents', inflow_cents,
          'outflow_cents', outflow_cents, 'transfer_in_cents', transfer_in_cents, 'transfer_out_cents', transfer_out_cents,
          'balance_cents', balance_cents) order by account) from balances),
      'free_balance_cents', (select balance_cents from balances where account = 'PICPAY_EMPRESAS'),
      'vault_balance_cents', (select balance_cents from balances where account = 'COFRINHO_PICPAY'),
      'available_balance_cents', (select sum(balance_cents) from balances where account in ('PICPAY_EMPRESAS', 'COFRINHO_PICPAY')),
      'receivables_balance_cents', (select balance_cents from balances where account = 'RECEBIVEIS_PICPAY'),
      'cash_balance_cents', (select balance_cents from balances where account = 'DINHEIRO_FISICO'),
      'negative_accounts', coalesce((select jsonb_agg(account order by account) from balances where balance_cents < 0), '[]'::jsonb),
      'statement_lines', private.finance_statement_unapplied(v_as_of))
  );
end;
$$;

revoke all on function private.finance_statement_row_nature(text, uuid, public.finance_category, bigint) from public, anon, authenticated, service_role;
revoke all on function private.finance_account_balances(date) from public, anon, authenticated, service_role;
revoke all on function private.finance_statement_unapplied(date) from public, anon, authenticated, service_role;
revoke all on function public.finance_balances(date) from public, anon, authenticated, service_role;
grant execute on function public.finance_balances(date) to authenticated;

comment on function private.finance_account_balances(date) is
  'Single authority for treasury balances: opening + inflows − outflows + transfers in − transfers out, by account.';
comment on function public.finance_balances(date) is
  'Treasury balances at a São Paulo day: free, Cofrinho, available (free + Cofrinho), receivables and physical cash.';
