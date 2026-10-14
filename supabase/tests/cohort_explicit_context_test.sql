-- ADR 0011 (multi-turma), PR 5 — nenhum registro cai numa turma por ausência de contexto: escrita scoped sem turma
-- falha, sem fallback para a turma padrão; turma padrão explícita (só para entrada pública e cadastro), trocada pelo
-- ADMIN_MASTER; visitantes resolvem a turma pelo slug ou pelo link no servidor; revogação imediata informa pendências.
begin;
select plan(54);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.headers', '{}', true);
  -- The service role writes through RPCs; the caller is identified by its claim (private.cohort_caller), so the test
  -- keeps the table owner's grants and only the claim says "service".
  perform set_config('role', 'postgres', true);
  perform set_config('germinatura.system_cohort', '', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.sys() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.headers', '', true);
  perform set_config('germinatura.system_cohort', '', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
-- What a visitor would read: the request claims say "anon", the scope function runs as the owner.
create function pg_temp.visitor_scope(p_header text) returns uuid[] language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
  perform set_config('germinatura.cohort_scope', '', true);
  return private.cohort_scope();
end;
$$;
create temp table ids (name text primary key, id uuid, code text);
grant all on ids to anon, authenticated, service_role;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create function pg_temp.a() returns uuid language sql as $$ select 'c0000000-0000-4000-8000-000000002026'::uuid $$;
create function pg_temp.b() returns uuid language sql as $$ select id from ids where name = 'cohort_b' $$;
create function pg_temp.master() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000005'::uuid $$;
create function pg_temp.admin_a() returns uuid language sql as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;

-- Cohorts: A (Turma 2026, default), B (ACTIVE), C (to be archived). People: a seller of B, a person of A and B.
select pg_temp.ctx(pg_temp.master(), 'all');
insert into ids (name, id) select 'cohort_b', (public.create_cohort('Turma PR5 B', 2035, 'turma-pr5-b', 'ACTIVE', 'pr5-create-b', gen_random_uuid()) ->> 'id')::uuid;
insert into ids (name, id) select 'cohort_c', (public.create_cohort('Turma PR5 C', 2036, 'turma-pr5-c', 'ACTIVE', 'pr5-create-c', gen_random_uuid()) ->> 'id')::uuid;
select pg_temp.sys();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, extensions.crypt('Turmas123!', extensions.gen_salt('bf')),
  now(), '{}', jsonb_build_object('name', name, 'username', username), now(), now()
from (values
  ('5c000000-0000-4000-8000-0000000000b1'::uuid, 'pr5.vendedor.b@institutojef.org.br', 'Vendedor PR5 B', 'pr5.vendedor.b'),
  ('5c000000-0000-4000-8000-0000000000d1'::uuid, 'pr5.duas@institutojef.org.br', 'Pessoa PR5 Duas', 'pr5.duas')
) people(id, email, name, username);

-- 1. Sign-up joins the ACTIVE default cohort explicitly (membership and base role), never by a column default.
select is((select string_agg(cohort_id::text, ',') from public.user_cohorts where user_id = '5c000000-0000-4000-8000-0000000000d1'),
  pg_temp.a()::text, 'a new account joins the default cohort');
select is((select string_agg(role.key || '@' || user_role.cohort_id, ',') from cohort_data.user_roles user_role join public.roles role on role.id = user_role.role_id
  where user_role.user_id = '5c000000-0000-4000-8000-0000000000d1'), 'CONSUMIDOR@' || pg_temp.a(), 'with its base role in that cohort, named explicitly');
select ok(not private.cohort_fallback_enabled(), 'the rollout fallback is off');
select ok(position('is_default' in pg_get_functiondef('private.guard_cohort_write'::regproc)) = 0, 'the write guard never refers to the default cohort');

select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select public.set_cohort_membership(person, true, 'Entrada na turma B', gen_random_uuid())
from unnest(array['5c000000-0000-4000-8000-0000000000b1', '5c000000-0000-4000-8000-0000000000d1']::uuid[]) person;
select public.set_user_access('5c000000-0000-4000-8000-0000000000b1', array['VENDEDOR', 'CONSUMIDOR'], true, gen_random_uuid());
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select public.set_user_access('5c000000-0000-4000-8000-0000000000b1', array['CONSUMIDOR'], false, gen_random_uuid());

-- 2. Scoped writes without a cohort fail, whoever writes.
select pg_temp.sys();
select throws_ok($$insert into public.categories (name, slug, active, sort_order) values ('Sem turma', 'sem-turma-sys', true, 1)$$,
  '22023', 'COHORT_REQUIRED', 'the system cannot write a scoped row without naming the cohort');
select private.enter_cohort_context(pg_temp.b());
select lives_ok($$insert into public.categories (name, slug, active, sort_order) values ('Com turma', 'com-turma-sys', true, 1)$$, 'with the cohort named it can');
select is((select cohort_id from cohort_data.categories where slug = 'com-turma-sys'), pg_temp.b(), 'and the row belongs to that cohort');
select pg_temp.service();
select throws_ok($$insert into public.categories (name, slug, active, sort_order) values ('Worker', 'sem-turma-worker', true, 1)$$,
  '22023', 'COHORT_REQUIRED', 'a worker (service role) without context cannot write a scoped row');
select throws_ok($$insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload) values ('teste.sem.turma', 'tipo_desconhecido', 'x', '{}')$$,
  '22023', 'COHORT_REQUIRED', 'nor an outbox event of an unclassified type (NULL is never "cohort unknown")');
select lives_ok($$insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload) values ('teste.global', 'cohort', 'x', '{}')$$,
  'a truly global event (a classified global entity type) is recorded without cohort');

select pg_temp.ctx('5c000000-0000-4000-8000-0000000000d1', null);
select is(public.get_my_session() ->> 'cohort_mode', 'NONE', 'header removed: a person of two cohorts has no cohort');
select throws_ok($$select public.create_share_campaign('Sem turma', 'OUTRO', array[]::uuid[], 'pr5-none', gen_random_uuid())$$,
  '42501', null, 'and writes nothing');
select pg_temp.ctx('10000000-0000-4000-8000-000000000003', null);
select is(public.get_my_session() -> 'cohort' ->> 'id', pg_temp.a()::text, 'a person of one cohort has it resolved from the only membership');
select pg_temp.ctx(pg_temp.admin_a(), 'turma-a');
select is(public.get_my_session() ->> 'cohort_mode', 'NONE', 'a tampered header resolves to nothing');
select ok(not public.has_permission('catalog.manage'), 'and grants nothing');
select pg_temp.ctx('10000000-0000-4000-8000-000000000003', pg_temp.b()::text);
select is(public.get_my_session() ->> 'cohort_mode', 'NONE', 'a common user forcing another cohort gets nothing');
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.b()::text);
select throws_ok($$select public.save_catalog_category(null, null, 'Invasora', 'invasora', true, 1, 'ADMIN de A forçando B', 'pr5-cross', gen_random_uuid())$$,
  '42501', null, 'an ADMIN of A forcing B cannot write there');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok($$select public.save_catalog_category(null, null, 'Em todas', 'em-todas-pr5', true, 1, 'Escrita em todas', 'pr5-all', gen_random_uuid())$$,
  null, 'COHORT_REQUIRED', 'ADMIN_MASTER in "all" cannot write a scoped entity');
select pg_temp.ctx(pg_temp.master(), null);
select is(public.get_my_session() ->> 'cohort_mode', 'NONE', 'ADMIN_MASTER without a selection never gets the default cohort');
select throws_ok($$select public.save_catalog_category(null, null, 'Sem seleção', 'sem-selecao', true, 1, 'Master sem turma', 'pr5-master-none', gen_random_uuid())$$,
  null, 'COHORT_REQUIRED', 'and writes nothing without one');

-- 3. Default cohort: explicit, ADMIN_MASTER only, always exactly one ACTIVE.
select pg_temp.ctx(pg_temp.admin_a(), null);
select throws_ok(format($$select public.set_default_cohort(%L, 'Tentativa', gen_random_uuid())$$, pg_temp.b()), '42501', 'ADMIN_MASTER_REQUIRED',
  'an ADMIN cannot change the default cohort');
select pg_temp.ctx(pg_temp.master(), 'all');
select throws_ok(format($$select public.update_cohort(%L, 'Turma 2026', 'PREPARING', 'Voltar a preparar', gen_random_uuid())$$, pg_temp.a()),
  'P0001', 'DEFAULT_COHORT_MUST_BE_ACTIVE', 'the default cohort cannot leave ACTIVE');
select throws_ok(format($$select public.update_cohort(%L, 'Turma 2026', 'ARCHIVED', 'Arquivar', gen_random_uuid())$$, pg_temp.a()),
  'P0001', null, 'nor be archived before another default is chosen');
select public.update_cohort(pg_temp.id('cohort_c'), 'Turma PR5 C', 'ARCHIVED', 'Turma encerrada', gen_random_uuid());
select throws_ok(format($$select public.set_default_cohort(%L, 'Arquivada', gen_random_uuid())$$, pg_temp.id('cohort_c')), 'P0001', 'DEFAULT_COHORT_MUST_BE_ACTIVE',
  'an archived cohort cannot become the default');
select is((public.set_default_cohort(pg_temp.b(), 'Nova geração', gen_random_uuid()) ->> 'changed')::boolean, true, 'ADMIN_MASTER makes B the default');
select pg_temp.sys();
select is((select array_agg(id) from public.cohorts where is_default), array[pg_temp.b()], 'exactly one default: B');
select is((select count(*)::integer from cohort_data.audit_logs where action = 'cohorts.default.changed' and entity_id = pg_temp.b()::text and cohort_id is null), 1,
  'the change is audited as a global operation');
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '5c000000-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', 'pr5.novo@institutojef.org.br',
  extensions.crypt('Turmas123!', extensions.gen_salt('bf')), now(), '{}', '{"name": "Cadastro Novo", "username": "pr5.novo"}', now(), now());
select is((select string_agg(cohort_id::text, ',') from public.user_cohorts where user_id = '5c000000-0000-4000-8000-0000000000e1'),
  pg_temp.b()::text, 'a new sign-up now joins B');
select is((select count(*)::integer from cohort_data.categories where slug = 'sem-turma-sys'), 0, 'and no write ever went to a default cohort');
select pg_temp.ctx(pg_temp.master(), 'all');
select is((public.set_default_cohort(pg_temp.a(), 'Volta da turma 2026', gen_random_uuid()) ->> 'changed')::boolean, true, 'and back to Turma 2026');
select is((public.set_default_cohort(pg_temp.a(), 'De novo', gen_random_uuid()) ->> 'changed')::boolean, false, 'choosing the current default changes nothing');

-- 4. Visitors: default cohort without a reference; an ACTIVE cohort resolved server-side; nothing else.
select is(pg_temp.visitor_scope(null), array[pg_temp.a()], 'a visitor without a reference reads the default cohort');
select is(pg_temp.visitor_scope(pg_temp.b()::text), array[pg_temp.b()], 'a visitor sent to an ACTIVE cohort reads that cohort');
select is(pg_temp.visitor_scope(pg_temp.id('cohort_c')::text), '{}'::uuid[], 'an archived cohort is not public');
select is(pg_temp.visitor_scope('all'), '{}'::uuid[], 'a visitor never reads "all"');
select is(pg_temp.visitor_scope('turma-pr5-b'), '{}'::uuid[], 'nor a slug or anything that is not a resolved cohort id');
select pg_temp.ctx(null, null);
select is(public.resolve_public_cohort('turma-pr5-b') ->> 'id', pg_temp.b()::text, 'the public slug of B resolves to B');
select is(public.resolve_public_cohort('turma-pr5-c'), null, 'the slug of an archived cohort resolves to nothing');
select is(public.resolve_public_cohort('../2026'), null, 'an invalid slug resolves to nothing');

-- Share links resolve their own cohort.
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
insert into ids (name, code) select 'link_b', public.create_share_campaign('Campanha B', 'OUTRO', array[]::uuid[], 'pr5-link-b', gen_random_uuid()) ->> 'code';
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
insert into ids (name, code) select 'link_a', public.create_share_campaign('Campanha 2026', 'OUTRO', array[]::uuid[], 'pr5-link-a', gen_random_uuid()) ->> 'code';
select pg_temp.ctx(null, null);
select is(public.record_share_visit((select code from ids where name = 'link_b')) ->> 'cohort_slug', 'turma-pr5-b', 'a link of B opens B, resolved by the code');
select is((public.record_share_visit((select code from ids where name = 'link_a')) ->> 'cohort_is_default')::boolean, true, 'a link of Turma 2026 opens the default cohort');
select is(public.record_share_visit('zzzzzzzz'), null, 'an unknown code records nothing');
select pg_temp.sys();
select is((select string_agg(visit.cohort_id::text, ',' order by visit.cohort_id) from cohort_data.share_visits visit
  join cohort_data.share_campaigns campaign on campaign.id = visit.campaign_id where campaign.code in (select code from ids where code is not null)),
  (select string_agg(id::text, ',' order by id) from unnest(array[pg_temp.a(), pg_temp.b()]) id), 'each visit is recorded in the cohort of its link');
-- The origin cookie of a link holds only its code; attribution (attribute_reservation / attribute_online_sale, definer)
-- looks it up through public.share_campaigns, filtered by the request's cohort: a code of B never attributes in A.
-- The lookup runs as the function owner, with the caller's claims and cohort.
select pg_temp.ctx(pg_temp.master(), pg_temp.a()::text);
select set_config('role', 'postgres', true);
select is((select count(*)::integer from public.share_campaigns where code = (select code from ids where name = 'link_b')), 0,
  'inside A, the code of a link of B resolves to no campaign (its attribution is ignored)');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select set_config('role', 'postgres', true);
select is((select count(*)::integer from public.share_campaigns where code = (select code from ids where name = 'link_b')), 1,
  'inside B, the same code resolves to its campaign');

-- 5. Revoking access is immediate and names what remains; another ADMIN/FINANCEIRO takes over; nothing is changed.
select pg_temp.ctx('5c000000-0000-4000-8000-0000000000b1', pg_temp.b()::text);
insert into ids (name, id) select 'shift', (public.open_seller_shift((select id from public.stock_locations where seller_id = '5c000000-0000-4000-8000-0000000000b1'),
  1500, 'pr5-shift', gen_random_uuid()) ->> 'shift_id')::uuid;
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select is(public.set_user_access('5c000000-0000-4000-8000-0000000000b1', array['VENDEDOR', 'CONSUMIDOR'], false, gen_random_uuid()) -> 'pending_operations',
  '["OPEN_SHIFT"]'::jsonb, 'revoking access at once names the open shift that remains');
select pg_temp.sys();
select is((select status::text from cohort_data.seller_shifts where id = pg_temp.id('shift')), 'OPEN', 'and changes nothing of it');
select pg_temp.ctx('5c000000-0000-4000-8000-0000000000b1', pg_temp.b()::text);
select throws_ok(format($$select public.close_seller_shift(%L, 1500, null, 'pr5-self-close', gen_random_uuid())$$, pg_temp.id('shift')),
  '42501', null, 'the revoked person can no longer act');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select throws_ok(format($$select public.close_seller_shift_on_behalf(%L, 1500, null, 'pr5-behalf-nojust', gen_random_uuid())$$, pg_temp.id('shift')),
  '22023', 'INVALID_SELLER_SHIFT_CLOSE', 'closing on behalf needs a justification');
select is(public.close_seller_shift_on_behalf(pg_temp.id('shift'), 1500, 'Vendedor desligado; caixa conferido', 'pr5-behalf', gen_random_uuid()) ->> 'status',
  'CLOSED', 'another ADMIN or FINANCEIRO closes it on behalf');
select pg_temp.sys();
select is((select metadata ->> 'seller_id' from cohort_data.audit_logs where action = 'shifts.closed_on_behalf' and entity_id = pg_temp.id('shift')::text),
  '5c000000-0000-4000-8000-0000000000b1', 'the audit names the seller and the actor');

-- 6. Storage: a file path names a product; an ADMIN of A cannot write a file for a product of B.
select pg_temp.sys();
select private.enter_cohort_context(pg_temp.b());
with created as (
  insert into public.products (category_id, sku, slug, name, active, published, sellable_pdv, reservable, tracks_lots)
  values ((select id from cohort_data.categories where slug = 'com-turma-sys'), 'PR5-B-001', 'produto-pr5-b', 'Produto PR5 B', true, true, true, true, false)
  returning id)
insert into ids (name, id) select 'product_b', id from created;
select pg_temp.ctx(pg_temp.admin_a(), pg_temp.a()::text);
select throws_ok(format($$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('product-images', 'products/%s/%s.png', %L, '{}')$$,
  pg_temp.id('product_b'), gen_random_uuid(), pg_temp.admin_a()), '42501', null, 'an ADMIN of A cannot upload a file for a product of B');
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('product-images', 'products/33f00000-0000-4000-8000-000000000001/%s.png', %L, '{}')$$,
  gen_random_uuid(), pg_temp.admin_a()), 'but uploads for a product of A');
select pg_temp.ctx(pg_temp.master(), pg_temp.b()::text);
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id, metadata) values ('product-images', 'products/%s/%s.png', %L, '{}')$$,
  pg_temp.id('product_b'), gen_random_uuid(), pg_temp.master()), 'and B uploads for its own product');

select * from finish();
rollback;
