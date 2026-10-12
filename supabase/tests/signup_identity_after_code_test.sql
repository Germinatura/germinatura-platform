begin;
select plan(40);

-- A1: a sign-up attempt is not a user. Identities are inserted the way Auth does it: no request JWT.
create function pg_temp.ctx(p_user uuid, p_role text, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
end;
$$;
create function pg_temp.auth_user(p_id uuid, p_email text, p_confirmed timestamptz, p_age interval, p_app jsonb default '{}') returns void language sql as $$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, recovery_sent_at)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email, '', p_confirmed, p_app, '{}',
    now() - p_age, now() - p_age, now() - p_age)
$$;
-- What the earlier sign-up trigger did for every attempt: an empty profile, the default membership, CONSUMIDOR.
create function pg_temp.legacy_domain(p_id uuid, p_email text) returns void language sql as $$
  insert into public.profiles (id, email, display_name, created_at) values (p_id, p_email, split_part(p_email, '@', 1), now() - interval '2 days');
  insert into cohort_data.user_roles (user_id, role_id, cohort_id)
  select p_id, role.id, (select id from public.cohorts where is_default) from public.roles role where role.key = 'CONSUMIDOR';
$$;
create function pg_temp.listed(p_page jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg((item ->> 'id')::uuid), '{}') from jsonb_array_elements(p_page -> 'items') item $$;

select pg_temp.ctx(null, null, null);
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000001', 'tecnica.velha@institutojef.org.br', null, interval '2 days');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000002', 'tecnica.recente@institutojef.org.br', null, interval '0 seconds');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000003', 'confirmada.velha@institutojef.org.br', now() - interval '2 days', interval '2 days');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000004', 'legado.vazio@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy_domain('1a000000-0000-4000-8000-000000000004', 'legado.vazio@institutojef.org.br');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000005', 'legado.auditado@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy_domain('1a000000-0000-4000-8000-000000000005', 'legado.auditado@institutojef.org.br');
insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
values ('auth.signup.unlocked', '10000000-0000-4000-8000-000000000001', 'profile', '1a000000-0000-4000-8000-000000000005', gen_random_uuid(), '{"cohort_scope": "GLOBAL"}');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000006', 'legado.preferencias@institutojef.org.br', null, interval '2 days');
select pg_temp.legacy_domain('1a000000-0000-4000-8000-000000000006', 'legado.preferencias@institutojef.org.br');
insert into public.profile_preferences (profile_id) values ('1a000000-0000-4000-8000-000000000006');
select pg_temp.auth_user('1a000000-0000-4000-8000-000000000007', 'provisionada.velha@institutojef.org.br', null, interval '2 days',
  '{"germinatura_provisioning": "1a000000-0000-4000-8000-0000000000ff"}');
insert into public.signup_code_limits (subject_hash, user_id, request_count, last_requested_at)
values (repeat('a', 64), '1a000000-0000-4000-8000-000000000004', 1, now() - interval '2 days');

-- 1. A code request leaves only the technical identity.
select ok(not exists (select 1 from public.profiles where id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-000000000003'))
  and not exists (select 1 from public.user_cohorts where user_id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002'))
  and not exists (select 1 from cohort_data.user_roles where user_id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002')),
  'a code request creates no profile, membership or role');

-- 2. Classification.
select is(private.identity_kind('1a000000-0000-4000-8000-000000000001'), 'TECHNICAL_PENDING', 'technical identity, old');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000002'), 'TECHNICAL_PENDING', 'technical identity, code just sent');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000003'), 'CONFIRMED_NOT_MATERIALIZED', 'confirmed, domain user still to be created');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000004'), 'UNCONFIRMED_ATTEMPT', 'earlier flow: empty attempt');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000005'), 'UNCONFIRMED_WITH_HISTORY', 'earlier flow with an audit entry: history');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000006'), 'UNCONFIRMED_WITH_HISTORY', 'earlier flow referenced by a foreign key: history');
select is(private.identity_kind('1a000000-0000-4000-8000-000000000007'), 'ADMIN_PROVISIONED', 'administrative provisioning');
select is(private.identity_kind('10000000-0000-4000-8000-000000000003'), 'ACTIVE_ACCOUNT', 'an onboarded account');

-- 3. User management lists people, not attempts; history stays visible.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'authenticated', 'all');
create temp table listing on commit drop as select public.list_cohort_users(p_limit => 100) as page;
select ok(not ('1a000000-0000-4000-8000-000000000004'::uuid = any (pg_temp.listed((select page from listing)))), 'an unconfirmed attempt is not listed');
select ok('1a000000-0000-4000-8000-000000000005'::uuid = any (pg_temp.listed((select page from listing))), 'an unconfirmed identity with history stays visible');
select is((public.list_cohort_users(p_query => 'legado.vazio') ->> 'matched')::integer, 0, 'nor found by the search');
select is((select page ->> 'total' from listing)::integer,
  (select count(distinct profile.id)::integer from public.profiles profile join public.user_cohorts membership on membership.user_id = profile.id
   where not private.is_unconfirmed_attempt(profile.id)), 'nor counted');
select ok(public.identity_inventory() ? 'UNCONFIRMED_ATTEMPT', 'ADMIN_MASTER reads the inventory');
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select throws_ok($$select public.identity_inventory()$$, '42501', 'ADMIN_MASTER_REQUIRED', 'a cohort ADMIN does not');

-- 4. Purge: only the worker, only safe rows.
select throws_ok($$select public.worker_purge_unconfirmed_identities(50, interval '1 hour')$$, '42501', 'WORKER_SERVICE_ROLE_REQUIRED', 'people cannot purge');
select pg_temp.ctx(null, 'service_role', null);
select throws_ok($$select public.worker_purge_unconfirmed_identities(50, interval '30 minutes')$$, '22023', 'INVALID_PURGE_REQUEST', 'the window is at least one hour');
create temp table purge on commit drop as select public.worker_purge_unconfirmed_identities(200, interval '1 hour') as result;
select pg_temp.ctx(null, null, null);
select ok(not exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000001'), 'an old technical identity is removed');
select ok(not exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000004')
  and not exists (select 1 from public.profiles where id = '1a000000-0000-4000-8000-000000000004')
  and not exists (select 1 from public.user_cohorts where user_id = '1a000000-0000-4000-8000-000000000004')
  and not exists (select 1 from cohort_data.user_roles where user_id = '1a000000-0000-4000-8000-000000000004'), 'an old empty attempt is removed with its automatic rows');
select is((select user_id from public.signup_code_limits where subject_hash = repeat('a', 64)), null, 'the code-request limit stays, detached');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000002'), 'a code still within the window is never touched');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000003'), 'a confirmed identity is never removed');
select ok(exists (select 1 from public.profiles where id = '1a000000-0000-4000-8000-000000000005')
  and exists (select 1 from public.profiles where id = '1a000000-0000-4000-8000-000000000006'), 'identities with history are never removed');
select ok(exists (select 1 from auth.users where id = '1a000000-0000-4000-8000-000000000007'), 'a provisioned identity is never removed');
select results_eq($$select user_id, kind from private.identity_purges where user_id in ('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000004') order by user_id$$,
  $$values ('1a000000-0000-4000-8000-000000000001'::uuid, 'TECHNICAL_PENDING'::text), ('1a000000-0000-4000-8000-000000000004'::uuid, 'UNCONFIRMED_ATTEMPT'::text)$$,
  'each removal is recorded with its kind');

-- 5. Materialization: only with the session of a valid code; once.
select pg_temp.ctx('1a000000-0000-4000-8000-000000000002', 'authenticated', null);
select throws_ok($$select public.materialize_my_signup_identity(gen_random_uuid())$$, '42501', 'EMAIL_NOT_VERIFIED', 'no domain user before the code is validated');
select pg_temp.ctx(null, null, null);
update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = '1a000000-0000-4000-8000-000000000002';
select pg_temp.ctx('1a000000-0000-4000-8000-000000000002', 'authenticated', null);
select is(public.materialize_my_signup_identity('1a000000-0000-4000-8000-0000000000aa') ->> 'created', 'true', 'the valid code creates the domain user');
select is(public.materialize_my_signup_identity('1a000000-0000-4000-8000-0000000000ab') ->> 'created', 'false', 'a second call changes nothing');
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
select is(private.identity_kind('1a000000-0000-4000-8000-000000000002'), 'CONFIRMED_ONBOARDING_INCOMPLETE', 'and it is now a person mid-onboarding');

-- 6. Signup code unlock by e-mail: same hash as the Portal, a uniform answer, audited.
insert into public.signup_code_limits (subject_hash, request_count, last_requested_at, blocked_at)
values ('6aec0309353752c6f3b3e6d9e7c74f5db091d156bb179d9a123509e984501412', 3, now() - interval '1 hour', now() - interval '1 hour');
select pg_temp.ctx('10000000-0000-4000-8000-000000000002', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select throws_ok($$select public.unlock_signup_code_by_email('bloqueado.teste@institutojef.org.br', 'Pessoa confirmou presencialmente', gen_random_uuid())$$,
  '42501', 'SIGNUP_UNLOCK_FORBIDDEN', 'a seller cannot unlock');
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', 'authenticated', 'c0000000-0000-4000-8000-000000002026');
select is(public.unlock_signup_code_by_email(' Bloqueado.Teste@institutojef.org.br ', 'Pessoa confirmou presencialmente', gen_random_uuid()),
  '{"status": "PROCESSED"}'::jsonb, 'the ADMIN of the default cohort unlocks by e-mail (normalized like the Portal)');
select is(public.unlock_signup_code_by_email('ninguem.tentou@institutojef.org.br', 'Pessoa confirmou presencialmente', gen_random_uuid()),
  '{"status": "PROCESSED"}'::jsonb, 'the answer is the same when nobody was blocked');
select pg_temp.ctx(null, null, null);
select results_eq($$select request_count::integer, blocked_at is null, cycle from public.signup_code_limits where subject_hash = '6aec0309353752c6f3b3e6d9e7c74f5db091d156bb179d9a123509e984501412'$$,
  $$values (0, true, 2)$$, 'the blocked cycle is reset (hash computed exactly like the Portal)');
select results_eq($$select (metadata ->> 'released')::boolean from cohort_data.audit_logs where action = 'auth.signup_code.unlocked_by_email' order by 1 desc$$,
  $$values (true), (false)$$, 'both unlocks are audited, with what really happened');
select throws_ok($$select public.unlock_signup_code_by_email('pessoa@example.org', 'Motivo válido', gen_random_uuid())$$,
  '42501', 'SIGNUP_UNLOCK_FORBIDDEN', 'without a session nothing is unlocked');

select * from finish();
rollback;
