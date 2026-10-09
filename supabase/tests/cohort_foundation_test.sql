-- ADR 0011 (multi-turma) — fundação de dados: catálogo de turmas, Turma 2026 de bootstrap, vínculos usuário ↔ turma,
-- classificação das tabelas, cohort_id e integridade (estado final, depois da autorização e do isolamento).
begin;
select plan(43);

-- Catálogo e Turma 2026 de bootstrap.
select has_table('public', 'cohorts', 'cohorts exists');
select has_table('public', 'user_cohorts', 'user_cohorts exists');
select is(private.bootstrap_cohort_id(), 'c0000000-0000-4000-8000-000000002026'::uuid, 'the bootstrap identifier of Turma 2026 is fixed');
select results_eq(
  $$select name, year::integer, slug, status::text, is_default from public.cohorts where id = private.bootstrap_cohort_id()$$,
  $$values ('Turma 2026'::text, 2026, '2026'::text, 'ACTIVE'::text, true)$$,
  'Turma 2026 exists, active and default'
);
select is((select count(*)::integer from public.cohorts where is_default), 1, 'exactly one default cohort');

-- Regras de unicidade e formato.
savepoint rules;
insert into public.cohorts (name, year, slug, status) values ('Turma 2027', 2027, '2027', 'PREPARING');
select lives_ok($$insert into public.cohorts (name, year, slug) values ('Turma 2028', 2028, 'turma-2028')$$, 'a second and third cohort can be created');
select throws_ok($$insert into public.cohorts (name, year, slug) values ('Outra 2027', 2027, 'outra-2027')$$, '23505', null, 'the year is unique');
select throws_ok($$insert into public.cohorts (name, year, slug) values ('Turma 2029', 2029, '2027')$$, '23505', null, 'the slug is unique');
select throws_ok($$update public.cohorts set status = 'ACTIVE', is_default = true where year = 2027$$, '23505', null, 'there is never a second default cohort');
select throws_ok($$update public.cohorts set is_default = true where year = 2028$$, 'P0001', 'DEFAULT_COHORT_MUST_BE_ACTIVE',
  'only an ACTIVE cohort can be the default (PR 5)');
select throws_ok($$insert into public.cohorts (name, year, slug) values ('Turma 2030', 2030, 'Turma 2030')$$, '23514', null, 'the slug is lowercase, digits and hyphens');
select throws_ok($$insert into public.cohorts (name, year, slug) values ('Turma 1990', 1990, '1990')$$, '23514', null, 'the year is plausible');
select throws_ok($$update public.cohorts set status = 'ARCHIVED' where id = private.bootstrap_cohort_id()$$, 'P0001', 'DEFAULT_COHORT_MUST_BE_ACTIVE',
  'the default cohort cannot be archived');
rollback to savepoint rules;

-- Classificação: tabelas por turma recebem cohort_id; globais não.
select is((select count(*)::integer from private.cohort_scoped_tables), 85,
  '85 tables are classified: 73 of the foundation, 12 decided with the authorization (ADR 0011)');
select results_eq($$select mode, count(*)::integer from private.cohort_scoped_tables group by mode order by mode$$,
  $$values ('MASTER_NULLABLE'::text, 2), ('REQUIRED'::text, 78), ('SHARED_NULLABLE'::text, 5)$$,
  'required, attribution (nullable) and log (nullable, global = NULL) tables');
select is((select count(*)::integer from private.cohort_scoped_tables t
  join information_schema.columns c on c.table_schema = 'cohort_data' and c.table_name = t.table_name and c.column_name = 'cohort_id'
  where c.data_type = 'uuid'), 85, 'every cohort table lives in cohort_data with a uuid cohort_id');
select is((select count(*)::integer from private.cohort_scoped_tables t
  join information_schema.columns c on c.table_schema = 'cohort_data' and c.table_name = t.table_name and c.column_name = 'cohort_id'
  where c.column_default is null), 85, 'no constant default anymore: the guard assigns the cohort of the request or of the parent');
select is((select count(*)::integer from private.cohort_scoped_tables t
  join pg_constraint fk on fk.conrelid = format('cohort_data.%I', t.table_name)::regclass and fk.conname = t.table_name || '_cohort_id_fkey'
  where fk.convalidated and fk.confrelid = 'public.cohorts'::regclass), 85, 'every cohort foreign key is validated');
select is((select count(*)::integer from private.cohort_scoped_tables t
  join information_schema.columns c on c.table_schema = 'cohort_data' and c.table_name = t.table_name and c.column_name = 'cohort_id'
  where (c.is_nullable = 'NO') = (t.mode = 'REQUIRED')), 85, 'NOT NULL exactly on the required tables (constrain after validate)');
select is((select count(*)::integer from information_schema.columns where table_schema in ('public', 'private', 'cohort_data') and column_name = 'cohort_id'
  and table_name in ('profiles', 'profile_preferences', 'roles', 'permissions', 'role_permissions', 'idempotency_keys', 'security_events',
    'notification_preferences', 'notifications', 'feature_flags', 'payment_terminals', 'payment_webhook_receipts',
    'payment_webhook_deliveries', 'payment_webhook_outcomes', 'picpay_source_imports', 'picpay_transactions',
    'picpay_transaction_observations', 'picpay_receivable_installments', 'picpay_receivable_observations', 'picpay_statement_imports',
    'picpay_statement_lines', 'picpay_statement_line_observations', 'picpay_statement_duplicate_conflicts')), 0,
  'global identity, infrastructure, terminal identity, the flag catalogue and the PicPay evidence receive no cohort_id');

-- Integridade dos dados existentes.
select is((select count(*)::integer from private.cohort_integrity_report() where violations <> 0), 0, 'the integrity report is clean');
select ok((select count(*) from private.cohort_integrity_report() where check_name = 'cross_cohort_reference') > 100,
  'cross-cohort references are checked for every foreign key between scoped tables');
select is((select count(*)::integer from public.profiles p where not exists (
  select 1 from public.user_cohorts m where m.user_id = p.id and m.cohort_id = private.bootstrap_cohort_id() and m.status = 'ACTIVE')), 0,
  'every existing identity participates in Turma 2026');

-- Nova identidade entra na turma padrão; a mesma identidade pode participar de várias turmas.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '1c000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'turma.nova@institutojef.org.br', '', now(), '{}', '{"name":"Turma Nova"}', now(), now());
select results_eq($$select cohort_id, status::text from public.user_cohorts where user_id = '1c000000-0000-4000-8000-000000000001'$$,
  $$values (private.bootstrap_cohort_id(), 'ACTIVE'::text)$$, 'a new identity joins the default cohort');
insert into public.cohorts (id, name, year, slug, status) values ('c0000000-0000-4000-8000-000000002027', 'Turma 2027', 2027, '2027', 'PREPARING');
select private.provision_cohort('c0000000-0000-4000-8000-000000002027', null);
insert into public.user_cohorts (user_id, cohort_id) values ('1c000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000002027');
select is((select count(*)::integer from public.user_cohorts where user_id = '1c000000-0000-4000-8000-000000000001'), 2,
  'one global identity participates in two cohorts');
select is((select count(*)::integer from auth.users where email = 'turma.nova@institutojef.org.br'), 1, 'without duplicating the auth account');
select throws_ok($$insert into public.user_cohorts (user_id, cohort_id) values ('1c000000-0000-4000-8000-000000000001', private.bootstrap_cohort_id())$$,
  '23505', null, 'one membership per user and cohort');

-- O comportamento atual não muda: escrita pelos RPCs continua na Turma 2026.
set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
create temp table created_category as
select (public.save_catalog_category(null, null, 'Categoria da fundação', 'categoria-fundacao', true, 900, 'Teste da fundação de turmas',
  'cohort-foundation-category', gen_random_uuid()) ->> 'id')::uuid as id;
reset role;
select is((select cohort_id from public.categories where id = (select id from created_category)), private.bootstrap_cohort_id(),
  'a category created through the existing RPC belongs to Turma 2026');
select is((select count(*)::integer from private.cohort_integrity_report() where violations <> 0), 0, 'still clean after the write');

-- Uma referência entre turmas é recusada pelo guard; o relatório a detecta se o guard for contornado.
select throws_ok($$insert into public.products (category_id, sku, slug, name, cohort_id)
  values ((select id from created_category), 'SKU-COHORT-X', 'produto-cruzado', 'Produto cruzado', 'c0000000-0000-4000-8000-000000002027')$$,
  '42501', 'COHORT_MISMATCH', 'a 2027 product under a 2026 category is refused');
savepoint cross_reference;
alter table cohort_data.products disable trigger a_cohort_guard;
insert into cohort_data.products (category_id, sku, slug, name, cohort_id)
values ((select id from created_category), 'SKU-COHORT-X', 'produto-cruzado', 'Produto cruzado', 'c0000000-0000-4000-8000-000000002027');
select is((select violations::integer from private.cohort_integrity_report()
  where check_name = 'cross_cohort_reference' and subject = 'products.products_category_id_fkey'), 1,
  'with the guard bypassed, the integrity report still catches it');
rollback to savepoint cross_reference;

-- As tabelas de turmas ficam fechadas: o acesso é por get_my_session e pelos RPCs de turmas.
select ok(not has_table_privilege('anon', 'public.cohorts', 'SELECT'), 'anon cannot read cohorts');
select ok(not has_table_privilege('authenticated', 'public.cohorts', 'SELECT'), 'authenticated cannot read cohorts directly');
select ok(not has_table_privilege('authenticated', 'public.user_cohorts', 'SELECT'), 'authenticated cannot read memberships directly');
select ok(not has_table_privilege('authenticated', 'public.user_cohorts', 'INSERT'), 'authenticated cannot write memberships');
select ok(not has_function_privilege('authenticated', 'private.cohort_integrity_report()', 'EXECUTE'), 'the integrity report is not exposed');
select ok(not has_function_privilege('anon', 'private.bootstrap_cohort_id()', 'EXECUTE'), 'the bootstrap helper is not exposed');
select ok((select relrowsecurity from pg_class where oid = 'public.cohorts'::regclass), 'cohorts has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.user_cohorts'::regclass), 'user_cohorts has RLS enabled');
select is((select count(*)::integer from pg_policies where tablename in ('cohorts', 'user_cohorts')), 0, 'no policy opens them to the Data API');
select is((select count(*)::integer from public.roles where key = 'ADMIN_MASTER'), 0, 'ADMIN_MASTER is not a role repeated per cohort (admin_masters)');

-- Imutabilidade preservada: o ledger continua recusando UPDATE, inclusive de cohort_id.
insert into public.finance_manual_entries (kind, category, account, amount_cents, occurred_on, description, actor_id, correlation_id)
values ('EXPENSE', 'OUTROS', 'PICPAY_EMPRESAS', 100, current_date, 'Lançamento da fundação', '10000000-0000-4000-8000-000000000001', gen_random_uuid());
select throws_ok($$update public.finance_manual_entries set cohort_id = 'c0000000-0000-4000-8000-000000002027' where description = 'Lançamento da fundação'$$,
  null, null, 'an immutable ledger still refuses updates, cohort_id included');
select is((select cohort_id from public.finance_manual_entries where description = 'Lançamento da fundação'), private.bootstrap_cohort_id(),
  'a ledger row written without cohort lands in Turma 2026');

select * from finish();
rollback;
