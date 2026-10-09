-- ADR 0011: one rule for a cohort's public slug (1 to 32 characters, lowercase letters, digits and hyphens, starting and
-- ending with a letter or digit), the same in the database, the contract, the API, the admin form and ?turma=.
begin;
select plan(13);

create function pg_temp.as_master() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.headers', '{"x-germinatura-cohort":"all"}', true);
  perform set_config('role', 'authenticated', true);
  perform set_config('germinatura.cohort_scope', '', true);
end;
$$;
create function pg_temp.create(p_slug text, p_year integer, p_status text default 'ACTIVE') returns jsonb language sql as $$
  select public.create_cohort('Turma ' || p_year, p_year, p_slug, p_status::public.cohort_status, 'slug-' || p_year || '-' || md5(p_slug), gen_random_uuid())
$$;
create temp table made (name text primary key, id uuid);
grant all on made to authenticated;

select pg_temp.as_master();
-- 32 characters: valid.
insert into made select 'max', (pg_temp.create('a' || repeat('b', 30) || 'c', 2091) ->> 'id')::uuid;
reset role;
select is((select slug from public.cohorts where id = (select id from made where name = 'max')), 'a' || repeat('b', 30) || 'c',
  'a 32-character slug is accepted');
select is(length((select slug from public.cohorts where id = (select id from made where name = 'max'))), 32, 'and stored with 32 characters');

-- 33 characters and invalid formats: refused (the API answers 422 INVALID_COHORT).
select pg_temp.as_master();
select throws_ok($$select pg_temp.create('a' || repeat('b', 31) || 'c', 2092)$$, '22023', 'INVALID_COHORT', 'a 33-character slug is refused');
select throws_ok($$select pg_temp.create('-turma', 2092)$$, '22023', 'INVALID_COHORT', 'a slug cannot start with a hyphen');
select throws_ok($$select pg_temp.create('turma-', 2092)$$, '22023', 'INVALID_COHORT', 'a slug cannot end with a hyphen');
select throws_ok($$select pg_temp.create('turma_2092', 2092)$$, '22023', 'INVALID_COHORT', 'a slug has no underscore');
select throws_ok($$select pg_temp.create('turma 2092', 2092)$$, '22023', 'INVALID_COHORT', 'a slug has no space');

-- Duplicate slug (another year): refused (the API answers 409 COHORT_ALREADY_EXISTS).
select throws_ok(format($$select pg_temp.create(%L, 2093)$$, 'a' || repeat('b', 30) || 'c'), 'P0001', 'COHORT_ALREADY_EXISTS',
  'a duplicate slug is refused');

-- The table itself refuses what the rule refuses.
reset role;
select throws_ok($$insert into public.cohorts (name, year, slug, status) values ('Direta', 2094, 'a' || repeat('b', 31) || 'c', 'PREPARING')$$,
  '23514', null, 'the database check refuses 33 characters even outside the RPC');

-- Public ?turma=: an ACTIVE cohort resolves by its slug; once archived, it resolves to nothing (404, never the default).
select is(public.resolve_public_cohort('a' || repeat('b', 30) || 'c') ->> 'id', (select id::text from made where name = 'max'),
  'the public slug of an ACTIVE cohort resolves to it');
select pg_temp.as_master();
select lives_ok(format($$select public.update_cohort(%L, 'Turma 2091', 'ARCHIVED', 'Fim do teste de slug', gen_random_uuid())$$,
  (select id from made where name = 'max')), 'the cohort is archived');
reset role;
select is(public.resolve_public_cohort('a' || repeat('b', 30) || 'c'), null, 'the slug of an archived cohort resolves to nothing');
select is(public.resolve_public_cohort('a' || repeat('b', 31) || 'c'), null, 'a 33-character slug resolves to nothing');

select * from finish();
rollback;
