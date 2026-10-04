begin;
select plan(18);

select has_table('public', 'signup_code_limits', 'signup code limits are persisted');
select has_function('public', 'consume_signup_code_request', array['text', 'uuid'], 'signup code consumer exists');
select has_function('public', 'unlock_signup_code_requests', array['uuid', 'text', 'uuid'], 'signup code admin unlock exists');
select ok((select relrowsecurity from pg_class where oid = 'public.signup_code_limits'::regclass), 'signup limits use RLS');
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name = 'signup_code_limits' and grantee in ('anon','authenticated','service_role')$$,
  array[0::bigint], 'API roles cannot read or write signup counters'
);

set local role service_role;
select results_eq(
  $$select (public.consume_signup_code_request(repeat('e',64), '10000000-0000-4000-8000-000000000003')->>'allowed')::boolean$$,
  array[true], 'initial signup code is allowed'
);
reset role;
select results_eq(
  $$select request_count from public.signup_code_limits where subject_hash=repeat('e',64)$$,
  array[1::smallint], 'initial request is persisted'
);
set local role service_role;
select results_eq(
  $$select (public.consume_signup_code_request(repeat('e',64), '10000000-0000-4000-8000-000000000003')->>'allowed')::boolean$$,
  array[false], 'resend before 90 seconds is denied without consuming it'
);
reset role;
select results_eq(
  $$select request_count from public.signup_code_limits where subject_hash=repeat('e',64)$$,
  array[1::smallint], 'early retry does not increment the counter'
);
update public.signup_code_limits set last_requested_at = clock_timestamp() - interval '91 seconds' where subject_hash=repeat('e',64);
set local role service_role;
select results_eq(
  $$select (public.consume_signup_code_request(repeat('e',64), '10000000-0000-4000-8000-000000000003')->>'allowed')::boolean$$,
  array[true], 'one resend is allowed after 90 seconds'
);
select results_eq(
  $$select (public.consume_signup_code_request(repeat('e',64), '10000000-0000-4000-8000-000000000003')->>'admin_reset_required')::boolean$$,
  array[true], 'second resend attempt requires an administrator'
);
reset role;
select results_eq(
  $$select request_count, (blocked_at is not null)::text from public.signup_code_limits where subject_hash=repeat('e',64)$$,
  $$values (3::smallint, 'true'::text)$$, 'blocked signup cycle remains persisted'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.unlock_signup_code_requests('10000000-0000-4000-8000-000000000003','Tentativa indevida','95000000-0000-4000-8000-000000000001')$$,
  '42501', 'USERS_MANAGE_REQUIRED', 'seller cannot unlock signup codes'
);
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select public.unlock_signup_code_requests('10000000-0000-4000-8000-000000000003','Identidade validada pelo atendimento','95000000-0000-4000-8000-000000000002')->>'status'$$,
  array['UNLOCKED'::text], 'admin unlocks signup code requests'
);
reset role;
select results_eq(
  $$select cycle, request_count, (blocked_at is null)::text from public.signup_code_limits where subject_hash=repeat('e',64)$$,
  $$values (2, 0::smallint, 'true'::text)$$, 'unlock starts a fresh cycle'
);
set local role service_role;
select results_eq(
  $$select (public.consume_signup_code_request(repeat('e',64), '10000000-0000-4000-8000-000000000003')->>'allowed')::boolean$$,
  array[true], 'new initial request is allowed after unlock'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action='auth.signup_code.unlocked' and entity_id='10000000-0000-4000-8000-000000000003'$$,
  array[1::bigint], 'admin unlock is audited'
);
set local role anon;
select throws_ok(
  $$select public.consume_signup_code_request('invalid', null)$$,
  '42501', null, 'anonymous callers cannot execute the limiter'
);
reset role;

select * from finish();
rollback;
