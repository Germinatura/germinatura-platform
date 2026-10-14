-- H1 (recebimentos): an automatic lot code for deliveries whose producer prints none.
--
-- Format PREFIX-DDMMYY-NN (e.g. BKI-131026-01), the pattern already typed by hand:
--   * PREFIX comes from the product name, decided by the database: initial of the first word + first two letters of the
--     second (Brownie Kinder -> BKI, Brownie Ninho -> BNI); one-word names use their first three letters. Accents and
--     connectives (de, com, e, ...) are ignored; short names are completed with X.
--   * DDMMYY is the delivery date (America/Sao_Paulo calendar day, as the receipt itself).
--   * NN is reserved here, per cohort + prefix + day, under a row lock: two people receiving at the same time never get
--     the same number, and the counter always starts above any code already typed by hand in the same pattern.
-- Uniqueness never depends on the prefix: two products with the same prefix share the counter (BNI-...-01, BNI-...-02)
-- and the lot keeps its product. A reserved number may stay unused (a gap), never repeated. Existing lots, CUTOVER-*
-- included, are never touched; lot_code keeps its rules (2-100 characters, trimmed, not unique, any supplier code).

set local lock_timeout = '5s';

create table private.purchase_lot_code_counters (
  cohort_id uuid not null references public.cohorts (id),
  prefix text not null check (prefix ~ '^[A-Z0-9]{3}$'),
  lot_day date not null,
  last_number integer not null check (last_number between 1 and 999),
  updated_at timestamptz not null default now(),
  primary key (cohort_id, prefix, lot_day)
);
comment on table private.purchase_lot_code_counters is
  'Último número de lote automático reservado por turma, prefixo e dia (H1). Só a função reserve_purchase_lot_code escreve.';
revoke all on private.purchase_lot_code_counters from public, anon, authenticated, service_role;

-- Deterministic prefix of a product name.
create function private.purchase_lot_prefix(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_clean text := regexp_replace(
    translate(upper(coalesce(p_name, '')), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9]+', ' ', 'g');
  v_words text[];
  v_prefix text;
begin
  select coalesce(array_agg(word order by ordinality), '{}') into v_words
  from unnest(regexp_split_to_array(btrim(v_clean), ' ')) with ordinality as word
  where word <> '' and word not in ('DE', 'DA', 'DO', 'DAS', 'DOS', 'COM', 'SEM', 'E', 'A', 'O', 'AS', 'OS', 'AO', 'EM', 'NA', 'NO', 'P', 'PARA');
  if cardinality(v_words) = 0 then
    v_prefix := 'LOT';
  elsif cardinality(v_words) = 1 then
    v_prefix := left(v_words[1], 3);
  else
    v_prefix := left(v_words[1], 1) || left(v_words[2], 2) || left(coalesce(v_words[3], ''), 1);
  end if;
  return rpad(left(v_prefix, 3), 3, 'X');
end;
$$;

-- Reserves the next automatic lot code of an order item for a delivery date.
create function public.reserve_purchase_lot_code(p_order_item_id uuid, p_received_on date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_cohort uuid;
  v_item cohort_data.purchase_order_items%rowtype;
  v_name text;
  v_prefix text;
  v_day text;
  v_existing integer;
  v_number integer;
begin
  if v_actor is null then raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('procurement.manage') then raise exception using errcode = '42501', message = 'PROCUREMENT_MANAGE_FORBIDDEN'; end if;
  if p_order_item_id is null or p_received_on is null or p_received_on > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception using errcode = '22023', message = 'INVALID_LOT_CODE_REQUEST';
  end if;
  -- Definer code reads the base tables, so the request cohort is enforced here (raises COHORT_REQUIRED without one).
  v_cohort := private.cohort_write_id();
  select * into v_item from cohort_data.purchase_order_items where id = p_order_item_id and cohort_id = v_cohort;
  if not found then raise exception using errcode = 'P0001', message = 'PURCHASE_ORDER_ITEM_NOT_FOUND'; end if;
  select name into v_name from cohort_data.products where id = v_item.product_id and cohort_id = v_cohort;
  if v_name is null then raise exception using errcode = 'P0001', message = 'PURCHASE_ORDER_ITEM_NOT_FOUND'; end if;

  v_prefix := private.purchase_lot_prefix(v_name);
  v_day := to_char(p_received_on, 'DDMMYY');
  -- Codes already typed in the same pattern (any product of the cohort) are never generated again.
  select coalesce(max(substring(lot_code from '-([0-9]{2,3})$')::integer), 0) into v_existing
  from cohort_data.inventory_lots
  where cohort_id = v_cohort and lot_code ~ ('^' || v_prefix || '-' || v_day || '-[0-9]{2,3}$');

  insert into private.purchase_lot_code_counters as counter (cohort_id, prefix, lot_day, last_number)
  values (v_cohort, v_prefix, p_received_on, v_existing + 1)
  on conflict (cohort_id, prefix, lot_day) do update
    set last_number = greatest(counter.last_number, v_existing) + 1, updated_at = now()
  returning last_number into v_number;

  return jsonb_build_object(
    'lot_code', v_prefix || '-' || v_day || '-' || lpad(v_number::text, 2, '0'),
    'prefix', v_prefix,
    'sequence', v_number,
    'received_on', p_received_on
  );
end;
$$;
revoke all on function public.reserve_purchase_lot_code(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.reserve_purchase_lot_code(uuid, date) to authenticated;
revoke all on function private.purchase_lot_prefix(text) from public, anon, authenticated, service_role;
