-- Spec 5.16 (AUD-001): logins, failed logins and authorization denials are recorded without secrets, bounded
-- against flooding, and readable only by administrators.
begin;
select plan(15);

select ok(not has_table_privilege('anon', 'public.security_events', 'SELECT'), 'nobody reads security events directly');
select ok(has_function_privilege('anon', 'public.record_login_failure(text,text,boolean,text)', 'EXECUTE'), 'the login route records failures before any session exists');
select ok(not has_function_privilege('anon', 'public.record_authorization_denied(text,text,text,text)', 'EXECUTE'), 'denials are recorded only for signed-in users');

set local role anon;
select public.record_login_failure('Consumidor.Teste', 'PORTAL', false, 'req-login-1');
select public.record_login_failure('ninguem@exemplo.com', 'PDV', true, 'req-login-2');
select public.record_login_failure('', 'PORTAL', false, 'req-empty');
select public.record_login_failure('flood@exemplo.com', 'PORTAL', false, null) from generate_series(1, 35);
reset role;

select is((select actor_id::text from public.security_events where request_id = 'req-login-1'), '10000000-0000-4000-8000-000000000003',
  'a failure on an existing account names the account');
select is((select kind || ':' || app || ':' || (actor_id is null)::text from public.security_events where request_id = 'req-login-2'),
  'LOGIN_RATE_LIMITED:PDV:true', 'an unknown identifier is kept only as a hash');
select is((select subject_hash from public.security_events where request_id = 'req-login-2'),
  encode(sha256(convert_to('ninguem@exemplo.com', 'UTF8')), 'hex'), 'the hash is of the normalized identifier');
select is((select count(*)::integer from public.security_events where request_id = 'req-empty'), 0, 'empty identifiers are ignored');
select is((select count(*)::integer from public.security_events where subject_hash = encode(sha256(convert_to('flood@exemplo.com', 'UTF8')), 'hex')),
  30, 'one identifier records at most 30 failures per 15 minutes');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select public.record_login_success('PDV', 'req-success');
select public.record_login_success('PDV', 'req-success-again');
select public.record_authorization_denied('PORTAL', '/api/v1/admin/audit', 'GET', 'req-denied');
select public.record_authorization_denied('PORTAL', 'javascript:alert(1)', 'GET', 'req-bad-route');
select throws_ok($$select public.search_security_events(current_date, current_date)$$, '42501', 'AUDIT_READ_REQUIRED', 'sellers do not read security events');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table security_page as select public.search_security_events(current_date - 1, current_date + 1, null, null, null, null, 100) result;
grant select on security_page to authenticated;
select is((select count(*)::integer from jsonb_array_elements((select result -> 'rows' from security_page)) row
  where row ->> 'kind' = 'LOGIN_SUCCEEDED' and row ->> 'actor_id' = '10000000-0000-4000-8000-000000000002'), 1, 'a double login submit is recorded once');
select is((select row ->> 'route' from jsonb_array_elements((select result -> 'rows' from security_page)) row where row ->> 'kind' = 'AUTHORIZATION_DENIED'),
  '/api/v1/admin/audit', 'the denied route is recorded');
select is((select count(*)::integer from jsonb_array_elements((select result -> 'rows' from security_page)) row where row ->> 'request_id' = 'req-bad-route'),
  0, 'malformed routes are not recorded');
select is((select count(*)::integer from jsonb_array_elements(public.search_security_events(current_date - 1, current_date + 1, 'LOGIN_FAILED', 'ninguem@exemplo.com', null, null, 50) -> 'rows')),
  0, 'filters combine kind and identifier');
select is(jsonb_array_length(public.search_security_events(current_date - 1, current_date + 1, 'LOGIN_RATE_LIMITED', 'ninguem@exemplo.com', null, null, 50) -> 'rows'),
  1, 'an unknown identifier is found by typing it again');
reset role;

select throws_ok($$delete from public.security_events$$, 'P0001', null, 'security events are immutable');

select * from finish();
rollback;
