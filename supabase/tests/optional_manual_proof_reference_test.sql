-- H2c: the external reference of a manual Maquininha / Área Pix confirmation is optional. Absent = NULL (never made up);
-- present = same non-sensitive format and uniqueness as before; NULLs never collide; idempotency and acréscimo unchanged.
begin;
select plan(20);

create function pg_temp.ctx(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.headers', json_build_object('x-germinatura-cohort', 'c0000000-0000-4000-8000-000000002026')::text, true);
  perform set_config('role', 'authenticated', true);
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
grant all on ids, results to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.r(p_name text) returns jsonb language sql as $$ select result from results where name = p_name $$;
create function pg_temp.admin() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.seller() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.sell(p_label text) returns uuid language plpgsql as $$
declare v_sale uuid;
begin
  v_sale := (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000002',
    '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'proof-optional-sale-' || p_label, gen_random_uuid()) ->> 'sale_id')::uuid;
  insert into ids values ('sale_' || p_label, v_sale);
  return v_sale;
end;
$$;

-- Stock, one registered terminal (so a Maquininha payment names it) and an acréscimo on Pix.
insert into public.inventory_balances (location_id, product_id)
values ('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001') on conflict (location_id, product_id) do nothing;
select pg_temp.ctx(pg_temp.admin());
select public.adjust_stock('50000000-0000-4000-8000-000000000002', '33f00000-0000-4000-8000-000000000001', 20, 'Estoque referência opcional', 'proof-optional-stock', gen_random_uuid());
insert into ids select 'terminal', (public.save_payment_terminal(null, 'MAQ-OPT', 'Maquininha opcional', true, 'proof-optional-terminal', gen_random_uuid()) ->> 'id')::uuid;
insert into results values ('rule_pix', public.save_payment_surcharge_rule('PIX', 'PERCENTAGE', 100, null, 'Repasse do Pix', 'proof-optional-rule-pix', gen_random_uuid()));

-- Constraint: a manual PicPay attempt may have no reference.
select pg_temp.sys();
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'payment_attempts_manual_origin_valid')) like '%proof_reference IS NULL%',
  'the manual origin constraint accepts a missing reference');

-- Maquininha without a reference: confirmed, stored as NULL, ledger and stock as before.
select pg_temp.ctx(pg_temp.seller());
select pg_temp.sell('card_none');
insert into results values ('card_none', public.confirm_manual_payment(pg_temp.id('sale_card_none'), 'MAQUININHA', null, 'DEBITO', pg_temp.id('terminal'), 'proof-optional-card-none', gen_random_uuid()));
select is(pg_temp.r('card_none') ->> 'sale_status', 'CONFIRMED', 'a Maquininha sale is confirmed without a reference');
select is(pg_temp.r('card_none') -> 'payment_attempt' -> 'proof_reference', 'null'::jsonb, 'the missing reference is NULL in the result');
select pg_temp.sys();
select is((select proof_reference from public.payment_attempts where sale_id = pg_temp.id('sale_card_none')), null, 'the attempt stores NULL, never a made-up value');
select is((select confirmation_source::text || '/' || terminal_id::text from public.payment_attempts where sale_id = pg_temp.id('sale_card_none')),
  'MANUAL/' || pg_temp.id('terminal')::text, 'still a manual confirmation, traceable by its terminal');
select is((select count(*)::integer from public.financial_ledger_entries where sale_id = pg_temp.id('sale_card_none') and entry_type = 'RECEIVABLE_PICPAY'), 1,
  'the PicPay receivable is recorded as before');
select is((select count(*)::integer from public.audit_logs where action = 'payments.manual.confirmed' and metadata ->> 'sale_id' = pg_temp.id('sale_card_none')::text), 1,
  'the confirmation is audited');

-- A second confirmation without a reference does not collide with the first (NULLs are distinct).
select pg_temp.ctx(pg_temp.seller());
select pg_temp.sell('pix_none');
insert into results values ('pix_none', public.confirm_manual_payment(pg_temp.id('sale_pix_none'), 'PIX_AREA', null, null, null, 'proof-optional-pix-none', gen_random_uuid(), 25));
select is(pg_temp.r('pix_none') ->> 'sale_status', 'CONFIRMED', 'a second sale without a reference is confirmed (no false collision)');
select is((pg_temp.r('pix_none') -> 'surcharge' ->> 'applied_cents')::integer, 25, 'the Pix acréscimo is applied as before (1% of R$ 25,90 = 25)');
select is((pg_temp.r('pix_none') -> 'payment_attempt' ->> 'amount_cents')::integer, 2615, 'the customer is charged product + acréscimo');

-- Idempotency: the same key and request returns the stored result; a different reference on the same key is refused.
select is(public.confirm_manual_payment(pg_temp.id('sale_pix_none'), 'PIX_AREA', null, null, null, 'proof-optional-pix-none', gen_random_uuid(), 25) ->> 'sale_id',
  pg_temp.id('sale_pix_none')::text, 'replaying the same request returns the same confirmation');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_pix_none'), 'PIX_AREA', 'PIX-OUTRA-01', null, null, 'proof-optional-pix-none', gen_random_uuid(), 25)$$,
  'P0001', null, 'the same key with another reference is not a replay');

-- A present reference keeps every rule: format, card data, trimming, uniqueness.
select pg_temp.sell('bad');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_bad'), 'PIX_AREA', 'ab', null, null, 'proof-optional-short', gen_random_uuid(), 25)$$,
  '22023', 'INVALID_NON_SENSITIVE_PROOF_REFERENCE', 'a reference shorter than 4 characters is refused');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_bad'), 'PIX_AREA', '4111111111111111', null, null, 'proof-optional-card', gen_random_uuid(), 25)$$,
  '22023', 'INVALID_NON_SENSITIVE_PROOF_REFERENCE', 'a card number is refused');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_bad'), 'PIX_AREA', ' NSU-123 ', null, null, 'proof-optional-spaces', gen_random_uuid(), 25)$$,
  '22023', 'INVALID_NON_SENSITIVE_PROOF_REFERENCE', 'a reference with surrounding spaces is refused');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_bad'), 'PIX_AREA', 'senha=1234', null, null, 'proof-optional-format', gen_random_uuid(), 25)$$,
  '22023', 'INVALID_NON_SENSITIVE_PROOF_REFERENCE', 'a reference outside the safe format is refused');
insert into results values ('ref_ok', public.confirm_manual_payment(pg_temp.id('sale_bad'), 'PIX_AREA', 'E2E-REF-0001', null, null, 'proof-optional-ok', gen_random_uuid(), 25));
select is(pg_temp.r('ref_ok') -> 'payment_attempt' ->> 'proof_reference', 'E2E-REF-0001', 'a valid reference is stored as typed');
select pg_temp.sell('dup');
select throws_ok($$select public.confirm_manual_payment(pg_temp.id('sale_dup'), 'PIX_AREA', 'E2E-REF-0001', null, null, 'proof-optional-dup', gen_random_uuid(), 25)$$,
  'P0001', 'PROOF_REFERENCE_ALREADY_USED', 'a filled reference stays unique among manual confirmations');

-- Cash is unchanged: no reference at all.
select pg_temp.sys();
select ok(pg_get_constraintdef((select oid from pg_constraint where conname = 'payment_attempts_manual_origin_valid')) like '%DINHEIRO%proof_reference IS NULL%',
  'cash never carries a reference');
select is((select count(*)::integer from public.payment_attempts where confirmation_source = 'MANUAL' and integration_channel in ('MAQUININHA', 'PIX_AREA')
  and proof_reference is not null and proof_reference ~ '[0-9]{12,}'), 0, 'no stored manual reference carries card data');

select * from finish();
rollback;
