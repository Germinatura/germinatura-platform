begin;
select plan(24);

select has_column('public', 'profiles', 'active', 'profiles expose an active access switch');
select has_table('public', 'institutional_auth_rate_limits', 'institutional OTP rate limits are persisted');
select has_table('public', 'institutional_bootstrap_state', 'first-admin bootstrap state is persisted');
select has_function('public', 'consume_institutional_auth_rate_limit', array['text', 'text'], 'fixed OTP rate limiter exists');
select has_function('public', 'bootstrap_first_admin', array['uuid'], 'first-admin bootstrap RPC exists');
select has_function('public', 'set_user_access', array['uuid', 'text[]', 'boolean', 'uuid'], 'audited role management RPC exists');
select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.institutional_auth_rate_limits'::regclass, 'public.institutional_bootstrap_state'::regclass) and relrowsecurity$$,
  array[2::bigint],
  'institutional control tables have RLS enabled'
);

select results_eq(
  $$select email from public.profiles where id = '10000000-0000-4000-8000-000000000003'$$,
  array['consumidor.teste@institutojef.org.br'::text],
  'local consumer identity uses the institutional domain'
);
select results_eq(
  $$select role.key from public.user_roles user_role join public.roles role on role.id = user_role.role_id where user_role.user_id = '10000000-0000-4000-8000-000000000003' order by role.key$$,
  array['CONSUMIDOR'::text],
  'a regular institutional identity starts only as consumer'
);

select throws_ok(
  $$
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      phone_change_token, email_change_token_current, reauthentication_token,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000099',
      'authenticated', 'authenticated', 'externo@example.org', '', now(),
      '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
    )
  $$,
  'P0001',
  'INSTITUTIONAL_EMAIL_REQUIRED',
  'the database rejects direct creation with an external domain'
);

select throws_ok(
  $$
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      phone_change_token, email_change_token_current, reauthentication_token,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000098',
      'authenticated', 'authenticated', 'pessoa@sub.institutojef.org.br', '', now(),
      '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()
    )
  $$,
  'P0001',
  'INSTITUTIONAL_EMAIL_REQUIRED',
  'the database rejects institutional subdomains'
);

select ok(public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('a', 64)), 'OTP request attempt 1 is accepted');
select ok(public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('a', 64)), 'OTP request attempt 2 is accepted');
select ok(public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('a', 64)), 'OTP request attempt 3 is accepted');
select ok(public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('a', 64)), 'OTP request attempt 4 is accepted');
select ok(public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('a', 64)), 'OTP request attempt 5 is accepted');
select ok(not public.consume_institutional_auth_rate_limit('OTP_REQUEST', repeat('a', 64)), 'OTP request attempt 6 is rejected');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change_token, email_change_token_current, reauthentication_token,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000010',
  'authenticated', 'authenticated', 'theo.martins@institutojef.org.br', '', now(),
  '', '', '', '', '', '', '', '{"provider":"email","providers":["email"]}', '{"name":"Bootstrap Test"}', now(), now()
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000010';
select is(
  public.bootstrap_first_admin('90000000-0000-4000-8000-000000000001')->>'status',
  'COMPLETED',
  'the verified canonical identity completes bootstrap'
);
select is(
  public.bootstrap_first_admin('90000000-0000-4000-8000-000000000002')->>'status',
  'ALREADY_COMPLETED',
  'bootstrap replay is idempotent'
);
select results_eq(
  $$select role.key from public.user_roles user_role join public.roles role on role.id = user_role.role_id where user_role.user_id = '10000000-0000-4000-8000-000000000010' order by role.key$$,
  array['ADMIN'::text, 'CONSUMIDOR'::text],
  'bootstrap adds admin without removing the base consumer role'
);

select is(
  public.set_user_access(
    '10000000-0000-4000-8000-000000000003',
    array['VENDEDOR'],
    true,
    '90000000-0000-4000-8000-000000000003'
  )->>'active',
  'true',
  'administrator activates seller access'
);
select results_eq(
  $$select role.key from public.user_roles user_role join public.roles role on role.id = user_role.role_id where user_role.user_id = '10000000-0000-4000-8000-000000000003' order by role.key$$,
  array['CONSUMIDOR'::text, 'VENDEDOR'::text],
  'seller activation retains the base consumer role'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action in ('auth.admin.bootstrap.completed', 'auth.user.access.changed')$$,
  array[2::bigint],
  'bootstrap and role changes are audited'
);

update public.profiles set active = false where id = '10000000-0000-4000-8000-000000000003';
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select ok(not public.has_permission('sales.create'), 'an inactive seller loses server-side permissions immediately');

select * from finish();
rollback;
