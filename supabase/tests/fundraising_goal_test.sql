-- Spec 4.1, 5.1 and 5.17 (ADMIN-002): fundraising goal measured by operating profit, with projection and an
-- optional public view that can hide the amounts.
begin;
select plan(17);

select ok(has_function_privilege('anon', 'public.public_fundraising_goal()', 'EXECUTE'), 'the public progress is readable without an account');
select ok(not has_function_privilege('anon', 'public.configure_fundraising_goal(bigint,date,date,boolean,boolean,text,uuid)', 'EXECUTE'), 'anonymous cannot configure the goal');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is(public.public_fundraising_goal(), null, 'no goal, nothing to show');
select throws_ok($$select public.configure_fundraising_goal(10000, current_date, current_date + 10, true, true, 'goal-consumer', gen_random_uuid())$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'consumers do not configure the goal');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.configure_fundraising_goal(10000, current_date, current_date - 1, true, true, 'goal-bad-dates', gen_random_uuid())$$,
  '22023', 'INVALID_FUNDRAISING_GOAL', 'the target date comes after the start');
-- A ten-day window so far and ten more days to go; R$ 20,00 of event income is the only result.
create temp table goal_day as select (now() at time zone 'America/Sao_Paulo')::date as today;
grant select on goal_day to authenticated;
select public.record_finance_entry('INCOME', 'EVENTO', 'PICPAY_EMPRESAS', null, 2000, (select today from goal_day), 'Festa junina', 'FESTA-META-01', 'goal-income', gen_random_uuid());
create temp table goal_hidden as select public.configure_fundraising_goal(10000, (select today - 9 from goal_day), (select today + 10 from goal_day), false, true, 'goal-hidden', gen_random_uuid()) result;
grant select on goal_hidden to authenticated;
select is((select (result ->> 'current_cents')::bigint from goal_hidden), 2000::bigint, 'progress is the operating profit since the start');
select is((select (result ->> 'projected_cents')::bigint from goal_hidden), 4000::bigint, 'the projection extends the daily average to the target date');
select is((select (result ->> 'progress_bps')::bigint from goal_hidden), 2000::bigint, 'progress in basis points');
select is((select result ->> 'on_track' from goal_hidden), 'false', 'the projection falls short of the target');
select is(public.configure_fundraising_goal(10000, (select today - 9 from goal_day), (select today + 10 from goal_day), false, true, 'goal-hidden', gen_random_uuid()),
  (select result from goal_hidden), 'a replay returns the same answer');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is(public.public_fundraising_goal(), null, 'an unpublished goal stays private');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.configure_fundraising_goal(10000, (select today - 9 from goal_day), (select today + 10 from goal_day), true, false, 'goal-percent-only', gen_random_uuid());
select public.record_finance_entry('EXPENSE', 'MATERIAIS', 'PICPAY_EMPRESAS', null, 500, (select today from goal_day), 'Decoração', 'DECOR-META-01', 'goal-expense', gen_random_uuid());
select is((public.get_fundraising_goal_admin() ->> 'current_cents')::bigint, 1500::bigint, 'expenses reduce the progress');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is((public.public_fundraising_goal() ->> 'progress_bps')::bigint, 1500::bigint, 'the class sees the percentage');
select is(public.public_fundraising_goal() -> 'current_cents', 'null'::jsonb, 'amounts stay hidden when the commission chose percentages only');
select is(public.public_fundraising_goal() -> 'target_cents', 'null'::jsonb, 'the target amount stays hidden too');
reset role;
set local role anon;
select is((public.public_fundraising_goal() ->> 'days_remaining')::integer, 10, 'the public progress shows the days remaining');
reset role;

select ok(exists (select 1 from public.audit_logs where action = 'settings.fundraising_goal.updated'
  and metadata #>> '{before,show_amounts}' = 'true' and metadata #>> '{after,show_amounts}' = 'false'), 'every change is audited with before and after');

select * from finish();
rollback;
