-- PR D: acréscimo por meio de pagamento. Configuração por turma (versões imutáveis), cálculo no servidor em centavos,
-- snapshot na venda, remoção autorizada e auditada, estorno, fechamento, indicadores e tarifa PicPay independente.
begin;
select plan(61);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.sys() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create temp table ids (name text primary key, id uuid);
create temp table results (name text primary key, result jsonb);
grant all on ids, results to anon, authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.r(p_name text) returns jsonb language sql as $$ select result from results where name = p_name $$;
create function pg_temp.a() returns text language sql as $$ select 'c0000000-0000-4000-8000-000000002026' $$;
create function pg_temp.admin() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.seller() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
-- One PDV sale of one unit (R$ 25,90) at the seller location.
create function pg_temp.sell(p_label text) returns uuid language plpgsql as $$
declare v_sale uuid;
begin
  v_sale := (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
    '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'surcharge-sale-' || p_label, gen_random_uuid()) ->> 'sale_id')::uuid;
  insert into ids values ('sale_' || p_label, v_sale);
  return v_sale;
end;
$$;

-- Structure and privileges.
select has_table('cohort_data', 'payment_surcharge_rules', 'rules are a cohort table');
select has_table('cohort_data', 'payment_surcharges', 'snapshots are a cohort table');
select ok(not has_table_privilege('authenticated', 'public.payment_surcharge_rules', 'INSERT')
  and not has_table_privilege('authenticated', 'public.payment_surcharge_rules', 'SELECT'), 'rules are reachable only through the commands');
select ok(not has_table_privilege('authenticated', 'public.payment_surcharges', 'INSERT')
  and not has_table_privilege('authenticated', 'public.payment_surcharges', 'SELECT'), 'snapshots are reachable only through the commands');
select ok(not has_function_privilege('anon', 'public.save_payment_surcharge_rule(public.payment_surcharge_method,public.payment_surcharge_mode,integer,bigint,text,text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_payment_surcharge_rules()', 'EXECUTE'), 'anonymous has no access to the configuration');

-- Pure calculation: floor of basis points, fixed once, zero base and NONE never charge.
select results_eq($$values
  (private.compute_payment_surcharge_cents('PERCENTAGE', 250, null, 1999)),
  (private.compute_payment_surcharge_cents('PERCENTAGE', 349, null, 2590)),
  (private.compute_payment_surcharge_cents('PERCENTAGE', 10000, null, 1)),
  (private.compute_payment_surcharge_cents('PERCENTAGE', 1, null, 9999)),
  (private.compute_payment_surcharge_cents('FIXED', null, 150, 1)),
  (private.compute_payment_surcharge_cents('FIXED', null, 150, 0)),
  (private.compute_payment_surcharge_cents('NONE', null, null, 5000))$$,
  $$values (49::bigint), (90::bigint), (1::bigint), (0::bigint), (150::bigint), (0::bigint), (0::bigint)$$,
  'percentage floors to the cent, fixed is charged once, zero base and NONE charge nothing');
select results_eq($$values (private.payment_surcharge_method_for('DINHEIRO', null)::text), (private.payment_surcharge_method_for('PIX_AREA', null)::text),
  (private.payment_surcharge_method_for('MAQUININHA', 'CREDITO')::text), (private.payment_surcharge_method_for('MAQUININHA', 'DEBITO')::text),
  (private.payment_surcharge_method_for('MAQUININHA', 'VOUCHER_REFEICAO')::text), (private.payment_surcharge_method_for('PAYMENT_LINK', null)::text)$$,
  $$values ('DINHEIRO'::text), ('PIX'::text), ('CREDITO'::text), ('DEBITO'::text), (null::text), (null::text)$$,
  'methods map to the PDV channels; vouchers and the Payment Link are not eligible');

-- Stock and an open shift for the seller.
select pg_temp.sys();
insert into public.inventory_balances (location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001') on conflict (location_id, product_id) do nothing;
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 20, 'Estoque acréscimo', 'surcharge-stock', gen_random_uuid());
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
insert into results values ('shift', public.open_seller_shift('50000000-0000-4000-8000-000000000002', 1000, 'surcharge-shift', gen_random_uuid()));

-- Configuration.
select is((select string_agg(rule ->> 'method' || ':' || (rule ->> 'mode'), ',') from jsonb_array_elements(public.list_payment_surcharge_rules() -> 'rules') rule),
  'DINHEIRO:NONE,PIX:NONE,CREDITO:NONE,DEBITO:NONE', 'without configuration every method is NONE');
select is(public.list_payment_surcharge_rules() -> 'history', 'null'::jsonb, 'sellers read the rules in force, not the history');
select throws_ok($$select public.save_payment_surcharge_rule('CREDITO', 'PERCENTAGE', 349, null, 'Repasse da tarifa', 'surcharge-rule-seller', gen_random_uuid())$$,
  '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot configure the acréscimo');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
select throws_ok($$select public.save_payment_surcharge_rule('CREDITO', 'PERCENTAGE', 349, 100, 'Repasse da tarifa', 'surcharge-rule-bad-1', gen_random_uuid())$$,
  '22023', 'INVALID_PAYMENT_SURCHARGE_RULE', 'percentage and fixed together are refused');
select throws_ok($$select public.save_payment_surcharge_rule('CREDITO', 'PERCENTAGE', 0, null, 'Repasse da tarifa', 'surcharge-rule-bad-2', gen_random_uuid())$$,
  '22023', 'INVALID_PAYMENT_SURCHARGE_RULE', 'a zero rate is refused (NONE disables the acréscimo)');
select throws_ok($$select public.save_payment_surcharge_rule('DEBITO', 'FIXED', null, 150, ' ', 'surcharge-rule-bad-3', gen_random_uuid())$$,
  '22023', 'INVALID_PAYMENT_SURCHARGE_RULE', 'a reason is required');
insert into results values ('rule_credit_1', public.save_payment_surcharge_rule('CREDITO', 'PERCENTAGE', 349, null, 'Repasse da tarifa do crédito', 'surcharge-rule-credit-1', gen_random_uuid()));
insert into results values ('rule_debit', public.save_payment_surcharge_rule('DEBITO', 'FIXED', null, 150, 'Repasse da tarifa do débito', 'surcharge-rule-debit', gen_random_uuid()));
insert into results values ('rule_pix', public.save_payment_surcharge_rule('PIX', 'PERCENTAGE', 100, null, 'Repasse do Pix', 'surcharge-rule-pix', gen_random_uuid()));
select is((pg_temp.r('rule_credit_1') ->> 'version')::integer, 1, 'the first rule of a method is version 1');
select is(public.save_payment_surcharge_rule('CREDITO', 'PERCENTAGE', 349, null, 'Repasse da tarifa do crédito', 'surcharge-rule-credit-1', gen_random_uuid()) ->> 'rule_id',
  pg_temp.r('rule_credit_1') ->> 'rule_id', 'replaying the same key returns the same version');
select throws_ok($$select public.save_payment_surcharge_rule('CREDITO', 'PERCENTAGE', 349, null, 'Outra vez', 'surcharge-rule-credit-same', gen_random_uuid())$$,
  'P0001', 'PAYMENT_SURCHARGE_RULE_UNCHANGED', 'saving the rule in force again is refused');
select is(jsonb_array_length(public.list_payment_surcharge_rules() -> 'history'), 3, 'finance reads the version history');
select pg_temp.sys();
select is((select count(*)::integer from public.audit_logs where action = 'payments.surcharge_rule.saved'), 3, 'every version is audited');
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
select is((select string_agg(rule ->> 'method' || ':' || (rule ->> 'mode') || ':' || coalesce(rule ->> 'rate_bps', rule ->> 'fixed_cents', '-'), ',')
  from jsonb_array_elements(public.list_payment_surcharge_rules() -> 'rules') rule),
  'DINHEIRO:NONE:-,PIX:PERCENTAGE:100,CREDITO:PERCENTAGE:349,DEBITO:FIXED:150', 'the seller sees the rules in force');

-- No acréscimo: cash has no rule. Nothing is snapshotted and the charge is the product total.
select pg_temp.sell('cash_none');
insert into results values ('cash_none', public.confirm_cash_payment(pg_temp.id('sale_cash_none'), 3000, 'surcharge-cash-none', gen_random_uuid()));
select is((pg_temp.r('cash_none') -> 'payment_attempt' ->> 'amount_cents')::bigint, 2590::bigint, 'without a rule the charge is the product total');
select is(pg_temp.r('cash_none') -> 'surcharge', 'null'::jsonb, 'and there is no acréscimo snapshot');

-- Percentage: 3,49% of R$ 25,90 = 90,391 cents, floored to 90.
select pg_temp.sell('credit');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_credit'), 'MAQUININHA', 'NSU-SURCH-0001', 'CREDITO', null, 'surcharge-credit-0', gen_random_uuid())$$,
  'P0001', 'PAYMENT_SURCHARGE_CHANGED', 'a confirmation that did not show the acréscimo is refused');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_credit'), 'MAQUININHA', 'NSU-SURCH-0001', 'CREDITO', null, 'surcharge-credit-1', gen_random_uuid(), 91)$$,
  'P0001', 'PAYMENT_SURCHARGE_CHANGED', 'a different acréscimo than the server computes is refused');
insert into results values ('credit', public.confirm_manual_payment(pg_temp.id('sale_credit'), 'MAQUININHA', 'NSU-SURCH-0002', 'CREDITO', null, 'surcharge-credit-2', gen_random_uuid(), 90));
select is((pg_temp.r('credit') -> 'payment_attempt' ->> 'amount_cents')::bigint, 2680::bigint, 'the customer is charged products + acréscimo');
select is(pg_temp.r('credit') -> 'surcharge' ->> 'applied_cents', '90', 'the confirmation returns the applied acréscimo');
select is(public.confirm_manual_payment(pg_temp.id('sale_credit'), 'MAQUININHA', 'NSU-SURCH-0002', 'CREDITO', null, 'surcharge-credit-2', gen_random_uuid(), 90) -> 'payment_attempt' ->> 'amount_cents',
  '2680', 'the confirmation replay is idempotent');

-- Fixed: R$ 1,50 on debit.
select pg_temp.sell('debit');
insert into results values ('debit', public.confirm_manual_payment(pg_temp.id('sale_debit'), 'MAQUININHA', 'NSU-SURCH-0003', 'DEBITO', null, 'surcharge-debit', gen_random_uuid(), 150));
select is((pg_temp.r('debit') -> 'payment_attempt' ->> 'amount_cents')::bigint, 2740::bigint, 'a fixed acréscimo is added once');
-- Pix: 1% of R$ 25,90 = 25,9 cents, floored to 25.
select pg_temp.sell('pix');
insert into results values ('pix', public.confirm_manual_payment(pg_temp.id('sale_pix'), 'PIX_AREA', 'PIX-SURCH-0010', null, null, 'surcharge-pix', gen_random_uuid(), 25));
select is((pg_temp.r('pix') -> 'payment_attempt' ->> 'amount_cents')::bigint, 2615::bigint, 'Área Pix follows its own rule');

select pg_temp.sys();
select results_eq($$select sale.total_cents, attempt.amount_cents, surcharge.base_cents, surcharge.expected_cents, surcharge.applied_cents,
    surcharge.mode::text, surcharge.rate_bps, surcharge.method::text, rule.version
  from public.sales sale join public.payment_attempts attempt on attempt.sale_id = sale.id
  join public.payment_surcharges surcharge on surcharge.payment_attempt_id = attempt.id
  join public.payment_surcharge_rules rule on rule.id = surcharge.rule_id where sale.id = pg_temp.id('sale_credit')$$,
  $$values (2590::bigint, 2680::bigint, 2590::bigint, 90::bigint, 90::bigint, 'PERCENTAGE'::text, 349, 'CREDITO'::text, 1)$$,
  'the sale keeps the product total and the snapshot keeps the rule, base and acréscimo');
select is((select entry_type::text || ':' || amount_cents || ':' || (metadata ->> 'product_cents') || ':' || (metadata ->> 'surcharge_cents')
  from public.financial_ledger_entries where id = (pg_temp.r('credit') ->> 'financial_ledger_entry_id')::uuid),
  'RECEIVABLE_PICPAY:2680:2590:90', 'the PicPay receivable is the gross charge with products and acréscimo apart');
select is((select count(*)::integer from public.audit_logs where action = 'payments.surcharge.applied'), 3, 'each applied acréscimo is audited');
select throws_ok($$update public.payment_surcharges set applied_cents = 0 where sale_id = pg_temp.id('sale_credit')$$,
  'P0001', 'IMMUTABLE_RECORD', 'an applied acréscimo is never rewritten');
select throws_ok($$delete from public.payment_surcharge_rules where id = (pg_temp.r('rule_credit_1') ->> 'rule_id')::uuid$$,
  'P0001', 'IMMUTABLE_RECORD', 'a rule version is never deleted');
select throws_ok($$insert into public.payment_surcharge_rules (cohort_id, method, version, mode, rate_bps, reason, created_by, correlation_id)
  values (pg_temp.a()::uuid, 'CREDITO', 1, 'PERCENTAGE', 500, 'Versão duplicada', pg_temp.admin(), gen_random_uuid())$$,
  '23505', null, 'one version number per cohort and method (concurrent saves cannot both win)');

-- A later change never touches yesterday's sale, and a confirmation that showed the old value is refused.
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
insert into results values ('rule_credit_2', public.save_payment_surcharge_rule('CREDITO', 'FIXED', null, 500, 'Tarifa fixa do crédito', 'surcharge-rule-credit-2', gen_random_uuid()));
select is((pg_temp.r('rule_credit_2') ->> 'version')::integer, 2, 'a change is a new version');
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
select pg_temp.sell('credit_new');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_credit_new'), 'MAQUININHA', 'NSU-SURCH-0004', 'CREDITO', null, 'surcharge-credit-new-0', gen_random_uuid(), 90)$$,
  'P0001', 'PAYMENT_SURCHARGE_CHANGED', 'the value shown before the change is refused after it');
insert into results values ('credit_new', public.confirm_manual_payment(pg_temp.id('sale_credit_new'), 'MAQUININHA', 'NSU-SURCH-0004', 'CREDITO', null, 'surcharge-credit-new', gen_random_uuid(), 500));
select is((pg_temp.r('credit_new') -> 'payment_attempt' ->> 'amount_cents')::bigint, 3090::bigint, 'new sales follow the new rule');
select pg_temp.sys();
select is((select attempt.amount_cents::text || ':' || surcharge.mode || ':' || surcharge.applied_cents from public.payment_attempts attempt
  join public.payment_surcharges surcharge on surcharge.payment_attempt_id = attempt.id where attempt.sale_id = pg_temp.id('sale_credit')),
  '2680:PERCENTAGE:90', 'the previous sale keeps its snapshot');

-- Waiver: a seller cannot, an administrator can with a reason; everything is recorded.
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
select pg_temp.sell('pix_waive_seller');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_pix_waive_seller'), 'PIX_AREA', 'PIX-SURCH-0001', null, null, 'surcharge-pix-waive-seller', gen_random_uuid(), 25, true, 'Cliente reclamou do valor')$$,
  '42501', 'SURCHARGE_WAIVE_FORBIDDEN', 'removing the acréscimo requires the explicit permission');
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
insert into ids select 'sale_admin_pix', (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'surcharge-sale-admin-pix', gen_random_uuid()) ->> 'sale_id')::uuid;
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_admin_pix'), 'PIX_AREA', 'PIX-SURCH-0002', null, null, 'surcharge-admin-waive-0', gen_random_uuid(), 25, true, ' ')$$,
  '22023', 'INVALID_SURCHARGE_WAIVER_REASON', 'a waiver needs a reason');
insert into results values ('admin_pix', public.confirm_manual_payment(pg_temp.id('sale_admin_pix'), 'PIX_AREA', 'PIX-SURCH-0002', null, null,
  'surcharge-admin-waive', gen_random_uuid(), 25, true, 'Cortesia autorizada pela comissão'));
select is((pg_temp.r('admin_pix') -> 'payment_attempt' ->> 'amount_cents')::bigint, 2590::bigint, 'a waived acréscimo is not charged');
select is(pg_temp.r('admin_pix') -> 'surcharge' ->> 'waived', 'true', 'the confirmation reports the waiver');
insert into ids select 'sale_admin_none', (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'surcharge-sale-admin-none', gen_random_uuid()) ->> 'sale_id')::uuid;
select pg_temp.sys();
select results_eq($$select surcharge.expected_cents, surcharge.applied_cents, surcharge.waived, surcharge.waived_by, surcharge.waiver_reason
  from public.payment_surcharges surcharge where surcharge.sale_id = pg_temp.id('sale_admin_pix')$$,
  $$values (25::bigint, 0::bigint, true, pg_temp.admin(), 'Cortesia autorizada pela comissão'::text)$$,
  'the snapshot keeps the expected amount, the waiver, who and why');
select is((select (metadata ->> 'waived_cents') || ':' || (metadata ->> 'rule_version') || ':' || actor_id
  from public.audit_logs where action = 'payments.surcharge.waived'), '25:1:' || pg_temp.admin(), 'the waiver is audited with the rule and the amount waived');
-- Cash has no rule, so there is nothing to waive.
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_admin_none'), 'MAQUININHA', 'NSU-SURCH-0009', 'CREDITO', null, 'surcharge-admin-none', gen_random_uuid(), 0, true, 'Sem acréscimo para remover')$$,
  'P0001', 'PAYMENT_SURCHARGE_CHANGED', 'a waiver is still checked against the acréscimo in force');

-- Cash with an acréscimo: the tendered money covers the gross charge and the drawer expects the gross.
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
select public.save_payment_surcharge_rule('DINHEIRO', 'FIXED', null, 100, 'Custo de manuseio do dinheiro', 'surcharge-rule-cash', gen_random_uuid());
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
select pg_temp.sell('cash_fixed');
select throws_ok($$select public.confirm_cash_payment(pg_temp.id('sale_cash_fixed'), 2590, 'surcharge-cash-short', gen_random_uuid(), 100)$$,
  'P0001', 'CASH_TENDERED_INSUFFICIENT', 'the tendered cash must cover products + acréscimo');
insert into results values ('cash_fixed', public.confirm_cash_payment(pg_temp.id('sale_cash_fixed'), 3000, 'surcharge-cash-fixed', gen_random_uuid(), 100));
select is((pg_temp.r('cash_fixed') -> 'cash' ->> 'change_cents')::bigint, 310::bigint, 'change is computed on the gross charge');
select is((public.get_my_seller_shift() ->> 'expected_cash_cents')::bigint, 1000 + 2590 + 2690::bigint, 'the drawer expects the gross cash received');

-- Closeout: confirmed sales are counted at what they charged, so the period balances against the payments.
select pg_temp.sys();
insert into results select 'counts', jsonb_agg(jsonb_build_object('product_id', product_id, 'counted_quantity', on_hand_quantity))
  from public.inventory_balances where location_id = '50000000-0000-4000-8000-000000000002';
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
insert into results values ('closeout', public.create_seller_closeout(clock_timestamp() - interval '1 hour', clock_timestamp(), pg_temp.r('counts'), null,
  'surcharge-closeout', gen_random_uuid()));
select is((pg_temp.r('closeout') ->> 'confirmed_sales_total_cents') || ':' || (pg_temp.r('closeout') ->> 'payment_total_cents') || ':'
  || (pg_temp.r('closeout') ->> 'payment_difference_cents'), '16405:16405:0', 'the closeout balances sales with acréscimo against payments');

-- PicPay fee is independent: the reconciliation observes the gross charge and records its own fee.
select pg_temp.ctx(pg_temp.admin(), pg_temp.a());
insert into results values ('reconcile', public.reconcile_payment_attempt((pg_temp.r('pix') -> 'payment_attempt' ->> 'attempt_id')::uuid, 2615, 10,
  'EXTRATO-SURCH-0001', 'MANUAL', 'surcharge-reconcile', gen_random_uuid()));
select is(pg_temp.r('reconcile') ->> 'outcome', 'MATCHED', 'the gross charge reconciles with the PicPay transaction');

-- Refund: the full reversal gives the acréscimo back with the products.
insert into results values ('refund', public.reverse_confirmed_sale(pg_temp.id('sale_credit'), 'Cliente desistiu da compra', 'ESTORNO-SURCH-0001', null,
  'surcharge-refund', gen_random_uuid()));
select pg_temp.sys();
select is((select amount_cents from public.financial_ledger_entries where sale_id = pg_temp.id('sale_credit') and entry_type = 'REFUND'),
  -2680::bigint, 'the refund returns products + acréscimo');

-- Indicators: the acréscimo is revenue reported apart from products, and never a fee.
select is((select (totals ->> 'surcharge_revenue_cents') || ':' || (totals ->> 'surcharge_refunds_cents') || ':' || (totals ->> 'surcharge_waived_cents')
    || ':' || (totals ->> 'surcharge_waivers') || ':' || ((totals ->> 'sale_revenue_cents')::bigint - (totals ->> 'product_revenue_cents')::bigint)
  from (select private.compute_management_indicators((now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date) -> 'totals' as totals) indicators),
  '865:90:25:1:865', 'acréscimo received (90+150+25+500+100), refunded (90), waived (25) and product revenue = receipts − acréscimo');
select is((select (private.compute_management_indicators((now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date)
  -> 'totals' ->> 'fees_cents')::bigint), 10::bigint, 'fees are only the reconciled PicPay fee');

-- Isolation: another cohort has its own rules, and "all" never writes.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
insert into ids select 'cohort_b', (public.create_cohort('Turma Acréscimo', 2032, 'turma-acrescimo', 'ACTIVE', 'surcharge-cohort-b', gen_random_uuid()) ->> 'id')::uuid;
select throws_ok($$select public.save_payment_surcharge_rule('PIX', 'FIXED', null, 50, 'Tentativa em todas', 'surcharge-rule-all', gen_random_uuid())$$,
  '22023', 'COHORT_REQUIRED', 'the consolidated view never writes a rule');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.id('cohort_b')::text);
select is((select string_agg(rule ->> 'mode', ',') from jsonb_array_elements(public.list_payment_surcharge_rules() -> 'rules') rule),
  'NONE,NONE,NONE,NONE', 'another cohort does not see the rules of Turma 2026');
select is(public.save_payment_surcharge_rule('PIX', 'FIXED', null, 50, 'Regra da outra turma', 'surcharge-rule-b', gen_random_uuid()) ->> 'version', '1',
  'and versions its own rules independently');
select is(jsonb_array_length(public.list_payment_surcharge_rules() -> 'history'), 1, 'its history holds only its own versions');
select pg_temp.ctx(pg_temp.seller(), pg_temp.a());
select is((select rule ->> 'mode' || ':' || (rule ->> 'rate_bps') from jsonb_array_elements(public.list_payment_surcharge_rules() -> 'rules') rule where rule ->> 'method' = 'PIX'),
  'PERCENTAGE:100', 'Turma 2026 keeps its own PIX rule');
select pg_temp.sys();
select is((select count(*)::integer from cohort_data.payment_surcharge_rules where cohort_id = pg_temp.id('cohort_b')), 1, 'the rule row belongs to the other cohort');
select is((select count(*)::integer from cohort_data.payment_surcharges where cohort_id <> pg_temp.a()::uuid), 0, 'every snapshot belongs to the sale cohort');
select is((select count(*)::integer from private.cohort_view_drift()), 0, 'the new views match their base tables');

select * from finish();
rollback;
