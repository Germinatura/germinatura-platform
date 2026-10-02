-- INV-002: the schema brings the central stock location, and granting the seller role provisions the seller's own.
begin;
select plan(7);

select is((select count(*)::integer from public.stock_locations where location_type = 'CENTRAL' and active), 1, 'there is exactly one active central location');
select ok(not exists (
  select 1 from public.user_roles user_role join public.roles role on role.id = user_role.role_id and role.key = 'VENDEDOR'
  where not exists (select 1 from public.stock_locations location where location.seller_id = user_role.user_id and location.active)),
  'every seller has an active location');

select is((select count(*)::integer from public.stock_locations where seller_id = '10000000-0000-4000-8000-000000000003'), 0, 'a consumer has no location');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.set_user_access('10000000-0000-4000-8000-000000000003', array['CONSUMIDOR', 'VENDEDOR'], true, gen_random_uuid())$$, 'the administrator makes the consumer a seller');
reset role;
select is((select count(*)::integer from public.stock_locations where seller_id = '10000000-0000-4000-8000-000000000003' and location_type = 'SELLER' and active), 1, 'granting the seller role provisions the location');

-- Revoking keeps the location and its history; granting again reuses it.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.set_user_access('10000000-0000-4000-8000-000000000003', array['CONSUMIDOR'], true, gen_random_uuid());
create temp table kept as select id from public.stock_locations where seller_id = '10000000-0000-4000-8000-000000000003';
select public.set_user_access('10000000-0000-4000-8000-000000000003', array['CONSUMIDOR', 'VENDEDOR'], true, gen_random_uuid());
reset role;
select is((select count(*)::integer from kept), 1, 'revoking the role keeps the location');
select is((select array_agg(id) from public.stock_locations where seller_id = '10000000-0000-4000-8000-000000000003'), (select array_agg(id) from kept), 'granting again reuses the same location');

select * from finish();
rollback;
