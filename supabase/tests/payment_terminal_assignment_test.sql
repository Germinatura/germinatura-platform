-- H2b: who holds each Maquininha (per cohort, audited, finance only) and the terminal the PDV preselects:
-- assigned > last used > only active > none; inactive ones ignored; assignment is never exclusivity.
begin;
select plan(26);

create function pg_temp.ctx(p_user uuid, p_cohort text default 'c0000000-0000-4000-8000-000000002026') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.headers', json_build_object('x-germinatura-cohort', p_cohort)::text, true);
  perform set_config('role', 'authenticated', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.sys() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.admin() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.seller() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.consumer() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.pref() returns jsonb language sql as $$ select public.pdv_terminal_preference() $$;
create function pg_temp.assign(p_terminal text, p_to uuid, p_key text) returns jsonb language sql as $$
  select public.assign_payment_terminal(pg_temp.id(p_terminal), p_to, 'Entregue no turno da manhã', 'terminal-assign-' || p_key, gen_random_uuid()) $$;

-- Structure and privileges.
select has_column('cohort_data', 'cohort_payment_terminals', 'assigned_to', 'the holder lives on the cohort authorization');
select ok(not has_function_privilege('anon', 'public.assign_payment_terminal(uuid,uuid,text,text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.pdv_terminal_preference()', 'EXECUTE'), 'anonymous has no access');

-- Without terminals there is nothing to preselect.
select pg_temp.ctx(pg_temp.seller());
select is(pg_temp.pref(), '{"source": null, "terminal_id": null}'::jsonb, 'no terminal, no preselection');

-- One active terminal: it is preselected.
select pg_temp.ctx(pg_temp.admin());
insert into ids select 'romeu', (public.save_payment_terminal(null, 'ROMEU', 'Romeu', true, 'terminal-romeu', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.ctx(pg_temp.seller());
select is(pg_temp.pref(), jsonb_build_object('terminal_id', pg_temp.id('romeu'), 'source', 'ONLY_ACTIVE'), 'the only active terminal is preselected');

-- Several active terminals without assignment or history: no preselection.
select pg_temp.ctx(pg_temp.admin());
insert into ids select 'julieta', (public.save_payment_terminal(null, 'JULIETA', 'Julieta', true, 'terminal-julieta', gen_random_uuid()) ->> 'id')::uuid;
insert into ids select 'mercucio', (public.save_payment_terminal(null, 'MERCUCIO', 'Mercúcio', true, 'terminal-mercucio', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.ctx(pg_temp.seller());
select is(pg_temp.pref(), '{"source": null, "terminal_id": null}'::jsonb, 'several active terminals and no preference: nothing preselected');

-- Only finance assigns; the holder must be an active seller of the cohort.
select throws_ok($$select pg_temp.assign('romeu', pg_temp.seller(), 'by-seller')$$, '42501', 'FINANCE_MANAGE_REQUIRED', 'a seller cannot assign terminals');
select pg_temp.ctx(pg_temp.admin());
select throws_ok($$select pg_temp.assign('romeu', pg_temp.consumer(), 'to-consumer')$$, 'P0001', 'TERMINAL_ASSIGNEE_NOT_A_SELLER', 'a consumer cannot hold a terminal');
select throws_ok($$select public.assign_payment_terminal(pg_temp.id('romeu'), pg_temp.seller(), ' ', 'terminal-assign-noreason', gen_random_uuid())$$,
  '22023', 'INVALID_TERMINAL_ASSIGNMENT', 'a reason is required');

-- Romeu goes to the seller: preselected for them, listed with the holder, audited.
select is(pg_temp.assign('romeu', pg_temp.seller(), 'romeu-seller') -> 'assigned_to' ->> 'id', pg_temp.seller()::text, 'finance assigns Romeu to the seller');
select is(pg_temp.assign('romeu', pg_temp.seller(), 'romeu-seller') -> 'assigned_to' ->> 'id', pg_temp.seller()::text, 'replaying the same key returns the same assignment');
select is((select item -> 'assigned_to' ->> 'id' from jsonb_array_elements(public.list_payment_terminals(true)) item where item ->> 'code' = 'ROMEU'),
  pg_temp.seller()::text, 'the list shows with whom Romeu is');
select pg_temp.ctx(pg_temp.seller());
select is(pg_temp.pref(), jsonb_build_object('terminal_id', pg_temp.id('romeu'), 'source', 'ASSIGNED'), 'the terminal assigned to the seller comes first');
select pg_temp.sys();
select is((select count(*)::integer from public.audit_logs where action = 'payments.terminal.assigned' and entity_id = pg_temp.id('romeu')::text), 1,
  'the assignment is audited once');

-- Assignment is not exclusivity: the admin (another seller) confirms a payment with Romeu.
insert into public.inventory_balances (location_id, product_id)
values ('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001') on conflict (location_id, product_id) do nothing;
select pg_temp.ctx(pg_temp.admin());
select public.adjust_stock('50000000-0000-4000-8000-000000000001', '33f00000-0000-4000-8000-000000000001', 5, 'Estoque maquininha', 'terminal-stock', gen_random_uuid());
insert into ids select 'sale_admin', (public.checkout_sale('PDV', '50000000-0000-4000-8000-000000000001',
  '[{"product_id":"33f00000-0000-4000-8000-000000000001","quantity":1}]'::jsonb, 'terminal-sale-admin', gen_random_uuid()) ->> 'sale_id')::uuid;
select is(public.confirm_manual_payment(pg_temp.id('sale_admin'), 'MAQUININHA', 'NSU-ROMEU-01', 'DEBITO', pg_temp.id('romeu'), 'terminal-pay-admin', gen_random_uuid()) ->> 'sale_status',
  'CONFIRMED', 'a terminal assigned to someone else can still be used');
select is((select terminal_id from public.payment_attempts where sale_id = pg_temp.id('sale_admin')), pg_temp.id('romeu'),
  'the payment records the terminal actually used, not its holder');

-- Without assignment, the last terminal the person used is preselected.
select pg_temp.ctx(pg_temp.admin());
select is(pg_temp.pref(), jsonb_build_object('terminal_id', pg_temp.id('romeu'), 'source', 'LAST_USED'), 'after using Romeu, it is the admin''s last used terminal');

-- Changing the holder: Romeu to the admin, the seller falls back to their own history (none) and no preselection.
select is(pg_temp.assign('romeu', pg_temp.admin(), 'romeu-admin') -> 'assigned_to' ->> 'id', pg_temp.admin()::text, 'the holder changes');
select is(pg_temp.pref() ->> 'source', 'ASSIGNED', 'the new holder gets Romeu as assigned');
select pg_temp.ctx(pg_temp.seller());
select is(pg_temp.pref(), '{"source": null, "terminal_id": null}'::jsonb, 'the previous holder no longer has it preselected');
select pg_temp.sys();
select is((select metadata ->> 'from' from public.audit_logs where action = 'payments.terminal.assigned' and metadata ->> 'to' = pg_temp.admin()::text),
  pg_temp.seller()::text, 'the change records from whom to whom');

-- An inactive assigned terminal is ignored; an inactive last used one too.
select pg_temp.ctx(pg_temp.admin());
select public.save_payment_terminal(pg_temp.id('romeu'), 'ROMEU', 'Romeu', false, 'terminal-romeu-off', gen_random_uuid());
select is(pg_temp.pref(), '{"source": null, "terminal_id": null}'::jsonb, 'an inactive assigned and last used terminal is ignored (two others active)');
select throws_ok($$select pg_temp.assign('romeu', pg_temp.seller(), 'romeu-inactive')$$, 'P0001', 'PAYMENT_TERMINAL_UNAVAILABLE', 'an inactive terminal cannot be assigned');
select is(pg_temp.assign('romeu', null, 'romeu-free') -> 'assigned_to', 'null'::jsonb, 'the assignment can be removed (even from an inactive terminal)');
select public.save_payment_terminal(pg_temp.id('mercucio'), 'MERCUCIO', 'Mercúcio', false, 'terminal-mercucio-off', gen_random_uuid());
select is(pg_temp.pref(), jsonb_build_object('terminal_id', pg_temp.id('julieta'), 'source', 'ONLY_ACTIVE'), 'with one active terminal left, it is preselected');

-- Two cohorts: the holder recorded in another cohort never leaks into this one.
select pg_temp.sys();
insert into public.cohorts (id, name, year, slug, status, is_default) values ('c0000000-0000-4000-8000-0000000002b1', 'Turma maquininha B', 2027, 'turma-maquininha-b', 'ACTIVE', false);
insert into cohort_data.cohort_payment_terminals (cohort_id, terminal_id, active, assigned_to, assigned_at)
values ('c0000000-0000-4000-8000-0000000002b1', pg_temp.id('julieta'), true, pg_temp.consumer(), now());
select pg_temp.ctx(pg_temp.admin());
select is((select item -> 'assigned_to' from jsonb_array_elements(public.list_payment_terminals(true)) item where item ->> 'code' = 'JULIETA'),
  'null'::jsonb, 'the holder of another cohort is not shown');
select is((select count(*)::integer from jsonb_array_elements(public.list_payment_terminal_assignees()) person where person ->> 'id' = pg_temp.consumer()::text), 0,
  'only sellers of the cohort are offered as holders');

select * from finish();
rollback;
