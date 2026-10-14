-- H2b (PDV): "com quem está" each Maquininha, and the terminal the PDV preselects for a seller.
--
-- The terminal hardware stays global (private.payment_terminals) and its authorization stays per cohort
-- (cohort_payment_terminals); the person holding it is recorded on that cohort authorization (user decision: per cohort),
-- so one cohort never sees the other's holder. An assignment is an operational preference, never exclusivity:
-- confirm_manual_payment keeps accepting any active terminal of the cohort, whoever holds it.
--
-- Preselection (server-side, never localStorage): 1. an active terminal assigned to the seller; 2. the last active terminal
-- the seller used; 3. the only active terminal; 4. none. The seller can always change it.

set local lock_timeout = '5s';

alter table cohort_data.cohort_payment_terminals
  add column assigned_to uuid references public.profiles (id),
  add column assigned_at timestamptz;
-- The public view mirrors its base table (cohort_view_drift stays empty).
select private.refresh_cohort_view('cohort_payment_terminals');
comment on column cohort_data.cohort_payment_terminals.assigned_to is
  'Com quem a maquininha está nesta turma (preferência operacional, não exclusividade). Alterado só por assign_payment_terminal.';

-- People who may hold a terminal in the cohort: active members whose roles in that cohort can sell.
create function private.payment_terminal_assignable(p_cohort_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.profiles profile
    join public.user_cohorts membership on membership.user_id = profile.id and membership.cohort_id = p_cohort_id and membership.status = 'ACTIVE'
    join cohort_data.user_roles user_role on user_role.user_id = profile.id and user_role.cohort_id = p_cohort_id
    join public.role_permissions grant_row on grant_row.role_id = user_role.role_id
    join public.permissions permission on permission.id = grant_row.permission_id and permission.key = 'sales.create'
    where profile.id = p_user_id and profile.active and profile.onboarding_completed_at is not null)
$$;
revoke all on function private.payment_terminal_assignable(uuid, uuid) from public, anon, authenticated, service_role;

-- Terminals of the request cohort, now with their holder (same access rules as before).
create or replace function public.list_payment_terminals(p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (public.has_permission('sales.create') or public.has_permission('finance.manage')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if coalesce(p_include_inactive, false) and not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', terminal.id, 'code', terminal.code, 'label', terminal.label,
        'active', terminal.active, 'updated_at', terminal.updated_at,
        'assigned_to', case when holder.id is null then null else jsonb_build_object('id', holder.id, 'name', holder.display_name) end,
        'assigned_at', association.assigned_at)
      order by terminal.active desc, terminal.code)
    from public.payment_terminals terminal
    -- The holder of the single request cohort only (none in "all"): one row per terminal, never another cohort's holder.
    left join cohort_data.cohort_payment_terminals association
      on association.terminal_id = terminal.id and association.cohort_id = private.cohort_permission_id()
    left join public.profiles holder on holder.id = association.assigned_to
    where (terminal.active or coalesce(p_include_inactive, false))
  ), '[]'::jsonb);
end;
$$;

-- Finance assigns, changes or removes (null) who holds a terminal in the request cohort. Audited and idempotent.
create function public.assign_payment_terminal(
  p_terminal_id uuid, p_assignee uuid, p_reason text, p_idempotency_key text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_cohort uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_scope text;
  v_claim record;
  v_association cohort_data.cohort_payment_terminals%rowtype;
  v_terminal private.payment_terminals%rowtype;
  v_result jsonb;
begin
  if v_actor is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_terminal_id is null or p_correlation_id is null or char_length(v_reason) not between 4 and 500
    or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_TERMINAL_ASSIGNMENT';
  end if;
  v_cohort := private.cohort_write_id();
  v_scope := private.build_idempotency_scope('payments', 'terminal_assignment', v_actor);
  select * into v_claim from private.claim_idempotency(v_scope, p_idempotency_key,
    jsonb_build_object('terminal_id', p_terminal_id, 'assignee', p_assignee, 'reason', v_reason, 'cohort_id', v_cohort));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;

  select * into v_association from cohort_data.cohort_payment_terminals
  where cohort_id = v_cohort and terminal_id = p_terminal_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_NOT_FOUND'; end if;
  select * into v_terminal from private.payment_terminals where id = p_terminal_id;
  if p_assignee is not null then
    if not v_association.active or not v_terminal.active then
      raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_UNAVAILABLE';
    end if;
    if not private.payment_terminal_assignable(v_cohort, p_assignee) then
      raise exception using errcode = 'P0001', message = 'TERMINAL_ASSIGNEE_NOT_A_SELLER';
    end if;
  end if;

  update cohort_data.cohort_payment_terminals
  set assigned_to = p_assignee, assigned_at = case when p_assignee is null then null else clock_timestamp() end,
      updated_by = v_actor, updated_at = clock_timestamp()
  where cohort_id = v_cohort and terminal_id = p_terminal_id;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.terminal.assigned', v_actor, 'payment_terminal', p_terminal_id::text, p_correlation_id,
    jsonb_build_object('code', v_terminal.code, 'from', v_association.assigned_to, 'to', p_assignee, 'reason', v_reason, 'cohort_id', v_cohort));
  v_result := jsonb_build_object('terminal_id', p_terminal_id, 'code', v_terminal.code, 'assigned_to',
    case when p_assignee is null then null else (select jsonb_build_object('id', id, 'name', display_name) from public.profiles where id = p_assignee) end,
    'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_terminal', p_terminal_id::text);
  return v_result;
end;
$$;

-- People finance may choose as holders in the request cohort.
create function public.list_payment_terminal_assignees() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cohort uuid;
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  v_cohort := private.cohort_permission_id();
  if v_cohort is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', profile.id, 'name', profile.display_name, 'username', profile.username)
      order by profile.display_name, profile.id)
    from public.profiles profile
    where private.payment_terminal_assignable(v_cohort, profile.id)
  ), '[]'::jsonb);
end;
$$;

-- The terminal the PDV preselects for the calling seller, and why.
create function public.pdv_terminal_preference() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_cohort uuid;
  v_terminal uuid;
begin
  if v_actor is null or not public.has_permission('sales.create') then
    raise exception using errcode = '42501', message = 'SELLER_REQUIRED';
  end if;
  v_cohort := private.cohort_permission_id();
  if v_cohort is null then return jsonb_build_object('terminal_id', null, 'source', null); end if;

  -- Active terminals of the cohort: authorized here and active as hardware.
  select association.terminal_id into v_terminal
  from cohort_data.cohort_payment_terminals association
  join private.payment_terminals terminal on terminal.id = association.terminal_id and terminal.active
  where association.cohort_id = v_cohort and association.active and association.assigned_to = v_actor
  order by association.assigned_at desc nulls last, terminal.code limit 1;
  if v_terminal is not null then return jsonb_build_object('terminal_id', v_terminal, 'source', 'ASSIGNED'); end if;

  select attempt.terminal_id into v_terminal
  from cohort_data.payment_attempts attempt
  join cohort_data.cohort_payment_terminals association
    on association.terminal_id = attempt.terminal_id and association.cohort_id = v_cohort and association.active
  join private.payment_terminals terminal on terminal.id = attempt.terminal_id and terminal.active
  where attempt.cohort_id = v_cohort and attempt.operator_id = v_actor and attempt.terminal_id is not null
  order by attempt.created_at desc, attempt.id desc limit 1;
  if v_terminal is not null then return jsonb_build_object('terminal_id', v_terminal, 'source', 'LAST_USED'); end if;

  select min(association.terminal_id::text)::uuid into v_terminal
  from cohort_data.cohort_payment_terminals association
  join private.payment_terminals terminal on terminal.id = association.terminal_id and terminal.active
  where association.cohort_id = v_cohort and association.active
  having count(*) = 1;
  if v_terminal is not null then return jsonb_build_object('terminal_id', v_terminal, 'source', 'ONLY_ACTIVE'); end if;
  return jsonb_build_object('terminal_id', null, 'source', null);
end;
$$;

revoke all on function public.assign_payment_terminal(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.assign_payment_terminal(uuid, uuid, text, text, uuid) to authenticated;
revoke all on function public.list_payment_terminal_assignees() from public, anon, authenticated, service_role;
grant execute on function public.list_payment_terminal_assignees() to authenticated;
revoke all on function public.pdv_terminal_preference() from public, anon, authenticated, service_role;
grant execute on function public.pdv_terminal_preference() to authenticated;
