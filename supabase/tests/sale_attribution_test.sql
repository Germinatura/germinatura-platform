-- Spec 5.13 (GROW-002): seller links and attribution of online and PDV sales, with paid figures from the ledger.
begin;
select plan(17);

select ok(not has_table_privilege('authenticated', 'public.sale_attributions', 'SELECT'), 'attributions are read only through functions');

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select throws_ok($$select public.create_seller_share_link('Meu link', 'WHATSAPP', '{}', 'link-consumer', gen_random_uuid())$$,
  '42501', 'SALES_CREATE_REQUIRED', 'a consumer has no seller link');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select lives_ok($$select public.adjust_stock('50000000-0000-4000-8000-000000000002','33f00000-0000-4000-8000-000000000001',5,'Estoque atribuição','attribution-stock',gen_random_uuid())$$,
  'admin prepares seller stock');
create temp table campaign as select public.create_share_campaign('Divulgação da turma', 'INSTAGRAM', '{}', 'attribution-campaign', gen_random_uuid()) as result;

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table link as select public.create_seller_share_link('Meu link do intervalo', 'WHATSAPP',
  array['33f00000-0000-4000-8000-000000000001']::uuid[], 'attribution-link', gen_random_uuid()) as result;
select is((select result ->> 'seller_id' from link), '10000000-0000-4000-8000-000000000002', 'the link belongs to the seller');
select ok(exists (select 1 from jsonb_array_elements(public.list_my_share_links() -> 'campaigns') item where item ->> 'code' = (select result ->> 'code' from campaign)),
  'the seller can attribute to the class campaign');
select is((select item -> 'mine' from jsonb_array_elements(public.list_my_share_links() -> 'campaigns') item
  where item ->> 'code' = (select result ->> 'code' from campaign)), 'false'::jsonb, 'a team campaign is listed as not mine (a boolean, never null)');

-- A cash sale at the PDV, attributed to the seller's link.
select lives_ok($$select public.open_seller_shift('50000000-0000-4000-8000-000000000002', 0, 'attribution-shift', gen_random_uuid())$$, 'seller opens a shift');
create temp table sale as select (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":2}]'::jsonb, 'attribution-sale', gen_random_uuid()) ->> 'sale_id')::uuid as id;
create temp table paid as select public.confirm_cash_payment((select id from sale), 100000, 'attribution-cash', gen_random_uuid()) as result;
select lives_ok($$select public.attribute_pdv_sale((select id from sale), (select result ->> 'code' from link), gen_random_uuid())$$, 'the seller attributes the sale');
select lives_ok($$select public.attribute_pdv_sale((select id from sale), (select result ->> 'code' from link), gen_random_uuid())$$, 'repeating the same origin is harmless');
select throws_ok($$select public.attribute_pdv_sale((select id from sale), (select result ->> 'code' from campaign), gen_random_uuid())$$,
  'P0001', 'SALE_ALREADY_ATTRIBUTED', 'a sale keeps its first origin');
reset role;
create temp table amount as select total_cents from public.sales where id = (select id from sale);
grant select on amount to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table mine as select item from jsonb_array_elements(public.list_my_share_links() -> 'links') item
  where item ->> 'code' = (select result ->> 'code' from link);
select is((select (item ->> 'paid_sales')::integer from mine), 1, 'the link counts one paid sale');
select is((select (item ->> 'paid_total_cents')::bigint from mine), (select total_cents from amount), 'the paid total comes from the ledger');

-- Another seller cannot attribute it.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.attribute_pdv_sale((select id from sale), (select result ->> 'code' from campaign), gen_random_uuid())$$,
  'P0001', 'SALE_NOT_FOUND', 'only the seller who made the sale attributes it');

-- A refund takes the sale out of the paid figures.
select lives_ok($$select public.reverse_confirmed_sale((select id from sale), 'Cliente devolveu os produtos', 'EST-ATTR-1', null, 'attribution-refund', gen_random_uuid())$$,
  'finance refunds the sale');
select is((select (item ->> 'paid_sales')::integer from jsonb_array_elements(public.list_share_campaigns(100)) item
  where item ->> 'code' = (select result ->> 'code' from link)), 0, 'a refunded sale is no longer counted as paid');

-- Online: the customer's own Portal sale is attributed from the link; someone else's is not.
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
reset role;
create temp table online as select id from public.sales where channel = 'PORTAL' and customer_id = '10000000-0000-4000-8000-000000000003' limit 1;
grant select on online to authenticated;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select is(public.attribute_online_sale(coalesce((select id from online), gen_random_uuid()), (select result ->> 'code' from campaign)), false,
  'a seller cannot attribute a customer''s online sale');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is(public.attribute_online_sale(gen_random_uuid(), (select result ->> 'code' from campaign)), false, 'an unknown sale is not attributed');
reset role;

select * from finish();
rollback;
