-- NOTIF-005 revised: a new product is announced once, when it is active, published and available in the catalog
-- (central stock) for the first time; later restocks follow only the "avise-me" rule.
begin;
select plan(13);

insert into public.products (id, category_id, sku, slug, name, active, published, sellable_pdv, reservable, tracks_lots) values
  ('3a000000-0000-4000-8000-000000000001', '23f00000-0000-4000-8000-000000000001', 'NEWPROD-STOCKED', 'newprod-stocked', 'Pão de mel', true, false, true, true, false),
  ('3a000000-0000-4000-8000-000000000002', '23f00000-0000-4000-8000-000000000001', 'NEWPROD-EMPTY', 'newprod-empty', 'Brigadeiro gourmet', true, true, true, true, false),
  ('3a000000-0000-4000-8000-000000000003', '23f00000-0000-4000-8000-000000000001', 'NEWPROD-HIDDEN', 'newprod-hidden', 'Bolo de pote', true, false, true, true, false),
  ('3a000000-0000-4000-8000-000000000004', '23f00000-0000-4000-8000-000000000001', 'NEWPROD-SELLER', 'newprod-seller', 'Cookie', true, false, true, true, false);

create function pg_temp.announcements(p_product uuid) returns integer language sql as $$
  select count(*)::integer from public.outbox_events where topic = 'catalog.product.published' and aggregate_id = p_product::text;
$$;
create function pg_temp.adjust(p_location uuid, p_product uuid, p_delta bigint, p_key text) returns void language plpgsql as $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
  perform public.adjust_stock(p_location, p_product, p_delta, 'Teste de novidade', p_key, gen_random_uuid());
  reset role;
end;
$$;

select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000002'), 0, 'publishing with zero stock does not use the announcement');

-- Stock first, then publication: announced at publication.
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 5, 'newprod-stocked-in');
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000001'), 0, 'stock of an unpublished product is not announced');
update public.products set active = true, published = true where id = '3a000000-0000-4000-8000-000000000001';
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000001'), 1, 'publishing a product with stock announces it');

-- Published at zero, then the first entry announces it once; a second entry does not.
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000002', 3, 'newprod-empty-in-1');
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000002'), 1, 'the first availability announces the new product');
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000002', 2, 'newprod-empty-in-2');
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000002'), 1, 'a second entry does not announce it again');

-- Already announced, sold out and back: only the avise-me rule fires.
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000002', -5, 'newprod-empty-out');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select lives_ok($$select public.set_stock_alert('3a000000-0000-4000-8000-000000000002', true)$$, 'the consumer asks to hear when it returns');
reset role;
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000002', 4, 'newprod-empty-back');
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000002'), 1, 'a restock after the announcement is not a new product');
select is((select count(*)::integer from public.outbox_events where topic = 'catalog.product.back_in_stock'
  and aggregate_id = '3a000000-0000-4000-8000-000000000002'), 1, 'the restock wakes the avise-me alerts');

-- Inactive or unpublished products are never announced, whatever the stock.
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000003', 4, 'newprod-hidden-in');
update public.products set active = false where id = '3a000000-0000-4000-8000-000000000003';
update public.products set published = true where id = '3a000000-0000-4000-8000-000000000003';
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000003'), 0, 'an inactive product is not announced');

-- Stock distributed to a seller is not catalog availability.
select pg_temp.adjust('50000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000004', 2, 'newprod-seller-in');
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.distribute_stock('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002',
  '3a000000-0000-4000-8000-000000000004', 2, 'Separação para venda externa', 'newprod-seller-distribute', gen_random_uuid());
reset role;
update public.products set published = true where id = '3a000000-0000-4000-8000-000000000004';
select is(pg_temp.announcements('3a000000-0000-4000-8000-000000000004'), 0, 'seller stock alone does not announce the product');

-- Delivery respects the NOVOS_PRODUTOS preference.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select lives_ok($$select public.set_notification_preference('NOVOS_PRODUTOS', false)$$, 'the consumer silences new products');
reset role;
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table claimed as select * from public.worker_claim_outbox_events('worker-new-products', 100, 300);
select public.worker_process_outbox_event(id, 'worker-new-products') from claimed;
reset role;
select ok(not exists (select 1 from public.notifications where kind = 'NEW_PRODUCT' and recipient_id = '10000000-0000-4000-8000-000000000003'
  and data->>'product_id' = '3a000000-0000-4000-8000-000000000002'), 'a silenced consumer does not hear about it');
select is((select count(*)::integer from public.notifications where kind = 'NEW_PRODUCT' and recipient_id = '10000000-0000-4000-8000-000000000002'
  and data->>'product_id' = '3a000000-0000-4000-8000-000000000002'), 1, 'others hear about it exactly once');

select * from finish();
rollback;
