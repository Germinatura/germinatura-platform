-- SPIKE (disposable local database only, never a migration): candidate cohort isolation for PR 2 (ADR 0011).
-- A representative slice of cohort-scoped tables moves to the non-exposed schema cohort_data. In public, a view with
-- the same name filters by the request's cohort scope (security_invoker, cascaded check option), and a guard trigger
-- on the base table fills and validates cohort_id. Existing functions keep reading and writing public.<table>.
--
-- Slice: categories (master with triggers), products (parent and child, FKs in and out), product_prices (immutable
-- ledger), product_images, product_stock_alerts (DELETE + ON CONFLICT), finance_manual_entries (ledger with a
-- self reference), portal_highlights (identity sequence).
begin;

-- Realtime/publication guard: a view cannot be published, so a published table must never be converted silently.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where schemaname = 'public'
      and tablename in ('categories', 'products', 'product_prices', 'product_images', 'product_stock_alerts', 'finance_manual_entries', 'portal_highlights')
  ) then
    raise exception 'COHORT_SPIKE_PUBLISHED_TABLE: a table of the slice is in a publication';
  end if;
end;
$$;

create schema cohort_data;
grant usage on schema cohort_data to anon, authenticated, service_role;

-- Prototype of ADMIN_MASTER storage (PR 2 models it properly).
create table private.spike_admin_masters (user_id uuid primary key references public.profiles (id));

-- Request context ----------------------------------------------------------------------------------------------------
-- Kind of caller: 'system' (no request: migrations, tests as postgres, maintenance), 'service', 'anon' or 'user'.
create function private.cohort_caller() returns text
language sql stable set search_path = '' as $$
  select case
    when auth.uid() is not null then 'user'
    when coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role') = 'service_role' then 'service'
    when coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role') = 'anon' then 'anon'
    else 'system'
  end
$$;

create function private.cohort_header() returns text
language sql stable set search_path = '' as $$
  select nullif(btrim(nullif(current_setting('request.headers', true), '')::json ->> 'x-germinatura-cohort'), '')
$$;

create function private.is_admin_master() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.spike_admin_masters master join public.profiles profile on profile.id = master.user_id
    where master.user_id = auth.uid() and profile.active
  )
$$;

-- Security boundary (RLS, Realtime): may the caller read rows of this cohort at all?
create function private.cohort_readable(p_cohort_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.cohort_caller()
    when 'system' then true
    when 'service' then true
    when 'anon' then exists (select 1 from public.cohorts where id = p_cohort_id and is_default)
    else private.is_admin_master() or exists (
      select 1 from public.user_cohorts where user_id = auth.uid() and cohort_id = p_cohort_id and status = 'ACTIVE')
  end
$$;

-- Request scope (views): the cohorts this request reads. 'all' only for ADMIN_MASTER; a cohort only if readable.
-- Without a header (rollout compatibility only): the default cohort if readable, else the single membership.
create function private.cohort_scope() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_caller text := private.cohort_caller();
  v_header text := private.cohort_header();
  v_key text := v_caller || '|' || coalesce(auth.uid()::text, '') || '|' || coalesce(v_header, '');
  v_cached text := nullif(current_setting('germinatura.cohort_scope', true), '');
  v_scope uuid[];
begin
  if v_cached is not null and split_part(v_cached, '#', 1) = v_key then
    return split_part(v_cached, '#', 2)::uuid[];
  end if;
  if v_caller in ('system', 'service') then
    select coalesce(array_agg(id order by id), '{}') into v_scope from public.cohorts;
  elsif v_caller = 'anon' then
    select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where is_default;
  elsif v_header = 'all' then
    if private.is_admin_master() then
      select coalesce(array_agg(id order by id), '{}') into v_scope from public.cohorts;
    else
      v_scope := '{}';
    end if;
  elsif v_header ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_scope := case when private.cohort_readable(v_header::uuid) then array[v_header::uuid] else '{}' end;
  else
    select coalesce(array_agg(id), '{}') into v_scope from public.cohorts where is_default and private.cohort_readable(id);
    if v_scope = '{}' then
      select coalesce(array_agg(cohort_id), '{}') into v_scope from public.user_cohorts
      where user_id = auth.uid() and status = 'ACTIVE' having count(*) = 1;
    end if;
  end if;
  perform set_config('germinatura.cohort_scope', v_key || '#' || v_scope::text, true);
  return v_scope;
end;
$$;

-- The single cohort a user/anon write goes to; never 'all'.
create function private.cohort_write_id() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_scope uuid[] := private.cohort_scope();
begin
  if private.cohort_caller() in ('system', 'service') then
    return null;
  end if;
  if private.cohort_header() = 'all' or cardinality(v_scope) <> 1 then
    raise exception using errcode = '22023', message = 'COHORT_REQUIRED';
  end if;
  return v_scope[1];
end;
$$;

-- Guard on every base table: fill, keep, validate (parents passed as column/table pairs in TG_ARGV).
create function private.guard_cohort_write() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_row jsonb;
  v_user boolean := private.cohort_caller() in ('user', 'anon');
  v_write uuid;
  v_parent uuid;
  v_value text;
  v_index integer := 0;
begin
  if v_user then
    v_write := private.cohort_write_id();
  end if;
  if tg_op = 'DELETE' then
    if v_user and old.cohort_id is distinct from v_write then
      raise exception using errcode = '42501', message = 'COHORT_MISMATCH';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.cohort_id is distinct from old.cohort_id then
    raise exception using errcode = '42501', message = 'COHORT_IMMUTABLE';
  end if;
  v_row := to_jsonb(new);
  while v_index < tg_nargs loop
    v_value := v_row ->> tg_argv[v_index];
    if v_value is not null then
      execute format('select cohort_id from cohort_data.%I where id = $1', tg_argv[v_index + 1]) into v_parent using v_value::uuid;
      if new.cohort_id is null then
        new.cohort_id := v_parent;
      elsif v_parent is distinct from new.cohort_id then
        raise exception using errcode = '42501', message = 'COHORT_MISMATCH';
      end if;
    end if;
    v_index := v_index + 2;
  end loop;
  if new.cohort_id is null then
    new.cohort_id := coalesce(v_write, (select id from public.cohorts where is_default));
  end if;
  if v_user then
    if new.cohort_id is distinct from v_write then
      raise exception using errcode = '42501', message = 'COHORT_MISMATCH';
    end if;
    if exists (select 1 from public.cohorts where id = new.cohort_id and status = 'ARCHIVED') then
      raise exception using errcode = '42501', message = 'COHORT_ARCHIVED';
    end if;
  end if;
  return new;
end;
$$;

-- View over the base table, same name and grants, filtered by the request scope.
create function private.refresh_cohort_view(p_table text) returns void
language plpgsql set search_path = '' as $$
declare
  v_grant record;
begin
  execute format(
    'create or replace view public.%I with (security_invoker = true, security_barrier = true) as '
    'select * from cohort_data.%I where cohort_id = any ((select private.cohort_scope())::uuid[]) with cascaded check option',
    p_table, p_table);
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

create function private.scope_table(p_table text, p_parents text[] default '{}') returns void
language plpgsql set search_path = '' as $$
begin
  execute format('alter table public.%I set schema cohort_data', p_table);
  execute format('alter table cohort_data.%I alter column cohort_id drop default', p_table);
  execute format('alter table cohort_data.%I alter column cohort_id set not null', p_table);
  execute format('alter table cohort_data.%I enable row level security', p_table);
  execute format(
    'create policy %I on cohort_data.%I as restrictive for all to anon, authenticated '
    'using ((select private.cohort_readable(cohort_id))) with check ((select private.cohort_readable(cohort_id)))',
    p_table || '_cohort_scope', p_table);
  execute format(
    'create trigger a_cohort_guard before insert or update or delete on cohort_data.%I for each row execute function private.guard_cohort_write(%s)',
    p_table, (select coalesce(string_agg(quote_literal(value), ', '), '') from unnest(p_parents) value));
  perform private.refresh_cohort_view(p_table);
end;
$$;

-- Dependent views were bound to the moved tables by OID: recreate them over the filtered views.
create temp table dependent_views as
select distinct format('%I.%I', view_namespace.nspname, view_class.relname) as view_name, view_class.oid as view_oid,
  view_class.reloptions
from pg_depend dependency
join pg_rewrite rewrite on rewrite.oid = dependency.objid
join pg_class view_class on view_class.oid = rewrite.ev_class
join pg_namespace view_namespace on view_namespace.oid = view_class.relnamespace
join pg_class table_class on table_class.oid = dependency.refobjid
where table_class.relnamespace = 'public'::regnamespace
  and table_class.relname in ('categories', 'products', 'product_prices', 'product_images', 'product_stock_alerts', 'finance_manual_entries', 'portal_highlights')
  and view_class.oid <> table_class.oid;

select private.scope_table('categories');
select private.scope_table('products', array['category_id', 'categories']);
select private.scope_table('product_prices', array['product_id', 'products']);
select private.scope_table('product_images', array['product_id', 'products']);
select private.scope_table('product_stock_alerts', array['product_id', 'products']);
select private.scope_table('finance_manual_entries', array['reversal_of', 'finance_manual_entries']);
select private.scope_table('portal_highlights');

do $$
declare
  v_view record;
  v_definition text;
begin
  perform set_config('search_path', '', true);
  for v_view in select view_name, view_oid, reloptions from dependent_views loop
    v_definition := replace(pg_get_viewdef(v_view.view_oid, true), 'cohort_data.', 'public.');
    execute format('create or replace view %s%s as %s', v_view.view_name,
      case when v_view.reloptions is null then '' else ' with (' || array_to_string(v_view.reloptions, ', ') || ')' end, v_definition);
  end loop;
end;
$$;

-- Functions whose signature uses a moved row type were bound to the base table's type by OID: recreate them over the
-- view's type (same body), keeping their privileges.
do $$
declare
  v_function record;
  v_definition text;
  v_acl record;
begin
  perform set_config('search_path', '', true);
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
end;
$$;

-- Drift check for later migrations: every view exposes exactly the columns of its base table.
create function private.cohort_view_drift() returns table (table_name text, problem text)
language sql stable set search_path = '' as $$
  select base.relname::text, 'view columns differ from base columns'
  from pg_class base
  join pg_class view_class on view_class.relname = base.relname and view_class.relnamespace = 'public'::regnamespace and view_class.relkind = 'v'
  where base.relnamespace = 'cohort_data'::regnamespace and base.relkind = 'r'
    and (select array_agg(attname order by attnum) from pg_attribute where attrelid = base.oid and attnum > 0 and not attisdropped)
      is distinct from (select array_agg(attname order by attnum) from pg_attribute where attrelid = view_class.oid and attnum > 0 and not attisdropped)
$$;

commit;

notify pgrst, 'reload schema';
