-- Spec 6.1: Portal→PDV handoff by a single-use, 60-second code whose hash alone is stored.
begin;
select plan(11);

select ok(not has_function_privilege('authenticated', 'public.consume_pdv_handoff(text)', 'EXECUTE'), 'browsers cannot redeem a code');
select ok(not has_function_privilege('anon', 'public.create_pdv_handoff(text)', 'EXECUTE'), 'anonymous cannot issue a code');

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.create_pdv_handoff(encode(sha256('consumer-code'::bytea), 'hex'))$$, '42501', 'PDV_ACCESS_REQUIRED', 'consumers get no PDV code');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok($$select public.create_pdv_handoff('abc')$$, '22023', 'INVALID_PDV_HANDOFF', 'only a SHA-256 is accepted');
select lives_ok($$select public.create_pdv_handoff(encode(sha256('seller-code'::bytea), 'hex'))$$, 'the seller gets a code');
select lives_ok($$select public.create_pdv_handoff(encode(sha256('expired-code'::bytea), 'hex'))$$, 'another code for the expiry case');
reset role;
update public.pdv_handoff_codes set created_at = created_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes'
where code_hash = encode(sha256('expired-code'::bytea), 'hex');

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
select is(public.consume_pdv_handoff(encode(sha256('seller-code'::bytea), 'hex')) ->> 'user_id', '10000000-0000-4000-8000-000000000002', 'the PDV redeems the code for the seller');
select throws_ok($$select public.consume_pdv_handoff(encode(sha256('seller-code'::bytea), 'hex'))$$, 'P0001', 'PDV_HANDOFF_INVALID', 'a code works once');
select throws_ok($$select public.consume_pdv_handoff(encode(sha256('expired-code'::bytea), 'hex'))$$, 'P0001', 'PDV_HANDOFF_INVALID', 'an expired code is refused');
select throws_ok($$select public.consume_pdv_handoff(encode(sha256('unknown-code'::bytea), 'hex'))$$, 'P0001', 'PDV_HANDOFF_INVALID', 'an unknown code gets the same answer');
reset role;

select ok(exists (select 1 from public.audit_logs where action = 'auth.pdv_handoff.issued' and actor_id = '10000000-0000-4000-8000-000000000002'), 'issuing a code is audited');

select * from finish();
rollback;
