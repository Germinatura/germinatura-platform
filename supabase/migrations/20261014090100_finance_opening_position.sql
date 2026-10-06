-- Spec 5.8 (FIN-002): opening position of the treasury accounts at the cutover.
--
-- The opening position is the money that already existed at the start of `as_of` (São Paulo day) in each
-- account. It is a concept of its own: it composes the balance and appears in the statement, but it is never
-- income, expense, transfer, sale, result, margin or fundraising progress.
--
-- `operating_since` is the first day the operation is recorded natively in the Germinatura. Imported statement
-- lines dated before it are cutover history: they never settle internal sales or receivables, and inflows may be
-- classified as RECEITA_HISTORICA. From `operating_since` on, everything follows the normal rules.
--
-- Immutable: a correction is a new version that supersedes the current one, with a reason. Exactly one version is
-- current (the highest), and versions form a single chain.

create table public.finance_opening_positions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version >= 1),
  as_of date not null,
  operating_since date not null,
  description text not null check (char_length(description) between 3 and 300 and description = btrim(description)),
  reason text check (reason is null or (char_length(reason) between 8 and 300 and reason = btrim(reason))),
  supersedes_id uuid unique references public.finance_opening_positions(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint finance_opening_positions_dates_valid check (operating_since > as_of),
  constraint finance_opening_positions_chain_valid check (
    (version = 1 and supersedes_id is null and reason is null)
    or (version > 1 and supersedes_id is not null and reason is not null)
  )
);

create table public.finance_opening_position_lines (
  position_id uuid not null references public.finance_opening_positions(id) on delete restrict,
  account public.finance_account not null
    check (account in ('PICPAY_EMPRESAS', 'COFRINHO_PICPAY', 'RECEBIVEIS_PICPAY', 'DINHEIRO_FISICO')),
  amount_cents bigint not null check (amount_cents between 0 and 9007199254740991),
  primary key (position_id, account)
);

create trigger finance_opening_positions_immutable before update or delete on public.finance_opening_positions
for each row execute function private.prevent_immutable_record_change();
create trigger finance_opening_position_lines_immutable before update or delete on public.finance_opening_position_lines
for each row execute function private.prevent_immutable_record_change();
alter table public.finance_opening_positions enable row level security;
alter table public.finance_opening_position_lines enable row level security;
revoke all on public.finance_opening_positions, public.finance_opening_position_lines from public, anon, authenticated, service_role;

-- The current version, or no row when the cutover was never recorded.
create function private.current_finance_opening_position()
returns setof public.finance_opening_positions
language sql stable security definer set search_path = '' as $$
  select * from public.finance_opening_positions order by version desc limit 1;
$$;

create function private.finance_opening_position_json(p_position_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', position.id, 'version', position.version, 'as_of', position.as_of, 'operating_since', position.operating_since,
    'description', position.description, 'reason', position.reason, 'supersedes_id', position.supersedes_id,
    'accounts', (select jsonb_object_agg(line.account, line.amount_cents) from public.finance_opening_position_lines line
      where line.position_id = position.id),
    'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email), 'created_at', position.created_at)
  from public.finance_opening_positions position
  join public.profiles actor on actor.id = position.actor_id
  where position.id = p_position_id;
$$;

-- Records the opening position (first version) or corrects the current one (new version with a reason).
-- The cutover must come before the statement it explains: a version is refused when lines dated before its
-- operating_since already carry a native effect (automatic receivable transfer, sale or refund reconciliation),
-- or when lines classified as historical revenue would fall on or after it.
create function public.record_finance_opening_position(
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
      and (current.resolution in ('CONCILIADA_VENDA', 'CONCILIADA_ESTORNO')
        or (current.resolution = 'TRANSFERENCIA' and current.counter_account = 'RECEBIVEIS_PICPAY'))
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

-- The current opening position and every earlier version, newest first.
create function public.get_finance_opening_position()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return jsonb_build_object(
    'current', (select private.finance_opening_position_json(id) from private.current_finance_opening_position()),
    'versions', coalesce((select jsonb_agg(private.finance_opening_position_json(id) order by version desc)
      from public.finance_opening_positions), '[]'::jsonb));
end;
$$;

revoke all on function private.current_finance_opening_position() from public, anon, authenticated, service_role;
revoke all on function private.finance_opening_position_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_finance_opening_position(date, date, bigint, bigint, bigint, bigint, text, text, uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_finance_opening_position() from public, anon, authenticated, service_role;
grant execute on function public.record_finance_opening_position(date, date, bigint, bigint, bigint, bigint, text, text, uuid, text, uuid)
  to authenticated;
grant execute on function public.get_finance_opening_position() to authenticated;

comment on table public.finance_opening_positions is
  'Opening position of the treasury accounts at the cutover; never income, expense, transfer, result or goal progress.';
comment on function public.record_finance_opening_position(date, date, bigint, bigint, bigint, bigint, text, text, uuid, text, uuid) is
  'Records the cutover opening position or a corrected version that supersedes the current one, with a reason.';
