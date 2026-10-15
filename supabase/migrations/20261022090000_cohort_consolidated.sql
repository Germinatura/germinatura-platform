-- Multi-turma, PR 4 (ADR 0011): consolidated view of ADMIN_MASTER, user ↔ cohort membership management and cohort
-- administration. Functions only: no table, column or row changes. Additive and backward compatible: the replaced
-- functions keep their signatures, and the new checks only refuse operations that would strand open work.

set local lock_timeout = '5s';

-- Pre-checks (fail-closed): the state these functions rely on.
do $$
begin
  if (select count(*) from public.cohorts where is_default) <> 1 then
    raise exception 'COHORT_CONSOLIDATED_PRECHECK: exactly one default cohort is required';
  end if;
  if exists (select 1 from public.cohorts where is_default and status = 'ARCHIVED') then
    raise exception 'COHORT_CONSOLIDATED_PRECHECK: the default cohort is archived';
  end if;
  if to_regprocedure('private.set_cohort_membership_in_cohort(uuid, boolean, text, uuid)') is null
    or to_regprocedure('public.update_cohort(uuid, text, public.cohort_status, text, uuid)') is null then
    raise exception 'COHORT_CONSOLIDATED_PRECHECK: PR 2/PR 3 cohort functions are missing';
  end if;
  if exists (select 1 from public.user_cohorts membership left join public.profiles profile on profile.id = membership.user_id where profile.id is null) then
    raise exception 'COHORT_CONSOLIDATED_PRECHECK: memberships without a profile';
  end if;
end;
$$;

-- Membership ------------------------------------------------------------------------------------------------------

-- Open work of a person in a cohort that an inactive membership would strand (empty: nothing pending).
create function private.membership_blockers(p_user_id uuid, p_cohort_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when exists (select 1 from cohort_data.seller_shifts shift
      where shift.seller_id = p_user_id and shift.cohort_id = p_cohort_id and shift.status = 'OPEN') then 'OPEN_SHIFT' end,
    case when exists (select 1 from cohort_data.stock_locations location
      join cohort_data.inventory_balances balance on balance.location_id = location.id
      where location.seller_id = p_user_id and location.cohort_id = p_cohort_id
        and (balance.on_hand_quantity <> 0 or balance.reserved_quantity <> 0)) then 'SELLER_STOCK' end,
    case when exists (select 1 from cohort_data.stock_locations location
      where location.seller_id = p_user_id and location.cohort_id = p_cohort_id and (
        exists (select 1 from cohort_data.seller_stock_transfer_requests request
          where request.status = 'REQUESTED' and (request.from_location_id = location.id or request.to_location_id = location.id))
        or exists (select 1 from cohort_data.stock_return_requests request
          where request.status = 'REQUESTED' and request.from_location_id = location.id))) then 'PENDING_STOCK_REQUESTS' end,
    case when exists (select 1 from cohort_data.sales sale
      where sale.created_by = p_user_id and sale.cohort_id = p_cohort_id and sale.status in ('DRAFT', 'AWAITING_PAYMENT')) then 'PENDING_SALES' end,
    case when exists (select 1 from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
        where user_role.user_id = p_user_id and user_role.cohort_id = p_cohort_id and role.key = 'ADMIN')
      and not exists (select 1 from cohort_data.user_roles user_role
        join public.roles role on role.id = user_role.role_id and role.key = 'ADMIN'
        join public.user_cohorts membership on membership.user_id = user_role.user_id and membership.cohort_id = user_role.cohort_id
          and membership.status = 'ACTIVE'
        join public.profiles profile on profile.id = user_role.user_id and profile.active
        where user_role.cohort_id = p_cohort_id and user_role.user_id <> p_user_id) then 'LAST_COHORT_ADMIN' end
  ]::text[], null)
$$;
revoke all on function private.membership_blockers(uuid, uuid) from public, anon, authenticated;

-- Same signature as before (PR 3 wrapper). Deactivating a membership is refused while the person has open work there;
-- the details name each blocker. Revoking access at once stays possible through set_user_access (security first).
create or replace function public.set_cohort_membership(p_user_id uuid, p_active boolean, p_reason text, p_correlation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cohort_id uuid;
  v_blockers text[];
begin
  if auth.uid() is not null and not public.has_permission('users.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if auth.uid() is not null and p_user_id is not null and not private.cohort_member_visible(p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  if p_active is false and p_user_id is not null then
    v_cohort_id := private.cohort_permission_id();
    if v_cohort_id is not null and exists (select 1 from public.user_cohorts
      where user_id = p_user_id and cohort_id = v_cohort_id and status = 'ACTIVE') then
      v_blockers := private.membership_blockers(p_user_id, v_cohort_id);
      if cardinality(v_blockers) > 0 then
        raise exception using errcode = 'P0001', message = 'MEMBERSHIP_HAS_OPEN_OPERATIONS', detail = array_to_string(v_blockers, ',');
      end if;
    end if;
  end if;
  return private.set_cohort_membership_in_cohort(p_user_id, p_active, p_reason, p_correlation_id);
end;
$$;

-- Every cohort for one person (ADMIN_MASTER): membership (ACTIVE, INACTIVE or NONE), the roles held in each cohort and,
-- for active memberships, what would block deactivating it. Relational data only (user_cohorts + user_roles).
create function public.user_cohort_memberships(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'USER_NOT_FOUND';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'cohort_id', cohort.id, 'name', cohort.name, 'year', cohort.year, 'status', cohort.status, 'is_default', cohort.is_default,
      'membership', coalesce(membership.status::text, 'NONE'),
      'roles', coalesce((select jsonb_agg(role.key order by role.key) from cohort_data.user_roles user_role
        join public.roles role on role.id = user_role.role_id
        where user_role.user_id = p_user_id and user_role.cohort_id = cohort.id), '[]'::jsonb),
      'blockers', case when membership.status = 'ACTIVE' then to_jsonb(private.membership_blockers(p_user_id, cohort.id)) else '[]'::jsonb end
    ) order by cohort.year desc), '[]'::jsonb)
    from public.cohorts cohort
    left join public.user_cohorts membership on membership.cohort_id = cohort.id and membership.user_id = p_user_id);
end;
$$;
revoke all on function public.user_cohort_memberships(uuid) from public, anon;
grant execute on function public.user_cohort_memberships(uuid) to authenticated;

-- Cohorts ---------------------------------------------------------------------------------------------------------

-- Open work in a cohort that archiving would strand (empty: the cohort can be archived).
create function private.cohort_open_operations(p_cohort_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when exists (select 1 from cohort_data.seller_shifts where cohort_id = p_cohort_id and status = 'OPEN') then 'OPEN_SHIFTS' end,
    case when exists (select 1 from cohort_data.sales where cohort_id = p_cohort_id and status in ('DRAFT', 'AWAITING_PAYMENT')) then 'PENDING_SALES' end,
    case when exists (select 1 from cohort_data.payment_attempts where cohort_id = p_cohort_id
      and status in ('CREATED', 'PENDING', 'AWAITING_EXTERNAL_CONFIRMATION', 'RECONCILIATION_PENDING')) then 'PENDING_PAYMENTS' end,
    case when exists (select 1 from cohort_data.payment_link_charges where cohort_id = p_cohort_id
      and status in ('REQUESTED', 'ACTIVE', 'UNCERTAIN')) then 'OPEN_PAYMENT_LINKS' end,
    case when exists (select 1 from cohort_data.commercial_reservations where cohort_id = p_cohort_id and status in ('ACTIVE', 'READY')) then 'OPEN_RESERVATIONS' end,
    case when exists (select 1 from cohort_data.stock_reservations where cohort_id = p_cohort_id and status = 'ACTIVE') then 'ACTIVE_STOCK_RESERVATIONS' end,
    case when exists (select 1 from cohort_data.seller_stock_transfer_requests where cohort_id = p_cohort_id and status = 'REQUESTED')
      or exists (select 1 from cohort_data.stock_return_requests where cohort_id = p_cohort_id and status = 'REQUESTED') then 'PENDING_STOCK_REQUESTS' end,
    case when exists (select 1 from cohort_data.inventory_counts where cohort_id = p_cohort_id and status = 'PENDING_APPROVAL')
      or exists (select 1 from cohort_data.stock_loss_reports where cohort_id = p_cohort_id and status = 'PENDING_APPROVAL') then 'PENDING_APPROVALS' end,
    case when exists (select 1 from cohort_data.raffle_campaigns where cohort_id = p_cohort_id and status in ('ACTIVE', 'PAUSED')) then 'OPEN_RAFFLES' end
  ]::text[], null)
$$;
revoke all on function private.cohort_open_operations(uuid) from public, anon, authenticated;

-- Same signature and behaviour as PR 2, plus: archiving waits until the cohort has no open work.
create or replace function public.update_cohort(p_cohort_id uuid, p_name text, p_status public.cohort_status, p_reason text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_before public.cohorts%rowtype;
  v_after public.cohorts%rowtype;
  v_open text[];
begin
  if v_actor_id is null or not public.has_permission('cohorts.manage') then
    raise exception using errcode = '42501', message = 'COHORTS_MANAGE_REQUIRED';
  end if;
  if p_cohort_id is null or p_name is null or p_status is null or p_correlation_id is null or p_reason is null
    or char_length(btrim(p_reason)) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end if;
  select * into v_before from public.cohorts where id = p_cohort_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'COHORT_NOT_FOUND';
  end if;
  if v_before.is_default and p_status = 'ARCHIVED' then
    raise exception using errcode = 'P0001', message = 'DEFAULT_COHORT_CANNOT_BE_ARCHIVED';
  end if;
  if p_status = 'ARCHIVED' and v_before.status <> 'ARCHIVED' then
    v_open := private.cohort_open_operations(p_cohort_id);
    if cardinality(v_open) > 0 then
      raise exception using errcode = 'P0001', message = 'COHORT_HAS_OPEN_OPERATIONS', detail = array_to_string(v_open, ',');
    end if;
  end if;
  begin
    update public.cohorts set name = btrim(p_name), status = p_status where id = p_cohort_id returning * into v_after;
  exception
    when check_violation then
      raise exception using errcode = '22023', message = 'INVALID_COHORT';
  end;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('cohorts.updated', v_actor_id, 'cohort', p_cohort_id::text, p_correlation_id,
    jsonb_build_object('reason', btrim(p_reason), 'before', jsonb_build_object('name', v_before.name, 'status', v_before.status),
      'after', jsonb_build_object('name', v_after.name, 'status', v_after.status), 'cohort_scope', 'GLOBAL'), null);
  return jsonb_build_object('id', v_after.id, 'name', v_after.name, 'year', v_after.year, 'slug', v_after.slug,
    'status', v_after.status, 'is_default', v_after.is_default, 'correlation_id', p_correlation_id);
end;
$$;

-- Every cohort with its membership and role counts (ADMIN_MASTER), and what would block archiving it.
create function public.cohort_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', cohort.id, 'name', cohort.name, 'year', cohort.year, 'slug', cohort.slug, 'status', cohort.status, 'is_default', cohort.is_default,
      'members_active', (select count(*) from public.user_cohorts where cohort_id = cohort.id and status = 'ACTIVE'),
      'members_inactive', (select count(*) from public.user_cohorts where cohort_id = cohort.id and status = 'INACTIVE'),
      'roles', coalesce((select jsonb_object_agg(counted.key, counted.people) from (
          select role.key, count(distinct user_role.user_id) as people
          from cohort_data.user_roles user_role
          join public.roles role on role.id = user_role.role_id
          join public.user_cohorts membership on membership.user_id = user_role.user_id and membership.cohort_id = user_role.cohort_id
            and membership.status = 'ACTIVE'
          where user_role.cohort_id = cohort.id
          group by role.key) counted), '{}'::jsonb),
      'open_operations', case when cohort.status = 'ARCHIVED' then '[]'::jsonb else to_jsonb(private.cohort_open_operations(cohort.id)) end
    ) order by cohort.year desc), '[]'::jsonb)
    from public.cohorts cohort);
end;
$$;
revoke all on function public.cohort_overview() from public, anon;
grant execute on function public.cohort_overview() to authenticated;

-- Global PicPay evidence (ADMIN_MASTER): the shared account statement, never split into per-cohort balances. Lines
-- are counted by the cohort their current resolution was attributed to, globally classified, or still pending.
create function public.picpay_evidence_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'ADMIN_MASTER_REQUIRED';
  end if;
  return jsonb_build_object(
    'imports', (select count(*) from public.picpay_statement_imports),
    'last_period_to', (select max(period_to) from public.picpay_statement_imports),
    'inflow_cents', (select coalesce(sum(inflow_cents), 0) from public.picpay_statement_imports),
    'outflow_cents', (select coalesce(sum(outflow_cents), 0) from public.picpay_statement_imports),
    'lines', (select count(*) from public.picpay_statement_lines),
    'lines_pending', (select count(*) from public.picpay_statement_lines line
      where not exists (select 1 from private.picpay_statement_current_resolutions current where current.line_id = line.id)),
    'lines_global', (select count(*) from private.picpay_statement_current_resolutions current
      join cohort_data.picpay_statement_line_resolutions resolution on resolution.id = current.id
      where resolution.cohort_id is null),
    'lines_by_cohort', coalesce((select jsonb_agg(jsonb_build_object('cohort_id', counted.cohort_id, 'lines', counted.lines) order by counted.cohort_id)
      from (select resolution.cohort_id, count(*) as lines
        from private.picpay_statement_current_resolutions current
        join cohort_data.picpay_statement_line_resolutions resolution on resolution.id = current.id
        where resolution.cohort_id is not null
        group by resolution.cohort_id) counted), '[]'::jsonb));
end;
$$;
revoke all on function public.picpay_evidence_overview() from public, anon;
grant execute on function public.picpay_evidence_overview() to authenticated;

-- Audit -----------------------------------------------------------------------------------------------------------

-- The cohort of audit records already returned by search_audit_logs (consolidated view labels each row). Same
-- permission and the same request scope: a record outside the scope is simply not answered.
create function public.audit_log_cohorts(p_ids uuid[]) returns table (id uuid, cohort_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('audit.read') then
    raise exception using errcode = '42501', message = 'AUDIT_READ_REQUIRED';
  end if;
  if p_ids is null or cardinality(p_ids) > 200 then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_FILTER';
  end if;
  return query
  select log.id, log.cohort_id from cohort_data.audit_logs log
  where log.id = any (p_ids)
    and (log.cohort_id = any ((select private.cohort_scope())::uuid[]) or (log.cohort_id is null and private.cohort_sees_global()));
end;
$$;
revoke all on function public.audit_log_cohorts(uuid[]) from public, anon;
grant execute on function public.audit_log_cohorts(uuid[]) to authenticated;
