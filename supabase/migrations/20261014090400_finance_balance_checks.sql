-- Spec 5.8 (FIN-003): formal balance check against the position observed in PicPay.
--
-- Finance types the free and Cofrinho balances it sees in PicPay for a São Paulo day; the database computes the
-- same figures through private.finance_account_balances and stores both, with the differences and the imported
-- lines that carried no effect of their own at that moment. CONCILIADO only when every difference is zero.
-- A difference never creates an adjustment: it is shown, kept and investigated; an adjustment is a separate,
-- explicit entry with its own reason.

create table public.finance_balance_checks (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  as_of date not null,
  opening_position_id uuid references public.finance_opening_positions(id) on delete restrict,
  observed_free_cents bigint not null check (observed_free_cents between 0 and 9007199254740991),
  observed_vault_cents bigint not null check (observed_vault_cents between 0 and 9007199254740991),
  computed_free_cents bigint not null,
  computed_vault_cents bigint not null,
  computed_receivables_cents bigint not null,
  computed_cash_cents bigint not null,
  free_difference_cents bigint not null,
  vault_difference_cents bigint not null,
  total_difference_cents bigint not null,
  statement_lines jsonb not null,
  status text not null check (status in ('CONCILIADO', 'DIVERGENTE')),
  note text check (note is null or (char_length(note) between 3 and 500 and note = btrim(note))),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint finance_balance_checks_differences_valid check (
    free_difference_cents = computed_free_cents - observed_free_cents
    and vault_difference_cents = computed_vault_cents - observed_vault_cents
    and total_difference_cents = free_difference_cents + vault_difference_cents
    and (status = 'CONCILIADO') = (free_difference_cents = 0 and vault_difference_cents = 0)
  )
);
create index finance_balance_checks_as_of_idx on public.finance_balance_checks (as_of desc, number desc);
create trigger finance_balance_checks_immutable before update or delete on public.finance_balance_checks
for each row execute function private.prevent_immutable_record_change();
alter table public.finance_balance_checks enable row level security;
revoke all on public.finance_balance_checks from public, anon, authenticated, service_role;

create function private.finance_balance_check_json(p_check_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', checked.id, 'number', checked.number, 'as_of', checked.as_of, 'opening_position_id', checked.opening_position_id,
    'observed_free_cents', checked.observed_free_cents, 'observed_vault_cents', checked.observed_vault_cents,
    'observed_total_cents', checked.observed_free_cents + checked.observed_vault_cents,
    'computed_free_cents', checked.computed_free_cents, 'computed_vault_cents', checked.computed_vault_cents,
    'computed_total_cents', checked.computed_free_cents + checked.computed_vault_cents,
    'computed_receivables_cents', checked.computed_receivables_cents, 'computed_cash_cents', checked.computed_cash_cents,
    'free_difference_cents', checked.free_difference_cents, 'vault_difference_cents', checked.vault_difference_cents,
    'total_difference_cents', checked.total_difference_cents, 'statement_lines', checked.statement_lines,
    'status', checked.status, 'note', checked.note,
    'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', checked.created_at)
  from public.finance_balance_checks checked
  join public.profiles actor on actor.id = checked.actor_id
  where checked.id = p_check_id;
$$;

create function public.record_finance_balance_check(
  p_as_of date, p_observed_free_cents bigint, p_observed_vault_cents bigint, p_note text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_claim record;
  v_position public.finance_opening_positions%rowtype;
  v_check_id uuid := gen_random_uuid();
  v_note text := nullif(btrim(p_note), '');
  v_free bigint;
  v_vault bigint;
  v_receivables bigint;
  v_cash bigint;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_as_of is null or p_as_of > (now() at time zone 'America/Sao_Paulo')::date
    or p_observed_free_cents is null or p_observed_free_cents not between 0 and 9007199254740991
    or p_observed_vault_cents is null or p_observed_vault_cents not between 0 and 9007199254740991
    or (v_note is not null and char_length(v_note) not between 3 and 500) then
    raise exception using errcode = '22023', message = 'INVALID_BALANCE_CHECK';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance', 'record_balance_check', v_actor_id), p_idempotency_key,
    jsonb_build_object('as_of', p_as_of, 'observed_free_cents', p_observed_free_cents,
      'observed_vault_cents', p_observed_vault_cents, 'note', v_note));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_position from private.current_finance_opening_position();
  if v_position.id is not null and p_as_of < v_position.as_of then
    raise exception using errcode = '22023', message = 'INVALID_BALANCE_CHECK';
  end if;

  select
    max(balance_cents) filter (where account = 'PICPAY_EMPRESAS'), max(balance_cents) filter (where account = 'COFRINHO_PICPAY'),
    max(balance_cents) filter (where account = 'RECEBIVEIS_PICPAY'), max(balance_cents) filter (where account = 'DINHEIRO_FISICO')
  into v_free, v_vault, v_receivables, v_cash
  from private.finance_account_balances(p_as_of);

  insert into public.finance_balance_checks (
    id, as_of, opening_position_id, observed_free_cents, observed_vault_cents, computed_free_cents, computed_vault_cents,
    computed_receivables_cents, computed_cash_cents, free_difference_cents, vault_difference_cents, total_difference_cents,
    statement_lines, status, note, actor_id, correlation_id
  ) values (
    v_check_id, p_as_of, v_position.id, p_observed_free_cents, p_observed_vault_cents, v_free, v_vault, v_receivables, v_cash,
    v_free - p_observed_free_cents, v_vault - p_observed_vault_cents,
    (v_free - p_observed_free_cents) + (v_vault - p_observed_vault_cents),
    private.finance_statement_unapplied(p_as_of),
    case when v_free = p_observed_free_cents and v_vault = p_observed_vault_cents then 'CONCILIADO' else 'DIVERGENTE' end,
    v_note, v_actor_id, p_correlation_id
  );

  v_result := private.finance_balance_check_json(v_check_id) || jsonb_build_object('correlation_id', p_correlation_id);
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('finance.balance_check.recorded', v_actor_id, 'finance_balance_check', v_check_id::text, p_correlation_id,
    jsonb_build_object('as_of', p_as_of, 'status', v_result -> 'status', 'free_difference_cents', v_result -> 'free_difference_cents',
      'vault_difference_cents', v_result -> 'vault_difference_cents', 'total_difference_cents', v_result -> 'total_difference_cents'));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('finance.balance_check.recorded', 'finance_balance_check', v_check_id::text,
    jsonb_build_object('check_id', v_check_id, 'status', v_result -> 'status', 'correlation_id', p_correlation_id));
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'finance_balance_check', v_check_id::text);
  return v_result;
end;
$$;

create function public.list_finance_balance_checks(p_before_number bigint default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'INVALID_BALANCE_CHECK';
  end if;
  select array_agg(page.id order by page.number desc) into v_ids from (
    select id, number from public.finance_balance_checks
    where p_before_number is null or number < p_before_number
    order by number desc limit p_limit + 1
  ) page;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.finance_balance_check_json(id) order by ordinality)
      from unnest(v_ids) with ordinality id where ordinality <= p_limit), '[]'::jsonb),
    'next_before', case when coalesce(array_length(v_ids, 1), 0) > p_limit
      then (select number from public.finance_balance_checks where id = v_ids[p_limit]) end);
end;
$$;

revoke all on function private.finance_balance_check_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_finance_balance_check(date, bigint, bigint, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_finance_balance_checks(bigint, integer) from public, anon, authenticated, service_role;
grant execute on function public.record_finance_balance_check(date, bigint, bigint, text, text, uuid) to authenticated;
grant execute on function public.list_finance_balance_checks(bigint, integer) to authenticated;

comment on table public.finance_balance_checks is
  'Immutable checks of the computed free and Cofrinho balances against the position observed in PicPay; never an adjustment.';
