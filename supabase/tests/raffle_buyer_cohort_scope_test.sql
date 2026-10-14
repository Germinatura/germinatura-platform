-- C: the PDV's registered-buyer lookup and the raffle reservation only know people of the operation's cohort.
begin;
select plan(27);

create function pg_temp.ctx(p_user uuid, p_header text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then '' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  perform set_config('request.headers', case when p_header is null then '{}' else json_build_object('x-germinatura-cohort', p_header)::text end, true);
end;
$$;
-- An identity created the way Auth does it (no request JWT, no username: it stays technical until materialized).
create function pg_temp.identity(p_id uuid, p_email text) returns void language sql as $$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email, '', now(), '{}', '{}', now(), now())
$$;
-- A person of a given cohort: domain user created there, onboarded with name and username.
create function pg_temp.person(p_id uuid, p_email text, p_username text, p_name text, p_cohort uuid) returns void language plpgsql as $$
begin
  perform pg_temp.identity(p_id, p_email);
  perform private.materialize_identity(p_id, gen_random_uuid(), p_cohort);
  update public.profiles set display_name = p_name, username = p_username, onboarding_completed_at = now() where id = p_id;
end;
$$;
create function pg_temp.a() returns uuid language sql as $$ select 'c0000000-0000-4000-8000-000000002026'::uuid $$;

select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
create temp table cohort_b on commit drop as
  select (public.create_cohort('Turma Rifa B', 2062, 'turma-rifa-b', 'ACTIVE', 'c-raffle-b', gen_random_uuid()) ->> 'id')::uuid as id;
grant select on cohort_b to authenticated;
create function pg_temp.b() returns uuid language sql as $$ select id from cohort_b $$;
select pg_temp.ctx(null, null);
-- Buyer and seller of cohort B (ADMIN of B holds raffles.sell there).
select pg_temp.person('1c000000-0000-4000-8000-0000000000b1', 'comprador.b@institutojef.org.br', 'comprador.b', 'Comprador da Turma B', pg_temp.b());
select pg_temp.person('1c000000-0000-4000-8000-0000000000b2', 'gestor.b@institutojef.org.br', 'gestor.b', 'Gestor da Turma B', pg_temp.b());
insert into cohort_data.user_roles (user_id, role_id, cohort_id) select '1c000000-0000-4000-8000-0000000000b2', id, pg_temp.b() from public.roles where key = 'ADMIN';
-- In cohort A: a sign-up attempt (technical identity only), a legacy profile that never confirmed, an inactive person.
select pg_temp.identity('1c000000-0000-4000-8000-0000000000a1', 'tentativa.a@institutojef.org.br');
select pg_temp.identity('1c000000-0000-4000-8000-0000000000a2', 'legado.a@institutojef.org.br');
delete from private.signup_attempts where user_id = '1c000000-0000-4000-8000-0000000000a2';
insert into public.profiles (id, email, display_name) values ('1c000000-0000-4000-8000-0000000000a2', 'legado.a@institutojef.org.br', 'Legado A');
select pg_temp.person('1c000000-0000-4000-8000-0000000000a3', 'inativo.a@institutojef.org.br', 'inativo.a', 'Inativo A', pg_temp.a());
update public.profiles set active = false where id = '1c000000-0000-4000-8000-0000000000a3';

-- A raffle of cohort A, sold by the seller of A.
select pg_temp.ctx('10000000-0000-4000-8000-000000000001', pg_temp.a()::text);
create temp table campaign_a on commit drop as select (public.create_raffle_campaign('Rifa da Turma A', '33f00000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 20, now() - interval '1 minute', now() + interval '1 day', 'c-raffle-a', gen_random_uuid()) ->> 'campaign_id')::uuid as id;
grant select on campaign_a to authenticated;
select public.transition_raffle_campaign((select id from campaign_a), 'PUBLISH', 'c-raffle-a-publish', gen_random_uuid());

-- Cohort A, seller of A.
select pg_temp.ctx('10000000-0000-4000-8000-000000000002', pg_temp.a()::text);
set local role authenticated;
select is(public.find_raffle_buyer('consumidor.teste@institutojef.org.br') ->> 'profile_id', '10000000-0000-4000-8000-000000000003', 'A: buyer of A by e-mail');
select is(public.find_raffle_buyer('consumidor.teste') ->> 'profile_id', '10000000-0000-4000-8000-000000000003', 'A: buyer of A by username');
select is(public.find_raffle_buyer('comprador.b@institutojef.org.br'), null, 'A: buyer of B by e-mail is not found');
select is(public.find_raffle_buyer('comprador.b'), null, 'A: buyer of B by username is not found');
select is(public.find_raffle_buyer('ninguem.existe@institutojef.org.br'), null, 'A: an unknown identifier: same answer as B');
select is(public.find_raffle_buyer('tentativa.a@institutojef.org.br'), null, 'A: a sign-up attempt is not a buyer');
select is(public.find_raffle_buyer('legado.a@institutojef.org.br'), null, 'A: a legacy profile that never confirmed is not a buyer');
select is(public.find_raffle_buyer('inativo.a'), null, 'A: an inactive person is not a buyer');
select ok(public.find_raffle_buyer('consumidor.teste')::text not like '%Turma B%', 'A: no display name of B in any answer');

-- The reservation applies the same rule to the profile id the client sends.
select throws_ok($$select public.reserve_raffle_numbers_pdv((select id from campaign_a), '50000000-0000-4000-8000-000000000002', array[1],
  '1c000000-0000-4000-8000-0000000000b1', null, null, 'c-raffle-b-buyer', gen_random_uuid())$$, '22023', 'RAFFLE_BUYER_REQUIRED', 'A: a buyer of B cannot be attached by id');
select throws_ok($$select public.reserve_raffle_numbers_pdv((select id from campaign_a), '50000000-0000-4000-8000-000000000002', array[1],
  gen_random_uuid(), null, null, 'c-raffle-unknown-buyer', gen_random_uuid())$$, '22023', 'RAFFLE_BUYER_REQUIRED', 'A: an unknown id fails the same way');
select throws_ok($$select public.reserve_raffle_numbers_pdv((select id from campaign_a), '50000000-0000-4000-8000-000000000002', array[1],
  '1c000000-0000-4000-8000-0000000000a2', null, null, 'c-raffle-legacy-buyer', gen_random_uuid())$$, '22023', 'RAFFLE_BUYER_REQUIRED', 'A: a legacy profile cannot be attached');
select is(public.reserve_raffle_numbers_pdv((select id from campaign_a), '50000000-0000-4000-8000-000000000002', array[1],
  '10000000-0000-4000-8000-000000000003', null, null, 'c-raffle-a-buyer', gen_random_uuid()) -> 'numbers', '[1]'::jsonb, 'A: the buyer of A is attached');
select is(public.reserve_raffle_numbers_pdv((select id from campaign_a), '50000000-0000-4000-8000-000000000002', array[2],
  null, 'Comprador Externo', 'externo@exemplo.com', 'c-raffle-walk-in', gen_random_uuid()) -> 'numbers', '[2]'::jsonb, 'A: the walk-in path is unchanged');
reset role;

-- Cohort B, mirrored.
select pg_temp.ctx('1c000000-0000-4000-8000-0000000000b2', pg_temp.b()::text);
set local role authenticated;
select is(public.find_raffle_buyer('comprador.b@institutojef.org.br') ->> 'display_name', 'Comprador da Turma B', 'B: buyer of B by e-mail');
select is(public.find_raffle_buyer('comprador.b') ->> 'profile_id', '1c000000-0000-4000-8000-0000000000b1', 'B: buyer of B by username');
select is(public.find_raffle_buyer('consumidor.teste@institutojef.org.br'), null, 'B: buyer of A by e-mail is not found');
select is(public.find_raffle_buyer('consumidor.teste'), null, 'B: buyer of A by username is not found');
select is(public.find_raffle_buyer('ninguem.existe@institutojef.org.br'), null, 'B: an unknown identifier: same answer as A');
reset role;

-- ADMIN_MASTER: the concrete cohort selected for the operation; "all" is not a sale context.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.a()::text);
set local role authenticated;
select is(public.find_raffle_buyer('consumidor.teste') ->> 'profile_id', '10000000-0000-4000-8000-000000000003', 'master in A: finds A');
select is(public.find_raffle_buyer('comprador.b'), null, 'master in A: does not find B');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', pg_temp.b()::text);
select is(public.find_raffle_buyer('comprador.b') ->> 'profile_id', '1c000000-0000-4000-8000-0000000000b1', 'master in B: finds B');
select is(public.find_raffle_buyer('consumidor.teste'), null, 'master in B: does not find A');
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', 'all');
select throws_ok($$select public.find_raffle_buyer('consumidor.teste')$$, '22023', 'COHORT_REQUIRED', 'master in "all": refused');
reset role;

-- No fallback: without a determinable cohort the lookup is refused, never answered from the default cohort.
select pg_temp.ctx('10000000-0000-4000-8000-000000000005', null);
set local role authenticated;
select throws_ok($$select public.find_raffle_buyer('consumidor.teste')$$, '22023', 'COHORT_REQUIRED', 'no cohort: refused, no default fallback');
reset role;
select ok(not has_function_privilege('authenticated', 'private.raffle_buyer_eligible(uuid,uuid)', 'EXECUTE'), 'the eligibility helper is internal');
select ok(not has_function_privilege('anon', 'public.find_raffle_buyer(text)', 'EXECUTE'), 'anonymous lookup denied');

select * from finish();
rollback;
