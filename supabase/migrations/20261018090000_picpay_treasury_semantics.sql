-- Spec 5.8 (FIN-002, FIN-003, FIN-007): treasury is separate from classification. Functions only: no row is inserted,
-- updated or deleted; balances change only because they are derived differently.
--
-- 1. Treasury. A canonical PicPay statement line moves the PicPay Empresas account exactly once, from the moment it is
--    imported, even before anyone classifies it. Pending lines (no decision, or reopened) now produce a row of their own,
--    source IMPORT_PENDING, without category: it counts in the balance and in the cash flow, never in revenue, expense or
--    result. Classifying the line swaps that row for the classified one with the same amount, so the balance does not
--    move. Lines whose money is carried by another record (linked to a supplier payment or a manual entry, marked as
--    already recorded, reconciled with a sale or a refund) keep producing no row of their own: never counted twice.
-- 2. Pending items. An unclassified statement line (EXTRATO_NAO_CLASSIFICADO) is resolved only by reviewing the line.
--    Earlier manual decisions stay in picpay_exception_resolutions as audit history but no longer hide the line, and
--    resolve_picpay_exception refuses that type.
-- 3. Period status. CONCILIADO needs no open item and no statement line awaiting review in the period. The summary also
--    reports what is open outside the period, so the screen can show it; period evaluation uses the same summary.

-- Treasury rows: every pending statement line moves the PicPay Empresas account once.
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
    where current.resolution in ('TRANSFERENCIA', 'CLASSIFICADA', 'CONCILIADA_PICPAY') and line.occurred_on between p_from and p_to
  ),
  -- Lines nobody decided yet (or reopened): the money already moved in the bank, the reason is still unknown.
  pending as (
    select line.id, line.occurred_on, line.movement_label, line.amount_cents, import.number, line.line_number
    from public.picpay_statement_lines line
    join public.picpay_statement_imports import on import.id = line.import_id
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where (current.id is null or current.resolution = 'REABERTA') and line.occurred_on between p_from and p_to
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
      when resolution = 'CONCILIADA_PICPAY' and movement = 'PIX_RECEBIDO' then 'Pix recebido conciliado com Minhas vendas'
      when resolution = 'CONCILIADA_PICPAY' then 'Estorno de Pix conciliado com Minhas vendas'
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
      when 'PIX_RECEBIDO' then 'Pix recebido conciliado com Minhas vendas'
      when 'PIX_ESTORNADO' then 'Estorno de Pix conciliado com Minhas vendas'
      else 'Recebíveis de venda liquidados'
    end,
    'PICPAY-CSV-' || number || '-L' || line_number
  from imported where resolution in ('TRANSFERENCIA', 'CONCILIADA_PICPAY')
  union all
  -- Treasury before classification: the PicPay account moves now; revenue and expense wait for the classification.
  select occurred_on, 'IMPORT_PENDING', id, null, 'PICPAY_EMPRESAS', amount_cents,
    'Extrato PicPay: ' || movement_label || ' (a classificar)', 'PICPAY-CSV-' || number || '-L' || line_number
  from pending
  union all
  -- The opening position: money that already existed, never inflow or outflow.
  select position.as_of, 'OPENING', position.id, null, line.account, line.amount_cents, 'Saldo de abertura',
    'ABERTURA-V' || position.version
  from private.current_finance_opening_position() position
  join public.finance_opening_position_lines line on line.position_id = position.id
  where position.as_of between p_from and p_to and line.amount_cents <> 0
  union all
  -- Acquirer evidence (Minhas vendas): historical revenue, real PicPay fees and historical refunds.
  select effect.occurred_on, 'PICPAY', effect.source_id, effect.category, effect.account, effect.amount_cents, effect.description, effect.reference
  from private.picpay_acquirer_effects(p_from, p_to) effect;
$$;
create or replace function private.finance_statement_row_nature(
  p_source text, p_source_id uuid, p_category public.finance_category, p_amount_cents bigint
)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_source = 'OPENING' then 'SALDO_ABERTURA'
    when p_source = 'IMPORT_PENDING' then 'A_CLASSIFICAR'
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
create or replace function private.finance_account_balances(p_as_of date)
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
      coalesce(sum(amount_cents) filter (where source <> 'OPENING' and (category is not null or source = 'IMPORT_PENDING') and amount_cents > 0), 0)::bigint as inflow_cents,
      coalesce(-sum(amount_cents) filter (where source <> 'OPENING' and (category is not null or source = 'IMPORT_PENDING') and amount_cents < 0), 0)::bigint as outflow_cents,
      coalesce(sum(amount_cents) filter (where source not in ('OPENING', 'IMPORT_PENDING') and category is null and amount_cents > 0), 0)::bigint as transfer_in_cents,
      coalesce(-sum(amount_cents) filter (where source not in ('OPENING', 'IMPORT_PENDING') and category is null and amount_cents < 0), 0)::bigint as transfer_out_cents
    from statement group by statement.account
  )
  select known.value, coalesce(sums.opening_cents, 0), coalesce(sums.inflow_cents, 0), coalesce(sums.outflow_cents, 0),
    coalesce(sums.transfer_in_cents, 0), coalesce(sums.transfer_out_cents, 0),
    coalesce(sums.opening_cents + sums.inflow_cents - sums.outflow_cents + sums.transfer_in_cents - sums.transfer_out_cents, 0)
  from unnest(enum_range(null::public.finance_account)) known(value)
  left join sums on sums.account = known.value
  order by known.value;
$$;
-- The statement lines without a classification of their own, for the balance screen and the balance check. The shape
-- is unchanged: 'pending' lines are already in the balance (awaiting classification); 'linked' and 'already_recorded'
-- lines are carried by another record.
create or replace function private.finance_statement_unapplied(p_as_of date)
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
        'inflow_cents', coalesce((select sum(amount_cents) from statement where (category is not null or source = 'IMPORT_PENDING') and amount_cents > 0), 0),
        'outflow_cents', coalesce((select -sum(amount_cents) from statement where (category is not null or source = 'IMPORT_PENDING') and amount_cents < 0), 0),
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
create or replace function private.compute_management_indicators(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_days integer;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using errcode = '22023', message = 'INVALID_INDICATORS_PERIOD';
  end if;
  v_start := p_from::timestamp at time zone 'America/Sao_Paulo';
  v_end := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';
  v_days := p_to - p_from + 1;

  return (
    with statement as (
      select * from private.finance_statement_rows(p_from, p_to)
    ),
    raffle_sales as (
      select distinct sale_id from public.raffle_numbers where sale_id is not null
      union
      select sale_id from public.raffle_sale_refunds
    ),
    sale_entries as (
      select entry.sale_id, entry.entry_type, entry.amount_cents,
        (entry.created_at at time zone 'America/Sao_Paulo')::date as day,
        coalesce(attempt.card_method::text, attempt.integration_channel::text) as method
      from public.financial_ledger_entries entry
      join public.payment_attempts attempt on attempt.id = entry.payment_attempt_id
      where entry.created_at >= v_start and entry.created_at < v_end
    ),
    receipts as (
      select * from sale_entries where entry_type in ('RECEIVABLE_PICPAY', 'CASH_RECEIPT')
    ),
    refunds as (
      select * from sale_entries where entry_type = 'REFUND'
    ),
    manual as (
      select coalesce(original.kind, entry.kind) as kind, coalesce(original.category, entry.category) as category,
        case when entry.kind = 'REVERSAL' then -entry.amount_cents else entry.amount_cents end as amount_cents,
        entry.occurred_on as day
      from public.finance_manual_entries entry
      left join public.finance_manual_entries original on original.id = entry.reversal_of
      where entry.occurred_on between p_from and p_to
        and coalesce(original.kind, entry.kind) in ('INCOME', 'EXPENSE')
      union all
      -- Classified lines of imported PicPay statements count like manual income and expense.
      select flow.kind, flow.category, flow.amount_cents, flow.day from private.picpay_statement_flows(p_from, p_to) flow
    ),
    -- Lot cost of the goods leaving through sales, and the cost a reversal brought back.
    cost_lines as (
      select item.product_id, (movement.created_at at time zone 'America/Sao_Paulo')::date as day,
        case when movement.movement_type = 'VENDA' then 1 else -1 end as direction,
        allocation.quantity, allocation.allocated_cost_cents
      from public.stock_movements movement
      join public.stock_movement_items item on item.movement_id = movement.id
      join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
      where movement.created_at >= v_start and movement.created_at < v_end
        and ((movement.movement_type = 'VENDA' and movement.source_type = 'sale')
          or (movement.movement_type = 'CANCELAMENTO_VENDA' and movement.source_type = 'sale_reversal'))
    ),
    losses as (
      select report.product_id, product.name as product_name, report.reason::text as reason, report.location_id,
        location.name as location_name, report.quantity,
        (select sum(allocation.allocated_cost_cents) from public.stock_movement_items item
          join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
          where item.movement_id = report.movement_id) as cost_cents,
        (select coalesce(sum(allocation.quantity) filter (where allocation.allocated_cost_cents is null), 0) from public.stock_movement_items item
          join public.stock_movement_lot_allocations allocation on allocation.movement_item_id = item.id
          where item.movement_id = report.movement_id) as unknown_units,
        (report.decided_at at time zone 'America/Sao_Paulo')::date as day
      from public.stock_loss_reports report
      join public.products product on product.id = report.product_id
      join public.stock_locations location on location.id = report.location_id
      where report.status = 'APPLIED' and report.decided_at >= v_start and report.decided_at < v_end
    ),
    figures as (
      select
        coalesce((select sum(amount_cents) from statement where source = 'SALE' and amount_cents > 0
          and category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')), 0) as sale_revenue,
        coalesce((select sum(amount_cents) from manual where kind = 'INCOME'), 0) as manual_income,
        coalesce((select sum(amount_cents) from statement where source = 'PICPAY' and category = 'RECEITA_HISTORICA'), 0) as picpay_revenue,
        coalesce((select -sum(amount_cents) from statement where source in ('SALE', 'PICPAY') and category = 'REEMBOLSO'), 0) as refunds,
        coalesce((select -sum(amount_cents) from statement where category = 'TAXAS'), 0) as fees,
        coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'AJUSTE'), 0) as divergences,
        coalesce((select sum(amount_cents) from manual where kind = 'EXPENSE' and category <> 'TAXAS'), 0) as expenses,
        coalesce((select -sum(amount_cents) from statement where source = 'PAYABLE'), 0) as supplier_payments,
        coalesce((select sum(amount_cents) from statement where category is not null or source = 'IMPORT_PENDING'), 0) as cash_balance,
        coalesce((select sum(direction * allocated_cost_cents) from cost_lines where allocated_cost_cents is not null), 0) as cogs,
        coalesce((select sum(direction * quantity) from cost_lines where allocated_cost_cents is null), 0) as cogs_unknown_units,
        coalesce((select sum(cost_cents) from losses), 0) as losses_cost,
        coalesce((select sum(quantity) from losses), 0) as losses_units,
        coalesce((select sum(unknown_units) from losses), 0) as losses_unknown_units,
        (select count(distinct sale_id) from receipts) as sales_count,
        (select count(distinct sale_id) from refunds) as refunded_sales
    ),
    totals as (
      select figures.*, sale_revenue + manual_income + picpay_revenue as gross_revenue,
        sale_revenue + manual_income + picpay_revenue - refunds - fees + divergences as net_revenue
      from figures
    ),
    product_lines as (
      select item.product_id, item.product_name, item.quantity, item.total_cents
      from (select distinct sale_id from receipts) sold join public.sale_items item on item.sale_id = sold.sale_id
      where sold.sale_id not in (select sale_id from raffle_sales)
      union all
      select item.product_id, item.product_name, -item.quantity, -item.total_cents
      from (select distinct sale_id from refunds) returned join public.sale_items item on item.sale_id = returned.sale_id
      where returned.sale_id not in (select sale_id from raffle_sales)
    ),
    products as (
      select lines.product_id, max(lines.product_name) as product_name, sum(lines.quantity) as units, sum(lines.total_cents) as revenue_cents,
        (select sum(direction * allocated_cost_cents) from cost_lines cost where cost.product_id = lines.product_id and cost.allocated_cost_cents is not null) as cost_cents,
        (select coalesce(sum(direction * quantity), 0) from cost_lines cost where cost.product_id = lines.product_id and cost.allocated_cost_cents is null) as unknown_units
      from product_lines lines group by lines.product_id
    ),
    seller_sales as (
      select sale.created_by, sale.id, sale.total_cents, 1 as direction
      from (select distinct sale_id from receipts) sold join public.sales sale on sale.id = sold.sale_id
      where sale.channel in ('PDV', 'RESERVA')
      union all
      select sale.created_by, sale.id, sale.total_cents, -1
      from (select distinct sale_id from refunds) returned join public.sales sale on sale.id = returned.sale_id
      where sale.channel in ('PDV', 'RESERVA')
    ),
    sellers as (
      select seller.id as seller_id, coalesce(nullif(btrim(seller.display_name), ''), split_part(seller.email, '@', 1)) as seller_name,
        sum(direction * total_cents) as revenue_cents,
        count(*) filter (where direction = 1) as sales_count,
        count(*) filter (where direction = -1) as refunded_count,
        (select coalesce(sum(direction * item.quantity), 0) from seller_sales inner_sale join public.sale_items item on item.sale_id = inner_sale.id
          where inner_sale.created_by = seller.id) as units
      from seller_sales join public.profiles seller on seller.id = seller_sales.created_by
      group by seller.id, seller.display_name, seller.email
    ),
    days as (
      select generate_series(p_from, p_to, interval '1 day')::date as day
    ),
    daily as (
      select days.day,
        coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day and row.source = 'SALE' and row.amount_cents > 0
          and row.category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')), 0)
          + coalesce((select sum(amount_cents) from manual where manual.day = days.day and manual.kind = 'INCOME'), 0)
          + coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day and row.source = 'PICPAY'
            and row.category = 'RECEITA_HISTORICA'), 0) as revenue_cents,
        coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day
          and (row.category = 'TAXAS' or (row.source in ('SALE', 'PICPAY') and row.category in ('REEMBOLSO', 'AJUSTE')))), 0) as deductions_cents,
        coalesce((select sum(direction * allocated_cost_cents) from cost_lines where cost_lines.day = days.day and allocated_cost_cents is not null), 0) as cogs_cents
      from days
    )
    select jsonb_build_object(
      'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'time_zone', 'America/Sao_Paulo'),
      'totals', (select jsonb_build_object(
        'gross_revenue_cents', gross_revenue, 'sale_revenue_cents', sale_revenue, 'manual_income_cents', manual_income,
        'refunds_cents', refunds, 'fees_cents', fees, 'divergences_cents', divergences, 'net_revenue_cents', net_revenue,
        'cogs_cents', cogs, 'cogs_unknown_units', cogs_unknown_units,
        'losses_cost_cents', losses_cost, 'losses_units', losses_units, 'losses_unknown_units', losses_unknown_units,
        'operating_expenses_cents', expenses, 'supplier_payments_cents', supplier_payments,
        'gross_margin_cents', net_revenue - cogs,
        'gross_margin_bps', case when net_revenue > 0 then floor((net_revenue - cogs) * 10000 / net_revenue)::bigint end,
        'operating_profit_cents', net_revenue - cogs - losses_cost - expenses,
        'cash_balance_cents', cash_balance,
        'sales_count', sales_count, 'refunded_sales', refunded_sales,
        'average_ticket_cents', case when sales_count > 0 then floor(sale_revenue / sales_count)::bigint end,
        'cost_complete', cogs_unknown_units = 0 and losses_unknown_units = 0) from totals),
      'by_channel', jsonb_build_object(
        'PDV', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'VENDA_PDV' and amount_cents > 0), 0),
        'ONLINE', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'VENDA_ONLINE' and amount_cents > 0), 0),
        'RESERVA', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'RESERVA' and amount_cents > 0), 0),
        'RIFA', coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'RIFA' and amount_cents > 0), 0),
        'EVENTO', coalesce((select sum(amount_cents) from manual where kind = 'INCOME' and category = 'EVENTO'), 0),
        'MANUAL', coalesce((select sum(amount_cents) from manual where kind = 'INCOME' and category <> 'EVENTO'), 0),
        'HISTORICO_PICPAY', coalesce((select sum(amount_cents) from statement where source = 'PICPAY' and category = 'RECEITA_HISTORICA'), 0)),
      'by_payment_method', coalesce((select jsonb_object_agg(method, total) from (
        select method, sum(amount_cents) as total from receipts group by method) grouped), '{}'::jsonb),
      'refunds_by_payment_method', coalesce((select jsonb_object_agg(method, total) from (
        select method, -sum(amount_cents) as total from refunds group by method) grouped), '{}'::jsonb),
      'expenses_by_category', coalesce((select jsonb_object_agg(category, total) from (
        select category, sum(amount_cents) as total from manual where kind = 'EXPENSE' group by category) grouped), '{}'::jsonb),
      'top_products', coalesce((select jsonb_agg(jsonb_build_object(
          'product_id', product_id, 'product_name', product_name, 'units', units, 'revenue_cents', revenue_cents,
          'cost_cents', cost_cents, 'unknown_cost_units', unknown_units,
          'margin_cents', case when unknown_units = 0 then revenue_cents - coalesce(cost_cents, 0) end,
          'units_per_day', round(units::numeric / v_days, 2))
        order by revenue_cents desc, units desc, product_id) from (select * from products where units <> 0 or revenue_cents <> 0
          order by revenue_cents desc, units desc, product_id limit 10) ranked), '[]'::jsonb),
      'sellers', coalesce((select jsonb_agg(jsonb_build_object(
          'seller_id', seller_id, 'seller_name', seller_name, 'revenue_cents', revenue_cents, 'sales_count', sales_count,
          'refunded_count', refunded_count, 'units', units,
          'average_ticket_cents', case when sales_count > 0 then floor(revenue_cents / sales_count)::bigint end)
        order by revenue_cents desc, seller_id) from sellers), '[]'::jsonb),
      'losses', coalesce((select jsonb_agg(jsonb_build_object(
          'product_id', product_id, 'product_name', product_name, 'reason', reason, 'location_id', location_id,
          'location_name', location_name, 'units', units, 'cost_cents', cost_cents, 'unknown_cost_units', unknown_units)
        order by cost_cents desc nulls last, units desc) from (
          select product_id, product_name, reason, location_id, location_name, sum(quantity) as units,
            sum(cost_cents) as cost_cents, sum(unknown_units) as unknown_units
          from losses group by product_id, product_name, reason, location_id, location_name) grouped), '[]'::jsonb),
      'daily', coalesce((select jsonb_agg(jsonb_build_object(
          'day', day, 'revenue_cents', revenue_cents, 'net_revenue_cents', revenue_cents + deductions_cents,
          'cogs_cents', cogs_cents, 'gross_margin_cents', revenue_cents + deductions_cents - cogs_cents) order by day) from daily), '[]'::jsonb),
      'pending', jsonb_build_object(
        'awaiting_payment', (select count(*) from public.sales where status = 'AWAITING_PAYMENT'),
        'divergent_reconciliations', (select count(*) from public.payment_reconciliations where outcome = 'DIVERGENT'),
        'reopened_closeouts', (select count(*) from public.seller_closeouts where status = 'REOPENED'),
        'open_payment_recoveries', (select count(*) from public.payment_recovery_items where status = 'OPEN'),
        'statement_lines_pending', (select count(*) from public.picpay_statement_lines line
          left join private.picpay_statement_current_resolutions current on current.line_id = line.id
          where current.resolution is null or current.resolution = 'REABERTA'))
    )
  );
end;
$$;
-- An unclassified statement line exists as an item only while the line itself has no decision, so it is resolved by
-- reviewing the line (classify, link, already recorded). A manual decision recorded earlier for such an item stays in
-- picpay_exception_resolutions and in the audit log, but no longer hides the line.
create or replace function private.picpay_exceptions()
returns table (exception_key text, type text, occurred_on date, amount_cents bigint, subject_type text, subject_id uuid, details jsonb,
  resolved boolean, resolution_reason text, resolved_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select row.*, coalesce(decision.action = 'RESOLVIDA', false), decision.reason, decision.created_at
  from private.picpay_exception_rows() row
  left join private.picpay_open_exception_resolutions decision
    on decision.exception_key = row.exception_key and row.type <> 'EXTRATO_NAO_CLASSIFICADO';
$$;
create or replace function public.resolve_picpay_exception(p_key text, p_action text, p_reason text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_reason text := btrim(p_reason);
  v_current text;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_key is null or p_action not in ('RESOLVIDA', 'REABERTA') or v_reason is null
    or char_length(v_reason) not between 8 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_EXCEPTION';
  end if;
  -- A bank line is treated by reviewing it, never by silencing its item.
  if p_key like 'EXTRATO_NAO_CLASSIFICADO:%' then
    raise exception using errcode = 'P0001', message = 'PICPAY_EXCEPTION_REQUIRES_LINE_REVIEW';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'resolve_picpay_exception', v_actor_id), p_idempotency_key,
    jsonb_build_object('key', p_key, 'action', p_action, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('picpay-exception:' || p_key, 0));
  if not exists (select 1 from private.picpay_exception_rows() where exception_key = p_key) then
    raise exception using errcode = 'P0001', message = 'PICPAY_EXCEPTION_NOT_FOUND';
  end if;
  select action into v_current from private.picpay_open_exception_resolutions where exception_key = p_key;
  if coalesce(v_current, 'REABERTA') = p_action then
    raise exception using errcode = 'P0001', message = 'PICPAY_EXCEPTION_ALREADY_' || p_action;
  end if;
  insert into public.picpay_exception_resolutions (exception_key, action, reason, actor_id, correlation_id)
  values (p_key, p_action, v_reason, v_actor_id, p_correlation_id);
  v_result := jsonb_build_object('key', p_key, 'action', p_action, 'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.exception_resolved', v_actor_id, 'picpay_exception', p_key, p_correlation_id,
    jsonb_build_object('action', p_action, 'reason', v_reason));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_exception', p_key);
  return v_result;
end;
$$;
create or replace function private.picpay_reconciliation_summary_json(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with position as (select as_of, operating_since from private.current_finance_opening_position()),
  pdv as (
    select attempt.id from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING') and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date between p_from and p_to
  ),
  tx as (select * from private.picpay_transactions_view where sold_on between p_from and p_to),
  open_exceptions as (select * from private.picpay_exceptions() where not resolved),
  exceptions as (select * from open_exceptions where occurred_on between p_from and p_to),
  pending_lines as (
    select line.occurred_on, line.amount_cents from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where current.id is null or current.resolution = 'REABERTA'
  ),
  latest_check as (select as_of, status, total_difference_cents from public.finance_balance_checks order by number desc limit 1),
  lines as (
    select line.*, current.resolution from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.occurred_on between p_from and p_to
  ),
  settlement as (select * from private.picpay_settlement_days())
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'operating_since', (select operating_since from position),
    'opening_as_of', (select as_of from position),
    'imported_from', least((select min(occurred_on) from public.picpay_statement_lines), (select min(sold_on) from private.picpay_transactions_view)),
    'imported_to', greatest((select max(occurred_on) from public.picpay_statement_lines), (select max(sold_on) from private.picpay_transactions_view)),
    'pdv_sales', (select count(*) from pdv),
    'picpay', jsonb_build_object(
      'transactions', (select count(*) from tx),
      'approved', (select count(*) from tx where status = 'APROVADA'),
      'denied', (select count(*) from tx where status = 'NEGADA'),
      'refunded', (select count(*) from tx where status = 'DEVOLVIDA'),
      'historical', (select count(*) from tx where historical),
      'linked', (select count(*) from tx where payment_attempt_id is not null),
      'gross_cents', coalesce((select sum(gross_cents) from tx where status in ('APROVADA', 'DEVOLVIDA')), 0),
      'fee_cents', coalesce((select sum(total_fee_cents) from tx where status in ('APROVADA', 'DEVOLVIDA')), 0),
      'net_cents', coalesce((select sum(net_cents) from tx where status in ('APROVADA', 'DEVOLVIDA')), 0)),
    'exceptions', jsonb_build_object(
      'total', (select count(*) from exceptions),
      'by_type', coalesce((select jsonb_object_agg(type, total) from (select type, count(*) as total from exceptions group by type) grouped), '{}'::jsonb),
      'total_all', (select count(*) from open_exceptions),
      'outside_period', (select count(*) from open_exceptions where occurred_on not between p_from and p_to),
      'first_open_on', (select min(occurred_on) from open_exceptions),
      'last_open_on', (select max(occurred_on) from open_exceptions)),
    'receivables', jsonb_build_object(
      'pending_cents', coalesce((select sum(expected_net_cents - settled_cents) from settlement where status in ('A_RECEBER', 'EM_ATRASO', 'PARCIAL')), 0),
      'overdue_cents', coalesce((select sum(expected_net_cents - settled_cents) from settlement where status in ('EM_ATRASO', 'PARCIAL')), 0),
      'snapshot_cents', coalesce((select sum(net_cents) from private.picpay_receivable_state), 0),
      'settled_cents', coalesce((select sum(settled_cents) from settlement where payment_on between p_from and p_to), 0)),
    'statement', jsonb_build_object(
      'lines', (select count(*) from lines),
      'inflow_cents', coalesce((select sum(amount_cents) from lines where amount_cents > 0
        and movement not in ('COFRINHO_RESGATADO')), 0),
      'outflow_cents', coalesce((select -sum(amount_cents) from lines where amount_cents < 0 and movement not in ('COFRINHO_GUARDADO')), 0),
      'internal_transfer_cents', coalesce((select sum(abs(amount_cents)) from lines where movement in ('COFRINHO_GUARDADO', 'COFRINHO_RESGATADO')), 0),
      'pending_lines', (select count(*) from lines where resolution is null or resolution = 'REABERTA'),
      'pending_lines_total', (select count(*) from pending_lines),
      'pending_net_cents_total', coalesce((select sum(amount_cents) from pending_lines), 0),
      'pending_outside_period', (select count(*) from pending_lines where occurred_on not between p_from and p_to)),
    'balance_check', (select jsonb_build_object('as_of', as_of, 'status', status, 'total_difference_cents', total_difference_cents) from latest_check),
    'balances', (select jsonb_build_object('as_of', balances.as_of, 'free_balance_cents', balances.free, 'vault_balance_cents', balances.vault,
        'available_balance_cents', balances.free + balances.vault, 'receivables_balance_cents', balances.receivables,
        'pix_clearing_cents', balances.clearing, 'cash_balance_cents', balances.cash)
      from (select least(p_to, (now() at time zone 'America/Sao_Paulo')::date) as as_of,
          max(balance_cents) filter (where account = 'PICPAY_EMPRESAS') as free, max(balance_cents) filter (where account = 'COFRINHO_PICPAY') as vault,
          max(balance_cents) filter (where account = 'RECEBIVEIS_PICPAY') as receivables,
          max(balance_cents) filter (where account = 'PENDENTE_LIQUIDACAO') as clearing, max(balance_cents) filter (where account = 'DINHEIRO_FISICO') as cash
        from private.finance_account_balances(least(p_to, (now() at time zone 'America/Sao_Paulo')::date))) balances),
    'status', case when (select count(*) from exceptions) = 0
        and (select count(*) from lines where resolution is null or resolution = 'REABERTA') = 0 then 'CONCILIADO' else 'COM_PENDENCIAS' end);
$$;
create or replace function public.close_picpay_period(p_from date, p_to date, p_note text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_period_id uuid := gen_random_uuid();
  v_summary jsonb;
  v_open integer;
  v_status text;
  v_note text := nullif(btrim(p_note), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366
    or (v_note is not null and char_length(v_note) not between 3 and 300) then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_PERIOD';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'close_picpay_period', v_actor_id), p_idempotency_key,
    jsonb_build_object('from', p_from, 'to', p_to, 'note', v_note));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));
  v_summary := private.picpay_reconciliation_summary_json(p_from, p_to);
  -- The summary is the single authority for the status: no open item and no statement line awaiting review.
  v_open := (v_summary -> 'exceptions' ->> 'total')::integer;
  v_status := v_summary ->> 'status';
  insert into public.picpay_reconciliation_periods (id, period_from, period_to, note, actor_id, correlation_id)
  values (v_period_id, p_from, p_to, v_note, v_actor_id, p_correlation_id);
  insert into public.picpay_reconciliation_period_events (period_id, status, open_exceptions, summary, reason, actor_id, correlation_id)
  values (v_period_id, v_status, v_open, v_summary, coalesce(v_note, 'Período avaliado'), v_actor_id, p_correlation_id);
  v_result := jsonb_build_object('id', v_period_id, 'status', v_status, 'open_exceptions', v_open, 'summary', v_summary,
    'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.period_evaluated', v_actor_id, 'picpay_reconciliation_period', v_period_id::text, p_correlation_id,
    jsonb_build_object('from', p_from, 'to', p_to, 'status', v_status, 'open_exceptions', v_open));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_reconciliation_period', v_period_id::text);
  return v_result;
end;
$$;
revoke all on function private.finance_statement_rows(date, date) from public, anon, authenticated, service_role;
revoke all on function private.finance_statement_row_nature(text, uuid, public.finance_category, bigint) from public, anon, authenticated, service_role;
revoke all on function private.finance_account_balances(date) from public, anon, authenticated, service_role;
revoke all on function private.finance_statement_unapplied(date) from public, anon, authenticated, service_role;
revoke all on function private.compute_management_indicators(date, date) from public, anon, authenticated, service_role;
revoke all on function private.picpay_exceptions() from public, anon, authenticated, service_role;
revoke all on function private.picpay_reconciliation_summary_json(date, date) from public, anon, authenticated, service_role;
revoke all on function public.finance_statement(date, date) from public, anon, authenticated, service_role;
grant execute on function public.finance_statement(date, date) to authenticated;
revoke all on function public.resolve_picpay_exception(text, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.resolve_picpay_exception(text, text, text, text, uuid) to authenticated;
revoke all on function public.close_picpay_period(date, date, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.close_picpay_period(date, date, text, text, uuid) to authenticated;

comment on function private.finance_account_balances(date) is
  'Single authority for treasury balances: opening + inflows − outflows + transfers in − transfers out, by account. '
  'Every canonical PicPay statement line moves PicPay Empresas exactly once, classified or not.';
