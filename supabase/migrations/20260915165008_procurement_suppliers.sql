insert into public.permissions (key, description) values
  ('procurement.manage', 'Administrar fornecedores e compras')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role cross join public.permissions permission
where role.key in ('ADMIN', 'ESTOQUE') and permission.key = 'procurement.manage'
on conflict do nothing;

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  email text,
  phone text,
  document text,
  notes text,
  active boolean not null default true,
  revision integer not null default 1,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_name_valid check (char_length(name) between 2 and 160 and name = btrim(name)),
  constraint suppliers_contact_name_valid check (contact_name is null or (char_length(contact_name) between 2 and 160 and contact_name = btrim(contact_name))),
  constraint suppliers_email_valid check (email is null or (char_length(email) between 5 and 254 and email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')),
  constraint suppliers_phone_valid check (phone is null or (char_length(phone) between 5 and 40 and phone = btrim(phone))),
  constraint suppliers_document_valid check (document is null or (char_length(document) between 5 and 40 and document ~ '^[A-Z0-9]+$')),
  constraint suppliers_notes_valid check (notes is null or (char_length(notes) between 2 and 1000 and notes = btrim(notes))),
  constraint suppliers_contact_required check (contact_name is not null or email is not null or phone is not null),
  constraint suppliers_revision_valid check (revision > 0)
);

create unique index suppliers_document_unique on public.suppliers (document) where document is not null;
create index suppliers_name_idx on public.suppliers (lower(name), id);
create index suppliers_active_name_idx on public.suppliers (active, lower(name), id);

create trigger suppliers_set_updated_at before update on public.suppliers
for each row execute function private.set_updated_at();

alter table public.suppliers enable row level security;

create policy suppliers_read_procurement on public.suppliers
for select to authenticated
using ((select public.has_permission('procurement.manage')));

revoke all on table public.suppliers from public, anon, authenticated, service_role;
grant select on table public.suppliers to authenticated;

create function public.save_supplier(
  p_supplier_id uuid,
  p_expected_revision integer,
  p_name text,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_document text,
  p_notes text,
  p_active boolean,
  p_reason text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(p_name);
  v_contact_name text := nullif(btrim(p_contact_name), '');
  v_email text := nullif(lower(btrim(p_email)), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_document text := nullif(upper(regexp_replace(btrim(p_document), '[^[:alnum:]]', '', 'g')), '');
  v_notes text := nullif(btrim(p_notes), '');
  v_before public.suppliers%rowtype;
  v_supplier public.suppliers%rowtype;
  v_claim record;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if not public.has_permission('procurement.manage') then
    raise exception using errcode = '42501', message = 'PROCUREMENT_MANAGE_FORBIDDEN';
  end if;
  if v_name is null or char_length(v_name) not between 2 and 160
    or (v_contact_name is null and v_email is null and v_phone is null)
    or (v_contact_name is not null and char_length(v_contact_name) not between 2 and 160)
    or (v_email is not null and (char_length(v_email) not between 5 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
    or (v_phone is not null and char_length(v_phone) not between 5 and 40)
    or (v_document is not null and (char_length(v_document) not between 5 and 40 or v_document !~ '^[A-Z0-9]+$'))
    or (v_notes is not null and char_length(v_notes) not between 2 and 1000)
    or p_active is null or p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 4 and 500
    or p_correlation_id is null
    or (p_supplier_id is null and p_expected_revision is not null)
    or (p_supplier_id is not null and (p_expected_revision is null or p_expected_revision < 1)) then
    raise exception using errcode = '22023', message = 'INVALID_SUPPLIER';
  end if;

  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('procurement', 'supplier_save', v_actor),
    p_idempotency_key,
    jsonb_build_object(
      'id', p_supplier_id, 'revision', p_expected_revision, 'name', v_name,
      'contact_name', v_contact_name, 'email', v_email, 'phone', v_phone,
      'document', v_document, 'notes', v_notes, 'active', p_active, 'reason', p_reason
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  if p_supplier_id is null then
    insert into public.suppliers (
      name, contact_name, email, phone, document, notes, active, created_by, updated_by
    ) values (
      v_name, v_contact_name, v_email, v_phone, v_document, v_notes, p_active, v_actor, v_actor
    ) returning * into v_supplier;
  else
    select * into v_before from public.suppliers where id = p_supplier_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'SUPPLIER_NOT_FOUND';
    end if;
    if v_before.revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'SUPPLIER_REVISION_CONFLICT';
    end if;
    update public.suppliers set
      name = v_name, contact_name = v_contact_name, email = v_email, phone = v_phone,
      document = v_document, notes = v_notes, active = p_active,
      revision = revision + 1, updated_by = v_actor
    where id = p_supplier_id returning * into v_supplier;
  end if;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values (
    case when p_supplier_id is null then 'procurement.supplier.created' else 'procurement.supplier.updated' end,
    v_actor, 'supplier', v_supplier.id::text, p_correlation_id,
    jsonb_build_object(
      'reason', p_reason,
      'before', case when p_supplier_id is null then null else to_jsonb(v_before) end,
      'after', to_jsonb(v_supplier)
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    case when p_supplier_id is null then 'procurement.supplier.created' else 'procurement.supplier.updated' end,
    'supplier', v_supplier.id::text,
    jsonb_build_object('supplier_id', v_supplier.id, 'revision', v_supplier.revision, 'active', v_supplier.active, 'correlation_id', p_correlation_id)
  );

  v_result := jsonb_build_object(
    'id', v_supplier.id,
    'name', v_supplier.name,
    'contactName', v_supplier.contact_name,
    'email', v_supplier.email,
    'phone', v_supplier.phone,
    'document', v_supplier.document,
    'notes', v_supplier.notes,
    'active', v_supplier.active,
    'revision', v_supplier.revision,
    'createdAt', v_supplier.created_at,
    'updatedAt', v_supplier.updated_at,
    'correlationId', p_correlation_id
  );
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'supplier', v_supplier.id::text);
  return v_result;
end;
$$;

revoke all on function public.save_supplier(uuid,integer,text,text,text,text,text,text,boolean,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_supplier(uuid,integer,text,text,text,text,text,text,boolean,text,text,uuid)
  to authenticated;

comment on table public.suppliers is 'PROC-001 supplier registry; retained and inactivated instead of deleted once used by procurement history.';
comment on function public.save_supplier(uuid,integer,text,text,text,text,text,text,boolean,text,text,uuid)
  is 'Audited and idempotent supplier create/update command with optimistic concurrency and no direct table writes.';
