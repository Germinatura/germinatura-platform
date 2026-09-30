-- Spec 5.17 (desbloqueios): administrators see blocked recovery and signup requests; nobody else does.
begin;
select plan(5);

insert into public.password_recovery_limits (subject_hash, user_id, request_count, blocked_at)
values (encode(sha256('lock-test'::bytea), 'hex'), '10000000-0000-4000-8000-000000000003', 3, now());

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.list_user_locks()$$, '42501', 'USERS_MANAGE_REQUIRED', 'sellers do not see account locks');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select ok(public.list_user_locks() -> 'password_recovery' ? '10000000-0000-4000-8000-000000000003', 'the blocked recovery is listed');
select is(public.list_user_locks() -> 'signup_code', '[]'::jsonb, 'no signup code is blocked');
select lives_ok($$select public.unlock_password_recovery('10000000-0000-4000-8000-000000000003', 'Identidade confirmada', gen_random_uuid())$$, 'the administrator unlocks it');
select is(public.list_user_locks() -> 'password_recovery', '[]'::jsonb, 'the unlocked account leaves the list');
reset role;

select * from finish();
rollback;
