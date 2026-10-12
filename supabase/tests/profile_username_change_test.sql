begin;
select plan(22);

-- Grants: only a signed-in person edits, and only their own profile.
select ok(not has_function_privilege('anon','public.update_my_profile(integer,text,text,text,text,text,text[],text,uuid)','EXECUTE'),'anonymous edit denied');
select ok(has_function_privilege('authenticated','public.update_my_profile(integer,text,text,text,text,text,text[],text,uuid)','EXECUTE'),'signed-in edit allowed');

-- No domain relation may depend on the username: nothing references profiles.username.
select is((select count(*)::integer from pg_constraint fk
  where fk.contype = 'f' and fk.confrelid = 'public.profiles'::regclass
    and (select attnum from pg_attribute where attrelid = 'public.profiles'::regclass and attname = 'username') = any (fk.confkey)),
  0, 'no foreign key points at the username');

create temporary table history_before on commit drop as
select (select count(*) from cohort_data.user_roles where user_id = '10000000-0000-4000-8000-000000000003') as roles,
  (select count(*) from public.user_cohorts where user_id = '10000000-0000-4000-8000-000000000003') as memberships;
grant select on history_before to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select is(public.update_my_profile(0,'Consumidor Local',' Consumidor.Novo ',null,'','',array[]::text[],'username-1','99000000-0000-4000-8000-000000000001'),
  '{"revision": 1, "username": "consumidor.novo"}'::jsonb, 'username changed, trimmed and lowercased with the sign-up rule');
select is(public.update_my_profile(0,'Consumidor Local','consumidor.novo',null,'','',array[]::text[],'username-1','99000000-0000-4000-8000-000000000002'),
  '{"revision": 1, "username": "consumidor.novo"}'::jsonb, 'replay of the same key answers the same');
select throws_ok($$select public.update_my_profile(1,'Consumidor Local','vendedor.teste',null,'','',array[]::text[],'username-taken','99000000-0000-4000-8000-000000000001')$$,
  '23505','USERNAME_ALREADY_USED','a username in use by someone else is refused');
select throws_ok($$select public.update_my_profile(1,'Consumidor Local','1abc',null,'','',array[]::text[],'username-invalid','99000000-0000-4000-8000-000000000001')$$,
  '22023','INVALID_USERNAME','a username outside the sign-up rule is refused');
select throws_ok($$select public.update_my_profile(1,'Consumidor Local',null,null,'','',array[]::text[],'username-null','99000000-0000-4000-8000-000000000001')$$,
  '22023','INVALID_USERNAME','the username cannot be removed');
select is((select username from public.profiles where id = auth.uid()), 'consumidor.novo', 'refused changes keep the saved username');
select is(public.update_my_profile(1,'Consumidor Renomeado','consumidor.novo',null,'','',array[]::text[],'username-same','99000000-0000-4000-8000-000000000001')->>'revision',
  '2', 'other fields save with the username unchanged');
-- The earlier signature (Portal still being replaced during a deploy) keeps the current username.
select is(public.update_my_profile(2,'Consumidor Local',null,'','',array[]::text[],'username-legacy','99000000-0000-4000-8000-000000000001')->>'username',
  'consumidor.novo', 'the earlier signature keeps the current username');
select is((select roles from history_before), (select count(*) from cohort_data.user_roles where user_id = auth.uid()), 'roles untouched');
reset role;

select is((select memberships from history_before), (select count(*) from public.user_cohorts where user_id = '10000000-0000-4000-8000-000000000003'), 'memberships untouched');
select is((select count(*)::integer from cohort_data.audit_logs where action = 'profile.username_changed'), 1, 'one username change, one audit entry');
select is((select metadata from cohort_data.audit_logs where action = 'profile.username_changed'),
  '{"username": "consumidor.novo", "previous_username": "consumidor.teste"}'::jsonb, 'audit keeps the previous and the new username');
select is((select count(*)::integer from cohort_data.audit_logs where action = 'profile.updated' and (metadata->>'username_changed')::boolean), 1,
  'only the save that changed it is flagged');
select is((select count(*)::integer from cohort_data.outbox_events where topic = 'auth.username.changed'
  and aggregate_id = '10000000-0000-4000-8000-000000000003'), 1, 'one outbox event for the change');
-- Login follows the new handle; the old one no longer resolves to anybody.
select is(public.resolve_login_identifier('consumidor.novo')->>'user_id', '10000000-0000-4000-8000-000000000003', 'login resolves the new username');
select ok(public.resolve_login_identifier('consumidor.teste') is null,
  'the previous username no longer resolves');

-- The confirmed e-mail cannot change, through Auth or any other path.
select throws_ok($$update auth.users set email = 'outra.pessoa@institutojef.org.br' where id = '10000000-0000-4000-8000-000000000003'$$,
  '42501', 'EMAIL_IMMUTABLE', 'the e-mail cannot be swapped');
select throws_ok($$update auth.users set email_change = 'outra.pessoa@gmail.com' where id = '10000000-0000-4000-8000-000000000003'$$,
  '42501', 'EMAIL_IMMUTABLE', 'an e-mail change cannot even be requested');
select lives_ok($$update auth.users set last_sign_in_at = now() where id = '10000000-0000-4000-8000-000000000003'$$,
  'other Auth updates (sign-in) still work');

select * from finish();
rollback;
