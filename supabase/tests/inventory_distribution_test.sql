begin;
select plan(13);

select has_function(
  'public', 'distribute_stock',
  array['uuid', 'uuid', 'uuid', 'bigint', 'text', 'text', 'uuid'],
  'central distribution RPC exists'
);
select function_privs_are(
  'public', 'distribute_stock',
  array['uuid', 'uuid', 'uuid', 'bigint', 'text', 'text', 'uuid'],
  'authenticated', array['EXECUTE'],
  'authenticated users can invoke the permission-protected RPC'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$select public.adjust_stock(
    '50000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000001',
    6, 'Preparar distribuição', 'distribution-adjust',
    '61000000-0000-4000-8000-000000000001'
  )$$,
  'admin prepares central stock through the ledger'
);

create temp table distribution_result as
select public.distribute_stock(
  '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  '33000000-0000-4000-8000-000000000001',
  2, 'Separação para venda externa', 'distribution-success',
  '61000000-0000-4000-8000-000000000002'
) as result;

select results_eq(
  $$select array_agg(on_hand_quantity order by location_id) from public.inventory_balances where product_id = '33000000-0000-4000-8000-000000000001'$$,
  $$values (array[4::bigint, 2::bigint])$$,
  'distribution debits central and credits seller atomically'
);
select results_eq(
  $$select movement_type::text from public.stock_movements where id = (select (result ->> 'movement_id')::uuid from distribution_result)$$,
  array['TRANSFERENCIA'::text],
  'distribution records the immutable transfer movement'
);
select results_eq(
  $$select (result ->> 'correlation_id')::uuid from distribution_result$$,
  array['61000000-0000-4000-8000-000000000002'::uuid],
  'distribution returns the persisted correlation id'
);
select results_eq(
  $$select public.distribute_stock(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    '33000000-0000-4000-8000-000000000001',
    2, 'Separação para venda externa', 'distribution-success',
    '61000000-0000-4000-8000-000000000099'
  )$$,
  $$select result from distribution_result$$,
  'distribution replay returns the original persisted response'
);
select results_eq(
  $$select count(*)::bigint from public.stock_movements where movement_type = 'TRANSFERENCIA'$$,
  array[1::bigint],
  'distribution replay does not duplicate the movement'
);
select throws_ok(
  $$select public.distribute_stock(
    '50000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000001',
    1, 'Direção inválida', 'distribution-wrong-direction',
    '61000000-0000-4000-8000-000000000003'
  )$$,
  '22023', 'DISTRIBUTION_SOURCE_MUST_BE_CENTRAL',
  'seller stock cannot be distributed directly back to central'
);
select throws_ok(
  $$select public.distribute_stock(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '33000000-0000-4000-8000-000000000001',
    1, 'Destino inválido', 'distribution-invalid-destination',
    '61000000-0000-4000-8000-000000000004'
  )$$,
  '22023', 'DISTRIBUTION_DESTINATION_MUST_BE_SELLER',
  'central stock cannot be distributed to the central location'
);
select throws_ok(
  $$select public.distribute_stock(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    '33000000-0000-4000-8000-000000000001',
    99, 'Acima do disponível', 'distribution-conflict',
    '61000000-0000-4000-8000-000000000005'
  )$$,
  'P0001', 'STOCK_CONFLICT',
  'distribution above the current available balance is rejected'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select public.distribute_stock(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    '33000000-0000-4000-8000-000000000001',
    1, 'Sem permissão', 'distribution-seller',
    '61000000-0000-4000-8000-000000000006'
  )$$,
  '42501', 'INVENTORY_MANAGE_REQUIRED',
  'seller cannot distribute stock'
);
reset role;

select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key in ('distribution-wrong-direction', 'distribution-invalid-destination', 'distribution-conflict', 'distribution-seller')$$,
  array[0::bigint],
  'rejected distributions do not leave idempotency records'
);

select * from finish();
rollback;
