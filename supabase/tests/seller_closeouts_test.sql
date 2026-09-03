begin;
select plan(37);

select has_table('public', 'seller_closeouts', 'seller closeouts table exists');
select has_table('public', 'seller_closeout_payment_summaries', 'payment summaries table exists');
select has_table('public', 'seller_closeout_stock_counts', 'stock counts table exists');
select has_type('public', 'seller_closeout_status', 'closeout status type exists');
select has_function(
  'public', 'create_seller_closeout',
  array['timestamptz', 'timestamptz', 'jsonb', 'text', 'text', 'uuid'],
  'create closeout RPC exists'
);
select has_function(
  'public', 'reopen_seller_closeout',
  array['uuid', 'text', 'text', 'uuid'],
  'reopen closeout RPC exists'
);
select has_function(
  'public', 'list_managed_seller_closeouts', array['integer'],
  'managed closeout list RPC exists'
);
select ok((select relrowsecurity from pg_class where oid = 'public.seller_closeouts'::regclass), 'closeouts have RLS');
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename like 'seller_closeout%' and cmd in ('INSERT','UPDATE','DELETE')$$,
  array[0::bigint], 'closeout tables expose no direct write policies'
);
select ok(
  not has_function_privilege('anon', 'public.create_seller_closeout(timestamptz,timestamptz,jsonb,text,text,uuid)', 'EXECUTE'),
  'anonymous closeout is not executable'
);

insert into public.inventory_balances (location_id, product_id) values
  ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 5, 'Estoque para fechamento', 'closeout-stock-1', '83000000-0000-4000-8000-000000000001')$$,
  'admin prepares seller stock'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table closeout_checkout as
select public.checkout_sale(
  'PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
  'closeout-checkout-1', '83000000-0000-4000-8000-000000000002'
) as result;
create temp table closeout_confirmation as
select public.confirm_manual_payment(
  (select (result ->> 'sale_id')::uuid from closeout_checkout),
  'PIX_AREA', 'PIX-CLOSEOUT-0001', 'closeout-confirm-1',
  '83000000-0000-4000-8000-000000000003'
) as result;
select results_eq(
  $$select result -> 'payment_attempt' ->> 'status' from closeout_confirmation$$,
  array['APPROVED'::text], 'sale is paid before closeout'
);

create temp table closeout_period as
select clock_timestamp() - interval '1 hour' as starts_at, clock_timestamp() as ends_at;
create temp table first_closeout as
select public.create_seller_closeout(
  (select starts_at from closeout_period), (select ends_at from closeout_period),
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","counted_quantity":4}]'::jsonb,
  null, 'closeout-create-1', '83000000-0000-4000-8000-000000000004'
) as result;

select results_eq(
  $$select result ->> 'status', result ->> 'confirmed_sales_total_cents', result ->> 'payment_total_cents', result ->> 'stock_difference_units' from first_closeout$$,
  $$values ('CLOSED'::text, '2590'::text, '2590'::text, '0'::text)$$,
  'balanced closeout freezes sales, payments and stock'
);
select results_eq(
  $$select payment_count, total_cents from public.seller_closeout_payment_summaries where closeout_id = (select (result ->> 'closeout_id')::uuid from first_closeout)$$,
  $$values (1::bigint, 2590::bigint)$$,
  'payment summary groups the approved Pix payment'
);
select results_eq(
  $$select expected_quantity, counted_quantity, difference_quantity from public.seller_closeout_stock_counts where closeout_id = (select (result ->> 'closeout_id')::uuid from first_closeout)$$,
  $$values (4::bigint, 4::bigint, 0::bigint)$$,
  'stock count preserves expected and observed quantities'
);
select results_eq(
  $$select public.create_seller_closeout((select starts_at from closeout_period), (select ends_at from closeout_period), '[{"product_id":"33f00000-0000-4000-8000-000000000001","counted_quantity":4}]'::jsonb, null, 'closeout-create-1', '83000000-0000-4000-8000-000000000099')$$,
  $$select result from first_closeout$$,
  'same key replays the closeout'
);
select results_eq(
  $$select count(*)::bigint from public.seller_closeouts$$,
  array[1::bigint], 'replay creates no duplicate closeout'
);
select throws_ok(
  $$select public.create_seller_closeout((select starts_at from closeout_period), (select ends_at from closeout_period), '[{"product_id":"33f00000-0000-4000-8000-000000000001","counted_quantity":3}]'::jsonb, 'Contagem divergente', 'closeout-create-1', '83000000-0000-4000-8000-000000000005')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'same key with another count conflicts'
);
select throws_ok(
  $$select public.create_seller_closeout((select starts_at from closeout_period), (select ends_at from closeout_period), '[{"product_id":"33f00000-0000-4000-8000-000000000001","counted_quantity":4}]'::jsonb, null, 'closeout-overlap-1', '83000000-0000-4000-8000-000000000006')$$,
  'P0001', 'CLOSEOUT_PERIOD_OVERLAP', 'closed periods cannot overlap'
);
select throws_ok(
  $$select public.reopen_seller_closeout((select (result ->> 'closeout_id')::uuid from first_closeout), 'Tentativa do vendedor', 'closeout-reopen-seller-1', '83000000-0000-4000-8000-000000000007')$$,
  '42501', 'CLOSEOUT_MANAGE_REQUIRED', 'seller cannot reopen a closeout'
);
select throws_ok(
  $$select public.list_managed_seller_closeouts(100)$$,
  '42501', 'CLOSEOUT_MANAGE_REQUIRED', 'seller cannot list managed closeouts'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.create_seller_closeout(clock_timestamp() - interval '1 hour', clock_timestamp(), '[]'::jsonb, null, 'closeout-consumer-1', '83000000-0000-4000-8000-000000000008')$$,
  '42501', 'SELLER_CLOSEOUT_REQUIRED', 'consumer cannot create a closeout'
);
select results_eq($$select count(*)::bigint from public.seller_closeouts$$, array[0::bigint], 'consumer cannot read closeouts');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select results_eq(
  $$select item ->> 'seller_name', item ->> 'location_name' from jsonb_array_elements(public.list_managed_seller_closeouts(100)) item$$,
  $$values ('Vendedor Local'::text, 'Estoque do vendedor local'::text)$$,
  'manager list resolves seller and location labels without weakening table RLS'
);
create temp table reopened_closeout as
select public.reopen_seller_closeout(
  (select (result ->> 'closeout_id')::uuid from first_closeout),
  'Recontagem autorizada', 'closeout-reopen-admin-1', '83000000-0000-4000-8000-000000000009'
) as result;
select results_eq(
  $$select result ->> 'status', result ->> 'reopen_reason' from reopened_closeout$$,
  $$values ('REOPENED'::text, 'Recontagem autorizada'::text)$$,
  'admin reopens with an audited reason'
);
select results_eq(
  $$select public.reopen_seller_closeout((select (result ->> 'closeout_id')::uuid from first_closeout), 'Recontagem autorizada', 'closeout-reopen-admin-1', '83000000-0000-4000-8000-000000000099')$$,
  $$select result from reopened_closeout$$,
  'reopen replay returns the stored result'
);
select throws_ok(
  $$select public.reopen_seller_closeout((select (result ->> 'closeout_id')::uuid from first_closeout), 'Segunda reabertura', 'closeout-reopen-admin-2', '83000000-0000-4000-8000-000000000010')$$,
  'P0001', 'CLOSEOUT_NOT_REOPENABLE', 'a closeout cannot be reopened twice'
);
select results_eq($$select count(*)::bigint from public.seller_closeouts$$, array[1::bigint], 'admin can read all closeouts');
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.create_seller_closeout((select starts_at from closeout_period), (select ends_at from closeout_period), '[{"product_id":"33f00000-0000-4000-8000-000000000001","counted_quantity":3}]'::jsonb, null, 'closeout-divergent-no-reason', '83000000-0000-4000-8000-000000000011')$$,
  'P0001', 'CLOSEOUT_JUSTIFICATION_REQUIRED', 'stock divergence requires justification'
);
create temp table divergent_closeout as
select public.create_seller_closeout(
  (select starts_at from closeout_period), (select ends_at from closeout_period),
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","counted_quantity":3}]'::jsonb,
  'Uma unidade não localizada', 'closeout-divergent-1', '83000000-0000-4000-8000-000000000012'
) as result;
select results_eq(
  $$select result ->> 'stock_difference_units', result ->> 'justification' from divergent_closeout$$,
  $$values ('1'::text, 'Uma unidade não localizada'::text)$$,
  'justified divergence creates a new immutable closeout'
);
select results_eq($$select count(*)::bigint from public.seller_closeouts$$, array[2::bigint], 'seller reads their own closeout history');
reset role;

select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'closeouts.created'$$,
  array[2::bigint], 'new closeouts are audited once'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where topic = 'closeouts.created'$$,
  array[2::bigint], 'new closeouts emit outbox events'
);
select results_eq(
  $$select count(*)::bigint from public.audit_logs where action = 'closeouts.reopened'$$,
  array[1::bigint], 'reopening is audited once'
);
select throws_ok(
  $$update public.seller_closeouts set confirmed_sales_total_cents = 1 where true$$,
  'P0001', 'CLOSEOUT_IMMUTABLE', 'closeout snapshots cannot be edited'
);
select throws_ok(
  $$delete from public.seller_closeout_stock_counts where true$$,
  'P0001', 'IMMUTABLE_RECORD', 'stock count snapshots cannot be deleted'
);
select throws_ok(
  $$delete from public.seller_closeouts where true$$,
  'P0001', 'CLOSEOUT_HARD_DELETE_FORBIDDEN', 'closeouts cannot be deleted'
);

select * from finish();
rollback;
