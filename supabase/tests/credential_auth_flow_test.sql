begin;
select plan(46);

select has_column('public', 'profiles', 'username', 'profiles have username');
select has_column('public', 'profiles', 'onboarding_completed_at', 'profiles track completed onboarding');
select has_table('public', 'password_recovery_limits', 'password recovery limits are persisted');
select has_function('public', 'complete_my_profile', array['text', 'text', 'text', 'uuid'], 'profile completion RPC exists');
select has_function('public', 'complete_admin_provisioned_profile', array['uuid', 'uuid', 'text', 'text', 'uuid'], 'admin provisioning completion RPC exists');
select has_function('public', 'resolve_login_identifier', array['text'], 'service-only identifier resolver exists');
select has_function('public', 'consume_password_recovery_request', array['text', 'uuid'], 'recovery request limiter exists');
select has_function('public', 'unlock_password_recovery', array['uuid', 'text', 'uuid'], 'admin recovery unlock exists');
select has_function('public', 'complete_password_recovery', array['uuid'], 'recovery completion RPC exists');
select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'profiles_username_unique'),
  'username has a unique index'
);
select ok(not has_function_privilege('anon', 'public.resolve_login_identifier(text)', 'EXECUTE'), 'anonymous cannot resolve username to email');
select ok(not has_function_privilege('authenticated', 'public.resolve_login_identifier(text)', 'EXECUTE'), 'authenticated users cannot resolve username to email');
select ok(has_function_privilege('service_role', 'public.resolve_login_identifier(text)', 'EXECUTE'), 'service role can resolve identifiers server-side');
select ok(has_function_privilege('service_role', 'public.complete_admin_provisioned_profile(uuid,uuid,text,text,uuid)', 'EXECUTE'), 'service role can finalize an authorized provisioned profile');
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'password_recovery_limits' and grantee in ('anon', 'authenticated', 'service_role')$$,
  array[0::bigint],
  'recovery counters expose no direct table grants'
);
select results_eq(
  $$select count(*)::bigint from storage.buckets where id = 'profile-photos' and not public and file_size_limit = 5242880$$,
  array[1::bigint],
  'profile photo bucket is private and limited to 5 MB'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'profile_photos_%'$$,
  array[4::bigint],
  'profile photos have own-read and own-write policies'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change_token, email_change_token_current, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'cadastro.teste@institutojef.org.br', '', now(),
  '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
);
select results_eq(
  $$select (onboarding_completed_at is null)::text, username from public.profiles where id = '11000000-0000-4000-8000-000000000001'$$,
  $$values ('true'::text, null::text)$$,
  'verified OTP identity remains incomplete until profile and password are chosen'
);
select results_eq(
  $$select role.key from public.user_roles user_role join public.roles role on role.id = user_role.role_id where user_role.user_id = '11000000-0000-4000-8000-000000000001'$$,
  array['CONSUMIDOR'::text],
  'self-signup receives only the consumer role'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '11000000-0000-4000-8000-000000000001';
select ok(not public.has_permission('portal.access'), 'incomplete account has no effective permissions');
create temp table completed_profile as
select public.complete_my_profile(
  'Cadastro Teste', 'Cadastro.Teste', null,
  '91000000-0000-4000-8000-000000000001'
) as result;
select results_eq(
  $$select result ->> 'username', result ->> 'onboarding_completed' from completed_profile$$,
  $$values ('cadastro.teste'::text, 'true'::text)$$,
  'profile completion normalizes username and completes onboarding'
);
select results_eq(
  $$select display_name, username, (onboarding_completed_at is not null)::text from public.profiles where id = '11000000-0000-4000-8000-000000000001'$$,
  $$values ('Cadastro Teste'::text, 'cadastro.teste'::text, 'true'::text)$$,
  'completed profile persists required fields'
);
select ok(public.has_permission('portal.access'), 'completed consumer regains effective portal permission');
select results_eq(
  $$select public.complete_my_profile('Cadastro Teste', 'cadastro.teste', null, '91000000-0000-4000-8000-000000000099')$$,
  $$select result from completed_profile$$,
  'same profile completion is idempotent'
);
select throws_ok(
  $$select public.complete_my_profile('Outro Nome', 'outro.username', null, '91000000-0000-4000-8000-000000000002')$$,
  'P0001', 'ONBOARDING_ALREADY_COMPLETED', 'completed onboarding cannot be rewritten through completion RPC'
);
reset role;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change_token, email_change_token_current, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'duplicado.teste@institutojef.org.br', '', now(),
  '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
);
set local role authenticated;
set local "request.jwt.claim.sub" = '11000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.complete_my_profile('Duplicado Teste', 'CADASTRO.TESTE', null, '91000000-0000-4000-8000-000000000003')$$,
  '23505', 'USERNAME_ALREADY_USED', 'username uniqueness is case-insensitive through normalization'
);
reset role;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change_token, email_change_token_current, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '11000000-0000-4000-8000-000000000003',
  'authenticated', 'authenticated', 'provisionado.teste@institutojef.org.br', '', now(),
  '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}',
  '{"name":"Provisionado Teste","username":"provisionado.teste"}', now(), now()
);
update auth.users set encrypted_password = 'hash-presente' where id = '11000000-0000-4000-8000-000000000003';
set local role service_role;
select throws_ok(
  $$select public.complete_admin_provisioned_profile('10000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000003', 'Provisionado Teste', 'provisionado.teste', '91000000-0000-4000-8000-000000000007')$$,
  '42501', 'USERS_MANAGE_REQUIRED', 'service call cannot attribute provisioning to a seller'
);
select results_eq(
  $$select public.complete_admin_provisioned_profile('10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 'Provisionado Teste', 'PROVISIONADO.TESTE', '91000000-0000-4000-8000-000000000008') ->> 'onboarding_completed'$$,
  array['true'::text],
  'authorized admin provisioning completes the credential profile'
);
reset role;
select results_eq(
  $$select username, (onboarding_completed_at is not null)::text from public.profiles where id = '11000000-0000-4000-8000-000000000003'$$,
  $$values ('provisionado.teste'::text, 'true'::text)$$,
  'provisioned profile persists normalized username and completion'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'auth.profile.provisioned' and actor_id = '10000000-0000-4000-8000-000000000001' and entity_id = '11000000-0000-4000-8000-000000000003'$$,
  array[1::bigint],
  'admin provisioning completion is audited once'
);

set local role service_role;
select ok(
  public.consume_institutional_auth_rate_limit('LOGIN', repeat('d', 64)),
  'credential login has a persistent hashed rate limit'
);
select results_eq(
  $$select public.resolve_login_identifier('CADASTRO.TESTE') ->> 'email'$$,
  array['cadastro.teste@institutojef.org.br'::text],
  'service resolver accepts normalized username without exposing a public table'
);
select results_eq(
  $$select (public.consume_password_recovery_request(repeat('b', 64), '11000000-0000-4000-8000-000000000001') ->> 'allowed')::boolean$$,
  array[true],
  'first recovery code request is allowed'
);
select results_eq(
  $$select (public.consume_password_recovery_request(repeat('b', 64), '11000000-0000-4000-8000-000000000001') ->> 'allowed')::boolean$$,
  array[true],
  'second recovery code request is allowed'
);
select results_eq(
  $$select (public.consume_password_recovery_request(repeat('b', 64), '11000000-0000-4000-8000-000000000001') ->> 'admin_reset_required')::boolean$$,
  array[true],
  'third recovery request requires administrator unlock'
);
reset role;
select results_eq(
  $$select request_count, (blocked_at is not null)::text from public.password_recovery_limits where subject_hash = repeat('b', 64)$$,
  $$values (3, 'true'::text)$$,
  'blocked recovery remains persisted without time-window reset'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.unlock_password_recovery('11000000-0000-4000-8000-000000000001', 'Tentativa indevida', '91000000-0000-4000-8000-000000000004')$$,
  '42501', 'USERS_MANAGE_REQUIRED', 'seller cannot unlock password recovery'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.unlock_password_recovery('11000000-0000-4000-8000-000000000001', 'Identidade validada pelo atendimento', '91000000-0000-4000-8000-000000000005') ->> 'status'$$,
  array['UNLOCKED'::text],
  'admin unlocks recovery without setting a password'
);
reset role;
select results_eq(
  $$select cycle, request_count, (blocked_at is null)::text, unlocked_by from public.password_recovery_limits where subject_hash = repeat('b', 64)$$,
  $$values (2, 0, 'true'::text, '10000000-0000-4000-8000-000000000001'::uuid)$$,
  'admin unlock starts a fresh audited cycle'
);

set local role service_role;
select results_eq(
  $$select (public.consume_password_recovery_request(repeat('b', 64), '11000000-0000-4000-8000-000000000001') ->> 'allowed')::boolean$$,
  array[true],
  'new recovery request is allowed after admin unlock'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '11000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.complete_password_recovery('91000000-0000-4000-8000-000000000006') ->> 'status'$$,
  array['COMPLETED'::text],
  'user completes their own recovery cycle'
);
reset role;
select results_eq(
  $$select request_count, (blocked_at is null)::text, unlocked_by from public.password_recovery_limits where subject_hash = repeat('b', 64)$$,
  $$values (0, 'true'::text, null::uuid)$$,
  'successful recovery clears counters and admin marker'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'auth.password_recovery.unlocked' and entity_id = '11000000-0000-4000-8000-000000000001'$$,
  array[1::bigint],
  'admin unlock is audited once'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'auth.profile.completed' and entity_id = '11000000-0000-4000-8000-000000000001'$$,
  array[1::bigint],
  'profile completion is audited once'
);
select throws_ok(
  $$select public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('c', 64))$$,
  '22023', 'INVALID_RATE_LIMIT_SCOPE', 'legacy OTP login scope is closed'
);
select ok(not has_function_privilege('anon', 'public.consume_password_recovery_request(text,uuid)', 'EXECUTE'), 'anonymous callers cannot mutate recovery counters directly');

select * from finish();
rollback;
