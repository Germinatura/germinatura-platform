-- Etapa 9 (ADMIN-002, spec 4.1, 5.1 e 5.17): configurable fundraising goal with a target and a target date.
-- Decision of 30/09/2026: progress is the operating profit (net revenue − real cost of goods − losses − manual
-- expenses) counted from the start date, the same figure as the management indicators. The public view may hide
-- the amounts and show only percentages. Nothing is stored besides the configuration; progress is recomputed.

create table public.fundraising_goal (
  singleton boolean primary key default true check (singleton),
  target_cents bigint not null check (target_cents between 100 and 99999999999),
  counting_from date not null,
  target_date date not null,
  public_visible boolean not null default false,
  show_amounts boolean not null default true,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  constraint fundraising_goal_dates_valid check (target_date >= counting_from)
);
alter table public.fundraising_goal enable row level security;
revoke all on public.fundraising_goal from public, anon, authenticated, service_role;

create function public.configure_fundraising_goal(
  p_target_cents bigint, p_counting_from date, p_target_date date, p_public_visible boolean, p_show_amounts boolean,
  p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_before public.fundraising_goal%rowtype;
  v_after public.fundraising_goal%rowtype;
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_target_cents is null or p_target_cents not between 100 and 99999999999
    or p_counting_from is null or p_target_date is null or p_target_date < p_counting_from
    or p_target_date - p_counting_from > 3660 or p_public_visible is null or p_show_amounts is null then
    raise exception using errcode = '22023', message = 'INVALID_FUNDRAISING_GOAL';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('settings', 'fundraising_goal', v_actor_id), p_idempotency_key,
    jsonb_build_object('target_cents', p_target_cents, 'counting_from', p_counting_from, 'target_date', p_target_date,
      'public_visible', p_public_visible, 'show_amounts', p_show_amounts));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select * into v_before from public.fundraising_goal where singleton for update;
  insert into public.fundraising_goal (singleton, target_cents, counting_from, target_date, public_visible, show_amounts, updated_by, updated_at)
  values (true, p_target_cents, p_counting_from, p_target_date, p_public_visible, p_show_amounts, v_actor_id, clock_timestamp())
  on conflict (singleton) do update set target_cents = excluded.target_cents, counting_from = excluded.counting_from,
    target_date = excluded.target_date, public_visible = excluded.public_visible, show_amounts = excluded.show_amounts,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_after;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('settings.fundraising_goal.updated', v_actor_id, 'fundraising_goal', 'singleton', p_correlation_id,
    jsonb_build_object(
      'before', case when v_before.singleton is null then null else jsonb_build_object('target_cents', v_before.target_cents,
        'counting_from', v_before.counting_from, 'target_date', v_before.target_date, 'public_visible', v_before.public_visible,
        'show_amounts', v_before.show_amounts) end,
      'after', jsonb_build_object('target_cents', v_after.target_cents, 'counting_from', v_after.counting_from,
        'target_date', v_after.target_date, 'public_visible', v_after.public_visible, 'show_amounts', v_after.show_amounts)));
  v_result := private.fundraising_goal_progress(true);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'fundraising_goal', 'singleton');
  return v_result;
end;
$$;

-- Progress is the operating profit from the start date to today (São Paulo), and the projection extends the
-- average daily result to the target date. p_full returns every amount; otherwise amounts follow show_amounts.
create function private.fundraising_goal_progress(p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_goal public.fundraising_goal%rowtype;
  v_today date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_until date;
  v_current bigint := 0;
  v_elapsed integer;
  v_remaining integer;
  v_projected bigint;
  v_show boolean;
begin
  select * into v_goal from public.fundraising_goal where singleton;
  if not found then return null; end if;
  v_until := least(v_today, v_goal.target_date);
  if v_until >= v_goal.counting_from then
    v_current := (private.compute_management_indicators(v_goal.counting_from, v_until) #>> '{totals,operating_profit_cents}')::numeric::bigint;
    v_elapsed := v_until - v_goal.counting_from + 1;
  else
    v_elapsed := 0;
  end if;
  v_remaining := greatest(v_goal.target_date - greatest(v_until, v_goal.counting_from - 1), 0);
  v_projected := case when v_elapsed > 0 then v_current + floor(v_current::numeric / v_elapsed * v_remaining)::bigint else v_current end;
  v_show := p_full or v_goal.show_amounts;
  return jsonb_build_object(
    'counting_from', v_goal.counting_from, 'target_date', v_goal.target_date,
    'public_visible', v_goal.public_visible, 'show_amounts', v_goal.show_amounts,
    'target_cents', case when v_show then v_goal.target_cents end,
    'current_cents', case when v_show then v_current end,
    'projected_cents', case when v_show then v_projected end,
    'progress_bps', greatest(floor(v_current::numeric * 10000 / v_goal.target_cents), 0)::bigint,
    'projected_bps', greatest(floor(v_projected::numeric * 10000 / v_goal.target_cents), 0)::bigint,
    'on_track', v_projected >= v_goal.target_cents,
    'days_remaining', greatest(v_goal.target_date - v_today, 0),
    'updated_at', case when p_full then v_goal.updated_at end);
end;
$$;

create function public.get_fundraising_goal_admin()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  return private.fundraising_goal_progress(true);
end;
$$;

-- Spec 4.1: the public progress, when the commission publishes it; amounts only when it chose to show them.
create function public.public_fundraising_goal()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.fundraising_goal where singleton and public_visible) then
    return null;
  end if;
  return private.fundraising_goal_progress(false) - 'public_visible';
end;
$$;

revoke all on function private.fundraising_goal_progress(boolean) from public, anon, authenticated, service_role;
revoke all on function public.configure_fundraising_goal(bigint, date, date, boolean, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_fundraising_goal_admin() from public, anon, authenticated, service_role;
revoke all on function public.public_fundraising_goal() from public, anon, authenticated, service_role;
grant execute on function public.configure_fundraising_goal(bigint, date, date, boolean, boolean, text, uuid) to authenticated;
grant execute on function public.get_fundraising_goal_admin() to authenticated;
grant execute on function public.public_fundraising_goal() to anon, authenticated;
comment on table public.fundraising_goal is 'ADMIN-002: fundraising goal; progress is the operating profit since counting_from.';
comment on function public.public_fundraising_goal() is
  'Public goal progress (percentages always; amounts only when show_amounts), or null when not published.';
