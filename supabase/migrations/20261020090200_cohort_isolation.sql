-- Cohort isolation (ADR 0011), the architecture proven by tools/spikes/cohort-isolation.
--
-- Every table registered in private.cohort_scoped_tables moves to the non-exposed schema cohort_data, and
-- public.<table> becomes a view with the same name and columns, security_invoker, filtered by the request scope
-- (private.cohort_scope()). Existing functions keep reading and writing public.<table> and therefore see and write only
-- the request cohort. Each base table gets a restrictive RLS policy with the same scope (the security boundary for Data
-- API, direct and Realtime access; the scope only ever holds cohorts the caller may read) and a guard trigger that
-- fills and validates cohort_id. The views carry no security_barrier: RLS already enforces the scope for every
-- non-owner reader, and a barrier would keep filters and indexes from reaching the base tables.
--
-- Global identities with per-cohort visibility: payment_terminals (base in private, the view shows the terminals
-- authorized for the request cohort) and feature_flags (base in private, the view shows the effective value).
--
-- Convention for later migrations: ALTER TABLE cohort_data.<table>, then select private.refresh_cohort_view('<table>');
-- private.cohort_view_drift() (checked by pgTAP) reports any view that no longer matches its base table.

set local lock_timeout = '5s';

-- 0. Publications: a view cannot be published. Abort before touching anything if a table of the plan is published
-- (production may have publications made from the dashboard) or a publication covers all tables.
do $$
declare
  v_published text;
begin
  select string_agg(pubname || ':' || schemaname || '.' || tablename, ', ') into v_published
  from pg_publication_tables
  where schemaname = 'public'
    and (tablename in (select table_name from private.cohort_scoped_tables) or tablename in ('feature_flags', 'payment_terminals'));
  if v_published is not null then
    raise exception 'COHORT_ISOLATION_ABORTED: published tables not covered by the plan: %', v_published;
  end if;
  if exists (select 1 from pg_publication where puballtables) then
    raise exception 'COHORT_ISOLATION_ABORTED: a publication FOR ALL TABLES exists: %',
      (select string_agg(pubname, ', ') from pg_publication where puballtables);
  end if;
end;
$$;

create schema if not exists cohort_data;
grant usage on schema cohort_data to anon, authenticated, service_role;
comment on schema cohort_data is
  'Tabelas físicas por turma (ADR 0011). Não exposto pela Data API: o acesso é pelas views public.<tabela>.';

-- 1. Views that depend on the tables that will move (bound by OID): rebound after the move.
create temp table cohort_dependent_views on commit drop as
select distinct format('%I.%I', view_namespace.nspname, view_class.relname) as view_name, view_class.oid as view_oid,
  view_class.reloptions
from pg_depend dependency
join pg_rewrite rewrite on rewrite.oid = dependency.objid
join pg_class view_class on view_class.oid = rewrite.ev_class
join pg_namespace view_namespace on view_namespace.oid = view_class.relnamespace
join pg_class table_class on table_class.oid = dependency.refobjid
where table_class.relnamespace = 'public'::regnamespace and table_class.relkind = 'r'
  and table_class.relname in (select table_name from private.cohort_scoped_tables)
  and view_class.oid <> table_class.oid;

-- 2. View over a base table, same name and grants, filtered by the request scope.
create function private.refresh_cohort_view(p_table text) returns void
language plpgsql set search_path = '' as $$
declare
  v_mode text := (select mode from private.cohort_scoped_tables where table_name = p_table);
  v_grant record;
begin
  if v_mode is null then
    raise exception 'COHORT_VIEW_UNKNOWN_TABLE: %', p_table;
  end if;
  execute format(
    'create or replace view public.%I with (security_invoker = true) as select * from cohort_data.%I where %s',
    p_table, p_table, case v_mode
      when 'REQUIRED' then 'cohort_id = any ((select private.cohort_scope())::uuid[]) with cascaded check option'
      when 'SHARED_NULLABLE' then '(cohort_id is null or cohort_id = any ((select private.cohort_scope())::uuid[])) with cascaded check option'
      else 'cohort_id = any ((select private.cohort_scope())::uuid[]) or (cohort_id is null and (select private.cohort_sees_global()))'
    end);
  execute format('revoke all on public.%I from anon, authenticated, service_role', p_table);
  for v_grant in
    select grantee, string_agg(privilege_type, ', ') as privileges
    from information_schema.role_table_grants
    where table_schema = 'cohort_data' and table_name = p_table and grantee in ('anon', 'authenticated', 'service_role')
    group by grantee
  loop
    execute format('grant %s on public.%I to %I', v_grant.privileges, p_table, v_grant.grantee);
  end loop;
end;
$$;
revoke all on function private.refresh_cohort_view(text) from public, anon, authenticated;

-- Every view exposes exactly the columns of its base table (later migrations must refresh the view).
create function private.cohort_view_drift() returns table (table_name text, problem text)
language sql stable set search_path = '' as $$
  select scoped.table_name, case
      when view_class.oid is null then 'missing view'
      else 'view columns differ from base columns' end
  from private.cohort_scoped_tables scoped
  join pg_class base on base.relname = scoped.table_name and base.relnamespace = 'cohort_data'::regnamespace and base.relkind = 'r'
  left join pg_class view_class on view_class.relname = scoped.table_name and view_class.relnamespace = 'public'::regnamespace and view_class.relkind = 'v'
  where view_class.oid is null
    or (select array_agg(attname order by attnum) from pg_attribute where attrelid = base.oid and attnum > 0 and not attisdropped)
      is distinct from (select array_agg(attname order by attnum) from pg_attribute where attrelid = view_class.oid and attnum > 0 and not attisdropped)
$$;
revoke all on function private.cohort_view_drift() from public, anon, authenticated;

-- 3. Move every registered table, constrain, protect and expose it through its view.
do $$
declare
  v_table record;
begin
  for v_table in select table_name, mode from private.cohort_scoped_tables order by table_name loop
    if to_regclass(format('public.%I', v_table.table_name)) is null
      or (select relkind from pg_class where oid = format('public.%I', v_table.table_name)::regclass) <> 'r' then
      raise exception 'COHORT_ISOLATION_TABLE_MISSING: public.%', v_table.table_name;
    end if;
    execute format('alter table public.%I set schema cohort_data', v_table.table_name);
    if v_table.mode = 'REQUIRED' then
      execute format('alter table cohort_data.%I alter column cohort_id drop default', v_table.table_name);
      execute format('alter table cohort_data.%I alter column cohort_id set not null', v_table.table_name);
    end if;
    execute format('alter table cohort_data.%I enable row level security', v_table.table_name);
    execute format(
      'create policy %I on cohort_data.%I as restrictive for all to anon, authenticated using (%s) with check (%s)',
      v_table.table_name || '_cohort_scope', v_table.table_name,
      case v_table.mode
        when 'REQUIRED' then 'cohort_id = any ((select private.cohort_scope())::uuid[])'
        when 'SHARED_NULLABLE' then 'cohort_id is null or cohort_id = any ((select private.cohort_scope())::uuid[])'
        else 'cohort_id = any ((select private.cohort_scope())::uuid[]) or (cohort_id is null and (select private.cohort_sees_global()))'
      end,
      case v_table.mode
        when 'REQUIRED' then 'cohort_id = any ((select private.cohort_scope())::uuid[])'
        when 'SHARED_NULLABLE' then 'cohort_id is null or cohort_id = any ((select private.cohort_scope())::uuid[])'
        else 'cohort_id = any ((select private.cohort_scope())::uuid[]) or (cohort_id is null and (select private.cohort_sees_global()))'
      end);
    perform private.refresh_cohort_view(v_table.table_name);
  end loop;
end;
$$;

-- Guards: parents are the single-column foreign keys between cohort tables, read from the catalogue.
do $$
declare
  v_table record;
  v_args text;
begin
  for v_table in select table_name, mode from private.cohort_scoped_tables order by table_name loop
    if v_table.mode = 'MASTER_NULLABLE' then
      execute format('create trigger a_cohort_assign before insert on cohort_data.%I for each row execute function private.assign_log_cohort()',
        v_table.table_name);
      execute format('create trigger a_cohort_guard before update on cohort_data.%I for each row execute function private.guard_cohort_write(%L)',
        v_table.table_name, v_table.mode);
      continue;
    end if;
    select string_agg(format('%L, %L, %L, %L', child_column.attname, parent.relname, parent_column.attname,
        format_type(parent_column.atttypid, parent_column.atttypmod)), ', ' order by constraint_row.conname)
    into v_args
    from pg_constraint constraint_row
    join pg_class child on child.oid = constraint_row.conrelid
    join pg_class parent on parent.oid = constraint_row.confrelid
    join pg_attribute child_column on child_column.attrelid = constraint_row.conrelid and child_column.attnum = constraint_row.conkey[1]
    join pg_attribute parent_column on parent_column.attrelid = constraint_row.confrelid and parent_column.attnum = constraint_row.confkey[1]
    where constraint_row.contype = 'f' and cardinality(constraint_row.conkey) = 1
      and child.relnamespace = 'cohort_data'::regnamespace and child.relname = v_table.table_name
      and parent.relnamespace = 'cohort_data'::regnamespace and child_column.attname <> 'cohort_id';
    execute format(
      'create trigger a_cohort_guard before insert or update or delete on cohort_data.%I for each row execute function private.guard_cohort_write(%L%s)',
      v_table.table_name, v_table.mode, case when v_args is null then '' else ', ' || v_args end);
  end loop;
end;
$$;

create trigger b_picpay_attribution before insert on cohort_data.picpay_transaction_links
for each row execute function private.guard_picpay_attribution();
create trigger b_picpay_attribution before insert on cohort_data.picpay_statement_line_resolutions
for each row execute function private.guard_picpay_attribution();

-- 4. Uniqueness and singletons per cohort (identifiers of external evidence stay globally unique).
alter table cohort_data.categories drop constraint categories_slug_key,
  add constraint categories_cohort_slug_key unique (cohort_id, slug);
alter table cohort_data.products drop constraint products_slug_key, drop constraint products_sku_key,
  add constraint products_cohort_slug_key unique (cohort_id, slug),
  add constraint products_cohort_sku_key unique (cohort_id, sku);
alter table cohort_data.promotions drop constraint promotions_code_key,
  add constraint promotions_cohort_code_key unique (cohort_id, code);
alter table cohort_data.promotion_coupon_rules drop constraint promotion_coupon_rules_code_key,
  add constraint promotion_coupon_rules_cohort_code_key unique (cohort_id, code);
alter table cohort_data.stock_locations drop constraint stock_locations_seller_unique,
  add constraint stock_locations_cohort_seller_key unique (cohort_id, seller_id);
drop index cohort_data.stock_locations_one_active_central_idx;
create unique index stock_locations_one_active_central_idx on cohort_data.stock_locations (cohort_id, location_type)
  where location_type = 'CENTRAL' and active;
drop index cohort_data.seller_shifts_one_open_per_seller;
create unique index seller_shifts_one_open_per_seller on cohort_data.seller_shifts (cohort_id, seller_id) where status = 'OPEN';
drop index cohort_data.suppliers_document_unique;
create unique index suppliers_document_unique on cohort_data.suppliers (cohort_id, document) where document is not null;
alter table cohort_data.finance_opening_positions drop constraint finance_opening_positions_version_key,
  add constraint finance_opening_positions_cohort_version_key unique (cohort_id, version);
alter table cohort_data.user_roles drop constraint user_roles_pkey, add constraint user_roles_pkey primary key (user_id, role_id, cohort_id);
alter table cohort_data.fundraising_goal drop constraint fundraising_goal_pkey, add constraint fundraising_goal_pkey primary key (cohort_id);
alter table cohort_data.reservation_settings drop constraint reservation_settings_pkey, add constraint reservation_settings_pkey primary key (cohort_id);
alter table cohort_data.stock_loss_settings drop constraint stock_loss_settings_pkey, add constraint stock_loss_settings_pkey primary key (cohort_id);

-- Listings ordered by date within a cohort.
create index sales_cohort_created_idx on cohort_data.sales (cohort_id, created_at desc, id desc);
create index audit_logs_cohort_created_idx on cohort_data.audit_logs (cohort_id, created_at desc, id desc);

-- 5. Payment terminals: the identity stays global (base in private); the view shows the terminals authorized for the
-- request cohort, so the existing confirmation and listing work per cohort without being rewritten.
alter table public.payment_terminals set schema private;
create view public.payment_terminals with (security_invoker = true) as
select terminal.* from private.payment_terminals terminal
where exists (select 1 from public.cohort_payment_terminals association
  where association.terminal_id = terminal.id and association.active);
revoke all on public.payment_terminals from anon, authenticated, service_role;
comment on view public.payment_terminals is
  'Maquininhas autorizadas para a turma da requisição. Identidade global em private.payment_terminals (ADR 0011).';

create function private.guard_payment_terminal_use() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.terminal_id is not null and (tg_op = 'INSERT' or new.terminal_id is distinct from old.terminal_id) and not exists (
    select 1 from cohort_data.cohort_payment_terminals association
    join private.payment_terminals terminal on terminal.id = association.terminal_id
    where association.cohort_id = new.cohort_id and association.terminal_id = new.terminal_id and association.active and terminal.active
  ) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_NOT_ALLOWED';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_payment_terminal_use() from public, anon, authenticated;
create trigger payment_attempts_terminal_allowed before insert or update of terminal_id on cohort_data.payment_attempts
for each row execute function private.guard_payment_terminal_use();

-- A terminal is created by a cohort (and authorized for it); a terminal used only by that cohort is maintained by it;
-- a terminal shared by several cohorts, and authorizing an existing terminal for another cohort, belong to ADMIN_MASTER.
create or replace function public.save_payment_terminal(p_terminal_id uuid, p_code text, p_label text, p_active boolean, p_idempotency_key text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_terminal private.payment_terminals%rowtype;
  v_code text := upper(btrim(p_code)); v_label text := btrim(p_label); v_result jsonb; v_cohort_id uuid;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_active is null or v_code is null or v_label is null
    or v_code !~ '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' or char_length(v_code) not between 2 and 32
    or char_length(v_label) not between 2 and 80 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TERMINAL';
  end if;
  v_cohort_id := private.cohort_write_id();
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('payments', 'save_terminal', v_actor_id), p_idempotency_key,
    jsonb_build_object('terminal_id', p_terminal_id, 'code', v_code, 'label', v_label, 'active', p_active));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  if exists (select 1 from private.payment_terminals where code = v_code and id is distinct from p_terminal_id) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_CODE_TAKEN';
  end if;
  if p_terminal_id is null then
    insert into private.payment_terminals (code, label, active, created_by, updated_by)
    values (v_code, v_label, p_active, v_actor_id, v_actor_id) returning * into v_terminal;
    insert into public.cohort_payment_terminals (cohort_id, terminal_id, active, updated_by)
    values (v_cohort_id, v_terminal.id, true, v_actor_id);
  else
    if not exists (select 1 from cohort_data.cohort_payment_terminals where cohort_id = v_cohort_id and terminal_id = p_terminal_id)
      and not private.is_admin_master() then
      raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_NOT_FOUND';
    end if;
    if exists (select 1 from cohort_data.cohort_payment_terminals where terminal_id = p_terminal_id and cohort_id <> v_cohort_id)
      and not private.is_admin_master() then
      raise exception using errcode = '42501', message = 'PAYMENT_TERMINAL_SHARED_REQUIRES_ADMIN_MASTER';
    end if;
    update private.payment_terminals
    set code = v_code, label = v_label, active = p_active, updated_by = v_actor_id, updated_at = clock_timestamp()
    where id = p_terminal_id returning * into v_terminal;
    if not found then
      raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_NOT_FOUND';
    end if;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('payments.terminal.saved', v_actor_id, 'payment_terminal', v_terminal.id::text, p_correlation_id,
    jsonb_build_object('code', v_terminal.code, 'label', v_terminal.label, 'active', v_terminal.active,
      'created', p_terminal_id is null, 'by_cohort_id', v_cohort_id));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('payments.terminal.saved', 'payment_terminal', v_terminal.id::text,
    jsonb_build_object('terminal_id', v_terminal.id, 'active', v_terminal.active, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('id', v_terminal.id, 'code', v_terminal.code, 'label', v_terminal.label,
    'active', v_terminal.active, 'updated_at', v_terminal.updated_at, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'payment_terminal', v_terminal.id::text);
  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_CODE_TAKEN';
end;
$$;

create function public.set_cohort_payment_terminal(p_terminal_id uuid, p_active boolean, p_reason text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cohort_id uuid;
begin
  if v_actor_id is null or not public.has_permission('finance.manage') then
    raise exception using errcode = '42501', message = 'FINANCE_MANAGE_REQUIRED';
  end if;
  if p_terminal_id is null or p_active is null or p_correlation_id is null or p_reason is null
    or char_length(btrim(p_reason)) not between 4 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_TERMINAL';
  end if;
  v_cohort_id := private.cohort_write_id();
  if not exists (select 1 from private.payment_terminals where id = p_terminal_id) then
    raise exception using errcode = 'P0001', message = 'PAYMENT_TERMINAL_NOT_FOUND';
  end if;
  if not exists (select 1 from cohort_data.cohort_payment_terminals where cohort_id = v_cohort_id and terminal_id = p_terminal_id)
    and not private.is_admin_master() then
    raise exception using errcode = '42501', message = 'PAYMENT_TERMINAL_ASSOCIATION_REQUIRES_ADMIN_MASTER';
  end if;
  insert into public.cohort_payment_terminals (cohort_id, terminal_id, active, updated_by, updated_at)
  values (v_cohort_id, p_terminal_id, p_active, v_actor_id, clock_timestamp())
  on conflict (cohort_id, terminal_id) do update set active = excluded.active, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('payments.terminal.cohort_access.changed', v_actor_id, 'payment_terminal', p_terminal_id::text, p_correlation_id,
    jsonb_build_object('active', p_active, 'reason', btrim(p_reason)), v_cohort_id);
  return jsonb_build_object('terminal_id', p_terminal_id, 'cohort_id', v_cohort_id, 'active', p_active, 'correlation_id', p_correlation_id);
end;
$$;
revoke all on function public.set_cohort_payment_terminal(uuid, boolean, text, uuid) from public, anon;
grant execute on function public.set_cohort_payment_terminal(uuid, boolean, text, uuid) to authenticated;

-- 6. Feature flags: global catalogue in private; public.feature_flags shows the effective value for the request
-- (GLOBAL: catalogue value; COHORT: the request cohort's value, any cohort in "all"). The catalogue is readable by
-- every authenticated user, as before, so the view runs with its owner's rights and applies the request scope
-- explicitly to the per-cohort values.
alter table public.feature_flags set schema private;
create view public.feature_flags with (security_invoker = false) as
select flag.key, flag.description,
  case when flag.scope = 'GLOBAL' then flag.enabled
    else coalesce((select bool_or(value.enabled) from cohort_data.cohort_feature_flags value
      where value.key = flag.key and value.cohort_id = any ((select private.cohort_scope())::uuid[])), false)
  end as enabled,
  case when flag.scope = 'GLOBAL' then flag.updated_by
    else (select value.updated_by from cohort_data.cohort_feature_flags value
      where value.key = flag.key and value.cohort_id = any ((select private.cohort_scope())::uuid[])
      order by value.updated_at desc limit 1) end as updated_by,
  flag.created_at,
  case when flag.scope = 'GLOBAL' then flag.updated_at
    else coalesce((select max(value.updated_at) from cohort_data.cohort_feature_flags value
      where value.key = flag.key and value.cohort_id = any ((select private.cohort_scope())::uuid[])), flag.updated_at)
  end as updated_at,
  flag.scope
from private.feature_flags flag;
revoke all on public.feature_flags from anon, authenticated, service_role;
grant select on public.feature_flags to authenticated, service_role;

create or replace function public.update_feature_flag(p_key text, p_enabled boolean, p_reason text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_scope text;
  v_cohort_id uuid;
  v_updated_at timestamptz;
begin
  if v_actor_id is null or not public.has_permission('admin.access') then
    raise exception using errcode = '42501', message = 'FEATURE_FLAG_MANAGE_FORBIDDEN';
  end if;
  if p_enabled is null or p_correlation_id is null or p_reason is null
    or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_FEATURE_FLAG_CHANGE';
  end if;
  select scope into v_scope from private.feature_flags where key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'FEATURE_FLAG_NOT_FOUND';
  end if;
  if v_scope = 'GLOBAL' then
    -- Shared infrastructure or accreditation: one value for every cohort, changed only by ADMIN_MASTER.
    if not private.is_admin_master() then
      raise exception using errcode = '42501', message = 'FEATURE_FLAG_GLOBAL_REQUIRES_ADMIN_MASTER';
    end if;
    update private.feature_flags set enabled = p_enabled, updated_by = v_actor_id where key = p_key
    returning updated_at into v_updated_at;
  else
    v_cohort_id := private.cohort_write_id();
    insert into public.cohort_feature_flags (cohort_id, key, enabled, updated_by, updated_at)
    values (v_cohort_id, p_key, p_enabled, v_actor_id, clock_timestamp())
    on conflict (cohort_id, key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    returning updated_at into v_updated_at;
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata, cohort_id)
  values ('features.flag.changed', v_actor_id, 'feature_flag', p_key, p_correlation_id,
    jsonb_build_object('enabled', p_enabled, 'reason', p_reason, 'scope', v_scope,
      'cohort_scope', case when v_scope = 'GLOBAL' then 'GLOBAL' end), v_cohort_id);
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, cohort_id)
  values ('features.flag.changed', 'feature_flag', p_key,
    jsonb_build_object('key', p_key, 'enabled', p_enabled, 'scope', v_scope, 'correlation_id', p_correlation_id,
      'cohort_scope', case when v_scope = 'GLOBAL' then 'GLOBAL' end), v_cohort_id);
  return jsonb_build_object('key', p_key, 'enabled', p_enabled, 'updated_at', v_updated_at, 'scope', v_scope, 'cohort_id', v_cohort_id);
end;
$$;

-- 7. Rebind the dependent views to the filtered views (they referenced the base tables by OID).
-- purchase_payable_balances grouped by the primary key of the payable (functional dependency), which a view does not
-- carry: it is rebound explicitly with every grouped column; the others are rebound from their own definition.
create or replace view public.purchase_payable_balances with (security_invoker = true) as
select payable.id,
  payable.receipt_id,
  payable.supplier_id,
  supplier.name as supplier_name,
  payable.amount_cents,
  payable.payment_method as expected_payment_method,
  payable.created_at,
  coalesce(sum(case settlement.entry_type when 'SETTLEMENT'::text then settlement.amount_cents else - settlement.amount_cents end), 0::numeric)::bigint as settled_cents,
  (payable.amount_cents::numeric - coalesce(sum(case settlement.entry_type when 'SETTLEMENT'::text then settlement.amount_cents else - settlement.amount_cents end), 0::numeric))::bigint as outstanding_cents,
  case when payable.amount_cents::numeric = coalesce(sum(case settlement.entry_type when 'SETTLEMENT'::text then settlement.amount_cents else - settlement.amount_cents end), 0::numeric)
    then 'SETTLED'::text else 'PENDING'::text end as status
from public.purchase_payable_entries payable
join public.suppliers supplier on supplier.id = payable.supplier_id
left join public.purchase_payable_settlements settlement on settlement.payable_id = payable.id
group by payable.id, payable.receipt_id, payable.supplier_id, supplier.name, payable.amount_cents, payable.payment_method, payable.created_at;
delete from cohort_dependent_views where view_name = 'public.purchase_payable_balances';

do $$
declare
  v_view record;
  v_definition text;
begin
  perform set_config('search_path', '', true);
  for v_view in select view_name, view_oid, reloptions from cohort_dependent_views order by view_name loop
    v_definition := replace(pg_get_viewdef(v_view.view_oid, true), 'cohort_data.', 'public.');
    execute format('create or replace view %s%s as %s', v_view.view_name,
      case when v_view.reloptions is null then '' else ' with (' || array_to_string(v_view.reloptions, ', ') || ')' end,
      v_definition);
  end loop;
end;
$$;

-- 8. Functions whose signature uses the row type of a moved table were bound to the base table's type. They are
-- recreated over the view's type (same body, same privileges): the 11 inventoried by the spike, plus the outbox
-- functions and the refund request serializer, whose tables are scoped by this PR. Any other change aborts.
do $$
declare
  v_function record;
  v_definition text;
  v_acl record;
  v_found text[];
  v_expected text[] := array['ack_outbox_event', 'claim_outbox_events', 'claimed_payment_link_charge',
    'current_finance_opening_position', 'finance_manual_entry_effects', 'payment_link_charge_json', 'payment_link_refund_json',
    'portal_event_over', 'portal_highlight_json', 'raffle_campaign_json', 'raffle_refund_block', 'retry_outbox_event',
    'share_campaign_json', 'transition_payment_attempt', 'transition_sale_state'];
  v_dependent_view text;
begin
  perform set_config('search_path', '', true);
  -- private.picpay_transactions_view uses current_finance_opening_position(): dropped and recreated around it.
  v_dependent_view := pg_get_viewdef('private.picpay_transactions_view'::regclass, true);
  drop view private.picpay_transactions_view;
  select array_agg(distinct p.proname::text order by p.proname::text) into v_found
  from pg_proc p
  where p.prorettype in (select reltype from pg_class where relnamespace = 'cohort_data'::regnamespace)
    or exists (select 1 from unnest(p.proargtypes::oid[]) argument_type
      where argument_type in (select reltype from pg_class where relnamespace = 'cohort_data'::regnamespace));
  if v_found is distinct from v_expected then
    raise exception 'COHORT_ISOLATION_ROWTYPE_FUNCTIONS_CHANGED: expected %, found %', v_expected, v_found;
  end if;
  for v_function in
    select p.oid, p.oid::regprocedure::text as signature, p.proacl
    from pg_proc p
    where p.prorettype in (select reltype from pg_class where relnamespace = 'cohort_data'::regnamespace)
      or exists (select 1 from unnest(p.proargtypes::oid[]) argument_type
        where argument_type in (select reltype from pg_class where relnamespace = 'cohort_data'::regnamespace))
  loop
    v_definition := replace(pg_get_functiondef(v_function.oid), 'cohort_data.', 'public.');
    execute 'drop function ' || v_function.signature;
    execute v_definition;
    if v_function.proacl is not null then
      execute 'revoke all on function ' || replace(v_function.signature, 'cohort_data.', 'public.') || ' from public';
      for v_acl in select case when grantee = 0 then 'public' else grantee::regrole::text end as grantee
        from aclexplode(v_function.proacl) where privilege_type = 'EXECUTE' loop
        execute format('grant execute on function %s to %s', replace(v_function.signature, 'cohort_data.', 'public.'), v_acl.grantee);
      end loop;
    end if;
  end loop;
  execute 'create view private.picpay_transactions_view as ' || replace(v_dependent_view, 'cohort_data.', 'public.');
  revoke all on private.picpay_transactions_view from public, anon, authenticated, service_role;
end;
$$;

-- 9. Functions whose conflict targets changed with the per-cohort uniqueness.
drop function private.ensure_seller_location(uuid);
create function private.ensure_seller_location(p_seller_id uuid, p_cohort_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_location_id uuid;
  v_name text;
begin
  select id into v_location_id from public.stock_locations where seller_id = p_seller_id and cohort_id = p_cohort_id for update;
  if found then
    update public.stock_locations set active = true, updated_at = now() where id = v_location_id and not active;
    return v_location_id;
  end if;
  select left('Estoque de ' || coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1)), 120) into v_name
  from public.profiles where id = p_seller_id;
  insert into public.stock_locations (location_type, name, seller_id, cohort_id)
  values ('SELLER', btrim(coalesce(v_name, 'Estoque do vendedor')), p_seller_id, p_cohort_id)
  on conflict (cohort_id, seller_id) do nothing
  returning id into v_location_id;
  if v_location_id is null then
    select id into v_location_id from public.stock_locations where seller_id = p_seller_id and cohort_id = p_cohort_id;
  end if;
  return v_location_id;
end;
$$;
revoke all on function private.ensure_seller_location(uuid, uuid) from public, anon, authenticated;

-- A seller gets a stock location in the cohort where the role was granted.
create or replace function private.provision_seller_location()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.roles where id = new.role_id and key = 'VENDEDOR') then
    perform private.ensure_seller_location(new.user_id, new.cohort_id);
  end if;
  return new;
end;
$$;

create or replace function public.configure_fundraising_goal(p_target_cents bigint, p_counting_from date, p_target_date date, p_public_visible boolean, p_show_amounts boolean, p_idempotency_key text, p_correlation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  on conflict (cohort_id) do update set target_cents = excluded.target_cents, counting_from = excluded.counting_from,
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

-- 10. Integrity report, now across public and cohort_data and aware of the scoping modes.
create or replace function private.cohort_integrity_report()
returns table (check_name text, subject text, violations bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_table record;
  v_relation regclass;
  v_fk record;
  v_join text;
begin
  check_name := 'single_default_cohort';
  subject := 'cohorts';
  select abs(count(*) - 1) into violations from public.cohorts where is_default;
  return next;

  check_name := 'bootstrap_cohort_present';
  subject := 'cohorts';
  select case when exists (select 1 from public.cohorts where id = private.bootstrap_cohort_id()) then 0 else 1 end into violations;
  return next;

  check_name := 'profile_without_membership';
  subject := 'user_cohorts';
  select count(*) into violations
  from public.profiles profile
  where not exists (select 1 from public.user_cohorts membership where membership.user_id = profile.id);
  return next;

  check_name := 'view_drift';
  subject := 'cohort_data';
  select count(*) into violations from private.cohort_view_drift();
  return next;

  for v_table in select table_name, mode from private.cohort_scoped_tables order by table_name loop
    v_relation := coalesce(to_regclass(format('cohort_data.%I', v_table.table_name)), to_regclass(format('public.%I', v_table.table_name)));
    if v_relation is null or not exists (
      select 1 from pg_attribute where attrelid = v_relation and attname = 'cohort_id' and not attisdropped
    ) then
      check_name := 'scoped_column_missing';
      subject := v_table.table_name;
      violations := 1;
      return next;
      continue;
    end if;

    if v_table.mode = 'REQUIRED' then
      check_name := 'scoped_row_without_cohort';
      subject := v_table.table_name;
      execute format('select count(*) from %s where cohort_id is null', v_relation) into violations;
      return next;
    end if;

    check_name := 'scoped_foreign_key_not_validated';
    subject := v_table.table_name;
    select case when exists (
      select 1 from pg_constraint where conrelid = v_relation and conname = v_table.table_name || '_cohort_id_fkey' and convalidated
    ) then 0 else 1 end into violations;
    return next;

    check_name := 'scoped_table_unprotected';
    subject := v_table.table_name;
    select case when v_relation::text like 'cohort_data.%'
        and exists (select 1 from pg_trigger where tgrelid = v_relation and tgname in ('a_cohort_guard', 'a_cohort_assign'))
        and exists (select 1 from pg_policy where polrelid = v_relation and polname = v_table.table_name || '_cohort_scope' and not polpermissive)
      then 0 else 1 end into violations;
    return next;
  end loop;

  -- A row and the cohort row it references belong to the same cohort (a NULL on either side is not attributed yet).
  for v_fk in
    select constraint_row.conname, child.oid as child_oid, parent.oid as parent_oid, child.relname as child_table,
      constraint_row.conrelid, constraint_row.confrelid, constraint_row.conkey, constraint_row.confkey
    from pg_constraint constraint_row
    join pg_class child on child.oid = constraint_row.conrelid
    join pg_class parent on parent.oid = constraint_row.confrelid
    where constraint_row.contype = 'f'
      and child.relnamespace in ('public'::regnamespace, 'cohort_data'::regnamespace)
      and parent.relnamespace in ('public'::regnamespace, 'cohort_data'::regnamespace)
      and child.relname in (select table_name from private.cohort_scoped_tables)
      and parent.relname in (select table_name from private.cohort_scoped_tables)
    order by child.relname, constraint_row.conname
  loop
    select string_agg(format('parent_row.%I = child_row.%I', parent_column.attname, child_column.attname), ' and ')
    into v_join
    from unnest(v_fk.conkey, v_fk.confkey) as key_pair(child_attnum, parent_attnum)
    join pg_attribute child_column on child_column.attrelid = v_fk.conrelid and child_column.attnum = key_pair.child_attnum
    join pg_attribute parent_column on parent_column.attrelid = v_fk.confrelid and parent_column.attnum = key_pair.parent_attnum;

    check_name := 'cross_cohort_reference';
    subject := v_fk.child_table || '.' || v_fk.conname;
    execute format(
      'select count(*) from %s child_row join %s parent_row on %s '
      'where child_row.cohort_id is not null and parent_row.cohort_id is not null and child_row.cohort_id <> parent_row.cohort_id',
      v_fk.child_oid::regclass, v_fk.parent_oid::regclass, v_join
    ) into violations;
    return next;
  end loop;

  check_name := 'unattributed_evidence_with_attributed_parent';
  subject := 'picpay_transaction_links';
  select count(*) into violations from cohort_data.picpay_transaction_links link
  join cohort_data.payment_attempts attempt on attempt.id = link.payment_attempt_id
  where link.cohort_id is null;
  return next;

  check_name := 'payment_terminal_without_cohort';
  subject := 'cohort_payment_terminals';
  select count(*) into violations from private.payment_terminals terminal
  where not exists (select 1 from cohort_data.cohort_payment_terminals association where association.terminal_id = terminal.id);
  return next;

  check_name := 'cohort_flag_value_missing';
  subject := 'cohort_feature_flags';
  select count(*) into violations from public.cohorts cohort cross join private.feature_flags flag
  where flag.scope = 'COHORT' and cohort.status <> 'ARCHIVED'
    and not exists (select 1 from cohort_data.cohort_feature_flags value where value.cohort_id = cohort.id and value.key = flag.key);
  return next;

  check_name := 'published_cohort_view';
  subject := 'publications';
  select count(*) into violations from pg_publication_tables
  where schemaname = 'public' and tablename in (select table_name from private.cohort_scoped_tables);
  return next;
end;
$$;

do $$
declare
  v_failures text;
begin
  select string_agg(check_name || ' ' || subject || '=' || violations, ', ' order by check_name, subject)
  into v_failures
  from private.cohort_integrity_report()
  where violations <> 0;
  if v_failures is not null then
    raise exception 'COHORT_INTEGRITY_FAILED: %', v_failures;
  end if;
end;
$$;

notify pgrst, 'reload schema';
