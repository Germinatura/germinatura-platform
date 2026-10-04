-- RES-004: Portal reservations resolve the single active central location on the server.
begin;
select plan(3);
select ok(not has_function_privilege('anon','public.default_reservation_location()','EXECUTE'),'anonymous cannot resolve the location');
set local role authenticated;
set local "request.jwt.claim.sub"='10000000-0000-4000-8000-000000000003';
select is(public.default_reservation_location(),'50000000-0000-4000-8000-000000000001'::uuid,'a consumer reserves at the central location');
set local "request.jwt.claim.sub"='';
select throws_ok($$select public.default_reservation_location()$$,'42501','COMMERCIAL_RESERVATION_FORBIDDEN','a request without a user cannot resolve it');
reset role;
select * from finish();
rollback;
