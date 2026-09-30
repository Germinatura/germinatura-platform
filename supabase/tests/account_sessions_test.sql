-- Spec 4.8: each person lists and ends only their own sessions; the current one is ended by logging out.
begin;
select plan(9);

insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('5e550000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', now() - interval '2 days', now() - interval '1 hour', 'Chrome no notebook'),
  ('5e550000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', now() - interval '1 day', now() - interval '10 minutes', 'Safari no celular'),
  ('5e550000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', now() - interval '3 days', now() - interval '2 days', 'Firefox antigo'),
  ('5e550000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', now(), now(), 'PDV do vendedor');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","session_id":"5e550000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.list_my_sessions()), 3, 'the consumer sees only their own sessions');
select is(public.list_my_sessions() -> 0 ->> 'current', 'true', 'the current session comes first');
select ok(not (public.list_my_sessions()::text like '%PDV do vendedor%'), 'another person''s session never appears');
select throws_ok($$select public.end_my_sessions('5e550000-0000-4000-8000-000000000001', gen_random_uuid())$$, 'P0001', 'CURRENT_SESSION_USE_LOGOUT', 'the current session ends by logging out');
select throws_ok($$select public.end_my_sessions('5e550000-0000-4000-8000-000000000004', gen_random_uuid())$$, 'P0001', 'SESSION_NOT_FOUND', 'another person''s session cannot be ended');
select is((public.end_my_sessions('5e550000-0000-4000-8000-000000000003', gen_random_uuid()) ->> 'ended')::integer, 1, 'an unrecognized session is ended');
select is((public.end_my_sessions(null, gen_random_uuid()) ->> 'ended')::integer, 1, 'every other session is ended at once');
select is(jsonb_array_length(public.list_my_sessions()), 1, 'only the current session remains');
reset role;

select is((select count(*)::integer from auth.sessions where user_id = '10000000-0000-4000-8000-000000000002'), 1, 'the seller''s session is untouched');

select * from finish();
rollback;
