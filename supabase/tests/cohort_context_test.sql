-- ADR 0011 (multi-turma), PR 3 — contexto de turma no Portal e no PDV: listagem de usuários por turma (filtros,
-- paginação, isolamento), operações sobre pessoas só dentro da turma, provisionamento na turma da requisição,
-- handoff Portal → PDV com a turma gravada no servidor, ADMIN_MASTER em "Todas as turmas".
begin;
select plan(53);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.headers', '{}', true);
  perform set_config('role', 'service_role', true);
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
create temp table ids (name text primary key, id uuid);
grant all on ids to anon, authenticated, service_role;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.a() returns uuid language sql as $$ select 'c0000000-0000-4000-8000-000000002026'::uuid $$;
create function pg_temp.b() returns uuid language sql as $$ select id from ids where name = 'cohort_b' $$;
-- Ids of a listing (jsonb items) as a sorted text array, and whether it holds one id.
create function pg_temp.listed(p_page jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), '{}') from jsonb_array_elements(p_page -> 'items') item $$;
create function pg_temp.has(p_page jsonb, p_id text) returns boolean language sql as $$
  select (p_id)::uuid = any (pg_temp.listed(p_page)) $$;

-- People. The Portal creates identities with confirmed e-mail, password, name and username, so the sign-up trigger
-- completes the profile and places it in the default cohort (Turma 2026 = A).
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, extensions.crypt('Turmas123!', extensions.gen_salt('bf')),
  now(), case when id in ('3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000c1')
    then jsonb_build_object('germinatura_provisioning', 'c7000000-0000-4000-8000-' || right(id::text, 12)) else '{}' end,
  case when username is null then jsonb_build_object('name', name) else jsonb_build_object('name', name, 'username', username) end, now(), now()
from (values
  ('3c000000-0000-4000-8000-0000000000a1'::uuid, 'ctx.admin.a@institutojef.org.br', 'Admin Contexto A', 'ctx.admin.a'),
  ('3c000000-0000-4000-8000-0000000000d1'::uuid, 'ctx.vendedor.ab@institutojef.org.br', 'Vendedora Duas Turmas', 'ctx.vendedor.ab'),
  ('3c000000-0000-4000-8000-0000000000e1'::uuid, 'ctx.zelia@institutojef.org.br', 'Zélia Contexto', 'ctx.zelia'),
  ('3c000000-0000-4000-8000-0000000000f1'::uuid, 'ctx.incompleto@institutojef.org.br', 'Cadastro Incompleto', null),
  ('3c000000-0000-4000-8000-0000000000b1'::uuid, 'ctx.admin.b@institutojef.org.br', 'Admin Contexto B', 'ctx.admin.b'),
  ('3c000000-0000-4000-8000-0000000000c1'::uuid, 'ctx.consumidor.b@institutojef.org.br', 'Consumidor Contexto B', 'ctx.consumidor.b')
) people(id, email, name, username);

-- ADMIN_MASTER creates Turma B in "all" (global operation).
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
insert into ids select 'cohort_b', (public.create_cohort('Turma Contexto B', 2032, 'turma-contexto-b', 'ACTIVE', 'ctx-create-b', gen_random_uuid()) ->> 'id')::uuid;

-- 1. Provisioning places the new account in the request cohort only.
select pg_temp.service();
select lives_ok($$select public.complete_admin_provisioned_profile('10000000-0000-4000-8000-000000000005', '3c000000-0000-4000-8000-0000000000b1',
  'Admin Contexto B', 'ctx.admin.b', pg_temp.b(), 'c7000000-0000-4000-8000-0000000000b1')$$, 'ADMIN_MASTER provisions an account into B');
select pg_temp.sys();
select is((select array_agg(cohort_id::text) from public.user_cohorts where user_id = '3c000000-0000-4000-8000-0000000000b1'), array[pg_temp.b()::text],
  'the account belongs to B only (the sign-up placement in the default cohort is undone)');
select is((select count(*)::integer from cohort_data.user_roles where user_id = '3c000000-0000-4000-8000-0000000000b1' and cohort_id = pg_temp.a()), 0,
  'and holds no role in the default cohort');
select is((select cohort_id from cohort_data.audit_logs where action = 'auth.profile.provisioned' and entity_id = '3c000000-0000-4000-8000-0000000000b1'),
  pg_temp.b(), 'the provisioning is audited in B');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b()::text);
select public.set_user_access('3c000000-0000-4000-8000-0000000000b1', array['ADMIN', 'CONSUMIDOR'], true, gen_random_uuid());
select pg_temp.service();
select lives_ok($$select public.complete_admin_provisioned_profile('3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000c1',
  'Consumidor Contexto B', 'ctx.consumidor.b', pg_temp.b(), 'c7000000-0000-4000-8000-0000000000c1')$$, 'the ADMIN of B provisions into B');
select is((public.complete_admin_provisioned_profile('3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000c1',
  'Consumidor Contexto B', 'ctx.consumidor.b', pg_temp.b(), 'c7000000-0000-4000-8000-0000000000c1') ->> 'cohort_id')::uuid, pg_temp.b(), 'a retry answers the same');
select throws_ok($$select public.complete_admin_provisioned_profile('3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000e1',
  'Zélia Contexto', 'ctx.zelia', 'c0000000-0000-4000-8000-000000002026', gen_random_uuid())$$,
  '42501', 'USERS_MANAGE_REQUIRED', 'the ADMIN of B cannot provision into A');
select throws_ok($$select public.complete_admin_provisioned_profile('3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000e1',
  'Zélia Contexto', 'ctx.zelia', gen_random_uuid(), gen_random_uuid())$$, '22023', 'COHORT_REQUIRED', 'nor into a cohort that does not exist');
select throws_ok($$select public.complete_admin_provisioned_profile('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003',
  (select display_name from public.profiles where id = '10000000-0000-4000-8000-000000000003'),
  (select username from public.profiles where id = '10000000-0000-4000-8000-000000000003'), pg_temp.b(), gen_random_uuid())$$,
  'P0001', 'ONBOARDING_ALREADY_COMPLETED', 'an existing person (not stamped by this provisioning) is never re-provisioned');
select pg_temp.sys();
select ok(exists (select 1 from public.user_cohorts where user_id = '10000000-0000-4000-8000-000000000003' and cohort_id = pg_temp.a() and status = 'ACTIVE')
  and exists (select 1 from cohort_data.user_roles where user_id = '10000000-0000-4000-8000-000000000003' and cohort_id = pg_temp.a()),
  'and keeps its membership and roles in the default cohort');
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000b1', pg_temp.b()::text);
select throws_ok($$select public.complete_admin_provisioned_profile('3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000e1',
  'Zélia Contexto', 'ctx.zelia', pg_temp.b(), gen_random_uuid())$$, '42501', null, 'provisioning is reserved to the service role');

-- People of A and roles per cohort.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.a()::text);
select public.set_user_access('3c000000-0000-4000-8000-0000000000a1', array['ADMIN', 'CONSUMIDOR'], true, gen_random_uuid());
select public.set_user_access('3c000000-0000-4000-8000-0000000000d1', array['VENDEDOR', 'CONSUMIDOR'], true, gen_random_uuid());
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b()::text);
select public.set_cohort_membership('3c000000-0000-4000-8000-0000000000d1', true, 'Vendedora também na turma B', gen_random_uuid());
select public.set_user_access('3c000000-0000-4000-8000-0000000000d1', array['ADMIN', 'VENDEDOR', 'CONSUMIDOR'], true, gen_random_uuid());

-- 2. list_cohort_users: the people of the request cohort only.
select pg_temp.sys();
create temp table expected (name text primary key, value bigint);
grant all on expected to anon, authenticated, service_role;
insert into expected values ('people_a', (select count(*) from public.user_cohorts where cohort_id = 'c0000000-0000-4000-8000-000000002026')),
  ('people', (select count(distinct user_id) from public.user_cohorts));
create function pg_temp.expected(p_name text) returns bigint language sql as $$ select value from expected where name = p_name $$;
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000a1', pg_temp.a()::text);
create temp table pages (name text primary key, page jsonb);
grant all on pages to anon, authenticated, service_role;
insert into pages values ('a_all', public.list_cohort_users(p_limit => 100));
create function pg_temp.page(p_name text) returns jsonb language sql as $$ select page from pages where name = p_name $$;
select is((pg_temp.page('a_all') ->> 'total')::bigint, pg_temp.expected('people_a'),
  'ADMIN of A: total = the people of A');
select ok(pg_temp.has(pg_temp.page('a_all'), '3c000000-0000-4000-8000-0000000000d1') and pg_temp.has(pg_temp.page('a_all'), '3c000000-0000-4000-8000-0000000000e1'),
  'lists the people of A');
select ok(not pg_temp.has(pg_temp.page('a_all'), '3c000000-0000-4000-8000-0000000000b1') and not pg_temp.has(pg_temp.page('a_all'), '3c000000-0000-4000-8000-0000000000c1'),
  'ADMIN A queries a B user: never listed');
select is((public.list_cohort_users(p_query => 'ctx.admin.b') ->> 'matched')::integer, 0, 'nor found by the search');
select is((public.list_cohort_users(p_query => 'ctx.') -> 'items' -> 0 -> 'cohorts'), 'null'::jsonb, 'a cohort admin does not see other cohorts of a person');
select is((public.list_cohort_users(p_query => 'ctx.') -> 'items' -> 0 -> 'admin_master'), 'null'::jsonb, 'nor who is ADMIN_MASTER');
select is((select array_agg(role_key order by role_key) from jsonb_array_elements_text(
    (select item -> 'roles' from jsonb_array_elements(public.list_cohort_users(p_query => 'ctx.vendedor.ab') -> 'items') item)) as roles_seen(role_key)),
  array['CONSUMIDOR', 'VENDEDOR'], 'roles shown are those of the request cohort');
select throws_ok(format($$select public.list_cohort_users(p_cohort_id => %L)$$, pg_temp.b()), '42501', 'COHORT_FORBIDDEN',
  'a cohort filter other than the request cohort is refused');

-- Filters and pagination (server side).
select public.set_user_access('3c000000-0000-4000-8000-0000000000e1', array['CONSUMIDOR'], false, gen_random_uuid());
select ok(pg_temp.has(public.list_cohort_users(p_status => 'INACTIVE', p_limit => 100), '3c000000-0000-4000-8000-0000000000e1')
  and not pg_temp.has(public.list_cohort_users(p_status => 'ACTIVE', p_limit => 100), '3c000000-0000-4000-8000-0000000000e1'),
  'status filter: Ativos/Inativos (inactive in the cohort)');
select ok(pg_temp.has(public.list_cohort_users(p_onboarding => 'INCOMPLETE', p_limit => 100), '3c000000-0000-4000-8000-0000000000f1')
  and not pg_temp.has(public.list_cohort_users(p_onboarding => 'INCOMPLETE', p_limit => 100), '3c000000-0000-4000-8000-0000000000a1'),
  'onboarding filter: cadastro incompleto');
select ok(pg_temp.has(public.list_cohort_users(p_query => 'zélia'), '3c000000-0000-4000-8000-0000000000e1')
  and pg_temp.has(public.list_cohort_users(p_query => 'CTX.ZELIA@'), '3c000000-0000-4000-8000-0000000000e1')
  and pg_temp.has(public.list_cohort_users(p_query => 'ctx.zel'), '3c000000-0000-4000-8000-0000000000e1'),
  'search by name, e-mail or username, case-insensitive');
select is((public.list_cohort_users(p_query => '%') ->> 'matched')::integer + (public.list_cohort_users(p_query => '_') ->> 'matched')::integer, 0,
  'LIKE wildcards in the search are literal');
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000b1', null);
select is(pg_temp.listed(public.list_cohort_users()), array['3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000c1',
  '3c000000-0000-4000-8000-0000000000d1']::uuid[], 'ADMIN of B (single membership, no header) lists exactly the people of B');
select is(pg_temp.listed(public.list_cohort_users(p_roles => array['ADMIN', 'VENDEDOR'], p_role_match => 'ALL')),
  array['3c000000-0000-4000-8000-0000000000d1']::uuid[], 'roles: TODOS');
select is(pg_temp.listed(public.list_cohort_users(p_roles => array['ADMIN', 'VENDEDOR'], p_role_match => 'ANY')),
  array['3c000000-0000-4000-8000-0000000000b1', '3c000000-0000-4000-8000-0000000000d1']::uuid[], 'roles: QUALQUER');
select ok((select count(distinct id) = 3 from (
    select jsonb_array_elements(public.list_cohort_users(p_offset => 0, p_limit => 2) -> 'items') ->> 'id' as id
    union all select jsonb_array_elements(public.list_cohort_users(p_offset => 2, p_limit => 2) -> 'items') ->> 'id') pages_seen),
  'pages are disjoint and complete');
select is(public.list_cohort_users(p_offset => 2, p_limit => 2) - 'items', jsonb_build_object('total', 3, 'matched', 3, 'offset', 2, 'limit', 2,
  'cohort_mode', 'COHORT', 'cohort_id', pg_temp.b()), 'the page reports total, matched, offset and limit');
select throws_ok($$select public.list_cohort_users(p_limit => 101)$$, '22023', 'INVALID_USER_FILTER', 'at most 100 per page');
select throws_ok($$select public.list_cohort_users(p_roles => array['ADMIN_MASTER'])$$, '22023', 'INVALID_USER_FILTER', 'ADMIN_MASTER is not a cohort role filter');

-- Ordinary users sending "all" or another cohort.
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000a1', 'all');
select throws_ok($$select public.list_cohort_users()$$, '42501', 'USERS_MANAGE_REQUIRED', 'an ADMIN sending "all" is refused');
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000a1', pg_temp.b()::text);
select throws_ok($$select public.list_cohort_users()$$, '42501', 'USERS_MANAGE_REQUIRED', 'an ADMIN forcing the context of B is refused');
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000d1', pg_temp.a()::text);
select throws_ok($$select public.list_cohort_users()$$, '42501', 'USERS_MANAGE_REQUIRED', 'ADMIN of B only, while in A, cannot list A');

-- ADMIN_MASTER: every cohort in "all", one cohort by filter, the roles of each cohort apart.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select is((public.list_cohort_users() ->> 'total')::bigint, pg_temp.expected('people'), 'master in all: every person once');
select is(pg_temp.listed(public.list_cohort_users(p_cohort_id => pg_temp.b())), array['3c000000-0000-4000-8000-0000000000b1',
  '3c000000-0000-4000-8000-0000000000c1', '3c000000-0000-4000-8000-0000000000d1']::uuid[], 'master in all filtered by B');
select is((select jsonb_agg(cohort ->> 'name' order by cohort ->> 'name') from jsonb_array_elements(
    (public.list_cohort_users(p_query => 'ctx.vendedor.ab') -> 'items' -> 0 -> 'cohorts')) cohort), '["Turma 2026", "Turma Contexto B"]'::jsonb,
  'master sees each membership of a person');
select is((public.list_cohort_users(p_query => 'master.teste') -> 'items' -> 0 ->> 'admin_master')::boolean, true, 'and who is ADMIN_MASTER');
select throws_ok(format($$select public.list_cohort_users(p_cohort_id => %L)$$, gen_random_uuid()), '22023', 'INVALID_USER_FILTER',
  'an unknown cohort filter is refused');

-- 3. Operations on a person require the person in the request cohort.
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000a1', pg_temp.a()::text);
select throws_ok($$select public.set_user_access('3c000000-0000-4000-8000-0000000000c1', array['ADMIN'], true, gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'ADMIN A alters a role of a B user: refused as not found');
select throws_ok($$select public.set_cohort_membership('3c000000-0000-4000-8000-0000000000c1', true, 'Puxar para a turma A', gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'nor brings a B user into A');
select throws_ok($$select public.unlock_password_recovery('3c000000-0000-4000-8000-0000000000c1', 'Desbloqueio cruzado', gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'nor unlocks password recovery of a B user');
select throws_ok($$select public.unlock_signup_code_requests('3c000000-0000-4000-8000-0000000000c1', 'Desbloqueio cruzado', gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'nor unlocks signup codes of a B user');
select lives_ok($$select public.set_user_access('3c000000-0000-4000-8000-0000000000d1', array['VENDEDOR', 'ESTOQUE', 'CONSUMIDOR'], true, gen_random_uuid())$$,
  'ADMIN A changes the roles in A of a person of A and B');
select pg_temp.sys();
select is((select string_agg(role.key, ',' order by role.key) from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
  where user_role.user_id = '3c000000-0000-4000-8000-0000000000d1' and user_role.cohort_id = pg_temp.b()), 'ADMIN,CONSUMIDOR,VENDEDOR',
  'and the roles in B stay untouched');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.a()::text);
select lives_ok($$select public.set_cohort_membership('3c000000-0000-4000-8000-0000000000c1', true, 'Entrada na turma A', gen_random_uuid())$$,
  'ADMIN_MASTER brings a person into another cohort');

-- 4. PDV handoff carries the concrete cohort of the Portal, recorded on the server.
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000d1', pg_temp.a()::text);
select is((public.create_pdv_handoff(repeat('a', 64)) ->> 'cohort_id')::uuid, pg_temp.a(), 'a handoff from A is issued for A');
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000d1', pg_temp.b()::text);
select is((public.create_pdv_handoff(repeat('b', 64)) ->> 'cohort_id')::uuid, pg_temp.b(), 'the same person from B gets B');
select pg_temp.ctx('3c000000-0000-4000-8000-0000000000a1', pg_temp.b()::text);
select throws_ok($$select public.create_pdv_handoff(repeat('c', 64))$$, '42501', 'PDV_ACCESS_REQUIRED', 'a seller of A forcing B gets no handoff');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select throws_ok($$select public.create_pdv_handoff(repeat('d', 64))$$, '22023', 'COHORT_REQUIRED', 'ADMIN_MASTER in "all" must pick a cohort for the PDV');
select pg_temp.service();
select is((public.consume_pdv_handoff(repeat('b', 64)) ->> 'cohort_id')::uuid, pg_temp.b(), 'the PDV reads the cohort from the redeemed code');
select throws_ok($$select public.consume_pdv_handoff(repeat('b', 64))$$, 'P0001', 'PDV_HANDOFF_INVALID', 'once');

-- 5. ADMIN_MASTER in "all": global operations only.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select throws_ok($$select public.save_catalog_category(null, null, 'Em todas', 'em-todas', true, 1, 'Escrita em todas as turmas', 'ctx-all-write', gen_random_uuid())$$,
  null, 'COHORT_REQUIRED', 'master writes cohort data in "all": refused');
select lives_ok(format($$select public.update_cohort(%L, 'Turma Contexto B', 'ARCHIVED', 'Formatura concluída', gen_random_uuid())$$, pg_temp.b()),
  'master archives a cohort in "all"');

select * from finish();
rollback;
