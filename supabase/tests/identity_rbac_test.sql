begin;
select plan(27);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'roles', 'roles table exists');
select has_table('public', 'permissions', 'permissions table exists');
select has_table('public', 'user_roles', 'user_roles table exists');
select has_table('public', 'role_permissions', 'role_permissions table exists');
select has_function('public', 'has_permission', array['text'], 'permission function exists');
select has_function('public', 'get_my_session', 'session function exists');
select results_eq('select count(*)::bigint from public.roles', array[7::bigint], 'all v2.1 roles are seeded');
select results_eq('select count(*)::bigint from public.permissions', array[18::bigint], 'permission catalog is seeded');
select results_eq('select count(*)::bigint from public.profiles', array[3::bigint], 'local users receive profiles');

select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'ADMIN'$$, array[18::bigint], 'administrator receives every permission');
select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'VENDEDOR'$$, array[8::bigint], 'seller permission matrix is seeded');
select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'ESTOQUE'$$, array[4::bigint], 'inventory permission matrix is seeded');
select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'FINANCEIRO'$$, array[3::bigint], 'finance permission matrix is seeded');
select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'COMUNICACAO'$$, array[2::bigint], 'communications permission matrix is seeded');
select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'MODERADOR'$$, array[2::bigint], 'moderator permission matrix is seeded');
select results_eq($$select count(*)::bigint from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'CONSUMIDOR'$$, array[4::bigint], 'consumer permission matrix is seeded');

select results_eq(
  $$select count(*)::bigint from pg_class where oid in ('public.profiles'::regclass, 'public.roles'::regclass, 'public.permissions'::regclass, 'public.user_roles'::regclass, 'public.role_permissions'::regclass) and relrowsecurity$$,
  array[5::bigint],
  'every public foundation table has RLS enabled'
);
select results_eq(
  $$select count(*)::bigint from pg_policies where schemaname = 'public' and tablename in ('profiles', 'roles', 'permissions', 'user_roles', 'role_permissions') and cmd in ('INSERT', 'UPDATE', 'DELETE')$$,
  array[0::bigint],
  'authenticated users have no self-service write policy for RBAC tables'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
select ok(public.has_permission('users.manage'), 'administrator can manage users');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000002';
select ok(not public.has_permission('users.manage'), 'seller cannot manage users');
set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000003';
select ok(not public.has_permission('admin.access'), 'consumer cannot access administration');
insert into public.user_roles (user_id, role_id) values ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004');
select ok(public.has_permission('inventory.manage'), 'a user can hold multiple roles and receives their combined permissions');

select results_eq($$select count(*)::bigint from storage.buckets where id = 'product-images'$$, array[1::bigint], 'product image bucket exists');
select ok((select allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp'] from storage.buckets where id = 'product-images'), 'product image MIME types are restricted');
select results_eq($$select file_size_limit from storage.buckets where id = 'product-images'$$, array[10485760::bigint], 'product image size is limited');
select results_eq($$select count(*)::bigint from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'catalog_images_%'$$, array[4::bigint], 'storage policies cover read and managed writes');

select * from finish();
rollback;
