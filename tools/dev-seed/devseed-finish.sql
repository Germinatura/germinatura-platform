-- Moves the rows written by the seed from real time into the simulated calendar, then checks the invariants.
-- Every timestamp written during batch k moves by that batch's offset, so the order of events is preserved and a
-- row that spans batches (a shift opened in the morning and closed at night) keeps both ends in their own slot.
-- Future timestamps (expiry, raffle end, event dates) move with the row they belong to; business dates move by
-- the same number of calendar days. Immutability triggers are bypassed only for this shift of time.

create function devseed.delta_at(p_at timestamptz) returns interval language sql stable as $$
  -- Helpers also write "now() - 1 minute" (promotion and raffle starts): before the first batch, use its offset.
  select coalesce(
    (select target_start - real_start from devseed.batches where real_start <= p_at order by real_start desc limit 1),
    (select target_start - real_start from devseed.batches order by real_start limit 1));
$$;

create function devseed.remap() returns table (moved_table text, moved_rows bigint) language plpgsql as $$
declare
  v_t0 timestamptz := (select min(real_start) from devseed.batches) - interval '1 hour';
  v_t1 timestamptz := clock_timestamp();
  v_table record;
  v_anchor text;
  v_sets text;
  v_count bigint;
begin
  perform set_config('devseed.t0', v_t0::text, true);
  perform set_config('devseed.t1', v_t1::text, true);
  set local session_replication_role = replica;
  for v_table in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.data_type = 'timestamp with time zone' and c.is_generated = 'NEVER'
    group by c.table_schema, c.table_name order by c.table_name
  loop
    select coalesce(
      (select column_name from information_schema.columns where table_schema = v_table.table_schema and table_name = v_table.table_name
        and column_name = 'created_at' and data_type = 'timestamp with time zone'),
      (select column_name from information_schema.columns where table_schema = v_table.table_schema and table_name = v_table.table_name
        and data_type = 'timestamp with time zone' and is_generated = 'NEVER' order by ordinal_position limit 1))
    into v_anchor;
    select string_agg(case when data_type = 'date'
        then format('%1$I = %1$I + (((%2$I + devseed.delta_at(%2$I)) at time zone ''America/Sao_Paulo'')::date - (%2$I at time zone ''America/Sao_Paulo'')::date)', column_name, v_anchor)
        else format('%1$I = case when %1$I is null then null when %1$I between %3$L::timestamptz and %4$L::timestamptz then %1$I + devseed.delta_at(%1$I) when %1$I > %4$L::timestamptz then %1$I + devseed.delta_at(%2$I) else %1$I end',
          column_name, v_anchor, v_t0, v_t1) end, ', ')
    into v_sets
    from information_schema.columns
    where table_schema = v_table.table_schema and table_name = v_table.table_name and is_generated = 'NEVER'
      and data_type in ('timestamp with time zone', 'date');
    execute format('update %I.%I set %s where %I between %L and %L', v_table.table_schema, v_table.table_name, v_sets, v_anchor, v_t0, v_t1);
    get diagnostics v_count = row_count;
    if v_count > 0 then
      moved_table := v_table.table_name; moved_rows := v_count; return next;
    end if;
  end loop;
  -- Synthetic accounts also existed since the start of the calendar.
  update auth.users set created_at = created_at + devseed.delta_at(created_at), updated_at = updated_at + devseed.delta_at(created_at)
  where email like 'seed.%@institutojef.org.br' and created_at between v_t0 and v_t1;
end;
$$;

-- Invariants of the finished dataset; each row is a check that must report zero violations.
create function devseed.check_invariants() returns table (check_name text, violations bigint) language sql stable as $$
  select 'stock never negative', count(*) from public.inventory_balances where on_hand_quantity < 0 or reserved_quantity < 0 or reserved_quantity > on_hand_quantity
  union all
  select 'confirmed sale without exactly one confirmed payment', count(*) from public.sales sale
    where sale.status = 'CONFIRMED' and (select count(*) from public.payment_attempts attempt where attempt.sale_id = sale.id
      and attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED', 'REFUNDED')) <> 1
  union all
  select 'raffle number with two owners', count(*) from (select campaign_id, number from public.raffle_numbers group by 1, 2 having count(*) > 1) duplicated
  union all
  select 'cash received twice for one attempt', count(*) from (select payment_attempt_id from public.financial_ledger_entries
    where entry_type = 'CASH_RECEIPT' group by 1 having count(*) > 1) duplicated
  union all
  select 'more than one open shift per seller', count(*) from (select seller_id from public.seller_shifts where status = 'OPEN' group by 1 having count(*) > 1) duplicated
  union all
  select 'outbox left unprocessed', count(*) from public.outbox_events where status in ('PENDING', 'PROCESSING')
  union all
  select 'reservation holding stock after it ended', count(*) from public.commercial_reservations reservation
    join public.stock_reservations stock on stock.id = reservation.stock_reservation_id
    where reservation.status in ('CANCELLED', 'EXPIRED') and stock.status = 'ACTIVE';
$$;

-- The jobs worker's expiry pass, run once the calendar is in place (reservations left open in the past expire).
create function devseed.expire_due() returns jsonb language plpgsql as $fn$
declare v_result jsonb;
begin
  perform devseed.as_service();
  v_result := public.worker_expire_due_reservations(500);
  perform devseed.unset();
  return v_result;
end;
$fn$;

-- Throwaway local schema: helpers switch to the product roles mid-function and must stay callable from them.
grant usage on schema devseed to public;
grant execute on all functions in schema devseed to public;
grant select, insert, update on all tables in schema devseed to public;
grant usage on all sequences in schema devseed to public;
