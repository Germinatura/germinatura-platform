-- SPIKE test (run after spike.sql on a disposable database): cohort isolation of the "base table + filtered view"
-- candidate, through views, base tables (RLS), SECURITY DEFINER RPCs and every DML form, plus grants, policies,
-- dependent views, identity sequences, later ALTER TABLE, publications and archived cohorts.
begin;
select plan(49);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
end;
$$;
create function pg_temp.sys() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
end;
$$;
-- What an RPC sees: runs a statement as the definer (postgres), with the caller's request context.
create function pg_temp.definer(p_sql text) returns bigint language plpgsql security definer as $$
declare v_count bigint;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
create function pg_temp.definer_count(p_sql text) returns bigint language plpgsql security definer as $$
declare v_count bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into v_count;
  return v_count;
end;
$$;

-- Setup (system context): Turma 2027, one admin per cohort, an ADMIN_MASTER, catalog and finance rows in both.
insert into public.cohorts (id, name, year, slug, status) values ('c0000000-0000-4000-8000-000000002027', 'Turma 2027', 2027, '2027', 'ACTIVE')
on conflict (id) do update set status = 'ACTIVE';
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', '1c000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'admin.b@institutojef.org.br',
    extensions.crypt('SpikeB123!', extensions.gen_salt('bf')), now(), '{}', '{"name":"Admin Turma B","username":"admin.turma.b"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '1c000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'master.spike@institutojef.org.br',
    extensions.crypt('SpikeM123!', extensions.gen_salt('bf')), now(), '{}', '{"name":"Master Spike","username":"master.spike"}', now(), now());
update public.user_cohorts set status = 'INACTIVE' where user_id = '1c000000-0000-4000-8000-00000000000b';
insert into public.user_cohorts (user_id, cohort_id) values ('1c000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-000000002027');
insert into public.user_roles (user_id, role_id) select '1c000000-0000-4000-8000-00000000000b', id from public.roles where key = 'ADMIN';
insert into public.user_roles (user_id, role_id) select '1c000000-0000-4000-8000-00000000000a', id from public.roles where key = 'ADMIN';
insert into private.spike_admin_masters values ('1c000000-0000-4000-8000-00000000000a');

insert into public.categories (id, name, slug, active, sort_order) values ('5a000000-0000-4000-8000-00000000000a', 'Spike A', 'spike-a', true, 1);
insert into public.categories (id, name, slug, active, sort_order, cohort_id) values ('5a000000-0000-4000-8000-00000000000b', 'Spike B', 'spike-b', true, 1, 'c0000000-0000-4000-8000-000000002027');
insert into public.products (id, category_id, sku, slug, name, active, published) values
  ('5b000000-0000-4000-8000-00000000000a', '5a000000-0000-4000-8000-00000000000a', 'SPIKE-A', 'spike-produto-a', 'Spike produto A', true, true),
  ('5b000000-0000-4000-8000-00000000000b', '5a000000-0000-4000-8000-00000000000b', 'SPIKE-B', 'spike-produto-b', 'Spike produto B', true, true);
insert into public.product_prices (product_id, amount_cents, valid_from, created_by) values
  ('5b000000-0000-4000-8000-00000000000a', 500, now() - interval '1 day', '10000000-0000-4000-8000-000000000001'),
  ('5b000000-0000-4000-8000-00000000000b', 700, now() - interval '1 day', '10000000-0000-4000-8000-000000000001');
insert into public.finance_manual_entries (id, kind, category, account, amount_cents, occurred_on, description, actor_id, correlation_id, cohort_id) values
  ('5c000000-0000-4000-8000-00000000000b', 'EXPENSE', 'OUTROS', 'PICPAY_EMPRESAS', 900, current_date, 'Despesa da turma B', '1c000000-0000-4000-8000-00000000000b', gen_random_uuid(), 'c0000000-0000-4000-8000-000000002027');
create temp table ids (name text primary key, id uuid);
grant all on ids to anon, authenticated;

select is((select cohort_id from public.categories where id = '5a000000-0000-4000-8000-00000000000a'), 'c0000000-0000-4000-8000-000000002026'::uuid,
  'system write without cohort lands in the default cohort');
select is((select cohort_id from public.products where id = '5b000000-0000-4000-8000-00000000000b'), 'c0000000-0000-4000-8000-000000002027'::uuid,
  'a child row without cohort inherits the cohort of its parent');

-- Reads through the views.
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', null);
select is((select count(*)::integer from public.categories where slug in ('spike-a', 'spike-b')), 1, 'admin of A without header reads only A (rollout fallback)');
select is((select count(*)::integer from public.products where sku in ('SPIKE-A', 'SPIKE-B')), 1, 'and only the products of A');
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000002027');
select is((select count(*)::integer from public.categories where slug in ('spike-a', 'spike-b')), 0, 'admin of A asking for B by header reads nothing');
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'all');
select is((select count(*)::integer from public.categories where slug in ('spike-a', 'spike-b')), 0, '"all" is refused to a non-master');
select pg_temp.ctx('1c000000-0000-4000-8000-00000000000b', null);
select is((select string_agg(slug, ',') from public.categories where slug in ('spike-a', 'spike-b')), 'spike-b', 'admin of B only (single membership) reads B');
select pg_temp.ctx('1c000000-0000-4000-8000-00000000000a', 'all');
select is((select count(*)::integer from public.categories where slug in ('spike-a', 'spike-b')), 2, 'ADMIN_MASTER reads every cohort in "all"');
select pg_temp.ctx('1c000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000002027');
select is((select string_agg(slug, ',') from public.categories where slug in ('spike-a', 'spike-b')), 'spike-b', 'ADMIN_MASTER narrows to one cohort');

-- The base table is a boundary of its own (RLS), even without the view.
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000002027');
select is((select count(*)::integer from cohort_data.categories where slug in ('spike-a', 'spike-b')), 1,
  'reading the base table directly still returns only the cohorts the user belongs to');
select pg_temp.ctx(null, null);
select is((select string_agg(sku, ',') from public.products where sku in ('SPIKE-A', 'SPIKE-B')), 'SPIKE-A', 'anon sees the published catalogue of the default cohort only');
select is((select count(*)::integer from cohort_data.products where sku in ('SPIKE-A', 'SPIKE-B')), 1, 'anon on the base table is limited the same way');

-- SECURITY DEFINER: what every existing RPC sees.
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', null);
select is(pg_temp.definer_count($$select 1 from public.categories where slug in ('spike-a', 'spike-b')$$), 1::bigint, 'a definer function sees only the request cohort');
select is(pg_temp.definer_count($$select 1 from public.categories where id = '5a000000-0000-4000-8000-00000000000b' for update$$), 0::bigint,
  'FOR UPDATE cannot lock a row of another cohort');
select is(pg_temp.definer_count($$select 1 from public.categories where id = '5a000000-0000-4000-8000-00000000000a' for update$$), 1::bigint,
  'FOR UPDATE locks a row of the request cohort');
select is(pg_temp.definer($$update public.categories set sort_order = 2 where id = '5a000000-0000-4000-8000-00000000000b'$$), 0::bigint,
  'UPDATE of a row of another cohort affects nothing');
select is(pg_temp.definer($$delete from public.product_stock_alerts where product_id = '5b000000-0000-4000-8000-00000000000b'$$), 0::bigint,
  'DELETE of rows of another cohort affects nothing');
select throws_ok($$select public.save_catalog_category('5a000000-0000-4000-8000-00000000000b', 1, 'Invadida', 'spike-b', true, 1, 'Tentativa entre turmas', 'spike-cross', gen_random_uuid())$$,
  'P0002', 'CATEGORY_NOT_FOUND', 'an existing RPC cannot touch a category of another cohort');
select throws_ok($$select public.set_catalog_product_price('5b000000-0000-4000-8000-00000000000b', 1, 999, 'Preço entre turmas', 'spike-cross-price', gen_random_uuid())$$,
  null, null, 'nor price a product of another cohort (immutable ledger)');
select throws_ok($$select public.save_catalog_product(null, null, '5a000000-0000-4000-8000-00000000000b', 'spike-cruzado', 'Cruzado', null, true, true, true, false, false, 'Produto entre turmas', 'spike-cross-product', gen_random_uuid())$$,
  null, null, 'nor create a product of A under a category of B');
select throws_ok($$select pg_temp.definer($q$insert into public.products (category_id, sku, slug, name) values ('5a000000-0000-4000-8000-00000000000b', 'SPIKE-X', 'spike-x', 'X')$q$)$$,
  '42501', 'COHORT_MISMATCH', 'a raw insert pointing at a parent of another cohort is refused by the guard');
select throws_ok($$select pg_temp.definer($q$insert into public.categories (name, slug, cohort_id) values ('Forçada', 'spike-forcada', 'c0000000-0000-4000-8000-000000002027')$q$)$$,
  '42501', 'COHORT_MISMATCH', 'a raw insert naming another cohort is refused');

-- Writes through existing RPCs land in the request cohort (INSERT … RETURNING, ON CONFLICT, ledger, identity).
insert into ids select 'cat_a', (public.save_catalog_category(null, null, 'Spike A2', 'spike-a2', true, 3, 'Categoria nova', 'spike-cat-a2', gen_random_uuid()) ->> 'id')::uuid;
select is((select cohort_id from cohort_data.categories where id = (select id from ids where name = 'cat_a')), 'c0000000-0000-4000-8000-000000002026'::uuid,
  'an RPC insert (RETURNING) of the admin of A lands in A');
select lives_ok($$select public.set_stock_alert('5b000000-0000-4000-8000-00000000000a', true)$$, 'stock alert on a product of A');
select lives_ok($$select public.set_stock_alert('5b000000-0000-4000-8000-00000000000a', true)$$, 'again: ON CONFLICT through the view');
select is((select count(*)::integer from public.product_stock_alerts where product_id = '5b000000-0000-4000-8000-00000000000a'), 1, 'still one alert');
select throws_ok($$select public.set_stock_alert('5b000000-0000-4000-8000-00000000000b', true)$$, '22023', 'INVALID_STOCK_ALERT',
  'no alert on a product of another cohort');
select lives_ok($$select public.set_stock_alert('5b000000-0000-4000-8000-00000000000a', false)$$, 'DELETE through the view');
select is((select count(*)::integer from public.product_stock_alerts where product_id = '5b000000-0000-4000-8000-00000000000a'), 0, 'alert removed');
select lives_ok($$select public.record_finance_entry('EXPENSE', 'OUTROS', 'PICPAY_EMPRESAS', null, 300, current_date, 'Despesa da turma A', null, 'spike-expense-a', gen_random_uuid())$$,
  'finance entry of A');
select throws_ok($$select public.reverse_finance_entry('5c000000-0000-4000-8000-00000000000b', 'Estorno entre turmas', 'spike-reverse-b', gen_random_uuid())$$,
  null, null, 'an entry of B cannot be reversed from A');
select is(((public.list_finance_entries(current_date - 1, current_date + 1) -> 'items') -> 0 ->> 'description'), 'Despesa da turma A',
  'the finance list of A shows only A');
select lives_ok($$select public.save_portal_highlight('Destaque A', 'Mensagem da turma A', null, null, true, null, 'spike-highlight-a', gen_random_uuid())$$,
  'highlight of A (identity sequence through the view)');
select is(pg_temp.definer_count($$select 1 from public.portal_highlights where title = 'Destaque A' and sequence is not null$$), 1::bigint, 'the identity sequence is assigned');

select pg_temp.ctx('1c000000-0000-4000-8000-00000000000b', null);
select lives_ok($$select public.reverse_finance_entry('5c000000-0000-4000-8000-00000000000b', 'Estorno legítimo', 'spike-reverse-b-own', gen_random_uuid())$$,
  'the admin of B reverses the entry of B (self reference)');
select is(pg_temp.definer_count($$select 1 from public.finance_manual_entries where reversal_of = '5c000000-0000-4000-8000-00000000000b' and cohort_id = 'c0000000-0000-4000-8000-000000002027'$$), 1::bigint,
  'the reversal belongs to B');

-- "All" is read-only; a concrete cohort is required to write.
select pg_temp.ctx('1c000000-0000-4000-8000-00000000000a', 'all');
select throws_ok($$select public.save_catalog_category(null, null, 'Sem turma', 'spike-sem-turma', true, 1, 'Escrita em Todas', 'spike-all', gen_random_uuid())$$,
  '22023', 'COHORT_REQUIRED', 'ADMIN_MASTER cannot write in "all"');
select pg_temp.ctx('1c000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000002027');
insert into ids select 'cat_master_b', (public.save_catalog_category(null, null, 'Spike B2', 'spike-b2', true, 3, 'Categoria da turma B', 'spike-cat-b2', gen_random_uuid()) ->> 'id')::uuid;
select is((select cohort_id from cohort_data.categories where id = (select id from ids where name = 'cat_master_b')), 'c0000000-0000-4000-8000-000000002027'::uuid,
  'ADMIN_MASTER with a concrete cohort writes into it');

-- Archived cohort: readable, not writable.
select pg_temp.sys();
update public.cohorts set status = 'ARCHIVED' where id = 'c0000000-0000-4000-8000-000000002027';
select pg_temp.ctx('1c000000-0000-4000-8000-00000000000b', null);
select is((select count(*)::integer from public.categories where slug in ('spike-b', 'spike-b2')), 2, 'an archived cohort stays readable');
select throws_ok($$select public.save_catalog_category(null, null, 'Arquivada', 'spike-arquivada', true, 1, 'Escrita em turma arquivada', 'spike-archived', gen_random_uuid())$$,
  '42501', 'COHORT_ARCHIVED', 'an archived cohort refuses writes');

-- Structure: grants, policies, dependent views, cohort immutability, publications, later ALTER TABLE.
select pg_temp.sys();
select ok(not has_table_privilege('authenticated', 'public.categories', 'INSERT') and not has_table_privilege('anon', 'public.products', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.finance_manual_entries', 'SELECT'), 'views carry exactly the grants of their base tables');
select is((select count(*)::integer from pg_policies where schemaname = 'cohort_data' and tablename = 'products'), 4,
  'the existing policies moved with the table, plus the restrictive cohort policy');
select ok(exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
  where r.ev_class = 'public.current_quantity_price_promotions'::regclass and d.refobjid = 'public.products'::regclass)
  and not exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
  where r.ev_class = 'public.current_quantity_price_promotions'::regclass and d.refobjid = 'cohort_data.products'::regclass),
  'dependent views were rebound from the base table to the filtered view');
select throws_ok($$update public.categories set cohort_id = 'c0000000-0000-4000-8000-000000002027' where id = '5a000000-0000-4000-8000-00000000000a'$$,
  '42501', 'COHORT_IMMUTABLE', 'a row never changes cohort');
select throws_ok($$alter publication supabase_realtime add table public.categories$$, null, null, 'a view cannot be published (Realtime)');
savepoint publication;
select lives_ok($$alter publication supabase_realtime add table cohort_data.categories$$, 'the base table can be published');
rollback to savepoint publication;
savepoint later_migration;
select throws_ok($$alter table public.categories add column spike_note text$$, null, null, 'a later migration cannot ALTER the view');
alter table cohort_data.categories add column spike_note text;
select is((select count(*)::integer from private.cohort_view_drift()), 1, 'the drift check catches the column the view does not expose');
select private.refresh_cohort_view('categories');
select is((select count(*)::integer from private.cohort_view_drift()), 0, 'refreshing the view restores parity (migration convention)');
rollback to savepoint later_migration;

select * from finish();
rollback;
