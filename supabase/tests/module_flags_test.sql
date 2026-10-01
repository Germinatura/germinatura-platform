-- Module flags: off refuses new operations of the module, never what closes work already started.
begin;
select plan(13);

select is((select array_agg(key order by key) from public.feature_flags where key in ('procurement', 'events') and enabled),
  array['events', 'procurement'], 'the new module flags start on, keeping current behaviour');

create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
end;
$$;
create function pg_temp.flag(p_key text, p_enabled boolean) returns void language plpgsql as $$
begin
  perform pg_temp.as_user('10000000-0000-4000-8000-000000000001');
  perform public.update_feature_flag(p_key, p_enabled, 'Teste de módulo', gen_random_uuid());
  reset role;
end;
$$;

-- Cash shifts follow cash_payment: no new shift, but an open one can be closed.
select pg_temp.as_user('10000000-0000-4000-8000-000000000002');
create temp table open_shift as select public.open_seller_shift('50000000-0000-4000-8000-000000000002', 1000, 'module-shift-open', gen_random_uuid()) as result;
reset role;
grant select on open_shift to authenticated;
select pg_temp.flag('cash_payment', false);
select pg_temp.as_user('10000000-0000-4000-8000-000000000002');
select lives_ok($$select public.close_seller_shift((select (result ->> 'shift_id')::uuid from open_shift), 1000, null, 'module-shift-close', gen_random_uuid())$$,
  'an open shift is closed with cash switched off');
select throws_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002', 0, 'module-shift-reopen', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'no new shift without physical cash');
reset role;
select pg_temp.flag('cash_payment', true);
select pg_temp.as_user('10000000-0000-4000-8000-000000000002');
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002', 0, 'module-shift-again', gen_random_uuid())$$,
  'turning cash back on allows shifts again');
reset role;

-- Procurement: no new supplier, order or edit; an open order can still be cancelled.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
create temp table supplier as select public.save_supplier(null, null, 'Fornecedor do módulo', 'Equipe', null, null, null, null, true, 'Preparar compra', 'module-supplier', gen_random_uuid()) as result;
create temp table purchase as select public.create_purchase_order((select (result ->> 'id')::uuid from supplier),
  (now() at time zone 'America/Sao_Paulo')::date, null, 0, 0, 'PIX', null, null,
  '[{"productId":"33000000-0000-4000-8000-000000000001","quantity":2,"unitCostCents":500}]'::jsonb, 'Repor doces', 'module-order', gen_random_uuid()) as result;
reset role;
grant select on supplier, purchase to authenticated;
select pg_temp.flag('procurement', false);
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
select throws_ok($$select public.save_supplier(null, null, 'Outro fornecedor', 'Equipe', null, null, null, null, true, 'Tentar cadastrar', 'module-supplier-off', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'no new supplier with procurement off');
select throws_ok($$select public.save_supplier((select (result ->> 'id')::uuid from supplier), 1, 'Fornecedor renomeado', 'Equipe', null, null, null, null, true, 'Tentar editar', 'module-supplier-edit', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'no supplier edit with procurement off');
select throws_ok($$select public.create_purchase_order((select (result ->> 'id')::uuid from supplier),
  (now() at time zone 'America/Sao_Paulo')::date, null, 0, 0, 'PIX', null, null,
  '[{"productId":"33000000-0000-4000-8000-000000000001","quantity":1,"unitCostCents":500}]'::jsonb, 'Outra compra', 'module-order-off', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'no new purchase order with procurement off');
select lives_ok($$select public.cancel_purchase_order((select (result ->> 'id')::uuid from purchase), 'Módulo desligado', 'module-order-cancel', gen_random_uuid())$$,
  'an open order can still be cancelled');
reset role;
select pg_temp.flag('procurement', true);

-- Events: no new or published event; a published one can still be cancelled.
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
create temp table party as select public.save_portal_event(null, null, 'EVENTO', 'Festa do módulo', 'Noite de festa.', now() + interval '3 days',
  null, null, null, null, null, '{}', '{}', '{}', 'module-event', gen_random_uuid()) as result;
create temp table draft as select public.save_portal_event(null, null, 'EVENTO', 'Rascunho do módulo', 'Ainda sem data certa.', now() + interval '5 days',
  null, null, null, null, null, '{}', '{}', '{}', 'module-draft', gen_random_uuid()) as result;
select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'PUBLICAR', null, 'module-event-publish', gen_random_uuid());
reset role;
grant select on party, draft to authenticated;
select pg_temp.flag('events', false);
select pg_temp.as_user('10000000-0000-4000-8000-000000000001');
select throws_ok($$select public.save_portal_event(null, null, 'EVENTO', 'Outra festa', 'Mais uma noite.', now() + interval '4 days',
  null, null, null, null, null, '{}', '{}', '{}', 'module-event-off', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'no new event with events off');
select throws_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from draft), 'PUBLICAR', null, 'module-draft-publish', gen_random_uuid())$$,
  'P0001', 'FEATURE_DISABLED', 'no publication with events off');
select lives_ok($$select public.transition_portal_event((select (result ->> 'id')::uuid from party), 'CANCELAR', 'Módulo desligado pela comissão', 'module-event-cancel', gen_random_uuid())$$,
  'a published event can still be cancelled');
reset role;
select is((select status::text from public.portal_events where id = (select (result ->> 'id')::uuid from party)), 'CANCELADO', 'the cancellation is recorded');

-- Flags never replace permissions: a consumer still cannot create suppliers with the module on.
select pg_temp.flag('events', true);
select pg_temp.as_user('10000000-0000-4000-8000-000000000003');
select throws_ok($$select public.save_supplier(null, null, 'Fornecedor indevido', 'Equipe', null, null, null, null, true, 'Sem permissão', 'module-supplier-consumer', gen_random_uuid())$$,
  '42501', null, 'permissions still apply with the module on');
reset role;

select * from finish();
rollback;
