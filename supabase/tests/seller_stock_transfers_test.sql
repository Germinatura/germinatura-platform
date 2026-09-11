begin;
select plan(26);

select has_table('public', 'seller_stock_transfer_requests', 'seller transfer requests are persisted');
select has_function('public', 'request_seller_stock_transfer', array['uuid', 'uuid', 'bigint', 'text', 'text', 'uuid'], 'request RPC exists');
select has_function('public', 'resolve_seller_stock_transfer', array['uuid', 'text', 'text', 'text', 'uuid'], 'resolution RPC exists');
select function_privs_are(
  'private', 'execute_seller_stock_transfer', array['uuid', 'uuid', 'uuid', 'bigint', 'uuid', 'text', 'uuid'],
  'authenticated', array[]::text[], 'internal transfer function is not directly executable'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.adjust_stock(
    '50000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000001',
    5, 'Preparar transferência entre vendedores', 'seller-transfer-adjust',
    '62000000-0000-4000-8000-000000000001'
  )$$,
  'admin prepares the source seller stock through the ledger'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000004';
create temp table requested_transfer as
select public.request_seller_stock_transfer(
  '50000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000001',
  2, 'Reposição para atendimento externo', 'seller-transfer-request-1',
  '62000000-0000-4000-8000-000000000002'
) as result;

reset role;
select results_eq(
  $$select status::text from public.seller_stock_transfer_requests where id = (select (result ->> 'request_id')::uuid from requested_transfer)$$,
  array['REQUESTED'::text], 'request is persisted as pending'
);
select results_eq(
  $$select array_agg(on_hand_quantity order by location_id) from public.inventory_balances where location_id in ('50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003') and product_id = '33000000-0000-4000-8000-000000000001'$$,
  $$values (array[5::bigint])$$, 'requesting does not move stock'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000004';
select results_eq(
  $$select public.request_seller_stock_transfer(
    '50000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000001',
    2, 'Reposição para atendimento externo', 'seller-transfer-request-1',
    '62000000-0000-4000-8000-000000000099'
  )$$,
  $$select result from requested_transfer$$, 'request replay returns the original result'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.seller_stock_transfer_requests$$,
  array[1::bigint], 'request replay does not duplicate work'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000004';
select throws_ok(
  $$select public.resolve_seller_stock_transfer(
    (select (result ->> 'request_id')::uuid from requested_transfer), null, 'Ação inválida',
    'seller-transfer-null-action', '62000000-0000-4000-8000-000000000097'
  )$$,
  '22023', 'INVALID_TRANSFER_ACTION', 'null cannot bypass the action allowlist'
);
select throws_ok(
  $$select public.resolve_seller_stock_transfer(
    (select (result ->> 'request_id')::uuid from requested_transfer), 'ACCEPT', 'Aceite indevido',
    'seller-transfer-forbidden', '62000000-0000-4000-8000-000000000003'
  )$$,
  '42501', 'TRANSFER_REQUEST_FORBIDDEN', 'destination seller cannot accept its own request'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table accepted_transfer as
select public.resolve_seller_stock_transfer(
  (select (result ->> 'request_id')::uuid from requested_transfer), 'ACCEPT', 'Saldo conferido e separado',
  'seller-transfer-accept-1', '62000000-0000-4000-8000-000000000004'
) as result;

reset role;
select results_eq(
  $$select status::text from public.seller_stock_transfer_requests where id = (select (result ->> 'request_id')::uuid from requested_transfer)$$,
  array['ACCEPTED'::text], 'source seller accepts the request'
);
select results_eq(
  $$select array_agg(on_hand_quantity order by location_id) from public.inventory_balances where location_id in ('50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003') and product_id = '33000000-0000-4000-8000-000000000001'$$,
  $$values (array[3::bigint, 2::bigint])$$, 'acceptance debits source and credits destination atomically'
);
select results_eq(
  $$select movement_type::text from public.stock_movements where id = (select (result ->> 'movement_id')::uuid from accepted_transfer)$$,
  array['TRANSFERENCIA'::text], 'acceptance creates one immutable transfer movement'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select public.resolve_seller_stock_transfer(
    (select (result ->> 'request_id')::uuid from requested_transfer), 'ACCEPT', 'Saldo conferido e separado',
    'seller-transfer-accept-1', '62000000-0000-4000-8000-000000000099'
  )$$,
  $$select result from accepted_transfer$$, 'acceptance replay returns the original result'
);
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000004';
select results_eq(
  $$select public.request_seller_stock_transfer(
    '50000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000001',
    2, 'Reposição para atendimento externo', 'seller-transfer-request-1',
    '62000000-0000-4000-8000-000000000098'
  )$$,
  $$select result from requested_transfer$$, 'request replay survives the later stock movement'
);
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select results_eq(
  $$select count(*)::bigint from public.stock_movements where movement_type = 'TRANSFERENCIA'$$,
  array[1::bigint], 'acceptance replay does not duplicate the movement'
);
select throws_ok(
  $$select public.resolve_seller_stock_transfer(
    (select (result ->> 'request_id')::uuid from requested_transfer), 'REJECT', 'Decisão duplicada',
    'seller-transfer-resolve-again', '62000000-0000-4000-8000-000000000005'
  )$$,
  'P0001', 'TRANSFER_REQUEST_ALREADY_RESOLVED', 'resolved request cannot change state'
);
reset role;
select results_eq(
  $$select count(*)::bigint from public.audit_logs where entity_type = 'seller_stock_transfer_request'$$,
  array[2::bigint], 'request and acceptance are audited'
);
select results_eq(
  $$select count(*)::bigint from public.outbox_events where aggregate_type = 'seller_stock_transfer_request'$$,
  array[2::bigint], 'request and acceptance publish outbox events'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000004';
create temp table cancelled_transfer as
select public.request_seller_stock_transfer(
  '50000000-0000-4000-8000-000000000002', '33000000-0000-4000-8000-000000000001',
  1, 'Solicitação para cancelar', 'seller-transfer-request-cancel',
  '62000000-0000-4000-8000-000000000006'
) as result;
select lives_ok(
  $$select public.resolve_seller_stock_transfer(
    (select (result ->> 'request_id')::uuid from cancelled_transfer), 'CANCEL', 'Demanda deixou de existir',
    'seller-transfer-cancel', '62000000-0000-4000-8000-000000000007'
  )$$,
  'requester can cancel a pending request'
);
select results_eq(
  $$select status::text from public.seller_stock_transfer_requests where id = (select (result ->> 'request_id')::uuid from cancelled_transfer)$$,
  array['CANCELLED'::text], 'cancellation persists without a movement'
);
select results_eq(
  $$select jsonb_array_length(public.get_my_seller_stock_transfers(null, 1) -> 'requests')$$,
  array[1], 'seller transfer history applies the requested page size'
);
select ok(
  (public.get_my_seller_stock_transfers(null, 1) ->> 'next_cursor') is not null,
  'seller transfer history returns a cursor when more requests exist'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok(
  $$select public.get_my_seller_stock_transfers()$$,
  '42501', 'SELLER_TRANSFER_REQUIRED', 'consumer cannot list seller transfers'
);

reset role;
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key in ('seller-transfer-forbidden', 'seller-transfer-resolve-again')$$,
  array[0::bigint], 'failed decisions do not leave idempotency claims'
);

select * from finish();
rollback;
