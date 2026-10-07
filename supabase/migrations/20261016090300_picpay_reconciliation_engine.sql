-- Spec 5.8 (FIN-001, FIN-002, FIN-003, FIN-007): the PicPay reconciliation engine across the three exports.
--
-- Perspectives: the Germinatura sale is the commercial truth; Minhas vendas the acquirer truth (method, status, gross,
-- real fees, net, payment forecast); Recebíveis the snapshot of card money still to be paid; the Extrato the treasury.
-- A sale is revenue once:
--   native sale (from operating_since)  revenue comes from the PDV ledger; its PicPay transaction is linked to it and only
--                                        adds the real PicPay fee (TAXAS on Recebíveis PicPay): the card fee no longer
--                                        stays forever in receivables
--   historical sale (before)            no PDV sale exists and none is invented: the PicPay transaction itself carries the
--                                        historical revenue (RECEITA_HISTORICA), its real fee and its refund
--     card / PicPay wallet               gross and fee on Recebíveis PicPay; the Extrato "Recebíveis de venda" settles the net
--                                        into PicPay Empresas as a transfer (aggregated by payment day: 1:N, N:1, batches)
--     Pix                                gross on the Pix clearing account (PENDENTE_LIQUIDACAO); each "Pix recebido" of the
--                                        same day and amount moves it into PicPay Empresas (multiset by day and amount; the
--                                        set is reconciled even when a 1:1 pair is not provable); a Devolvida transaction
--                                        reverses the revenue and its "Pix estornado" moves the money back out
-- Everything is recomputed from immutable evidence and append-only decisions after every import, so files may arrive in
-- any order, overlap, or repeat, and the state converges. Nothing here stores or alters financial facts by itself.

alter table public.picpay_statement_line_resolutions drop constraint picpay_statement_line_resolutions_shape_valid;
-- Historical receivables may now be settled as a transfer: the engine only does it when acquirer evidence explains them.
alter table public.picpay_statement_line_resolutions add constraint picpay_statement_line_resolutions_shape_valid check (
  (resolution = 'TRANSFERENCIA' and counter_account is not null and counter_account <> 'PICPAY_EMPRESAS'
    and category is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null)
  or (resolution = 'CONCILIADA_PICPAY' and counter_account = 'PENDENTE_LIQUIDACAO'
    and category is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null)
  or (resolution = 'CONCILIADA_VENDA' and payment_attempt_id is not null and reconciliation_id is not null
    and category is null and counter_account is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null and not cutover)
  or (resolution = 'CONCILIADA_ESTORNO' and refund_entry_id is not null
    and category is null and counter_account is null and payment_attempt_id is null
    and payable_settlement_id is null and manual_entry_id is null and not cutover)
  or (resolution = 'CLASSIFICADA' and category is not null and category not in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')
    and counter_account is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null
    and (category <> 'RECEITA_HISTORICA' or cutover))
  or (resolution = 'VINCULADA' and num_nonnulls(payable_settlement_id, manual_entry_id) = 1
    and category is null and counter_account is null and payment_attempt_id is null and refund_entry_id is null)
  or (resolution in ('JA_REGISTRADO', 'REABERTA') and reason is not null
    and category is null and counter_account is null and payment_attempt_id is null and refund_entry_id is null
    and payable_settlement_id is null and manual_entry_id is null)
);

-- PDV ↔ Minhas vendas: append-only decisions; the latest decision of a transaction is its current link.
create table public.picpay_transaction_links (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  transaction_id uuid not null references public.picpay_transactions(id) on delete restrict,
  payment_attempt_id uuid references public.payment_attempts(id) on delete restrict,
  action text not null check (action in ('LINK', 'UNLINK')),
  automatic boolean not null,
  evidence text not null check (evidence in ('REFERENCIA', 'VALOR_HORARIO_METODO', 'MANUAL')),
  reason text check (reason is null or (char_length(reason) between 8 and 300 and reason = btrim(reason))),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_transaction_links_shape check ((action = 'LINK') = (payment_attempt_id is not null)),
  constraint picpay_transaction_links_reason check (automatic or reason is not null)
);
create index picpay_transaction_links_transaction_idx on public.picpay_transaction_links (transaction_id, sequence desc);
create index picpay_transaction_links_attempt_idx on public.picpay_transaction_links (payment_attempt_id) where payment_attempt_id is not null;

-- Exceptions are derived; a person may acknowledge one (with a reason) or reopen it. Decisions are append-only.
create table public.picpay_exception_resolutions (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  exception_key text not null check (char_length(exception_key) between 3 and 200),
  action text not null check (action in ('RESOLVIDA', 'REABERTA')),
  reason text not null check (char_length(reason) between 8 and 300 and reason = btrim(reason)),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
create index picpay_exception_resolutions_key_idx on public.picpay_exception_resolutions (exception_key, sequence desc);

-- Reconciliation periods: a person evaluates a period; later evidence may send it back to review. Append-only events.
create table public.picpay_reconciliation_periods (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  period_from date not null,
  period_to date not null,
  note text check (note is null or (char_length(note) between 3 and 300 and note = btrim(note))),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint picpay_reconciliation_periods_valid check (period_to >= period_from and period_to - period_from <= 366)
);
create table public.picpay_reconciliation_period_events (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  period_id uuid not null references public.picpay_reconciliation_periods(id) on delete restrict,
  status text not null check (status in ('CONCILIADO', 'COM_PENDENCIAS', 'REVISAR')),
  open_exceptions integer not null check (open_exceptions >= 0),
  summary jsonb not null,
  reason text not null check (char_length(reason) between 3 and 300),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);
create index picpay_reconciliation_period_events_period_idx on public.picpay_reconciliation_period_events (period_id, sequence desc);

create trigger picpay_transaction_links_immutable before update or delete on public.picpay_transaction_links
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_exception_resolutions_immutable before update or delete on public.picpay_exception_resolutions
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_reconciliation_periods_immutable before update or delete on public.picpay_reconciliation_periods
for each row execute function private.prevent_immutable_record_change();
create trigger picpay_reconciliation_period_events_immutable before update or delete on public.picpay_reconciliation_period_events
for each row execute function private.prevent_immutable_record_change();
alter table public.picpay_transaction_links enable row level security;
alter table public.picpay_exception_resolutions enable row level security;
alter table public.picpay_reconciliation_periods enable row level security;
alter table public.picpay_reconciliation_period_events enable row level security;
revoke all on public.picpay_transaction_links, public.picpay_exception_resolutions, public.picpay_reconciliation_periods,
  public.picpay_reconciliation_period_events from public, anon, authenticated, service_role;

create view private.picpay_current_links as
  select current.transaction_id, current.payment_attempt_id, current.automatic, current.evidence, current.created_at
  from (select distinct on (transaction_id) * from public.picpay_transaction_links order by transaction_id, sequence desc) current
  where current.action = 'LINK';
revoke all on private.picpay_current_links from public, anon, authenticated, service_role;

create view private.picpay_open_exception_resolutions as
  select distinct on (exception_key) exception_key, action, reason, actor_id, created_at
  from public.picpay_exception_resolutions order by exception_key, sequence desc;
revoke all on private.picpay_open_exception_resolutions from public, anon, authenticated, service_role;

-- Whether an acquirer method fits how the PDV recorded the payment.
create function private.picpay_kind_fits_attempt(
  p_kind public.picpay_payment_kind, p_channel public.payment_integration_channel, p_card_method public.card_payment_method
)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'PIX' then p_channel = 'PIX_AREA'
    when p_kind = 'CREDITO' then p_channel in ('MAQUININHA', 'TAP') and (p_card_method is null or p_card_method = 'CREDITO')
    when p_kind = 'DEBITO' then p_channel in ('MAQUININHA', 'TAP') and (p_card_method is null or p_card_method = 'DEBITO')
    else p_channel in ('MAQUININHA', 'TAP')
  end;
$$;

-- The acquirer state with the cutover side of each transaction and its current PDV link.
create view private.picpay_transactions_view as
  select state.*,
    link.payment_attempt_id, link.automatic as link_automatic, link.evidence as link_evidence,
    position.operating_since,
    position.id is not null and state.sold_on < position.operating_since as historical
  from private.picpay_transaction_state state
  left join private.picpay_current_links link on link.transaction_id = state.transaction_id
  left join lateral (select id, operating_since from private.current_finance_opening_position()) position on true;
revoke all on private.picpay_transactions_view from public, anon, authenticated, service_role;

-- Money effects of the acquirer evidence, in the shape of statement rows.
create function private.picpay_acquirer_effects(p_from date, p_to date)
returns table (
  occurred_on date, source_id uuid, category public.finance_category, account public.finance_account, amount_cents bigint,
  description text, reference text
)
language sql stable security definer set search_path = '' as $$
  with transactions as (
    select tx.*, case when tx.payment_kind = 'PIX' then 'PENDENTE_LIQUIDACAO' else 'RECEBIVEIS_PICPAY' end::public.finance_account as account
    from private.picpay_transactions_view tx
    where tx.sold_on between p_from and p_to and tx.status in ('APROVADA', 'DEVOLVIDA')
  )
  -- Historical revenue: the transaction itself, once; never for a sale linked to the PDV.
  select sold_on, transaction_id, 'RECEITA_HISTORICA'::public.finance_category, account, gross_cents,
    'Venda PicPay (histórico do cutover): ' || payment_label, 'PICPAY-' || transaction_ref
  from transactions where historical and payment_attempt_id is null
  union all
  -- The real PicPay fee: historical transactions and native ones linked to their PDV sale.
  select sold_on, transaction_id, 'TAXAS', case when historical then account else 'RECEBIVEIS_PICPAY' end, -total_fee_cents,
    'Taxa PicPay: ' || payment_label, 'PICPAY-' || transaction_ref
  from transactions where total_fee_cents > 0 and ((historical and payment_attempt_id is null) or payment_attempt_id is not null)
  union all
  -- A historical refund reverses its revenue (a native refund is recorded by the PDV refund itself).
  select sold_on, transaction_id, 'REEMBOLSO', account, -cancelled_cents,
    'Devolução PicPay (histórico do cutover): ' || payment_label, 'PICPAY-' || transaction_ref
  from transactions where historical and payment_attempt_id is null and status = 'DEVOLVIDA' and cancelled_cents > 0;
$$;

-- Card settlement by payment day: what Minhas vendas expects to be paid against what the Extrato settled.
create function private.picpay_settlement_days()
returns table (
  payment_on date, expected_net_cents bigint, expected_count integer, settled_cents bigint, settled_lines integer,
  receivable_snapshot_cents bigint, statement_covered boolean, status text
)
language sql stable security definer set search_path = '' as $$
  with expected as (
    select expected_payment_on as day, sum(net_cents)::bigint as net, count(*)::integer as transactions
    from private.picpay_transaction_state
    where status = 'APROVADA' and payment_kind <> 'PIX' and expected_payment_on is not null
    group by expected_payment_on
  ),
  settled as (
    select occurred_on as day, sum(amount_cents)::bigint as amount, count(*)::integer as lines
    from public.picpay_statement_lines where movement = 'RECEBIVEIS_VENDA' group by occurred_on
  ),
  snapshot as (select payment_on as day, sum(net_cents)::bigint as net from private.picpay_receivable_state group by payment_on),
  days as (select day from expected union select day from settled union select day from snapshot)
  select days.day, coalesce(expected.net, 0), coalesce(expected.transactions, 0), coalesce(settled.amount, 0), coalesce(settled.lines, 0),
    coalesce(snapshot.net, 0),
    exists (select 1 from public.picpay_statement_imports import where days.day between import.period_from and import.period_to),
    case
      when coalesce(settled.amount, 0) > coalesce(expected.net, 0) then 'EXCEDENTE'
      when coalesce(settled.amount, 0) = coalesce(expected.net, 0) then 'LIQUIDADO'
      when coalesce(settled.amount, 0) > 0 then 'PARCIAL'
      when exists (select 1 from public.picpay_statement_imports import where days.day between import.period_from and import.period_to)
        then 'EM_ATRASO'
      else 'A_RECEBER'
    end
  from days
  left join expected on expected.day = days.day
  left join settled on settled.day = days.day
  left join snapshot on snapshot.day = days.day
  order by days.day;
$$;

-- Recomputes what evidence allows: native PDV links, historical Pix and refunds, historical card settlements.
-- Idempotent; safe to run after every import and when the opening position changes.
create function private.run_picpay_reconciliation(p_actor_id uuid, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_links integer := 0;
  v_pix integer := 0;
  v_refunds integer := 0;
  v_settlements integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));

  -- 1. Native transactions ↔ PDV payments: a reference typed by the seller (NSU or authorization) first, then amount,
  --    method and time (30 minutes); only a candidate unique in both directions is linked automatically.
  with position as (select operating_since from private.current_finance_opening_position()),
  open_transactions as (
    select tx.* from private.picpay_transactions_view tx
    where tx.status in ('APROVADA', 'DEVOLVIDA') and tx.payment_attempt_id is null and not tx.historical
  ),
  open_attempts as (
    select attempt.* from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING')
      and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (not exists (select 1 from position) or (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date
        >= (select operating_since from position))
      and not exists (select 1 from private.picpay_current_links link where link.payment_attempt_id = attempt.id)
  ),
  pairs as (
    select tx.transaction_id, attempt.id as attempt_id,
      attempt.proof_reference is not null and attempt.proof_reference in (tx.nsu, tx.authorization_code) as strong
    from open_transactions tx
    join open_attempts attempt on attempt.amount_cents = tx.gross_cents
      and private.picpay_kind_fits_attempt(tx.payment_kind, attempt.integration_channel, attempt.card_method)
      and ((attempt.proof_reference is not null and attempt.proof_reference in (tx.nsu, tx.authorization_code))
        or abs(extract(epoch from coalesce(attempt.confirmed_at, attempt.created_at) - tx.sold_at)) <= 1800)
  ),
  preferred as (
    select pair.* from pairs pair
    where pair.strong or not exists (select 1 from pairs other where other.transaction_id = pair.transaction_id and other.strong)
  ),
  unique_pairs as (
    select pair.* from preferred pair
    where (select count(*) from preferred other where other.transaction_id = pair.transaction_id) = 1
      and (select count(*) from preferred other where other.attempt_id = pair.attempt_id) = 1
  ),
  inserted as (
    insert into public.picpay_transaction_links (transaction_id, payment_attempt_id, action, automatic, evidence, actor_id, correlation_id)
    select transaction_id, attempt_id, 'LINK', true, case when strong then 'REFERENCIA' else 'VALOR_HORARIO_METODO' end, p_actor_id, p_correlation_id
    from unique_pairs
    returning 1
  )
  select count(*) into v_links from inserted;

  -- 2. Historical "Pix recebido": as many pending lines of a day and amount as historical Pix transactions of that day and
  --    amount still unexplained. The set is reconciled; no arbitrary pair is claimed.
  with acquirer as (
    select sold_on as day, gross_cents as amount, count(*) as transactions
    from private.picpay_transactions_view
    where historical and payment_attempt_id is null and payment_kind = 'PIX' and status in ('APROVADA', 'DEVOLVIDA')
    group by sold_on, gross_cents
  ),
  explained as (
    select line.occurred_on as day, line.amount_cents as amount, count(*) as lines
    from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.movement = 'PIX_RECEBIDO' and current.resolution = 'CONCILIADA_PICPAY'
    group by line.occurred_on, line.amount_cents
  ),
  pending as (
    select line.id, line.occurred_on, line.amount_cents,
      row_number() over (partition by line.occurred_on, line.amount_cents order by line.id) as position
    from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.movement = 'PIX_RECEBIDO' and private.is_statement_cutover_day(line.occurred_on)
      and (current.id is null or current.resolution = 'REABERTA')
  ),
  inserted as (
    insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
    select pending.id, 'CONCILIADA_PICPAY', 'PENDENTE_LIQUIDACAO', true, p_actor_id, p_correlation_id
    from pending
    join acquirer on acquirer.day = pending.occurred_on and acquirer.amount = pending.amount_cents
    left join explained on explained.day = pending.occurred_on and explained.amount = pending.amount_cents
    where pending.position <= acquirer.transactions - coalesce(explained.lines, 0)
    returning 1
  )
  select count(*) into v_pix from inserted;

  -- 3. Historical "Pix estornado": as many pending refund lines of an amount as refunded (Devolvida) historical Pix of
  --    that amount still unexplained, never before the sale day.
  with acquirer as (
    select gross_cents as amount, count(*) as transactions, min(sold_on) as first_day
    from private.picpay_transactions_view
    where historical and payment_attempt_id is null and payment_kind = 'PIX' and status = 'DEVOLVIDA'
    group by gross_cents
  ),
  explained as (
    select -line.amount_cents as amount, count(*) as lines
    from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.movement = 'PIX_ESTORNADO' and current.resolution = 'CONCILIADA_PICPAY'
    group by line.amount_cents
  ),
  pending as (
    select line.id, line.occurred_on, -line.amount_cents as amount,
      row_number() over (partition by line.amount_cents order by line.occurred_on, line.id) as position
    from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.movement = 'PIX_ESTORNADO' and line.amount_cents < 0 and private.is_statement_cutover_day(line.occurred_on)
      and (current.id is null or current.resolution = 'REABERTA')
  ),
  inserted as (
    insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
    select pending.id, 'CONCILIADA_PICPAY', 'PENDENTE_LIQUIDACAO', true, p_actor_id, p_correlation_id
    from pending
    join acquirer on acquirer.amount = pending.amount and pending.occurred_on >= acquirer.first_day
    left join explained on explained.amount = pending.amount
    where pending.position <= acquirer.transactions - coalesce(explained.lines, 0)
    returning 1
  )
  select count(*) into v_refunds from inserted;

  -- 4. Historical "Recebíveis de venda": settled as a transfer out of Recebíveis PicPay only when the day's settlements
  --    do not exceed what Minhas vendas expected to be paid that day.
  with days as (select * from private.picpay_settlement_days() where settled_cents <= expected_net_cents),
  inserted as (
    insert into public.picpay_statement_line_resolutions (line_id, resolution, counter_account, automatic, actor_id, correlation_id)
    select line.id, 'TRANSFERENCIA', 'RECEBIVEIS_PICPAY', true, p_actor_id, p_correlation_id
    from public.picpay_statement_lines line
    join days on days.payment_on = line.occurred_on
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.movement = 'RECEBIVEIS_VENDA' and (current.id is null or current.resolution = 'REABERTA')
    returning 1
  )
  select count(*) into v_settlements from inserted;

  return jsonb_build_object('links', v_links, 'pix', v_pix, 'refunds', v_refunds, 'settlements', v_settlements);
end;
$$;

-- The opening position decides what is history: reconcile again whenever it changes.
create function private.picpay_reconcile_after_opening()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.run_picpay_reconciliation(new.actor_id, new.correlation_id);
  return new;
end;
$$;
create trigger finance_opening_positions_reconcile_picpay after insert on public.finance_opening_positions
for each row execute function private.picpay_reconcile_after_opening();

-- The statement rows gain the acquirer evidence and the statement lines reconciled with it.
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


-- The opening position may now be recorded after the files: receivable settlements are explained by Minhas vendas,
-- so only native sale and refund reconciliations before operating_since still contradict a cutover.
create or replace function public.record_finance_opening_position(
  p_as_of date, p_operating_since date, p_free_cents bigint, p_vault_cents bigint, p_receivables_cents bigint,
  p_cash_cents bigint, p_description text, p_reason text, p_supersedes_id uuid, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_current public.finance_opening_positions%rowtype;
  v_position_id uuid := gen_random_uuid();
  v_version integer;
  v_description text := btrim(p_description);
  v_reason text := nullif(btrim(p_reason), '');
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_as_of is null or p_operating_since is null or p_operating_since <= p_as_of
    or p_as_of > (now() at time zone 'America/Sao_Paulo')::date
    or v_description is null or char_length(v_description) not between 3 and 300
    or (v_reason is not null and char_length(v_reason) not between 8 and 300)
    or p_free_cents is null or p_vault_cents is null or p_receivables_cents is null or p_cash_cents is null
    or least(p_free_cents, p_vault_cents, p_receivables_cents, p_cash_cents) < 0
    or greatest(p_free_cents, p_vault_cents, p_receivables_cents, p_cash_cents) > 9007199254740991 then
    raise exception using errcode = '22023', message = 'INVALID_OPENING_POSITION';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'record_opening_position', v_actor_id), p_idempotency_key,
    jsonb_build_object('as_of', p_as_of, 'operating_since', p_operating_since, 'free_cents', p_free_cents,
      'vault_cents', p_vault_cents, 'receivables_cents', p_receivables_cents, 'cash_cents', p_cash_cents,
      'description', v_description, 'reason', v_reason, 'supersedes_id', p_supersedes_id));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- One writer at a time: the version chain and the statement checks below see a stable state.
  perform pg_advisory_xact_lock(hashtextextended('finance-opening-position', 0));
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-import', 0));
  select * into v_current from private.current_finance_opening_position();
  if v_current.id is null then
    if p_supersedes_id is not null or v_reason is not null then
      raise exception using errcode = '22023', message = 'INVALID_OPENING_POSITION';
    end if;
    v_version := 1;
  else
    if p_supersedes_id is null then
      raise exception using errcode = 'P0001', message = 'OPENING_POSITION_ALREADY_RECORDED';
    end if;
    if p_supersedes_id <> v_current.id then
      raise exception using errcode = 'P0001', message = 'OPENING_POSITION_STALE';
    end if;
    if v_reason is null then
      raise exception using errcode = '22023', message = 'INVALID_OPENING_POSITION';
    end if;
    v_version := v_current.version + 1;
  end if;

  if exists (
    select 1 from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.occurred_on < p_operating_since
      and current.resolution in ('CONCILIADA_VENDA', 'CONCILIADA_ESTORNO')
  ) or exists (
    select 1 from public.picpay_statement_lines line
    join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.occurred_on >= p_operating_since and current.resolution = 'CLASSIFICADA' and current.category = 'RECEITA_HISTORICA'
  ) then
    raise exception using errcode = 'P0001', message = 'OPENING_POSITION_CONFLICTS_WITH_STATEMENT';
  end if;

  insert into public.finance_opening_positions (
    id, version, as_of, operating_since, description, reason, supersedes_id, actor_id, correlation_id
  ) values (
    v_position_id, v_version, p_as_of, p_operating_since, v_description, v_reason, p_supersedes_id, v_actor_id, p_correlation_id
  );
  insert into public.finance_opening_position_lines (position_id, account, amount_cents) values
    (v_position_id, 'PICPAY_EMPRESAS', p_free_cents),
    (v_position_id, 'COFRINHO_PICPAY', p_vault_cents),
    (v_position_id, 'RECEBIVEIS_PICPAY', p_receivables_cents),
    (v_position_id, 'DINHEIRO_FISICO', p_cash_cents);

  v_result := private.finance_opening_position_json(v_position_id) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.opening_position.recorded', v_actor_id, 'finance_opening_position', v_position_id::text, p_correlation_id,
    jsonb_build_object('version', v_version, 'as_of', p_as_of, 'operating_since', p_operating_since,
      'supersedes_id', p_supersedes_id, 'accounts', v_result -> 'accounts'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.opening_position.recorded', 'finance_opening_position', v_position_id::text,
    jsonb_build_object('position_id', v_position_id, 'version', v_version, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_opening_position', v_position_id::text);
  return v_result;
end;
$$;


-- Indicators count the historical revenue and refunds carried by Minhas vendas once; fees already come from TAXAS.
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

revoke all on function private.compute_management_indicators(date, date) from public, anon, authenticated, service_role;


-- Every open question of the reconciliation, derived from the evidence; the key identifies it across recomputations.
create function private.picpay_exception_rows()
returns table (exception_key text, type text, occurred_on date, amount_cents bigint, subject_type text, subject_id uuid, details jsonb)
language sql stable security definer set search_path = '' as $$
  with position as (select operating_since from private.current_finance_opening_position()),
  sales_coverage as (select period_from, period_to from public.picpay_source_imports where source_type = 'PICPAY_SALES'),
  native_attempts as (
    select attempt.*, (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date as paid_on
    from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING') and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (not exists (select 1 from position) or (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date
        >= (select operating_since from position))
  ),
  linked as (
    select tx.*, attempt.amount_cents as attempt_amount, attempt.integration_channel, attempt.card_method, attempt.sale_id
    from private.picpay_transactions_view tx join public.payment_attempts attempt on attempt.id = tx.payment_attempt_id
  )
  select 'PDV_SEM_PICPAY:' || attempt.id, 'PDV_SEM_PICPAY', attempt.paid_on, attempt.amount_cents, 'payment_attempt', attempt.id,
    jsonb_build_object('channel', attempt.integration_channel, 'sale_id', attempt.sale_id)
  from native_attempts attempt
  where exists (select 1 from sales_coverage where attempt.paid_on between sales_coverage.period_from and sales_coverage.period_to)
    and not exists (select 1 from private.picpay_current_links link where link.payment_attempt_id = attempt.id)
  union all
  select 'PICPAY_SEM_PDV:' || tx.transaction_id, 'PICPAY_SEM_PDV', tx.sold_on, tx.gross_cents, 'picpay_transaction', tx.transaction_id,
    jsonb_build_object('transaction_ref', tx.transaction_ref, 'method', tx.payment_label, 'terminal', tx.terminal_number, 'status', tx.status)
  from private.picpay_transactions_view tx
  where tx.status in ('APROVADA', 'DEVOLVIDA') and not tx.historical and tx.payment_attempt_id is null
  union all
  select 'VALOR_DIVERGENTE:' || linked.transaction_id, 'VALOR_DIVERGENTE', linked.sold_on, linked.gross_cents - linked.attempt_amount,
    'picpay_transaction', linked.transaction_id,
    jsonb_build_object('transaction_ref', linked.transaction_ref, 'picpay_cents', linked.gross_cents, 'pdv_cents', linked.attempt_amount)
  from linked where linked.gross_cents <> linked.attempt_amount
  union all
  select 'METODO_DIVERGENTE:' || linked.transaction_id, 'METODO_DIVERGENTE', linked.sold_on, linked.gross_cents, 'picpay_transaction',
    linked.transaction_id, jsonb_build_object('transaction_ref', linked.transaction_ref, 'picpay_method', linked.payment_label,
      'pdv_channel', linked.integration_channel, 'pdv_card_method', linked.card_method)
  from linked where not private.picpay_kind_fits_attempt(linked.payment_kind, linked.integration_channel, linked.card_method)
  union all
  select 'TRANSACAO_DEVOLVIDA:' || linked.transaction_id, 'TRANSACAO_DEVOLVIDA', linked.sold_on, linked.gross_cents, 'picpay_transaction',
    linked.transaction_id, jsonb_build_object('transaction_ref', linked.transaction_ref, 'sale_id', linked.sale_id)
  from linked where linked.status = 'DEVOLVIDA'
    and not exists (select 1 from public.financial_ledger_entries refund where refund.sale_id = linked.sale_id and refund.entry_type = 'REFUND')
  union all
  select 'STATUS_DIVERGENTE:' || tx.transaction_id, 'STATUS_DIVERGENTE', tx.sold_on, tx.gross_cents, 'picpay_transaction', tx.transaction_id,
    jsonb_build_object('transaction_ref', tx.transaction_ref, 'status_conflict', tx.status_conflict, 'amount_conflict', tx.amount_conflict)
  from private.picpay_transactions_view tx where tx.status_conflict or tx.amount_conflict
  union all
  select 'LIQUIDACAO_SEM_EXPLICACAO:' || day.payment_on, 'LIQUIDACAO_SEM_EXPLICACAO', day.payment_on, day.settled_cents - day.expected_net_cents,
    'settlement_day', null::uuid, jsonb_build_object('expected_cents', day.expected_net_cents, 'settled_cents', day.settled_cents)
  from private.picpay_settlement_days() day where day.status = 'EXCEDENTE'
  union all
  select 'RECEBIVEL_EM_ATRASO:' || day.payment_on, 'RECEBIVEL_EM_ATRASO', day.payment_on, day.expected_net_cents - day.settled_cents,
    'settlement_day', null::uuid, jsonb_build_object('expected_cents', day.expected_net_cents, 'settled_cents', day.settled_cents)
  from private.picpay_settlement_days() day where day.status in ('EM_ATRASO', 'PARCIAL')
  union all
  select 'RECEBIVEL_INCONSISTENTE:' || receivable.installment_id, 'RECEBIVEL_INCONSISTENTE', receivable.payment_on, receivable.net_cents,
    'picpay_receivable', receivable.installment_id,
    jsonb_build_object('transaction_ref', receivable.transaction_ref, 'installment', receivable.installment_number,
      'transaction_status', tx.status, 'transaction_net_cents', tx.net_cents)
  from private.picpay_receivable_state receivable
  left join private.picpay_transaction_state tx on tx.transaction_ref = receivable.transaction_ref
  where tx.transaction_id is not null and (tx.status <> 'APROVADA'
    or (receivable.installments_total = 1 and receivable.net_cents <> tx.net_cents))
  union all
  select 'DUPLICIDADE:' || conflict.id, 'DUPLICIDADE', conflict.occurred_on, conflict.amount_cents, 'statement_conflict', conflict.id,
    jsonb_build_object('movement', conflict.movement, 'known_count', conflict.known_count, 'observed_count', conflict.observed_count,
      'import_number', import.number)
  from public.picpay_statement_duplicate_conflicts conflict join public.picpay_statement_imports import on import.id = conflict.import_id
  union all
  select 'EXTRATO_NAO_CLASSIFICADO:' || line.id, 'EXTRATO_NAO_CLASSIFICADO', line.occurred_on, line.amount_cents, 'statement_line', line.id,
    jsonb_build_object('movement', line.movement, 'movement_label', line.movement_label, 'line_number', line.line_number, 'import_number', import.number)
  from public.picpay_statement_lines line
  join public.picpay_statement_imports import on import.id = line.import_id
  left join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where current.id is null or current.resolution = 'REABERTA'
  union all
  -- A line classified by hand as historical revenue while Minhas vendas already carries that revenue: counted twice.
  select 'RECEITA_DUPLICADA:' || line.id, 'RECEITA_DUPLICADA', line.occurred_on, line.amount_cents, 'statement_line', line.id,
    jsonb_build_object('movement', line.movement, 'line_number', line.line_number)
  from public.picpay_statement_lines line
  join private.picpay_statement_current_resolutions current on current.line_id = line.id
  where current.resolution = 'CLASSIFICADA' and current.category = 'RECEITA_HISTORICA'
    and ((line.movement = 'PIX_RECEBIDO' and exists (select 1 from private.picpay_transactions_view tx where tx.historical
        and tx.payment_kind = 'PIX' and tx.sold_on = line.occurred_on and tx.gross_cents = line.amount_cents))
      or (line.movement = 'RECEBIVEIS_VENDA' and exists (select 1 from private.picpay_transactions_view tx where tx.historical
        and tx.payment_kind <> 'PIX' and tx.expected_payment_on = line.occurred_on)))
  union all
  -- A card sale settled by the manual reconciliation route would also be settled by the Extrato: never twice.
  select 'LIQUIDACAO_DUPLICADA:' || attempt.id, 'LIQUIDACAO_DUPLICADA', (settlement.created_at at time zone 'America/Sao_Paulo')::date,
    settlement.amount_cents, 'payment_attempt', attempt.id, jsonb_build_object('sale_id', attempt.sale_id)
  from public.payment_attempts attempt
  join public.financial_ledger_entries settlement on settlement.payment_attempt_id = attempt.id and settlement.entry_type = 'SETTLEMENT'
  where attempt.integration_channel in ('MAQUININHA', 'TAP')
  union all
  select 'SALDO_DIVERGENTE:' || checked.id, 'SALDO_DIVERGENTE', checked.as_of, checked.total_difference_cents, 'balance_check', checked.id,
    jsonb_build_object('free_difference_cents', checked.free_difference_cents, 'vault_difference_cents', checked.vault_difference_cents)
  from (select * from public.finance_balance_checks order by number desc limit 1) checked
  where checked.status = 'DIVERGENTE';
$$;

create function private.picpay_exceptions()
returns table (exception_key text, type text, occurred_on date, amount_cents bigint, subject_type text, subject_id uuid, details jsonb,
  resolved boolean, resolution_reason text, resolved_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select row.*, coalesce(decision.action = 'RESOLVIDA', false), decision.reason, decision.created_at
  from private.picpay_exception_rows() row
  left join private.picpay_open_exception_resolutions decision on decision.exception_key = row.exception_key;
$$;

-- The reconciliation of a São Paulo period across the three perspectives.
create function private.picpay_reconciliation_summary_json(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with position as (select operating_since from private.current_finance_opening_position()),
  pdv as (
    select attempt.id from public.payment_attempts attempt
    where attempt.status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING') and attempt.integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')
      and (coalesce(attempt.confirmed_at, attempt.created_at) at time zone 'America/Sao_Paulo')::date between p_from and p_to
  ),
  tx as (select * from private.picpay_transactions_view where sold_on between p_from and p_to),
  exceptions as (select * from private.picpay_exceptions() where occurred_on between p_from and p_to and not resolved),
  lines as (
    select line.*, current.resolution from public.picpay_statement_lines line
    left join private.picpay_statement_current_resolutions current on current.line_id = line.id
    where line.occurred_on between p_from and p_to
  ),
  settlement as (select * from private.picpay_settlement_days())
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'operating_since', (select operating_since from position),
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
      'by_type', coalesce((select jsonb_object_agg(type, total) from (select type, count(*) as total from exceptions group by type) grouped), '{}'::jsonb)),
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
      'pending_lines', (select count(*) from lines where resolution is null or resolution = 'REABERTA')),
    'balances', (select jsonb_build_object('as_of', balances.as_of, 'free_balance_cents', balances.free, 'vault_balance_cents', balances.vault,
        'available_balance_cents', balances.free + balances.vault, 'receivables_balance_cents', balances.receivables,
        'pix_clearing_cents', balances.clearing, 'cash_balance_cents', balances.cash)
      from (select least(p_to, (now() at time zone 'America/Sao_Paulo')::date) as as_of,
          max(balance_cents) filter (where account = 'PICPAY_EMPRESAS') as free, max(balance_cents) filter (where account = 'COFRINHO_PICPAY') as vault,
          max(balance_cents) filter (where account = 'RECEBIVEIS_PICPAY') as receivables,
          max(balance_cents) filter (where account = 'PENDENTE_LIQUIDACAO') as clearing, max(balance_cents) filter (where account = 'DINHEIRO_FISICO') as cash
        from private.finance_account_balances(least(p_to, (now() at time zone 'America/Sao_Paulo')::date))) balances),
    'status', case when (select count(*) from exceptions) = 0 then 'CONCILIADO' else 'COM_PENDENCIAS' end);
$$;

-- Periods evaluated before and touched by new evidence go back to review, with the import that touched them.
create function private.picpay_flag_periods_for_review(p_from date, p_to date, p_reason text, p_actor_id uuid, p_correlation_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.picpay_reconciliation_period_events (period_id, status, open_exceptions, summary, reason, actor_id, correlation_id)
  select period.id, 'REVISAR', 0, '{}'::jsonb, p_reason, p_actor_id, p_correlation_id
  from public.picpay_reconciliation_periods period
  join lateral (select status from public.picpay_reconciliation_period_events event where event.period_id = period.id
    order by event.sequence desc limit 1) latest on true
  where latest.status <> 'REVISAR' and period.period_from <= p_to and period.period_to >= p_from;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Imports one PicPay export of any type, detected from its header; the same file is refused. Then reconciles.
create function public.import_picpay_file(p_file_name text, p_content text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_type public.picpay_source_type;
  v_sha256 text;
  v_file_name text;
  v_import_id uuid;
  v_import jsonb;
  v_engine jsonb;
  v_flagged integer;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_file_name := left(btrim(regexp_replace(regexp_replace(coalesce(p_file_name, ''), '^.*[\\/]', ''), '[0-9]{11,}', '[doc]', 'g')), 200);
  if p_correlation_id is null or p_content is null or char_length(p_content) > 4000000 or v_file_name = '' then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILE';
  end if;
  v_type := private.detect_picpay_source(p_content);
  if v_type is null then
    raise exception using errcode = '22023', message = 'PICPAY_FILE_UNKNOWN';
  end if;
  v_sha256 := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'import_picpay_file', v_actor_id), p_idempotency_key,
    jsonb_build_object('sha256', v_sha256, 'file_name', v_file_name));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  -- One PicPay import at a time: deduplication and reconciliation see every earlier file.
  perform pg_advisory_xact_lock(hashtextextended('picpay-statement-import', 0));
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));
  if exists (select 1 from public.picpay_source_imports where file_sha256 = v_sha256)
    or exists (select 1 from public.picpay_statement_imports where file_sha256 = v_sha256) then
    raise exception using errcode = 'P0001', message = 'PICPAY_FILE_ALREADY_IMPORTED';
  end if;
  v_import_id := case v_type
    when 'PICPAY_SALES' then private.import_picpay_sales_file(v_file_name, p_content, v_sha256, v_actor_id, p_correlation_id)
    when 'PICPAY_RECEIVABLES' then private.import_picpay_receivables_file(v_file_name, p_content, v_sha256, v_actor_id, p_correlation_id)
    else private.import_picpay_statement_file(v_file_name, p_content, v_sha256, v_actor_id, p_correlation_id)
  end;
  v_engine := private.run_picpay_reconciliation(v_actor_id, p_correlation_id);
  v_import := private.picpay_import_json(v_type, v_import_id);
  v_flagged := private.picpay_flag_periods_for_review((v_import ->> 'period_from')::date, (v_import ->> 'period_to')::date,
    'Nova evidência: arquivo ' || (v_import ->> 'number') || ' de ' || case v_type when 'PICPAY_SALES' then 'Minhas vendas'
      when 'PICPAY_RECEIVABLES' then 'Recebíveis' else 'Extrato' end, v_actor_id, p_correlation_id);

  v_result := v_import || jsonb_build_object('reconciliation', v_engine, 'periods_flagged', v_flagged, 'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.file_imported', v_actor_id, 'picpay_import', v_import_id::text, p_correlation_id,
    jsonb_build_object('source_type', v_type, 'number', v_import -> 'number', 'file_sha256', v_sha256, 'row_count', v_import -> 'row_count',
      'period_from', v_import -> 'period_from', 'period_to', v_import -> 'period_to', 'new_count', v_import -> 'new_count',
      'known_count', v_import -> 'known_count', 'updated_count', v_import -> 'updated_count', 'ambiguous_count', v_import -> 'ambiguous_count',
      'reconciliation', v_engine, 'periods_flagged', v_flagged));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.picpay.file_imported', 'picpay_import', v_import_id::text,
    jsonb_build_object('import_id', v_import_id, 'source_type', v_type, 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_import', v_import_id::text);
  return v_result;
end;
$$;

-- Every imported PicPay file, newest first.
create function public.list_picpay_imports(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(item order by (item ->> 'created_at') desc) from (
    select private.picpay_import_json(kind, id) as item from (
      select 'PICPAY_STATEMENT'::public.picpay_source_type as kind, id, created_at from public.picpay_statement_imports
      union all
      select source_type, id, created_at from public.picpay_source_imports
      order by created_at desc limit p_limit) recent) items), '[]'::jsonb);
end;
$$;

create function public.picpay_reconciliation_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return private.picpay_reconciliation_summary_json(p_from, p_to);
end;
$$;

create function public.list_picpay_exceptions(p_from date, p_to date, p_type text default null, p_include_resolved boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'key', exception_key, 'type', type, 'occurred_on', occurred_on, 'amount_cents', amount_cents, 'subject_type', subject_type,
      'subject_id', subject_id, 'details', details, 'resolved', resolved, 'resolution_reason', resolution_reason, 'resolved_at', resolved_at)
    order by occurred_on, type, exception_key)
    from (select * from private.picpay_exceptions()
      where occurred_on between p_from and p_to and (p_type is null or type = p_type) and (coalesce(p_include_resolved, false) or not resolved)
      order by occurred_on, type, exception_key limit 500) page), '[]'::jsonb);
end;
$$;

create function public.resolve_picpay_exception(p_key text, p_action text, p_reason text, p_idempotency_key text, p_correlation_id uuid)
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

-- Links a PicPay transaction to a PDV payment by hand (or unlinks it), with a reason; one attempt per transaction.
create function public.link_picpay_transaction(
  p_transaction_id uuid, p_payment_attempt_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_reason text := btrim(p_reason);
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_transaction_id is null or v_reason is null or char_length(v_reason) not between 8 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_LINK';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'link_picpay_transaction', v_actor_id), p_idempotency_key,
    jsonb_build_object('transaction_id', p_transaction_id, 'payment_attempt_id', p_payment_attempt_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('picpay-reconciliation', 0));
  if not exists (select 1 from public.picpay_transactions where id = p_transaction_id) then
    raise exception using errcode = 'P0001', message = 'PICPAY_TRANSACTION_NOT_FOUND';
  end if;
  if p_payment_attempt_id is null then
    if not exists (select 1 from private.picpay_current_links where transaction_id = p_transaction_id) then
      raise exception using errcode = 'P0001', message = 'PICPAY_TRANSACTION_NOT_LINKED';
    end if;
  else
    if not exists (select 1 from public.payment_attempts where id = p_payment_attempt_id
      and status in ('APPROVED', 'RECONCILED', 'RECONCILIATION_PENDING') and integration_channel in ('PIX_AREA', 'MAQUININHA', 'TAP')) then
      raise exception using errcode = 'P0001', message = 'PICPAY_PAYMENT_NOT_LINKABLE';
    end if;
    if exists (select 1 from private.picpay_current_links where payment_attempt_id = p_payment_attempt_id)
      or exists (select 1 from private.picpay_current_links where transaction_id = p_transaction_id) then
      raise exception using errcode = 'P0001', message = 'PICPAY_ALREADY_LINKED';
    end if;
  end if;
  insert into public.picpay_transaction_links (transaction_id, payment_attempt_id, action, automatic, evidence, reason, actor_id, correlation_id)
  values (p_transaction_id, p_payment_attempt_id, case when p_payment_attempt_id is null then 'UNLINK' else 'LINK' end, false, 'MANUAL',
    v_reason, v_actor_id, p_correlation_id);
  v_result := jsonb_build_object('transaction_id', p_transaction_id, 'payment_attempt_id', p_payment_attempt_id,
    'action', case when p_payment_attempt_id is null then 'UNLINK' else 'LINK' end, 'correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.transaction_linked', v_actor_id, 'picpay_transaction', p_transaction_id::text, p_correlation_id,
    jsonb_build_object('payment_attempt_id', p_payment_attempt_id, 'reason', v_reason));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'picpay_transaction', p_transaction_id::text);
  return v_result;
end;
$$;

-- Transactions of Minhas vendas with their status, fees, cutover side and PDV link (filters by period and status).
create function public.list_picpay_transactions(p_from date, p_to date, p_status public.picpay_transaction_status default null,
  p_unlinked_only boolean default false, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 or p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', tx.transaction_id, 'transaction_ref', tx.transaction_ref, 'sold_at', tx.sold_at, 'expected_payment_on', tx.expected_payment_on,
      'method', tx.payment_label, 'kind', tx.payment_kind, 'capture', tx.capture_solution, 'terminal', tx.terminal_number, 'brand', tx.brand,
      'card_last4', tx.card_last4, 'status', tx.status, 'gross_cents', tx.gross_cents, 'fee_cents', tx.total_fee_cents, 'net_cents', tx.net_cents,
      'cancelled_cents', tx.cancelled_cents, 'installments', tx.installments, 'historical', tx.historical,
      'payment_attempt_id', tx.payment_attempt_id, 'link_evidence', tx.link_evidence, 'observations', tx.observation_count,
      'imports', (select jsonb_agg(import.number order by import.number) from public.picpay_transaction_observations observation
        join public.picpay_source_imports import on import.id = observation.import_id where observation.transaction_id = tx.transaction_id))
    order by tx.sold_at desc)
    from (select * from private.picpay_transactions_view
      where sold_on between p_from and p_to and (p_status is null or status = p_status)
        and (not coalesce(p_unlinked_only, false) or payment_attempt_id is null)
      order by sold_at desc limit p_limit) tx), '[]'::jsonb);
end;
$$;

-- Card settlement days and the current receivable snapshot.
create function public.list_picpay_settlements(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('payment_on', payment_on, 'expected_net_cents', expected_net_cents,
        'expected_count', expected_count, 'settled_cents', settled_cents, 'settled_lines', settled_lines,
        'receivable_snapshot_cents', receivable_snapshot_cents, 'statement_covered', statement_covered, 'status', status) order by payment_on)
      from private.picpay_settlement_days() where payment_on between p_from and p_to), '[]'::jsonb),
    'receivables', coalesce((select jsonb_agg(jsonb_build_object('id', installment_id, 'transaction_ref', transaction_ref,
        'installment', installment_number, 'installments_total', installments_total, 'payment_on', payment_on, 'status', status_label,
        'gross_cents', gross_cents, 'discount_cents', discount_cents, 'net_cents', net_cents, 'terminal', terminal_number,
        'snapshots', snapshot_count, 'last_snapshot', import_number) order by payment_on, transaction_ref)
      from private.picpay_receivable_state where payment_on between p_from and p_to), '[]'::jsonb));
end;
$$;

create function public.run_picpay_reconciliation(p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  v_result := private.run_picpay_reconciliation(auth.uid(), p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.picpay.reconciled', auth.uid(), 'picpay_reconciliation', p_correlation_id::text, p_correlation_id, v_result);
  return v_result;
end;
$$;

-- Evaluates a period: CONCILIADO with no open exception, otherwise COM_PENDENCIAS. Later evidence may send it to REVISAR.
create function public.close_picpay_period(p_from date, p_to date, p_note text, p_idempotency_key text, p_correlation_id uuid)
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
  v_open := (v_summary -> 'exceptions' ->> 'total')::integer;
  v_status := case when v_open = 0 then 'CONCILIADO' else 'COM_PENDENCIAS' end;
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

create function public.list_picpay_periods(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_PICPAY_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', period.id, 'number', period.number, 'period_from', period.period_from,
      'period_to', period.period_to, 'note', period.note, 'status', latest.status, 'open_exceptions', first_event.open_exceptions,
      'status_reason', latest.reason, 'status_at', latest.created_at,
      'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', period.created_at) order by period.number desc)
    from (select * from public.picpay_reconciliation_periods order by number desc limit p_limit) period
    join public.profiles actor on actor.id = period.actor_id
    join lateral (select * from public.picpay_reconciliation_period_events event where event.period_id = period.id order by event.sequence desc limit 1) latest on true
    join lateral (select * from public.picpay_reconciliation_period_events event where event.period_id = period.id order by event.sequence limit 1) first_event on true),
    '[]'::jsonb);
end;
$$;

revoke all on function private.picpay_kind_fits_attempt(public.picpay_payment_kind, public.payment_integration_channel, public.card_payment_method)
  from public, anon, authenticated, service_role;
revoke all on function private.picpay_acquirer_effects(date, date) from public, anon, authenticated, service_role;
revoke all on function private.picpay_settlement_days() from public, anon, authenticated, service_role;
revoke all on function private.run_picpay_reconciliation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.picpay_reconcile_after_opening() from public, anon, authenticated, service_role;
revoke all on function private.picpay_exception_rows() from public, anon, authenticated, service_role;
revoke all on function private.picpay_exceptions() from public, anon, authenticated, service_role;
revoke all on function private.picpay_reconciliation_summary_json(date, date) from public, anon, authenticated, service_role;
revoke all on function private.picpay_flag_periods_for_review(date, date, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.import_picpay_file(text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_imports(integer) from public, anon, authenticated, service_role;
revoke all on function public.picpay_reconciliation_summary(date, date) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_exceptions(date, date, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.resolve_picpay_exception(text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.link_picpay_transaction(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_transactions(date, date, public.picpay_transaction_status, boolean, integer) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_settlements(date, date) from public, anon, authenticated, service_role;
revoke all on function public.run_picpay_reconciliation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.close_picpay_period(date, date, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_picpay_periods(integer) from public, anon, authenticated, service_role;
grant execute on function public.import_picpay_file(text, text, text, uuid) to authenticated;
grant execute on function public.list_picpay_imports(integer) to authenticated;
grant execute on function public.picpay_reconciliation_summary(date, date) to authenticated;
grant execute on function public.list_picpay_exceptions(date, date, text, boolean) to authenticated;
grant execute on function public.resolve_picpay_exception(text, text, text, text, uuid) to authenticated;
grant execute on function public.link_picpay_transaction(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.list_picpay_transactions(date, date, public.picpay_transaction_status, boolean, integer) to authenticated;
grant execute on function public.list_picpay_settlements(date, date) to authenticated;
grant execute on function public.run_picpay_reconciliation(uuid) to authenticated;
grant execute on function public.close_picpay_period(date, date, text, text, uuid) to authenticated;
grant execute on function public.list_picpay_periods(integer) to authenticated;

comment on function public.import_picpay_file(text, text, text, uuid) is
  'Imports a PicPay export (Minhas vendas, Recebíveis or Extrato, detected from the header) with cross-file deduplication, then reconciles.';
