-- get_my_session is the authority behind every Portal and PDV session (identity comes from the verified token):
-- it refuses ended sessions and another person's session, and always reflects the current state and roles.
begin;
select plan(9);

insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('5e551000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', now(), now(), 'Navegador do consumidor'),
  ('5e551000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', now(), now(), 'PDV do vendedor');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","session_id":"5e551000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.get_my_session() ->> 'auth_id', '10000000-0000-4000-8000-000000000003', 'a live session resolves');
select is(public.get_my_session() -> 'roles', '["CONSUMIDOR"]'::jsonb, 'roles come from the database');

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","session_id":"5e551000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.get_my_session(), null, 'another person''s session id does not resolve');

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","session_id":"5e551000-0000-4000-8000-0000000000ff","role":"authenticated"}';
select is(public.get_my_session(), null, 'a session that no longer exists does not resolve');

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(public.get_my_session() ->> 'auth_id', '10000000-0000-4000-8000-000000000003', 'like Auth, a token without a session id is not tied to one');

-- Ending the session (logout or "Sessões ativas") takes effect on the next resolution.
reset role;
delete from auth.sessions where id = '5e551000-0000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","session_id":"5e551000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.get_my_session(), null, 'an ended session stops resolving at once');

-- State and roles are read on every call, never cached in the token.
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at) values ('5e551000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', now(), now());
update public.profiles set active = false where id = '10000000-0000-4000-8000-000000000003';
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","session_id":"5e551000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"roles":["ADMIN"]},"user_metadata":{"role":"ADMIN"}}';
select is(public.get_my_session() ->> 'active', 'false', 'deactivation shows on the next resolution');
select is(public.get_my_session() -> 'roles', '["CONSUMIDOR"]'::jsonb, 'roles in the token metadata are ignored');

reset role;
insert into public.user_roles (user_id, role_id) select '10000000-0000-4000-8000-000000000003', id from public.roles where key = 'VENDEDOR';
set local role authenticated;
select is(public.get_my_session() -> 'roles', '["CONSUMIDOR", "VENDEDOR"]'::jsonb, 'a role change shows on the next resolution');

select * from finish();
rollback;
