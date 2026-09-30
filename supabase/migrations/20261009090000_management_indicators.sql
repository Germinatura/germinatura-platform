-- Etapa 9 (ADMIN-001, spec 5.1 e 5.9): management indicators for a São Paulo period, derived only from the
-- immutable ledgers — the finance statement rows, the sale ledger, lot cost allocations and applied losses —
-- never from manual numbers typed into the dashboard. A read model: nothing is stored.
--
-- Definitions:
--   gross revenue      sale receipts (PDV, online, reservation, raffle) + manual income entries
--   net revenue        gross revenue − refunds − fees ± reconciliation divergences
--   cost of goods      lot cost allocated to sales minus the cost restored by sale reversals
--   operating expenses manual expense entries (fees are already in net revenue); supplier payments are cash
--                      outflows whose cost reaches the result through the cost of goods
--   operating profit   net revenue − cost of goods − cost of applied losses − operating expenses
--   cash balance       every categorized inflow and outflow of the period (the finance statement)
-- Units whose lot has no known cost are reported, so margin is never presented as complete when it is not.

-- The computation carries no permission check: the finance wrapper below and the public goal (which only
-- exposes the operating profit) each decide what may be read.
create function private.compute_management_indicators(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_days integer;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
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
        coalesce((select -sum(amount_cents) from statement where source = 'SALE' and category = 'REEMBOLSO'), 0) as refunds,
        coalesce((select -sum(amount_cents) from statement where category = 'TAXAS'), 0) as fees,
        coalesce((select sum(amount_cents) from statement where source = 'SALE' and category = 'AJUSTE'), 0) as divergences,
        coalesce((select sum(amount_cents) from manual where kind = 'EXPENSE' and category <> 'TAXAS'), 0) as expenses,
        coalesce((select -sum(amount_cents) from statement where source = 'PAYABLE'), 0) as supplier_payments,
        coalesce((select sum(amount_cents) from statement where category is not null), 0) as cash_balance,
        coalesce((select sum(direction * allocated_cost_cents) from cost_lines where allocated_cost_cents is not null), 0) as cogs,
        coalesce((select sum(direction * quantity) from cost_lines where allocated_cost_cents is null), 0) as cogs_unknown_units,
        coalesce((select sum(cost_cents) from losses), 0) as losses_cost,
        coalesce((select sum(quantity) from losses), 0) as losses_units,
        coalesce((select sum(unknown_units) from losses), 0) as losses_unknown_units,
        (select count(distinct sale_id) from receipts) as sales_count,
        (select count(distinct sale_id) from refunds) as refunded_sales
    ),
    totals as (
      select figures.*, sale_revenue + manual_income as gross_revenue,
        sale_revenue + manual_income - refunds - fees + divergences as net_revenue
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
          + coalesce((select sum(amount_cents) from manual where manual.day = days.day and manual.kind = 'INCOME'), 0) as revenue_cents,
        coalesce((select sum(amount_cents) from statement row where row.occurred_on = days.day
          and (row.category = 'TAXAS' or (row.source = 'SALE' and row.category in ('REEMBOLSO', 'AJUSTE')))), 0) as deductions_cents,
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
        'MANUAL', coalesce((select sum(amount_cents) from manual where kind = 'INCOME' and category <> 'EVENTO'), 0)),
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
        'open_payment_recoveries', (select count(*) from public.payment_recovery_items where status = 'OPEN'))
    )
  );
end;
$$;
revoke all on function private.compute_management_indicators(date, date) from public, anon, authenticated, service_role;

create function public.management_indicators(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return private.compute_management_indicators(p_from, p_to);
end;
$$;
revoke all on function public.management_indicators(date, date) from public, anon, authenticated, service_role;
grant execute on function public.management_indicators(date, date) to authenticated;
comment on function public.management_indicators(date, date) is
  'ADMIN-001: period indicators from the ledgers — revenue by channel and method, cost of goods, losses, margin, profit, products, sellers and pending items.';
