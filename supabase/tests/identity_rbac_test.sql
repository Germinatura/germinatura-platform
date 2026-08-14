begin;
select plan(18);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'roles', 'roles table exists');
select has_table('public', 'permissions', 'permissions table exists');
select has_table('public', 'user_roles', 'user_roles table exists');
select has_table('public', 'role_permissions', 'role_permissions table exists');
select has_function('public', 'has_permission', array['text'], 'permission function exists');
select has_function('public', 'get_my_session', 'session function exists');
select results_eq('select count(*)::bigint from public.roles', array[3::bigint], 'three base roles are seeded');
select results_eq('select count(*)::bigint from public.permissions', array[16::bigint], 'permission catalog is seeded');
select results_eq('select count(*)::bigint from public.profiles', array[3::bigint], 'seed users receive profiles');
select results_eq(
  $$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'ADMIN'$$,
  array[16::bigint],
  'administrator receives every permission'
);
select results_eq(
  $$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'VENDEDOR'$$,
  array[8::bigint],
  'seller receives the initial PDV permission matrix'
);
select results_eq(
  $$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'CONSUMER'$$,
  array[4::bigint],
  'consumer receives the initial customer permission matrix'
);
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.roles'::regclass), 'roles has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.user_roles'::regclass), 'user_roles has RLS enabled');

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select ok(public.has_permission('users.manage'), 'administrator can manage users');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select ok(not public.has_permission('users.manage'), 'seller cannot manage users');

select * from finish();
rollback;
