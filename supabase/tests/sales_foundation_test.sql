begin;
select plan(41);

select has_table('public', 'sales', 'sales table exists');
select has_table('public', 'sale_items', 'immutable sale items table exists');
select has_table('public', 'sale_status_history', 'sale status history table exists');
select has_type('public', 'sale_status', 'closed sale status type exists');
select has_function(
  'private', 'transition_sale_state',
  array['uuid', 'public.sale_status', 'uuid', 'uuid', 'text'],
  'internal state transition primitive exists'
);
select has_function('private', 'assert_sale_totals', array['uuid'], 'sale total assertion exists');
select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.sales'::regclass, 'public.sale_items'::regclass, 'public.sale_status_history'::regclass) and relrowsecurity$$,
  array[3::bigint],
  'all sale tables have RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('sales', 'sale_items', 'sale_status_history') and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'sale tables expose no direct write policies'
);
select results_eq(
  $$select count(*)::bigint from information_schema.role_table_grants where table_schema = 'public' and table_name in ('sales', 'sale_items', 'sale_status_history') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'$$,
  array[0::bigint],
  'API roles receive no sale write grants'
);
select ok(
  exists (
    select 1 from public.role_permissions role_permission
    join public.roles role on role.id = role_permission.role_id
    join public.permissions permission on permission.id = role_permission.permission_id
    where role.key = 'CONSUMIDOR' and permission.key = 'sales.read.own'
  ),
  'consumers may read only their own purchase history'
);

insert into public.sales (
  id, channel, location_id, created_by, customer_id,
  original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
) values (
  '71000000-0000-4000-8000-000000000001', 'PDV',
  '50000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002', null,
  3000, 500, 2500, now(), '72000000-0000-4000-8000-000000000001'
);
insert into public.sale_items (
  id, sale_id, product_id, product_sku, product_name, quantity,
  unit_price_cents, original_subtotal_cents, discount_cents, total_cents
) values (
  '73000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  'CONCURRENCY-ITEM', 'Snapshot vendedor', 2, 1500, 3000, 500, 2500
);

insert into public.sales (
  id, channel, location_id, created_by, customer_id,
  original_total_cents, discount_total_cents, total_cents, quoted_at, correlation_id
) values (
  '71000000-0000-4000-8000-000000000002', 'PORTAL',
  '50000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000003',
  1100, 0, 1100, now(), '72000000-0000-4000-8000-000000000002'
);
insert into public.sale_items (
  id, sale_id, product_id, product_sku, product_name, quantity,
  unit_price_cents, original_subtotal_cents, discount_cents, total_cents
) values (
  '73000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000002',
  '33000000-0000-4000-8000-000000000001',
  'CONCURRENCY-ITEM', 'Snapshot consumidor', 1, 1000, 1000, 0, 1000
);

select results_eq(
  $$select status::text from public.sales order by id$$,
  array['DRAFT'::text, 'DRAFT'::text],
  'every sale starts as a draft'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where from_status is null and to_status = 'DRAFT'$$,
  array[2::bigint],
  'creation writes one initial history record per sale'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'sales.created'$$,
  array[2::bigint],
  'sale creation is audited'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'sales.created'$$,
  array[2::bigint],
  'sale creation emits transactional outbox events'
);
select lives_ok(
  $$select private.assert_sale_totals('71000000-0000-4000-8000-000000000001')$$,
  'matching item snapshots satisfy the aggregate totals'
);
select throws_ok(
  $$insert into public.sales (id, channel, location_id, created_by, status, original_total_cents, total_cents, quoted_at, correlation_id) values ('71000000-0000-4000-8000-000000000003', 'PDV', '50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'CONFIRMED', 1, 1, now(), '72000000-0000-4000-8000-000000000003')$$,
  'P0001', 'SALE_MUST_START_AS_DRAFT', 'a sale cannot be inserted directly into a later state'
);
select throws_ok(
  $$update public.sales set total_cents = 1, original_total_cents = 1, discount_total_cents = 0 where id = '71000000-0000-4000-8000-000000000001'$$,
  'P0001', 'SALE_SNAPSHOT_IMMUTABLE', 'financial snapshot cannot be rewritten'
);
select throws_ok(
  $$select private.transition_sale_state('71000000-0000-4000-8000-000000000001', 'CONFIRMED', '10000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000004', null)$$,
  'P0001', 'INVALID_SALE_TRANSITION', 'draft cannot skip the payment-waiting state'
);
select lives_ok(
  $$select private.transition_sale_state('71000000-0000-4000-8000-000000000001', 'AWAITING_PAYMENT', '10000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000005', null)$$,
  'draft advances through the internal transition primitive'
);
select results_eq(
  $$select status::text from public.sales where id = '71000000-0000-4000-8000-000000000001'$$,
  array['AWAITING_PAYMENT'::text],
  'sale persists the payment-waiting state'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where sale_id = '71000000-0000-4000-8000-000000000001'$$,
  array[2::bigint],
  'valid transition appends history'
);
select lives_ok(
  $$select private.transition_sale_state('71000000-0000-4000-8000-000000000001', 'AWAITING_PAYMENT', '10000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000006', null)$$,
  'repeating the current state is a no-op'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where sale_id = '71000000-0000-4000-8000-000000000001'$$,
  array[2::bigint],
  'state no-op creates no duplicate history'
);
select lives_ok(
  $$select private.transition_sale_state('71000000-0000-4000-8000-000000000001', 'CONFIRMED', '10000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000007', null)$$,
  'payment-waiting sale can be confirmed internally'
);
select results_eq(
  $$select status::text from public.sales where id = '71000000-0000-4000-8000-000000000001'$$,
  array['CONFIRMED'::text],
  'confirmed status is persisted'
);
select throws_ok(
  $$select private.transition_sale_state('71000000-0000-4000-8000-000000000001', 'CANCELLED', '10000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000008', 'Sem reversão')$$,
  'P0001', 'INVALID_SALE_TRANSITION', 'confirmed cancellation stays closed until reversal workflows exist'
);
select results_eq(
  $$select count(*)::bigint from public.sale_status_history where sale_id = '71000000-0000-4000-8000-000000000001'$$,
  array[3::bigint],
  'seller sale keeps exactly its real state changes'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'sales.status.changed' and entity_id = '71000000-0000-4000-8000-000000000001'$$,
  array[2::bigint],
  'state changes are audited'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'sales.status.changed' and aggregate_id = '71000000-0000-4000-8000-000000000001'$$,
  array[2::bigint],
  'state changes emit outbox events'
);
select throws_ok(
  $$select private.assert_sale_totals('71000000-0000-4000-8000-000000000002')$$,
  'P0001', 'SALE_TOTAL_MISMATCH', 'aggregate mismatch fails closed'
);
select throws_ok(
  $$update public.sale_items set quantity = 9 where id = '73000000-0000-4000-8000-000000000001'$$,
  'P0001', 'IMMUTABLE_RECORD', 'sale item snapshots are immutable'
);
select throws_ok(
  $$update public.sale_status_history set reason = 'reescrito' where sale_id = '71000000-0000-4000-8000-000000000001'$$,
  'P0001', 'IMMUTABLE_RECORD', 'sale history is immutable'
);
select throws_ok(
  $$delete from public.sales where id = '71000000-0000-4000-8000-000000000001'$$,
  'P0001', 'SALE_HARD_DELETE_FORBIDDEN', 'sales cannot be hard deleted'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq($$select count(*)::bigint from public.sales$$, array[1::bigint], 'seller sees only their own sale');
select results_eq($$select count(*)::bigint from public.sale_items$$, array[1::bigint], 'seller sees only their own item snapshots');
select results_eq($$select count(*)::bigint from public.sale_status_history$$, array[3::bigint], 'seller sees only their own status history');
select throws_ok(
  $$update public.sales set status = 'CANCELLED' where id = '71000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'seller cannot mutate sale state directly'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.sales$$, array[1::bigint], 'consumer sees only their own purchase');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq($$select count(*)::bigint from public.sales$$, array[2::bigint], 'admin can read all sales');
reset role;

insert into public.user_roles (user_id, role_id)
values ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000005');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select results_eq($$select count(*)::bigint from public.sales$$, array[2::bigint], 'finance role can read all sales');
select throws_ok(
  $$insert into public.sales (channel, location_id, created_by, original_total_cents, total_cents, quoted_at, correlation_id) values ('PDV', '50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 1, 1, now(), gen_random_uuid())$$,
  '42501', null, 'authenticated roles cannot insert sales directly'
);
reset role;

select * from finish();
rollback;
