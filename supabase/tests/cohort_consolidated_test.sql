-- ADR 0011 (multi-turma), PR 4 — visão consolidada do ADMIN_MASTER, vínculos usuário ↔ turma com papéis por turma,
-- travas contra vínculo/turma com operações em aberto, contagens das turmas, evidência PicPay global e rótulo de turma
-- da auditoria, sem vazamento para ADMIN comum.
begin;
select plan(40);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
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
create function pg_temp.c() returns uuid language sql as $$ select id from ids where name = 'cohort_c' $$;
create function pg_temp.master() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000005'::uuid $$;
create function pg_temp.membership(p_user uuid, p_cohort uuid) returns text language sql as $$
  select coalesce((select status::text from public.user_cohorts where user_id = p_user and cohort_id = p_cohort), 'NONE') $$;
create function pg_temp.roles_in(p_user uuid, p_cohort uuid) returns text language sql as $$
  select string_agg(role.key, ',' order by role.key) from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
  where user_role.user_id = p_user and user_role.cohort_id = p_cohort $$;

-- People: João (A and B), an ADMIN of A, an ADMIN of B, a seller of B. All start in the default cohort A.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, extensions.crypt('Turmas123!', extensions.gen_salt('bf')),
  now(), '{}', jsonb_build_object('name', name, 'username', username), now(), now()
from (values
  ('4c000000-0000-4000-8000-0000000000a1'::uuid, 'pr4.admin.a@institutojef.org.br', 'Admin PR4 A', 'pr4.admin.a'),
  ('4c000000-0000-4000-8000-0000000000b1'::uuid, 'pr4.admin.b@institutojef.org.br', 'Admin PR4 B', 'pr4.admin.b'),
  ('4c000000-0000-4000-8000-0000000000c1'::uuid, 'pr4.vendedor.b@institutojef.org.br', 'Vendedor PR4 B', 'pr4.vendedor.b'),
  ('4c000000-0000-4000-8000-0000000000d1'::uuid, 'pr4.joao@institutojef.org.br', 'João PR4', 'pr4.joao')
) people(id, email, name, username);

select pg_temp.ctx(pg_temp.master(), 'all');
insert into ids select 'cohort_b', (public.create_cohort('Turma PR4 B', 2033, 'turma-pr4-b', 'ACTIVE', 'pr4-create-b', gen_random_uuid()) ->> 'id')::uuid;
insert into ids select 'cohort_c', (public.create_cohort('Turma PR4 C', 2034, 'turma-pr4-c', 'PREPARING', 'pr4-create-c', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select public.set_user_access('4c000000-0000-4000-8000-0000000000a1', array['ADMIN', 'CONSUMIDOR'], true, gen_random_uuid());
select public.set_user_access('4c000000-0000-4000-8000-0000000000d1', array['ADMIN', 'CONSUMIDOR'], true, gen_random_uuid());

-- 1. ADMIN_MASTER adds people to B (explicit cohort) with roles of B.
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select lives_ok($$select public.set_cohort_membership(person, true, 'Entrada na turma B', gen_random_uuid())
  from unnest(array['4c000000-0000-4000-8000-0000000000b1', '4c000000-0000-4000-8000-0000000000c1', '4c000000-0000-4000-8000-0000000000d1']::uuid[]) person$$,
  'ADMIN_MASTER adds people to B');
select public.set_user_access('4c000000-0000-4000-8000-0000000000b1', array['ADMIN', 'CONSUMIDOR'], true, gen_random_uuid());
select public.set_user_access('4c000000-0000-4000-8000-0000000000c1', array['VENDEDOR', 'CONSUMIDOR'], true, gen_random_uuid());
select public.set_user_access('4c000000-0000-4000-8000-0000000000d1', array['VENDEDOR', 'CONSUMIDOR'], true, gen_random_uuid());
select pg_temp.sys();
-- The ADMIN and the seller of B belong to B only (as an account provisioned for B would): out of the default cohort.
delete from cohort_data.user_roles where cohort_id = pg_temp.a()
  and user_id in ('4c000000-0000-4000-8000-0000000000b1', '4c000000-0000-4000-8000-0000000000c1');
delete from public.user_cohorts where cohort_id = pg_temp.a()
  and user_id in ('4c000000-0000-4000-8000-0000000000b1', '4c000000-0000-4000-8000-0000000000c1');
select is(pg_temp.roles_in('4c000000-0000-4000-8000-0000000000d1', pg_temp.a()) || ' | ' || pg_temp.roles_in('4c000000-0000-4000-8000-0000000000d1', pg_temp.b()),
  'ADMIN,CONSUMIDOR | CONSUMIDOR,VENDEDOR', 'João: Turma A → ADMIN, Turma B → VENDEDOR (relational, per cohort)');

-- 2. user_cohort_memberships: every cohort of a person, ADMIN_MASTER only.
select pg_temp.ctx(pg_temp.master(), 'all');
create temp table memberships as select value as row from jsonb_array_elements(public.user_cohort_memberships('4c000000-0000-4000-8000-0000000000d1'));
grant all on memberships to authenticated;
select is((select row ->> 'membership' from memberships where (row ->> 'cohort_id')::uuid = pg_temp.b()), 'ACTIVE', 'lists the active membership in B');
select is((select row -> 'roles' from memberships where (row ->> 'cohort_id')::uuid = pg_temp.b()), '["CONSUMIDOR", "VENDEDOR"]'::jsonb, 'with the roles of B');
select is((select row ->> 'membership' from memberships where (row ->> 'cohort_id')::uuid = pg_temp.c()), 'NONE', 'and the cohorts without membership');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000a1', pg_temp.a()::text);
select throws_ok($$select public.user_cohort_memberships('4c000000-0000-4000-8000-0000000000d1')$$, '42501', 'ADMIN_MASTER_REQUIRED',
  'an ADMIN cannot list the cohorts of a person');
select throws_ok($$select public.cohort_overview()$$, '42501', 'ADMIN_MASTER_REQUIRED', 'nor list cohorts and their counts');

-- 3. A common ADMIN never manages a membership of another cohort.
select throws_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000c1', true, 'Puxar para A', gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'ADMIN of A cannot bring a person of B into A');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000a1', pg_temp.b()::text);
select throws_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000c1', false, 'Tirar de B', gen_random_uuid())$$,
  '42501', 'FORBIDDEN', 'ADMIN of A forcing the context of B cannot deactivate someone there');
select throws_ok($$select public.set_user_access('4c000000-0000-4000-8000-0000000000c1', array['ADMIN'], true, gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'nor change roles there (refused without revealing the person)');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000b1', pg_temp.b()::text);
select throws_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000a1', true, 'Puxar para B', gen_random_uuid())$$,
  'P0002', 'USER_NOT_FOUND', 'ADMIN of B cannot add an ADMIN of A to B');

-- 4. Blockers: an open shift, a pending sale, the last ADMIN of a cohort.
select pg_temp.sys();
select private.enter_cohort_context(pg_temp.b());
insert into cohort_data.seller_shifts (seller_id, location_id, status, opening_cash_cents, opened_correlation_id, cohort_id)
select '4c000000-0000-4000-8000-0000000000c1', location.id, 'OPEN', 1000, gen_random_uuid(), pg_temp.b()
from cohort_data.stock_locations location where location.seller_id = '4c000000-0000-4000-8000-0000000000c1' and location.cohort_id = pg_temp.b();
select pg_temp.sys();
select is((select count(*)::integer from cohort_data.seller_shifts where seller_id = '4c000000-0000-4000-8000-0000000000c1' and status = 'OPEN'), 1,
  '(the seller of B has an open shift)');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select throws_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000c1', false, 'Saída da turma', gen_random_uuid())$$,
  'P0001', 'MEMBERSHIP_HAS_OPEN_OPERATIONS', 'a membership with an open shift cannot be deactivated');
select pg_temp.sys();
select is(pg_temp.membership('4c000000-0000-4000-8000-0000000000c1', pg_temp.b()), 'ACTIVE', 'and stays active');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select is((select row -> 'blockers' from jsonb_array_elements(public.user_cohort_memberships('4c000000-0000-4000-8000-0000000000c1')) row
  where (row ->> 'cohort_id')::uuid = pg_temp.b()), '["OPEN_SHIFT"]'::jsonb, 'the blocker is named before trying');
select throws_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000b1', false, 'Saída da turma', gen_random_uuid())$$,
  'P0001', 'MEMBERSHIP_HAS_OPEN_OPERATIONS', 'the last active ADMIN of B cannot leave B');
select pg_temp.ctx(pg_temp.master(), 'all');
select is((select row -> 'blockers' from jsonb_array_elements(public.user_cohort_memberships('4c000000-0000-4000-8000-0000000000b1')) row
  where (row ->> 'cohort_id')::uuid = pg_temp.b()), '["LAST_COHORT_ADMIN"]'::jsonb, 'named as the last ADMIN');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select lives_ok($$select public.set_user_access('4c000000-0000-4000-8000-0000000000c1', array['CONSUMIDOR'], false, gen_random_uuid())$$,
  'revoking access at once stays possible for security, even with open work');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000c1', true, 'Retorno', gen_random_uuid())$$,
  '22023', 'COHORT_REQUIRED', 'membership changes need a concrete cohort, never "all"');

-- 5. Deactivation keeps history; reactivation restores the membership with the roles of that cohort.
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select lives_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000d1', false, 'Pausa na turma B', gen_random_uuid())$$,
  'João leaves B (nothing open there)');
select pg_temp.sys();
select is(pg_temp.membership('4c000000-0000-4000-8000-0000000000d1', pg_temp.b()) || ' / ' || pg_temp.membership('4c000000-0000-4000-8000-0000000000d1', pg_temp.a()),
  'INACTIVE / ACTIVE', 'the membership in B is inactive (kept, not deleted) and A is untouched');
select is(pg_temp.roles_in('4c000000-0000-4000-8000-0000000000d1', pg_temp.b()), 'CONSUMIDOR,VENDEDOR', 'the roles of B are kept as history');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000d1', pg_temp.b()::text);
select ok(not public.has_permission('sales.create'), 'an inactive membership grants nothing in B');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000d1', pg_temp.a()::text);
select ok(public.has_permission('users.manage'), 'while the person keeps ADMIN in A');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select lives_ok($$select public.set_cohort_membership('4c000000-0000-4000-8000-0000000000d1', true, 'Volta à turma B', gen_random_uuid())$$, 'reactivation');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000d1', pg_temp.b()::text);
select ok(public.has_permission('sales.create'), 'reactivated with the roles of B');
select pg_temp.sys();
select is((select count(*)::integer from cohort_data.audit_logs where action = 'cohorts.membership.changed'
  and entity_id = '4c000000-0000-4000-8000-0000000000d1' and cohort_id = pg_temp.b()), 3, 'every membership change of B is audited in B');

-- 6. Cohort overview and archiving.
select pg_temp.ctx(pg_temp.master(), 'all');
create temp table overview as select value as row from jsonb_array_elements(public.cohort_overview());
grant all on overview to authenticated;
select is((select (row ->> 'members_active')::integer from overview where (row ->> 'id')::uuid = pg_temp.b()), 2, 'B counts its active members (the seller whose access was revoked is inactive)');
select is((select (row -> 'roles' ->> 'ADMIN')::integer from overview where (row ->> 'id')::uuid = pg_temp.b()), 1, 'and its ADMINs');
select ok((select row -> 'open_operations' ? 'OPEN_SHIFTS' from overview where (row ->> 'id')::uuid = pg_temp.b()), 'and names its open work');
select throws_ok(format($$select public.update_cohort(%L, 'Turma PR4 B', 'ARCHIVED', 'Formatura concluída', gen_random_uuid())$$, pg_temp.b()),
  'P0001', 'COHORT_HAS_OPEN_OPERATIONS', 'a cohort with open work cannot be archived');
select lives_ok(format($$select public.update_cohort(%L, 'Turma PR4 C', 'ARCHIVED', 'Turma não iniciada', gen_random_uuid())$$, pg_temp.c()),
  'a cohort without open work is archived in "all" (global operation)');
select lives_ok(format($$select public.update_cohort(%L, 'Turma PR4 C', 'ACTIVE', 'Reativada', gen_random_uuid())$$, pg_temp.c()), 'and reactivated');
select throws_ok(format($$select public.update_cohort(%L, 'Turma 2026', 'ARCHIVED', 'Tentativa', gen_random_uuid())$$, pg_temp.a()),
  'P0001', 'DEFAULT_COHORT_CANNOT_BE_ARCHIVED', 'the default cohort is never archived');

-- 7. Global PicPay evidence is ADMIN_MASTER only and never split into balances.
select ok(public.picpay_evidence_overview() ?& array['imports', 'lines', 'lines_pending', 'lines_by_cohort'], 'ADMIN_MASTER reads the global PicPay evidence');
select ok(not (public.picpay_evidence_overview() ? 'balance_cents'), 'no balance is derived from the statement');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000a1', pg_temp.a()::text);
select throws_ok($$select public.picpay_evidence_overview()$$, '42501', 'ADMIN_MASTER_REQUIRED', 'an ADMIN does not read the consolidated evidence');

-- 8. Audit labels: each answered within the caller's scope only.
select pg_temp.sys();
insert into ids select 'audit_b', id from cohort_data.audit_logs where cohort_id = pg_temp.b() order by created_at limit 1;
insert into ids select 'audit_global', id from cohort_data.audit_logs where cohort_id is null and action = 'cohorts.created' order by created_at desc limit 1;
select pg_temp.ctx(pg_temp.master(), 'all');
select is((select count(*)::integer from public.audit_log_cohorts(array[pg_temp.id('audit_b'), pg_temp.id('audit_global')])), 2,
  'ADMIN_MASTER in "all" labels records of B and global ones');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000a1', pg_temp.a()::text);
select is((select count(*)::integer from public.audit_log_cohorts(array[pg_temp.id('audit_b'), pg_temp.id('audit_global')])), 0,
  'an ADMIN of A learns nothing about records of B or global ones');
select pg_temp.ctx('4c000000-0000-4000-8000-0000000000c1', pg_temp.b()::text);
select throws_ok($$select public.audit_log_cohorts(array[gen_random_uuid()])$$, '42501', 'AUDIT_READ_REQUIRED', 'a seller cannot use it');

select * from finish();
rollback;
