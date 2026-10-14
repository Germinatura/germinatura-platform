begin;
select plan(54);

-- A1: a sign-up attempt is not a user. Identities are inserted the way Auth does it: no request JWT.
create function pg_temp.ctx(p_user uuid, p_role text, p_header text, p_session uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role, 'session_id', p_session)::text, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
end;
$$;
create function pg_temp.auth_user(p_id uuid, p_email text, p_confirmed timestamptz, p_age interval, p_app jsonb default '{}') returns void language sql as $$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, recovery_sent_at)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email, '', p_confirmed, p_app, '{}',
    now() - p_age, now() - p_age, now() - p_age);
  -- The attempt mark carries the creation time of the identity (the trigger stamps the statement time).
  update private.signup_attempts set created_at = now() - p_age where user_id = p_id;
$$;
-- A legacy identity existed before A1: it never got the attempt mark.
create function pg_temp.legacy(p_id uuid) returns void language sql as $$ delete from private.signup_attempts where user_id = p_id $$;
-- What the earlier sign-up trigger did for every attempt: an empty profile, the default membership, CONSUMIDOR.
create function pg_temp.legacy_domain(p_id uuid, p_email text) returns void language sql as $$
  insert into public.profiles (id, email, display_name, created_at) values (p_id, p_email, split_part(p_email, '@', 1), now() - interval '2 days');
  insert into cohort_data.user_roles (user_id, role_id, cohort_id)
  select p_id, role.id, (select id from public.cohorts where is_default) from public.roles role where role.key = 'CONSUMIDOR';
$$;
create function pg_temp.listed(p_page jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg((item ->> 'id')::uuid), '{}') from jsonb_array_elements(p_page -> 'items') item $$;

select pg_temp.ctx(null, null, null);
-- Attempts of the new flow.
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000001', 'tecnica.velha@institutojef.org.br', null, interval '2 days');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000002', 'tecnica.recente@institutojef.org.br', null, interval '0 seconds');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000003', 'confirmada.velha@institutojef.org.br', now() - interval '2 days', interval '2 days');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000008', 'tecnica.sessao@institutojef.org.br', null, interval '2 days');
insert into auth.sessions (id, user_id, created_at, updated_at) values ('5e000000-0000-4000-8000-000000000008', '1a000000-0000-4000-8000-000000000008', now() - interval '2 days', now() - interval '2 days');
-- Legacy identities (before A1).
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000004', 'legado.vazio@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy('1a000000-0000-4000-8000-000000000004');
select pg_temp.legacy_domain('1a000000-0000-4000-8000-000000000004', 'legado.vazio@institutojef.org.br');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000005', 'legado.auditado@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy('1a000000-0000-4000-8000-000000000005');
select pg_temp.legacy_domain('1a000000-0000-4000-8000-000000000005', 'legado.auditado@institutojef.org.br');
insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
values ('auth.signup.unlocked', '10000000-0000-4000-8000-000000000001', 'profile', '1a000000-0000-4000-8000-000000000005', gen_random_uuid(), '{"cohort_scope": "GLOBAL"}');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000006', 'legado.preferencias@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy('1a000000-0000-4000-8000-000000000006');
select pg_temp.legacy_domain('1a000000-0000-4000-8000-000000000006', 'legado.preferencias@institutojef.org.br');
insert into public.profile_preferences (profile_id) values ('1a000000-0000-4000-8000-000000000006');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000009', 'legado.sem.perfil@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy('1a000000-0000-4000-8000-000000000009');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000007', 'provisionada.velha@institutojef.org.br', null, interval '2 days',
  '{"germinatura_provisioning": "1a000000-0000-4000-8000-0000000000ff"}');

-- 1. A code request leaves only the technical identity, marked as an attempt of this flow by the database itself.
select ok(not exists (select 1 from public.profiles where id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-000000000003'))
  and not exists (select 1 from public.user_cohorts where user_id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002'))
  and not exists (select 1 from cohort_data.user_roles where user_id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002')),
  'a code request creates no profile, membership or role');
select is((select count(*)::integer from private.signup_attempts where user_id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002')), 2,
  'each attempt of this flow is marked at creation');
select ok(not has_table_privilege('authenticated', 'private.signup_attempts', 'INSERT') and not has_table_privilege('service_role', 'private.signup_attempts', 'INSERT'),
  'nobody but the database writes the mark');
select ok(not exists (select 1 from private.signup_attempts where user_id = '1a000000-0000-4000-8000-000000000007'), 'a provisioned identity is not an attempt');

-- 2. Classification.
select is(private.identity_kind('1a000000-0000-4000-8000-000000000001'), 'SIGNUP_ATTEMPT', 'attempt of this flow, old');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000002'), 'SIGNUP_ATTEMPT', 'attempt of this flow, code just sent');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000003'), 'CONFIRMED_NOT_MATERIALIZED', 'confirmed, domain user still to be created');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000008'), 'CONFIRMED_NOT_MATERIALIZED', 'an identity with a session is not an attempt');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000004'), 'LEGACY_UNCONFIRMED_EMPTY', 'legacy: empty attempt');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000005'), 'LEGACY_UNCONFIRMED_WITH_HISTORY', 'legacy with an audit entry');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000006'), 'LEGACY_UNCONFIRMED_WITH_HISTORY', 'legacy referenced by a foreign key');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000009'), 'LEGACY_UNCONFIRMED_NO_PROFILE', 'legacy without a profile');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000007'), 'ADMIN_PROVISIONED', 'administrative provisioning');
select is(private.identity_kind('10000000-0000-4000-8000-000000000003'), 'ACTIVE_ACCOUNT', 'an onboarded account');

-- 3. User management lists people, not attempts; history stays visible.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'authenticated', 'all');
create temp table listing on commit drop as select public.list_cohort_users(p_limit => 100) as page;
select ok(not ('1a000000-0000-4000-8000-000000000004'::uuid = any (pg_temp.listed((select page from listing)))), 'a legacy unconfirmed attempt is not listed');
select ok('1a000000-0000-4000-8000-000000000005'::uuid = any (pg_temp.listed((select page from listing))), 'a legacy identity with history stays visible');
select is((public.list_cohort_users(p_query => 'legado.vazio') ->> 'matched')::integer, 0, 'nor found by the search');
select is((select page ->> 'total' from listing)::integer,
  (select count(distinct profile.id)::integer from public.profiles profile join public.user_cohorts membership on membership.user_id = profile.id
   where not private.is_unconfirmed_attempt(profile.id)), 'nor counted');
create temp table inventory on commit drop as select public.identity_inventory() as counts;
select ok((select counts from inventory) ?& array['SIGNUP_ATTEMPT', 'LEGACY_UNCONFIRMED_EMPTY', 'LEGACY_UNCONFIRMED_WITH_HISTORY', 'LEGACY_UNCONFIRMED_NO_PROFILE', 'ADMIN_PROVISIONED', 'ACTIVE_ACCOUNT'],
  'ADMIN_MASTER reads every category in the inventory');
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select throws_ok($$select public.identity_inventory()$$, '42501', 'ADMIN_MASTER_REQUIRED', 'a cohort ADMIN does not');

-- 4. Purge: only the worker, only expired attempts of this flow; no legacy identity ever.
select throws_ok($$select public.worker_purge_unconfirmed_identities(50, interval '1 hour')$$, '42501', 'WORKER_SERVICE_ROLE_REQUIRED', 'people cannot purge');
select pg_temp.ctx(null, 'service_role', null);
select throws_ok($$select public.worker_purge_unconfirmed_identities(50, interval '30 minutes')$$, '22023', 'INVALID_PURGE_REQUEST', 'the window is at least one hour');
create temp table purge on commit drop as select public.worker_purge_unconfirmed_identities(200, interval '1 hour') as result;
select pg_temp.ctx(null, null, null);
select ok(not exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000001')
  and not exists (select 1 from private.signup_attempts where user_id = '1a000000-0000-4000-8000-000000000001'), 'an expired attempt of this flow is removed');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000004')
  and exists (select 1 from public.profiles where id = '1a000000-0000-4000-8000-000000000004')
  and exists (select 1 from public.user_cohorts where user_id = '1a000000-0000-4000-8000-000000000004'), 'a legacy empty attempt is NOT removed');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000009'), 'a legacy identity without a profile is NOT removed');
select ok(exists (select 1 from public.profiles where id = '1a000000-0000-4000-8000-000000000005')
  and exists (select 1 from public.profiles where id = '1a000000-0000-4000-8000-000000000006'), 'legacy identities with history are not removed');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000002'), 'an attempt still within the window is never touched');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000003'), 'a confirmed identity is never removed');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000008'), 'an identity with a session is never removed');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000007'), 'a provisioned identity is never removed');
select results_eq($$select user_id, kind from private.identity_purges$$,
  $$values ('1a000000-0000-4000-8000-000000000001'::uuid, 'SIGNUP_ATTEMPT'::text)$$, 'exactly that removal is recorded, with its kind');

-- 5. Materialization: only with the session a valid code produced; once.
select pg_temp.ctx('1a000000-0000-4000-8000-000000000002', 'authenticated', null);
select throws_ok($$select public.materialize_my_signup_identity(gen_random_uuid())$$, '42501', 'CODE_SESSION_REQUIRED', 'a JWT that names no issued session proves nothing');
select pg_temp.ctx(null, null, null);
update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = '1a000000-0000-4000-8000-000000000002';
insert into auth.sessions (id, user_id, created_at, updated_at) values ('5e000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-000000000002', now(), now());
select pg_temp.ctx('1a000000-0000-4000-8000-000000000002', 'authenticated', null, '5e000000-0000-4000-8000-000000000008');
select throws_ok($$select public.materialize_my_signup_identity(gen_random_uuid())$$, '42501', 'CODE_SESSION_REQUIRED', 'nor does a session of somebody else');
select pg_temp.ctx('1a000000-0000-4000-8000-000000000002', 'authenticated', null, '5e000000-0000-4000-8000-000000000002');
select is(public.materialize_my_signup_identity('1a000000-0000-4000-8000-0000000000aa') ->> 'created', 'true', 'the valid code creates the domain user');
select is(public.materialize_my_signup_identity('1a000000-0000-4000-8000-0000000000ab') ->> 'created', 'false', 'a retry changes nothing');
select pg_temp.ctx(null, null, null);
select is((select count(*)::integer from public.profiles where id = '1a000000-0000-4000-8000-000000000002'), 1, 'exactly one profile');
select results_eq($$select cohort_id, status::text from public.user_cohorts where user_id = '1a000000-0000-4000-8000-000000000002'$$,
  $$select id, 'ACTIVE'::text from public.cohorts where is_default and status = 'ACTIVE'$$, 'exactly one membership, explicitly in the ACTIVE default cohort');
select results_eq($$select role.key, user_role.cohort_id from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
  where user_role.user_id = '1a000000-0000-4000-8000-000000000002'$$,
  $$select 'CONSUMIDOR'::text, id from public.cohorts where is_default$$, 'exactly one role: CONSUMIDOR in that cohort');
select is((select onboarding_completed_at from public.profiles where id = '1a000000-0000-4000-8000-000000000002'), null, 'onboarding still to do');
select is((select count(*)::integer from cohort_data.audit_logs where action = 'auth.identity.materialized' and entity_id = '1a000000-0000-4000-8000-000000000002'), 1,
  'materialization audited once');
select isnt((select materialized_at from private.signup_attempts where user_id = '1a000000-0000-4000-8000-000000000002'), null, 'the attempt is closed');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000002'), 'CONFIRMED_ONBOARDING_INCOMPLETE', 'and it is now a person mid-onboarding');

-- 6. Administrative provisioning: Auth writes the stamp after the insert; the person joins ONLY the target cohort.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'authenticated', 'all');
create temp table cohort_b on commit drop as select (public.create_cohort('Turma Provisionamento', 2061, 'turma-prov-a1', 'ACTIVE', 'a1-prov-b', gen_random_uuid()) ->> 'id')::uuid as id;
select pg_temp.ctx(null, null, null);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '1a000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'provisionada.b@institutojef.org.br',
  'hash', now(), '{"provider": "email"}', '{"name": "Provisionada B"}', now(), now());
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"germinatura_provisioning": "1a000000-0000-4000-8000-0000000000b9"}' where id = '1a000000-0000-4000-8000-0000000000b1';
select is((select count(*)::integer from public.profiles where id = '1a000000-0000-4000-8000-0000000000b1'), 0, 'before provisioning: no domain user');
select pg_temp.ctx(null, 'service_role', null);
select is(public.complete_admin_provisioned_profile('10000000-0000-4000-8000-000000000005', '1a000000-0000-4000-8000-0000000000b1', 'Provisionada B',
  'provisionada.b', (select id from cohort_b), '1a000000-0000-4000-8000-0000000000b9') ->> 'cohort_id', (select id::text from cohort_b), 'provisioned into the target cohort');
select is(public.complete_admin_provisioned_profile('10000000-0000-4000-8000-000000000005', '1a000000-0000-4000-8000-0000000000b1', 'Provisionada B',
  'provisionada.b', (select id from cohort_b), '1a000000-0000-4000-8000-0000000000b9') ->> 'cohort_id', (select id::text from cohort_b), 'a repeated provisioning answers the same');
select pg_temp.ctx(null, null, null);
select results_eq($$select cohort_id from public.user_cohorts where user_id = '1a000000-0000-4000-8000-0000000000b1'$$, $$select id from cohort_b$$,
  'exactly one membership, in the target cohort only');
select results_eq($$select role.key, user_role.cohort_id from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
  where user_role.user_id = '1a000000-0000-4000-8000-0000000000b1'$$, $$select 'CONSUMIDOR'::text, id from cohort_b$$, 'CONSUMIDOR in the target cohort only');
select is((select count(*)::integer from cohort_data.audit_logs where entity_id = '1a000000-0000-4000-8000-0000000000b1'
  and cohort_id is distinct from (select id from cohort_b)), 0, 'nothing about the person is written in another cohort');

-- 7. Signup code unlock by e-mail: same hash as the Portal, a uniform answer, audited, rate-limited.
insert into public.signup_code_limits (subject_hash, request_count, last_requested_at, blocked_at)
values ('6aec0309353752c6f3b3e6d9e7c74f5db091d156bb179d9a123509e984501412', 3, now() - interval '1 hour', now() - interval '1 hour');
select pg_temp.ctx('10000000-0000-4000-8000-000000000002', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select throws_ok($$select public.unlock_signup_code_by_email('bloqueado.teste@institutojef.org.br', 'Pessoa confirmou presencialmente', gen_random_uuid())$$,
  '42501', 'SIGNUP_UNLOCK_FORBIDDEN', 'a seller cannot unlock');
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select is(public.unlock_signup_code_by_email(' Bloqueado.Teste@institutojef.org.br ', 'Pessoa confirmou presencialmente', gen_random_uuid()),
  '{"status": "PROCESSED"}'::jsonb, 'the ADMIN of the default cohort unlocks by e-mail (normalized like the Portal)');
select is(public.unlock_signup_code_by_email('ninguem.tentou@institutojef.org.br', 'Pessoa confirmou presencialmente', gen_random_uuid()),
  '{"status": "PROCESSED"}'::jsonb, 'the answer is the same when nobody was blocked or ever tried');
select pg_temp.ctx(null, null, null);
select results_eq($$select request_count::integer, blocked_at is null, cycle from public.signup_code_limits where subject_hash = '6aec0309353752c6f3b3e6d9e7c74f5db091d156bb179d9a123509e984501412'$$,
  $$values (0, true, 2)$$, 'the blocked cycle is reset (hash computed exactly like the Portal)');
select results_eq($$select (metadata ->> 'released')::boolean from cohort_data.audit_logs where action = 'auth.signup_code.unlocked_by_email' order by 1 desc$$,
  $$values (true), (false)$$, 'both unlocks are audited, with what really happened');
insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
select 'auth.signup_code.unlocked_by_email', '10000000-0000-4000-8000-000000000001', 'signup_code_limit', repeat('b', 64), gen_random_uuid(), '{"cohort_scope": "GLOBAL"}'
from generate_series(1, 28);
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select throws_ok($$select public.unlock_signup_code_by_email('outra.pessoa@institutojef.org.br', 'Pessoa confirmou presencialmente', gen_random_uuid())$$,
  'P0001', 'SIGNUP_UNLOCK_RATE_LIMITED', 'at most 30 unlocks per administrator per hour');

select * from finish();
rollback;
