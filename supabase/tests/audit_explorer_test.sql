-- Spec 5.16 (AUD-001): administrators search the audit trail and follow one correlation across sale, payment,
-- stock and finance, without editing anything.
begin;
select plan(16);

select ok(exists (select 1 from public.role_permissions rp join public.roles role on role.id = rp.role_id
  join public.permissions permission on permission.id = rp.permission_id where role.key = 'ADMIN' and permission.key = 'audit.read'),
  'administrators hold audit.read');
select ok(not exists (select 1 from public.role_permissions rp join public.roles role on role.id = rp.role_id
  join public.permissions permission on permission.id = rp.permission_id where role.key = 'FINANCEIRO' and permission.key = 'audit.read'),
  'finance does not read the audit trail');
select is(private.audit_severity('sales.confirmed.reversed'), 'HIGH', 'reversals are high severity');
select is(private.audit_severity('settings.fundraising_goal.updated'), 'MEDIUM', 'settings changes are medium severity');
select is(private.audit_severity('catalog.product.created'), 'LOW', 'routine catalog work is low severity');

insert into public.inventory_balances(location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001')
on conflict (location_id, product_id) do nothing;
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 2, 'Estoque para auditoria', 'audit-stock', gen_random_uuid());
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
create temp table audit_sale as select (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'audit-checkout', '7a000000-0000-4000-8000-000000000001') ->> 'sale_id')::uuid sale_id;
grant select on audit_sale to authenticated;
select public.confirm_manual_payment((select sale_id from audit_sale), 'PIX_AREA', 'PIX-AUDIT-01', null, null, 'audit-pay', '7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.search_audit_logs(current_date, current_date)$$, '42501', 'AUDIT_READ_REQUIRED', 'sellers do not read the audit trail');
select throws_ok($$select public.get_audit_correlation('7a000000-0000-4000-8000-000000000001')$$, '42501', 'AUDIT_READ_REQUIRED', 'nor follow correlations');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select throws_ok($$select public.search_audit_logs(current_date, current_date - 1)$$, '22023', 'INVALID_AUDIT_FILTER', 'the period must be valid');
create temp table by_correlation as select public.search_audit_logs(current_date - 1, current_date + 1, null, null, null, null,
  '7a000000-0000-4000-8000-000000000001', null, null, null, 50) result;
grant select on by_correlation to authenticated;
select ok(jsonb_array_length((select result -> 'rows' from by_correlation)) >= 2, 'the sale and its payment are found by correlation');
select ok(not exists (select 1 from jsonb_array_elements((select result -> 'rows' from by_correlation)) row
  where row ->> 'correlation_id' <> '7a000000-0000-4000-8000-000000000001'), 'only that correlation is returned');
create temp table first_page as select public.search_audit_logs(current_date - 1, current_date + 1, null, null, null, null,
  '7a000000-0000-4000-8000-000000000001', null, null, null, 1) result;
grant select on first_page to authenticated;
select isnt((select result -> 'next_cursor' from first_page), 'null'::jsonb, 'a page that is not the last one offers a cursor');
select isnt((public.search_audit_logs(current_date - 1, current_date + 1, null, null, null, null, '7a000000-0000-4000-8000-000000000001', null,
    (select (result #>> '{next_cursor,created_at}')::timestamptz from first_page), (select (result #>> '{next_cursor,id}')::uuid from first_page), 1) -> 'rows' -> 0 ->> 'id'),
  (select result -> 'rows' -> 0 ->> 'id' from first_page), 'the next page continues after the cursor');
select ok(jsonb_array_length(public.search_audit_logs(current_date - 1, current_date + 1, 'vendedor', null, null, null, null, null, null, null, 50) -> 'rows') >= 1,
  'entries are found by the user who acted');

create temp table correlation as select public.get_audit_correlation('7a000000-0000-4000-8000-000000000001') result;
grant select on correlation to authenticated;
select is((select result -> 'sales' -> 0 ->> 'id' from correlation), (select sale_id::text from audit_sale), 'the correlation shows the sale');
select is((select result -> 'payments' -> 0 ->> 'status' from correlation), 'APPROVED', 'the correlation shows the payment');
select ok(exists (select 1 from jsonb_array_elements((select result -> 'stock_movements' from correlation)) movement
  where movement ->> 'movement_type' = 'VENDA'), 'the correlation shows the stock leaving');
reset role;

select * from finish();
rollback;
