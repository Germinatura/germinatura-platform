-- ADR 0011 (multi-turma), PR 2 — autorização e isolamento por turma: contexto da requisição, ADMIN_MASTER, RBAC por
-- turma, isolamento A/B por views/RLS/guards, maquininhas globais, flags por turma, atribuição PicPay, fan-out,
-- unicidades e singletons por turma, auditoria.
begin;
select plan(77);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  -- Each call stands for a new request (a new transaction in production): drop the per-transaction scope cache.
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.sys() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('germinatura.system_cohort', '', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
-- What a SECURITY DEFINER function sees for the current request (counts rows of a query).
create function pg_temp.seen(p_sql text) returns bigint language plpgsql security definer as $$
declare v_count bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into v_count;
  return v_count;
end;
$$;
create temp table ids (name text primary key, id uuid);
grant all on ids to anon, authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.a() returns text language sql as $$ select 'c0000000-0000-4000-8000-000000002026' $$;
create function pg_temp.b() returns text language sql as $$ select id::text from ids where name = 'cohort_b' $$;

-- People: master.teste (fixture) is the ADMIN_MASTER; the others start as consumers of Turma 2026.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, extensions.crypt('Turmas123!', extensions.gen_salt('bf')), now(),
  '{}', jsonb_build_object('name', name, 'username', username), now(), now()
from (values
  ('1d000000-0000-4000-8000-0000000000a1'::uuid, 'admin.turma.a@institutojef.org.br', 'Admin Turma A', 'admin.turma.a'),
  ('1d000000-0000-4000-8000-0000000000b1'::uuid, 'admin.turma.b@institutojef.org.br', 'Admin Turma B', 'admin.turma.b'),
  ('1d000000-0000-4000-8000-0000000000d1'::uuid, 'duas.turmas@institutojef.org.br', 'Pessoa Duas Turmas', 'duas.turmas'),
  ('1d000000-0000-4000-8000-0000000000c1'::uuid, 'consumidor.turma.b@institutojef.org.br', 'Consumidor Turma B', 'consumidor.turma.b')
) people(id, email, name, username);

-- A. ADMIN_MASTER creates Turma B (a global operation) and is audited as a normal actor.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
insert into ids select 'cohort_b', (public.create_cohort('Turma B', 2031, 'turma-b', 'ACTIVE', 'cohort-test-create-b', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.sys();
select is((select name || '/' || status from public.cohorts where id = pg_temp.id('cohort_b')), 'Turma B/ACTIVE', 'ADMIN_MASTER creates a cohort');
select is((select count(*)::integer from cohort_data.audit_logs where action = 'cohorts.created' and entity_id = pg_temp.b()
  and actor_id = '10000000-0000-4000-8000-000000000005' and cohort_id is null), 1, 'the creation is audited, global, with ADMIN_MASTER as actor');
select ok(exists (select 1 from cohort_data.stock_locations where cohort_id = pg_temp.id('cohort_b') and location_type = 'CENTRAL' and active)
  and exists (select 1 from cohort_data.reservation_settings where cohort_id = pg_temp.id('cohort_b'))
  and (select count(*) from cohort_data.cohort_feature_flags where cohort_id = pg_temp.id('cohort_b'))
    = (select count(*) from private.feature_flags where scope = 'COHORT'), 'the new cohort is provisioned (central stock, settings, module flags)');
select throws_ok($$select public.create_cohort('Turma B de novo', 2031, 'turma-b-2', 'ACTIVE', 'cohort-test-create-dup', gen_random_uuid())$$,
  '42501', 'COHORTS_MANAGE_REQUIRED', 'without a session nobody creates cohorts');

-- Roles per cohort, granted by ADMIN_MASTER inside each concrete cohort.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.a());
select public.set_user_access('1d000000-0000-4000-8000-0000000000a1', array['ADMIN'], true, gen_random_uuid());
select public.set_user_access('1d000000-0000-4000-8000-0000000000d1', array['VENDEDOR'], true, gen_random_uuid());
select public.set_user_access('1d000000-0000-4000-8000-0000000000b1', array[]::text[], false, gen_random_uuid());
select public.set_user_access('1d000000-0000-4000-8000-0000000000c1', array[]::text[], false, gen_random_uuid());
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b());
select public.set_cohort_membership(person, true, 'Entrada na turma B', gen_random_uuid())
from unnest(array['1d000000-0000-4000-8000-0000000000b1', '1d000000-0000-4000-8000-0000000000d1', '1d000000-0000-4000-8000-0000000000c1']::uuid[]) person;
select public.set_user_access('1d000000-0000-4000-8000-0000000000b1', array['ADMIN'], true, gen_random_uuid());
select public.set_user_access('1d000000-0000-4000-8000-0000000000d1', array['ADMIN', 'VENDEDOR'], true, gen_random_uuid());
select pg_temp.sys();
create function pg_temp.roles_in(p_user uuid, p_cohort uuid) returns text language sql as $$
  select string_agg(role.key, ',' order by role.key) from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
  where user_role.user_id = p_user and user_role.cohort_id = p_cohort $$;
select ok(pg_temp.roles_in('1d000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-000000002026') = 'CONSUMIDOR,VENDEDOR'
  and pg_temp.roles_in('1d000000-0000-4000-8000-0000000000d1', pg_temp.id('cohort_b')) = 'ADMIN,CONSUMIDOR,VENDEDOR',
  'one identity holds different roles in two cohorts');
select is((select count(*)::integer from cohort_data.stock_locations where seller_id = '1d000000-0000-4000-8000-0000000000d1'), 2,
  'a seller of two cohorts has one stock location in each');
select is((select count(*)::integer from public.user_cohorts where user_id = '1d000000-0000-4000-8000-0000000000b1' and status = 'ACTIVE'), 1,
  'the admin of B is active only in B');

-- C. has_permission and the session follow the request cohort.
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000d1', pg_temp.a());
select ok(public.has_permission('sales.create') and not public.has_permission('catalog.manage'), 'in A the person sells but does not manage the catalog');
select is((public.get_my_session() ->> 'roles'), '["CONSUMIDOR", "VENDEDOR"]', 'the session of A lists the roles of A');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000d1', pg_temp.b());
select ok(public.has_permission('catalog.manage') and public.has_permission('sales.create'), 'in B the same person manages the catalog');
select is((public.get_my_session() -> 'cohort' ->> 'id'), pg_temp.b(), 'the session reports the request cohort');
select is((public.get_my_session() ->> 'admin_master')::boolean, false, 'and that the person is not ADMIN_MASTER');

-- Data in both cohorts (catalog through the existing RPCs).
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
insert into ids select 'category_a', (public.save_catalog_category(null, null, 'Turma A', 'mesma-categoria', true, 1, 'Categoria da turma A', 'cohort-test-cat-a', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
insert into ids select 'category_b', (public.save_catalog_category(null, null, 'Turma B', 'mesma-categoria', true, 1, 'Categoria da turma B', 'cohort-test-cat-b', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.sys();
select ok((select count(*) from cohort_data.categories where slug = 'mesma-categoria' and cohort_id = 'c0000000-0000-4000-8000-000000002026') = 1
  and (select count(*) from cohort_data.categories where slug = 'mesma-categoria' and cohort_id = pg_temp.id('cohort_b')) = 1,
  'the same slug exists once per cohort (single-membership users write without a header)');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
select throws_ok($$select public.save_catalog_category(null, null, 'Repetida', 'mesma-categoria', true, 2, 'Slug repetido na turma', 'cohort-test-cat-dup', gen_random_uuid())$$,
  null, null, 'but twice in one cohort is refused');

-- B. A normal ADMIN administers only its cohort.
select is(pg_temp.seen($$select 1 from public.categories where slug = 'mesma-categoria'$$), 1::bigint, 'admin of A sees only the category of A');
select is(pg_temp.seen(format($$select 1 from public.categories where id = %L$$, pg_temp.id('category_b'))), 0::bigint,
  'not even reading the category of B by id');
select throws_ok(format($$select public.save_catalog_category(%L, 1, 'Invadida', 'mesma-categoria', true, 1, 'Tentativa entre turmas', 'cohort-test-cross', gen_random_uuid())$$,
  pg_temp.id('category_b')), 'P0002', 'CATEGORY_NOT_FOUND', 'nor changing it through an RPC by id');
select is(pg_temp.seen(format($$select 1 from cohort_data.categories where id = %L$$, pg_temp.id('category_b'))), 1::bigint,
  '(the row exists: the definer bypasses RLS, the view is what isolates)');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', 'x');
select is(pg_temp.seen($$select 1 from public.categories$$), 0::bigint, 'a malformed cohort header reads nothing');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', pg_temp.b());
select is(pg_temp.seen($$select 1 from public.categories$$), 0::bigint, 'F. a header naming a cohort the user does not belong to reads nothing');
select ok(not public.has_permission('catalog.manage'), 'and grants no permission');
select throws_ok($$select public.save_catalog_category(null, null, 'Furtiva', 'furtiva', true, 1, 'Escrita sem vínculo', 'cohort-test-sneak', gen_random_uuid())$$,
  '42501', null, 'nor writing');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', 'all');
select is(pg_temp.seen($$select 1 from public.categories$$), 0::bigint, 'F. "all" is refused to a normal admin');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', pg_temp.a());
select throws_ok($$select public.set_admin_master('1d000000-0000-4000-8000-0000000000a1', true, 'Autopromoção', gen_random_uuid())$$,
  '42501', 'ADMIN_MASTER_REQUIRED', 'a normal admin cannot promote itself to ADMIN_MASTER');
select throws_ok($$select public.create_cohort('Turma Z', 2040, 'turma-z', 'PREPARING', 'cohort-test-z', gen_random_uuid())$$,
  '42501', 'COHORTS_MANAGE_REQUIRED', 'nor create cohorts');
select throws_ok($$select public.update_cohort('c0000000-0000-4000-8000-000000002026', 'Turma 2026', 'ARCHIVED', 'Tentativa', gen_random_uuid())$$,
  '42501', 'COHORTS_MANAGE_REQUIRED', 'nor archive one');
select is(pg_temp.seen($$select 1 from public.user_roles where user_id = '1d000000-0000-4000-8000-0000000000d1'$$), 2::bigint,
  'the admin of A sees only the roles granted in A');

-- A. ADMIN_MASTER reads A, B and "all", and writes only into a concrete cohort.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.a());
select is(pg_temp.seen($$select 1 from public.categories where slug = 'mesma-categoria'$$), 1::bigint, 'ADMIN_MASTER in A sees A');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b());
select is(pg_temp.seen($$select 1 from public.categories where slug = 'mesma-categoria'$$), 1::bigint, 'ADMIN_MASTER in B sees B');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select is(pg_temp.seen($$select 1 from public.categories where slug = 'mesma-categoria'$$), 2::bigint, 'ADMIN_MASTER in "all" sees both');
select is((public.get_my_session() ->> 'cohort_mode'), 'ALL', 'the session reports the "all" mode');
select throws_ok($$select public.save_catalog_category(null, null, 'Sem turma', 'sem-turma', true, 1, 'Escrita em Todas', 'cohort-test-all', gen_random_uuid())$$,
  '22023', 'COHORT_REQUIRED', 'F. ADMIN_MASTER cannot write in "all"');
select throws_ok($$select public.set_user_access('1d000000-0000-4000-8000-0000000000a1', array['ADMIN'], true, gen_random_uuid())$$,
  '22023', 'COHORT_REQUIRED', 'nor grant roles in "all"');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b());
insert into ids select 'category_master_b', (public.save_catalog_category(null, null, 'Do master em B', 'do-master', true, 3, 'Categoria criada pelo master', 'cohort-test-master-b', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.sys();
select is((select cohort_id::text from cohort_data.categories where id = pg_temp.id('category_master_b')), pg_temp.b(),
  'ADMIN_MASTER with a concrete cohort writes into it');
select is((select cohort_id::text from cohort_data.audit_logs where entity_id = pg_temp.id('category_master_b')::text
  and actor_id = '10000000-0000-4000-8000-000000000005' order by created_at desc limit 1), pg_temp.b(),
  'the audit names the cohort and ADMIN_MASTER as a normal actor');

-- F. Context (final state, PR 5): no fallback. A single-cohort user has the cohort resolved from the only membership;
-- anyone else names it explicitly, or reads and writes nothing.
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000c1', null);
select is((public.get_my_session() -> 'cohort' ->> 'id'), pg_temp.b(), 'a single-cohort user without header has the only cohort resolved');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000d1', null);
select is((public.get_my_session() -> 'cohort' ->> 'id'), null, 'a multi-cohort user without header never falls back to the default cohort');
select is((public.get_my_session() ->> 'cohort_mode'), 'NONE', 'and needs an explicit cohort');
select throws_ok($$select public.save_catalog_category(null, null, 'Sem contexto', 'sem-contexto', true, 1, 'Sem turma explícita', 'cohort-test-none', gen_random_uuid())$$,
  '42501', null, 'and cannot write without it');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000c1', null);
select is((public.get_my_session() -> 'cohort' ->> 'id'), pg_temp.b(), 'a single-cohort user is still inferred');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', null);
select is((public.get_my_session() ->> 'cohort_mode'), 'NONE', 'ADMIN_MASTER is never inferred');
select pg_temp.sys();
create or replace function private.cohort_fallback_enabled() returns boolean language sql immutable set search_path = '' as $$ select true $$;

-- D. Payment terminals: global identity, authorized per cohort.
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
insert into ids select 'terminal', (public.save_payment_terminal(null, 'MAQ-TURMAS', 'Maquininha compartilhável', true, 'cohort-test-terminal', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.sys();
select ok(exists (select 1 from private.payment_terminals where id = pg_temp.id('terminal')) and
  (select count(*) from cohort_data.cohort_payment_terminals where terminal_id = pg_temp.id('terminal')) = 1,
  'a terminal is created once (global identity) and authorized for the creating cohort');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
select is((select count(*)::integer from jsonb_array_elements(public.list_payment_terminals()) terminal where terminal ->> 'code' = 'MAQ-TURMAS'), 0,
  'B does not see a terminal it is not authorized to use');
select throws_ok(format($$select public.set_cohort_payment_terminal(%L, true, 'Uso pela turma B', gen_random_uuid())$$, pg_temp.id('terminal')),
  '42501', 'PAYMENT_TERMINAL_ASSOCIATION_REQUIRES_ADMIN_MASTER', 'B cannot take a terminal of another cohort');
select pg_temp.sys();
insert into public.sales (id, channel, location_id, created_by, original_total_cents, total_cents, quoted_at, correlation_id, cohort_id)
select '5e000000-0000-4000-8000-00000000000a', 'PDV', (select id from cohort_data.stock_locations where cohort_id = 'c0000000-0000-4000-8000-000000002026' and location_type = 'CENTRAL' and active),
  '10000000-0000-4000-8000-000000000005', 500, 500, now(), gen_random_uuid(), 'c0000000-0000-4000-8000-000000002026';
insert into public.sales (id, channel, location_id, created_by, original_total_cents, total_cents, quoted_at, correlation_id, cohort_id)
select '5e000000-0000-4000-8000-00000000000b', 'PDV', (select id from cohort_data.stock_locations where cohort_id = pg_temp.id('cohort_b') and location_type = 'CENTRAL' and active),
  '10000000-0000-4000-8000-000000000005', 700, 700, now(), gen_random_uuid(), pg_temp.id('cohort_b');
insert into public.payment_attempts (id, sale_id, amount_cents, operator_id, idempotency_key, correlation_id) values
  ('5f000000-0000-4000-8000-00000000000a', '5e000000-0000-4000-8000-00000000000a', 500, '10000000-0000-4000-8000-000000000005', 'cohort-test-attempt-a', gen_random_uuid()),
  ('5f000000-0000-4000-8000-00000000000b', '5e000000-0000-4000-8000-00000000000b', 700, '10000000-0000-4000-8000-000000000005', 'cohort-test-attempt-b', gen_random_uuid());
select is((select string_agg(cohort_id::text, ',' order by id) from cohort_data.payment_attempts where id in
  ('5f000000-0000-4000-8000-00000000000a', '5f000000-0000-4000-8000-00000000000b')), 'c0000000-0000-4000-8000-000000002026,' || pg_temp.b(),
  'each payment attempt inherits the cohort of its sale');
select lives_ok(format($$update public.payment_attempts set terminal_id = %L where id = '5f000000-0000-4000-8000-00000000000a'$$, pg_temp.id('terminal')),
  'a payment of A uses the terminal authorized for A');
select throws_ok(format($$update public.payment_attempts set terminal_id = %L where id = '5f000000-0000-4000-8000-00000000000b'$$, pg_temp.id('terminal')),
  'P0001', 'PAYMENT_TERMINAL_NOT_ALLOWED', 'a payment of B cannot use it');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b());
select lives_ok(format($$select public.set_cohort_payment_terminal(%L, true, 'Maquininha passa a atender a turma B', gen_random_uuid())$$, pg_temp.id('terminal')),
  'ADMIN_MASTER authorizes the same terminal for B');
select pg_temp.sys();
select lives_ok(format($$update public.payment_attempts set terminal_id = %L where id = '5f000000-0000-4000-8000-00000000000b'$$, pg_temp.id('terminal')),
  'now the payment of B uses it');
select is((select count(*)::integer from private.payment_terminals where code = 'MAQ-TURMAS'), 1, 'without duplicating the terminal identity');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
select throws_ok(format($$select public.save_payment_terminal(%L, 'MAQ-TURMAS', 'Renomeada por A', true, 'cohort-test-terminal-rename', gen_random_uuid())$$, pg_temp.id('terminal')),
  '42501', 'PAYMENT_TERMINAL_SHARED_REQUIRES_ADMIN_MASTER', 'a shared terminal is maintained by ADMIN_MASTER only');

-- E. PicPay: global evidence, attribution per cohort.
select pg_temp.sys();
insert into public.picpay_source_imports (id, source_type, file_name, file_sha256, file_size_bytes, row_count, period_from, period_to,
  new_count, known_count, updated_count, actor_id, correlation_id)
values ('5d000000-0000-4000-8000-000000000001', 'PICPAY_SALES', 'vendas.csv', repeat('ab', 32), 10, 1, current_date, current_date, 1, 0, 0,
  '10000000-0000-4000-8000-000000000005', gen_random_uuid());
insert into public.picpay_transactions (id, transaction_ref, first_import_id)
values ('5c000000-0000-4000-8000-000000000001', 'E-TURMAS-0001', '5d000000-0000-4000-8000-000000000001');
select ok(not exists (select 1 from information_schema.columns where table_name in ('picpay_transactions', 'picpay_source_imports') and column_name = 'cohort_id'),
  'the evidence itself has no cohort');
select throws_ok($$insert into public.picpay_source_imports (source_type, file_name, file_sha256, file_size_bytes, row_count, period_from, period_to,
  new_count, known_count, updated_count, actor_id, correlation_id) values ('PICPAY_SALES', 'outra.csv', repeat('ab', 32), 10, 1, current_date, current_date,
  1, 0, 0, '10000000-0000-4000-8000-000000000005', gen_random_uuid())$$, '23505', null, 'the same file is unique across cohorts');
insert into public.picpay_transaction_links (transaction_id, payment_attempt_id, action, automatic, evidence, reason, actor_id, correlation_id)
values ('5c000000-0000-4000-8000-000000000001', '5f000000-0000-4000-8000-00000000000a', 'LINK', false, 'MANUAL', 'Vínculo com a venda da turma A',
  '10000000-0000-4000-8000-000000000005', gen_random_uuid());
select is((select cohort_id::text from cohort_data.picpay_transaction_links where transaction_id = '5c000000-0000-4000-8000-000000000001'),
  'c0000000-0000-4000-8000-000000002026', 'linking the evidence to a sale of A attributes it to A');
select throws_ok($$insert into public.picpay_transaction_links (transaction_id, payment_attempt_id, action, automatic, evidence, reason, actor_id, correlation_id)
  values ('5c000000-0000-4000-8000-000000000001', '5f000000-0000-4000-8000-00000000000b', 'LINK', false, 'MANUAL', 'Vínculo conflitante',
  '10000000-0000-4000-8000-000000000005', gen_random_uuid())$$,
  '42501', 'PICPAY_EVIDENCE_ATTRIBUTED_TO_ANOTHER_COHORT', 'the same evidence cannot be attributed to a sale of B');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
select is(pg_temp.seen($$select 1 from public.picpay_transaction_links where transaction_id = '5c000000-0000-4000-8000-000000000001'$$), 0::bigint,
  'B does not see the attribution made by A');

-- Feature flags: modules per cohort, infrastructure global.
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
select lives_ok($$select public.update_feature_flag('raffles', false, 'Rifas pausadas na turma A', gen_random_uuid())$$, 'A pauses its raffles');
select is(public.is_feature_enabled('raffles'), false, 'raffles are off in A');
select throws_ok($$select public.update_feature_flag('payment_link', true, 'Tentativa de ligar a integração', gen_random_uuid())$$,
  '42501', 'FEATURE_FLAG_GLOBAL_REQUIRES_ADMIN_MASTER', 'a global integration flag is not changed by a cohort admin');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
select is(public.is_feature_enabled('raffles'), true, 'raffles stay on in B');
select is((select enabled from public.feature_flags where key = 'raffles'), true, 'the flags read by the Portal show the value of the request cohort');

-- Fan-out per cohort: an announcement to everyone reaches the members of the cohort only.
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
insert into ids select 'announcement_b', (public.publish_announcement('Aviso da turma B', 'Somente para a turma B', true, null, null, 'cohort-test-announce', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.sys();
select ok((select bool_and(exists (select 1 from public.user_cohorts membership where membership.user_id = recipient.recipient_id
    and membership.cohort_id = pg_temp.id('cohort_b') and membership.status = 'ACTIVE'))
  from cohort_data.announcement_recipients recipient where recipient.announcement_id = pg_temp.id('announcement_b')),
  'every recipient is an active member of B');
select ok(not exists (select 1 from cohort_data.announcement_recipients where announcement_id = pg_temp.id('announcement_b')
  and recipient_id = '1d000000-0000-4000-8000-0000000000a1'), 'the admin of A is not reached');
select pg_temp.sys();
select private.enter_cohort_context(pg_temp.id('cohort_b'));
select ok(exists (select 1 from private.staff_with_permission('catalog.manage') where recipient_id = '1d000000-0000-4000-8000-0000000000b1')
  and not exists (select 1 from private.staff_with_permission('catalog.manage') where recipient_id = '1d000000-0000-4000-8000-0000000000a1'),
  'the worker inside B notifies the staff of B only');
select pg_temp.sys();
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
select throws_ok($$select private.enter_cohort_context('c0000000-0000-4000-8000-000000002026')$$, '42501', null,
  'a user cannot enter a cohort context');

-- Singletons per cohort.
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000a1', null);
select lives_ok($$select public.configure_fundraising_goal(100000, current_date - 30, current_date + 300, false, false, 'cohort-test-goal-a', gen_random_uuid())$$,
  'A configures its fundraising goal');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
select lives_ok($$select public.configure_fundraising_goal(250000, current_date - 10, current_date + 400, false, false, 'cohort-test-goal-b', gen_random_uuid())$$,
  'B configures its own');
select pg_temp.sys();
select results_eq($$select target_cents from cohort_data.fundraising_goal where cohort_id in ('c0000000-0000-4000-8000-000000002026', pg_temp.id('cohort_b')) order by target_cents$$,
  $$values (100000::bigint), (250000::bigint)$$, 'one goal per cohort');

-- Archived cohort: readable, not writable. PR 4: archiving waits until the open work of B (the sale and the payment of
-- the terminal checks above) is closed, through the same state transitions the operations use.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select throws_ok(format($$select public.update_cohort(%L, 'Turma B', 'ARCHIVED', 'Formatura concluída', gen_random_uuid())$$, pg_temp.b()),
  'P0001', 'COHORT_HAS_OPEN_OPERATIONS', 'B cannot be archived while a sale and a payment are open');
select pg_temp.sys();
select private.enter_cohort_context(pg_temp.id('cohort_b'));
select private.transition_payment_attempt('5f000000-0000-4000-8000-00000000000b', 'CANCELLED', '10000000-0000-4000-8000-000000000005', gen_random_uuid(), 'Turma encerrada');
select private.transition_sale_state('5e000000-0000-4000-8000-00000000000b', 'CANCELLED', '10000000-0000-4000-8000-000000000005', gen_random_uuid(), 'Turma encerrada');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select lives_ok(format($$select public.update_cohort(%L, 'Turma B', 'ARCHIVED', 'Formatura concluída', gen_random_uuid())$$, pg_temp.b()),
  'ADMIN_MASTER archives B once nothing is open');
select throws_ok($$select public.update_cohort('c0000000-0000-4000-8000-000000002026', 'Turma 2026', 'ARCHIVED', 'Tentativa', gen_random_uuid())$$,
  'P0001', 'DEFAULT_COHORT_CANNOT_BE_ARCHIVED', 'the default cohort is never archived');
select pg_temp.ctx('1d000000-0000-4000-8000-0000000000b1', null);
select is(pg_temp.seen($$select 1 from public.categories where slug = 'mesma-categoria'$$), 1::bigint, 'an archived cohort stays readable');
select throws_ok($$select public.save_catalog_category(null, null, 'Depois do arquivo', 'depois-arquivo', true, 1, 'Escrita em turma arquivada', 'cohort-test-archived', gen_random_uuid())$$,
  '42501', 'COHORT_ARCHIVED', 'but refuses new operations');

-- Structure: no drift, nothing published, a clean integrity report.
select pg_temp.sys();
select is((select count(*)::integer from private.cohort_view_drift()), 0, 'every view matches its base table');
select is((select count(*)::integer from pg_publication_tables where schemaname in ('public', 'cohort_data')), 0, 'no table is published');
select is((select string_agg(check_name || ' ' || subject || '=' || violations, ', ') from private.cohort_integrity_report() where violations <> 0),
  null, 'the integrity report is clean');
select is((select count(*)::integer from pg_proc where prorettype in (select reltype from pg_class where relnamespace = 'cohort_data'::regnamespace)
  or exists (select 1 from unnest(proargtypes::oid[]) argument_type where argument_type in (select reltype from pg_class where relnamespace = 'cohort_data'::regnamespace))),
  0, 'no function is bound to the row type of a base table');

select * from finish();
rollback;
