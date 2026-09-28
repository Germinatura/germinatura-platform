-- Spec 5.8 (FIN-005): simplified category plan, treasury accounts and audited manual entries.
-- Manual entries are immutable; a mistake is undone by one compensating REVERSAL entry. Sale, reservation
-- and raffle revenue only comes from the automatic financial events, never from manual entries.

create type public.finance_category as enum (
  'VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA', 'EVENTO', 'FORNECEDOR', 'TAXAS', 'MENSALIDADES',
  'TRANSPORTE', 'MATERIAIS', 'REEMBOLSO', 'AJUSTE', 'OUTROS'
);
create type public.finance_account as enum ('PICPAY_EMPRESAS', 'DINHEIRO_FISICO', 'RECEBIVEIS_PICPAY', 'PENDENTE_LIQUIDACAO');
create type public.finance_manual_entry_kind as enum ('EXPENSE', 'INCOME', 'TRANSFER', 'REVERSAL');

create table public.finance_manual_entries (
  id uuid primary key default gen_random_uuid(),
  kind public.finance_manual_entry_kind not null,
  category public.finance_category,
  account public.finance_account not null,
  counter_account public.finance_account,
  amount_cents bigint not null check (amount_cents between 1 and 9007199254740991),
  occurred_on date not null,
  description text not null check (char_length(description) between 3 and 300 and description = btrim(description)),
  reference text check (reference is null or (reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$' and reference !~ '[0-9]{12,}')),
  reversal_of uuid unique references public.finance_manual_entries(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint finance_manual_entries_shape_valid check (
    (kind in ('EXPENSE', 'INCOME') and category is not null and counter_account is null and reversal_of is null)
    or (kind = 'TRANSFER' and category is null and counter_account is not null and counter_account <> account and reversal_of is null)
    or (kind = 'REVERSAL' and reversal_of is not null)
  ),
  constraint finance_manual_entries_no_sale_revenue check (
    category is null or category not in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA')
  )
);
create index finance_manual_entries_occurred_idx on public.finance_manual_entries (occurred_on desc, created_at desc, id desc);
create trigger finance_manual_entries_immutable before update or delete on public.finance_manual_entries
for each row execute function private.prevent_immutable_record_change();
alter table public.finance_manual_entries enable row level security;
revoke all on public.finance_manual_entries from public, anon, authenticated, service_role;

-- Signed effect of an entry on each account it touches (reversals negate the original).
create function private.finance_manual_entry_effects(p_entry public.finance_manual_entries)
returns table (account public.finance_account, amount_cents bigint)
language sql immutable set search_path = '' as $$
  select effect.account, effect.amount_cents from (
    select p_entry.account as account,
      case p_entry.kind when 'INCOME' then p_entry.amount_cents else -p_entry.amount_cents end as amount_cents
    where p_entry.kind in ('EXPENSE', 'INCOME', 'TRANSFER')
    union all
    select p_entry.counter_account, p_entry.amount_cents where p_entry.kind = 'TRANSFER'
  ) effect;
$$;

create function private.finance_manual_entry_json(p_entry_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', entry.id, 'kind', entry.kind, 'category', entry.category, 'account', entry.account,
    'counter_account', entry.counter_account, 'amount_cents', entry.amount_cents, 'occurred_on', entry.occurred_on,
    'description', entry.description, 'reference', entry.reference, 'reversal_of', entry.reversal_of,
    'reversed_by', (select reversal.id from public.finance_manual_entries reversal where reversal.reversal_of = entry.id),
    'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', entry.created_at
  )
  from public.finance_manual_entries entry
  join public.profiles actor on actor.id = entry.actor_id
  where entry.id = p_entry_id;
$$;

-- Finance records an expense, an income or a treasury transfer (a transfer is never revenue).
create function public.record_finance_entry(
  p_kind public.finance_manual_entry_kind, p_category public.finance_category, p_account public.finance_account,
  p_counter_account public.finance_account, p_amount_cents bigint, p_occurred_on date, p_description text,
  p_reference text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_entry_id uuid := gen_random_uuid(); v_result jsonb;
  v_description text := btrim(p_description); v_reference text := nullif(btrim(p_reference), '');
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_kind is null or p_kind = 'REVERSAL' or p_account is null
    or p_amount_cents is null or p_amount_cents not between 1 and 9007199254740991
    or p_occurred_on is null or p_occurred_on > (now() at time zone 'America/Sao_Paulo')::date
    or v_description is null or char_length(v_description) not between 3 and 300
    or (p_kind in ('EXPENSE', 'INCOME') and (p_category is null or p_counter_account is not null))
    or (p_kind = 'TRANSFER' and (p_category is not null or p_counter_account is null or p_counter_account = p_account)) then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE_ENTRY';
  end if;
  if p_category in ('VENDA_PDV', 'VENDA_ONLINE', 'RESERVA', 'RIFA') then
    raise exception using errcode = '22023', message = 'FINANCE_CATEGORY_AUTOMATIC_ONLY';
  end if;
  if v_reference is not null and (v_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{3,127}$' or v_reference ~ '[0-9]{12,}') then
    raise exception using errcode = '22023', message = 'INVALID_NON_SENSITIVE_REFERENCE';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'record_entry', v_actor_id), p_idempotency_key,
    jsonb_build_object('kind', p_kind, 'category', p_category, 'account', p_account, 'counter_account', p_counter_account,
      'amount_cents', p_amount_cents, 'occurred_on', p_occurred_on, 'description', v_description, 'reference', v_reference));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  insert into public.finance_manual_entries (
    id, kind, category, account, counter_account, amount_cents, occurred_on, description, reference, actor_id, correlation_id
  ) values (
    v_entry_id, p_kind, p_category, p_account, p_counter_account, p_amount_cents, p_occurred_on, v_description, v_reference,
    v_actor_id, p_correlation_id
  );
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.entry.recorded', v_actor_id, 'finance_manual_entry', v_entry_id::text, p_correlation_id,
    jsonb_build_object('kind', p_kind, 'category', p_category, 'account', p_account, 'counter_account', p_counter_account,
      'amount_cents', p_amount_cents, 'occurred_on', p_occurred_on));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.entry.recorded', 'finance_manual_entry', v_entry_id::text,
    jsonb_build_object('entry_id', v_entry_id, 'kind', p_kind, 'correlation_id', p_correlation_id));
  v_result := private.finance_manual_entry_json(v_entry_id) || jsonb_build_object('correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_manual_entry', v_entry_id::text);
  return v_result;
end;
$$;

-- Undoes a manual entry with one compensating entry dated when the correction happens.
create function public.reverse_finance_entry(p_entry_id uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_original public.finance_manual_entries%rowtype;
  v_entry_id uuid := gen_random_uuid(); v_reason text := btrim(p_reason); v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or v_reason is null or char_length(v_reason) not between 8 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_FINANCE_REVERSAL';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'reverse_entry', v_actor_id), p_idempotency_key,
    jsonb_build_object('entry_id', p_entry_id, 'reason', v_reason));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_original from public.finance_manual_entries where id = p_entry_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'FINANCE_ENTRY_NOT_FOUND';
  end if;
  if v_original.kind = 'REVERSAL' then
    raise exception using errcode = 'P0001', message = 'FINANCE_ENTRY_NOT_REVERSIBLE';
  end if;
  if exists (select 1 from public.finance_manual_entries where reversal_of = v_original.id) then
    raise exception using errcode = 'P0001', message = 'FINANCE_ENTRY_ALREADY_REVERSED';
  end if;
  insert into public.finance_manual_entries (
    id, kind, category, account, counter_account, amount_cents, occurred_on, description, reference, reversal_of,
    actor_id, correlation_id
  ) values (
    v_entry_id, 'REVERSAL', v_original.category, v_original.account, v_original.counter_account, v_original.amount_cents,
    (now() at time zone 'America/Sao_Paulo')::date, v_reason, v_original.reference, v_original.id, v_actor_id, p_correlation_id
  );
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.entry.reversed', v_actor_id, 'finance_manual_entry', v_original.id::text, p_correlation_id,
    jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', v_reason, 'amount_cents', v_original.amount_cents));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.entry.reversed', 'finance_manual_entry', v_original.id::text,
    jsonb_build_object('entry_id', v_original.id, 'reversal_entry_id', v_entry_id, 'correlation_id', p_correlation_id));
  v_result := private.finance_manual_entry_json(v_entry_id) || jsonb_build_object('correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_manual_entry', v_entry_id::text);
  return v_result;
end;
$$;

-- Manual entries of a São Paulo period (inclusive days) with per-account and per-category net effects.
create function public.list_finance_entries(
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
        'inflow_cents', coalesce(sum(amount_cents) filter (where amount_cents > 0), 0),
        'outflow_cents', coalesce(-sum(amount_cents) filter (where amount_cents < 0), 0),
        'by_account', coalesce((select jsonb_object_agg(account, total) from (
          select account, sum(amount_cents) as total from effects group by account) grouped), '{}'::jsonb),
        'by_category', coalesce((select jsonb_object_agg(category, total) from (
          select category, sum(amount_cents) as total from effects where category is not null group by category) grouped), '{}'::jsonb))
      from effects));
end;
$$;

revoke all on function private.finance_manual_entry_effects(public.finance_manual_entries) from public, anon, authenticated, service_role;
revoke all on function private.finance_manual_entry_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_finance_entry(public.finance_manual_entry_kind, public.finance_category, public.finance_account, public.finance_account, bigint, date, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reverse_finance_entry(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_finance_entries(date, date, public.finance_category, public.finance_account, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.record_finance_entry(public.finance_manual_entry_kind, public.finance_category, public.finance_account, public.finance_account, bigint, date, text, text, text, uuid) to authenticated;
grant execute on function public.reverse_finance_entry(uuid, text, text, uuid) to authenticated;
grant execute on function public.list_finance_entries(date, date, public.finance_category, public.finance_account, uuid, integer) to authenticated;

comment on table public.finance_manual_entries is 'Spec 5.8: audited manual expenses, incomes and treasury transfers; immutable, undone only by a REVERSAL entry.';
comment on function public.list_finance_entries(date, date, public.finance_category, public.finance_account, uuid, integer) is
  'Manual finance entries of a São Paulo period with net effects by account and category.';
