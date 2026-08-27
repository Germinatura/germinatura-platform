begin;
select plan(31);

select has_type('public', 'idempotency_status', 'idempotency status exists');
select has_table('public', 'idempotency_keys', 'idempotency table exists');
select has_function('private', 'hash_idempotency_request', array['jsonb'], 'canonical request hash helper exists');
select has_function('private', 'build_idempotency_scope', array['text', 'text', 'uuid'], 'server scope helper exists');
select has_function('private', 'claim_idempotency', array['text', 'text', 'jsonb'], 'claim helper exists');
select has_function(
  'private',
  'complete_idempotency',
  array['uuid', 'public.idempotency_status', 'jsonb', 'text', 'text', 'text'],
  'completion helper exists'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.idempotency_keys'::regclass),
  'RLS is enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename = 'idempotency_keys'$$,
  array[0::bigint],
  'no direct RLS policy exposes idempotency records'
);
select ok(
  not has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT,INSERT,UPDATE,DELETE'),
  'authenticated has no direct table privileges'
);
select ok(
  not has_table_privilege('anon', 'public.idempotency_keys', 'SELECT,INSERT,UPDATE,DELETE'),
  'anonymous has no direct table privileges'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.idempotency_keys',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ),
  'service role also has no direct table privileges'
);
select ok(
  not has_function_privilege('authenticated', 'private.claim_idempotency(text,text,jsonb)', 'EXECUTE'),
  'authenticated cannot execute the private claim helper'
);
select results_eq(
  $$select count(*)::bigint from pg_constraint where conrelid = 'public.idempotency_keys'::regclass and contype = 'u'$$,
  array[1::bigint],
  'scope and key have a unique constraint'
);

select is(
  encode(private.hash_idempotency_request('{"amount":1290,"order":"o-1"}'::jsonb), 'hex'),
  encode(private.hash_idempotency_request('{"order":"o-1","amount":1290}'::jsonb), 'hex'),
  'jsonb key order produces a canonical hash'
);
select isnt(
  encode(private.hash_idempotency_request('{"amount":1290}'::jsonb), 'hex'),
  encode(private.hash_idempotency_request('{"amount":1291}'::jsonb), 'hex'),
  'different payloads produce different hashes'
);
select is(
  private.build_idempotency_scope('inventory', 'reserve', '10000000-0000-4000-8000-000000000002'),
  'inventory.reserve:10000000-0000-4000-8000-000000000002',
  'scope includes server domain, operation and principal'
);
select throws_ok(
  $$select private.build_idempotency_scope('Inventory', 'reserve', '10000000-0000-4000-8000-000000000002')$$,
  '22023',
  'INVALID_IDEMPOTENCY_SCOPE',
  'invalid scope segments are rejected'
);

select results_eq(
  $$select is_new from private.claim_idempotency(
    'payments.create:10000000-0000-4000-8000-000000000002',
    'attempt-1',
    '{"amount_in_cents":1290,"order_id":"order-1"}'::jsonb
  )$$,
  array[true],
  'first claim owns the operation'
);
select results_eq(
  $$select status::text from public.idempotency_keys where key = 'attempt-1'$$,
  array['IN_PROGRESS'::text],
  'new claim is in progress'
);
select results_eq(
  $$select octet_length(request_hash) from public.idempotency_keys where key = 'attempt-1'$$,
  array[32],
  'request hash is stored as SHA-256 bytes'
);
select lives_ok(
  $$select private.complete_idempotency(
    (select id from public.idempotency_keys where key = 'attempt-1'),
    'SUCCEEDED',
    '{"payment_id":"payment-1"}'::jsonb,
    null,
    'payment',
    'payment-1'
  )$$,
  'operation can persist a sanitized successful result'
);
select results_eq(
  $$select is_new::text || ':' || operation_status::text || ':' || (stored_result->>'payment_id')
    from private.claim_idempotency(
      'payments.create:10000000-0000-4000-8000-000000000002',
      'attempt-1',
      '{"order_id":"order-1","amount_in_cents":1290}'::jsonb
    )$$,
  array['false:SUCCEEDED:payment-1'::text],
  'same scope, key and payload replays the stored result'
);
select throws_ok(
  $$select * from private.claim_idempotency(
    'payments.create:10000000-0000-4000-8000-000000000002',
    'attempt-1',
    '{"order_id":"order-1","amount_in_cents":1300}'::jsonb
  )$$,
  'P0001',
  'IDEMPOTENCY_CONFLICT',
  'same key with a different payload conflicts'
);

select lives_ok($$
  do $block$
  declare
    v_id uuid;
  begin
    select record_id into v_id from private.claim_idempotency(
      'inventory.reserve:10000000-0000-4000-8000-000000000002',
      'rejected-1',
      '{"product_id":"product-1","quantity":2}'::jsonb
    );
    perform private.complete_idempotency(
      v_id,
      'REJECTED',
      '{"code":"STOCK_CONFLICT"}'::jsonb,
      'STOCK_CONFLICT'
    );
  end;
  $block$;
$$, 'a rejected result can be stored');
select results_eq(
  $$select operation_status::text || ':' || stored_error_code
    from private.claim_idempotency(
      'inventory.reserve:10000000-0000-4000-8000-000000000002',
      'rejected-1',
      '{"quantity":2,"product_id":"product-1"}'::jsonb
    )$$,
  array['REJECTED:STOCK_CONFLICT'::text],
  'rejected operations replay without a second effect'
);

select lives_ok($$
  do $block$
  begin
    begin
      perform * from private.claim_idempotency(
        'inventory.adjust:10000000-0000-4000-8000-000000000001',
        'rolled-back-1',
        '{"quantity":1}'::jsonb
      );
      raise exception 'SIMULATED_BUSINESS_FAILURE';
    exception when others then
      null;
    end;
  end;
  $block$;
$$, 'a failed business subtransaction can roll back its claim');
select results_eq(
  $$select count(*)::bigint from public.idempotency_keys where key = 'rolled-back-1'$$,
  array[0::bigint],
  'rollback leaves no orphan idempotency record'
);

select throws_ok(
  $$select * from private.claim_idempotency(
    'payments.create:10000000-0000-4000-8000-000000000002',
    'contains whitespace',
    '{}'::jsonb
  )$$,
  '22023',
  'INVALID_IDEMPOTENCY_KEY',
  'invalid client keys are rejected'
);
select throws_ok(
  $$select * from private.claim_idempotency(
    'client-controlled-scope',
    'attempt-2',
    '{}'::jsonb
  )$$,
  '22023',
  'INVALID_IDEMPOTENCY_SCOPE',
  'scope must use the server-constructed domain operation and principal format'
);
select throws_ok(
  $$select * from private.claim_idempotency(
    'payments.create:10000000-0000-4000-8000-000000000002',
    'attempt-2',
    '[]'::jsonb
  )$$,
  '22023',
  'INVALID_IDEMPOTENCY_REQUEST',
  'request payload must be a JSON object'
);
select throws_ok(
  $$select private.complete_idempotency(
    (select id from public.idempotency_keys where key = 'attempt-1'),
    'SUCCEEDED',
    '"raw-result"'::jsonb
  )$$,
  '22023',
  'INVALID_IDEMPOTENCY_COMPLETION',
  'stored terminal result must be a sanitized JSON object'
);

select * from finish();
rollback;
