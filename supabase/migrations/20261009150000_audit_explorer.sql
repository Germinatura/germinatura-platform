-- Etapa 9 (AUD-001, spec 5.16): administrators investigate what happened without editing history. Search by
-- period, user, action, entity, correlation and severity, and follow one correlation across sale, payment,
-- stock, finance and outbox. Read-only over the existing immutable records.

insert into public.permissions (key, description) values
  ('audit.read', 'Investigar a auditoria')
on conflict (key) do update set description = excluded.description;
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role cross join public.permissions permission
where role.key = 'ADMIN' and permission.key = 'audit.read'
on conflict do nothing;

create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc, id desc);
create index if not exists audit_logs_correlation_idx on public.audit_logs (correlation_id);
create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index if not exists stock_movements_correlation_idx on public.stock_movements (correlation_id);
create index if not exists financial_ledger_entries_correlation_idx on public.financial_ledger_entries (correlation_id);
create index if not exists payment_attempts_correlation_idx on public.payment_attempts (correlation_id);
create index if not exists sales_correlation_idx on public.sales (correlation_id);

-- Severity is derived from the action, so every past and future entry is classified the same way.
create function private.audit_severity(p_action text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_action ~ '(revers|refund|cancel|reopen|drawn|draw|roles|access|unlock|loss|adjust|bootstrap|divergen|payout|expired)' then 'HIGH'
    when p_action ~ '(settings|feature|flag|price|promotion|terminal|reconcil|payment|closeout|shift|transition|publish)' then 'MEDIUM'
    else 'LOW'
  end;
$$;
revoke all on function private.audit_severity(text) from public, anon, authenticated, service_role;

create function public.search_audit_logs(
  p_from date, p_to date, p_actor text default null, p_action text default null, p_entity_type text default null,
  p_entity_id text default null, p_correlation_id uuid default null, p_severity text default null,
  p_cursor_created_at timestamptz default null, p_cursor_id uuid default null, p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor text := nullif(btrim(p_actor), '');
  v_action text := nullif(lower(btrim(p_action)), '');
  v_entity_type text := nullif(lower(btrim(p_entity_type)), '');
  v_entity_id text := nullif(btrim(p_entity_id), '');
begin
  if auth.uid() is null or not public.has_permission('audit.read') then
    raise exception using errcode = '42501', message = 'AUDIT_READ_REQUIRED';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 or p_limit is null or p_limit not between 1 and 100
    or (p_severity is not null and p_severity not in ('LOW', 'MEDIUM', 'HIGH'))
    or (v_actor is not null and char_length(v_actor) > 80) or (v_action is not null and char_length(v_action) > 100)
    or (v_entity_type is not null and char_length(v_entity_type) > 64) or (v_entity_id is not null and char_length(v_entity_id) > 128)
    or ((p_cursor_created_at is null) <> (p_cursor_id is null)) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_FILTER';
  end if;

  return (
    with page as (
      select entry.id, entry.created_at, entry.action, entry.actor_id, entry.entity_type, entry.entity_id, entry.correlation_id,
        entry.metadata, coalesce(nullif(btrim(actor.display_name), ''), actor.email) as actor_name,
        row_number() over (order by entry.created_at desc, entry.id desc) as position
      from public.audit_logs entry
      left join public.profiles actor on actor.id = entry.actor_id
      where entry.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
        and entry.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
        and (v_action is null or entry.action like v_action || '%')
        and (v_entity_type is null or entry.entity_type = v_entity_type)
        and (v_entity_id is null or entry.entity_id = v_entity_id)
        and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
        and (p_severity is null or private.audit_severity(entry.action) = p_severity)
        and (v_actor is null or actor.display_name ilike '%' || v_actor || '%' or actor.email ilike '%' || v_actor || '%'
          or actor.username ilike '%' || v_actor || '%')
        and (p_cursor_created_at is null or (entry.created_at, entry.id) < (p_cursor_created_at, p_cursor_id))
      order by entry.created_at desc, entry.id desc
      limit p_limit + 1
    )
    select jsonb_build_object(
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'created_at', created_at, 'action', action, 'severity', private.audit_severity(action),
          'actor_id', actor_id, 'actor_name', actor_name, 'entity_type', entity_type, 'entity_id', entity_id,
          'correlation_id', correlation_id, 'metadata', metadata) order by position)
        from page where position <= p_limit), '[]'::jsonb),
      'next_cursor', (select jsonb_build_object('created_at', created_at, 'id', id) from page
        where position = p_limit and exists (select 1 from page where position = p_limit + 1)))
  );
end;
$$;

-- One correlation across every immutable record that carries it.
create function public.get_audit_correlation(p_correlation_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('audit.read') then
    raise exception using errcode = '42501', message = 'AUDIT_READ_REQUIRED';
  end if;
  if p_correlation_id is null then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_FILTER';
  end if;
  return jsonb_build_object(
    'correlation_id', p_correlation_id,
    'audit', coalesce((select jsonb_agg(jsonb_build_object('id', entry.id, 'created_at', entry.created_at, 'action', entry.action,
        'severity', private.audit_severity(entry.action), 'actor_name', coalesce(nullif(btrim(actor.display_name), ''), actor.email),
        'entity_type', entry.entity_type, 'entity_id', entry.entity_id, 'metadata', entry.metadata) order by entry.created_at, entry.id)
      from public.audit_logs entry left join public.profiles actor on actor.id = entry.actor_id
      where entry.correlation_id = p_correlation_id), '[]'::jsonb),
    'sales', coalesce((select jsonb_agg(jsonb_build_object('id', sale.id, 'status', sale.status, 'channel', sale.channel,
        'total_cents', sale.total_cents, 'created_at', sale.created_at) order by sale.created_at)
      from public.sales sale where sale.correlation_id = p_correlation_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', attempt.id, 'sale_id', attempt.sale_id, 'status', attempt.status,
        'integration_channel', attempt.integration_channel, 'amount_cents', attempt.amount_cents, 'created_at', attempt.created_at) order by attempt.created_at)
      from public.payment_attempts attempt where attempt.correlation_id = p_correlation_id), '[]'::jsonb),
    'stock_movements', coalesce((select jsonb_agg(jsonb_build_object('id', movement.id, 'movement_type', movement.movement_type,
        'source_type', movement.source_type, 'source_id', movement.source_id, 'created_at', movement.created_at,
        'items', (select jsonb_agg(jsonb_build_object('product_name', product.name, 'quantity', item.quantity) order by product.name)
          from public.stock_movement_items item join public.products product on product.id = item.product_id
          where item.movement_id = movement.id)) order by movement.created_at)
      from public.stock_movements movement where movement.correlation_id = p_correlation_id), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', entry.id, 'entry_type', entry.entry_type, 'sale_id', entry.sale_id,
        'amount_cents', entry.amount_cents, 'created_at', entry.created_at) order by entry.created_at)
      from public.financial_ledger_entries entry where entry.correlation_id = p_correlation_id), '[]'::jsonb),
    'cash_movements', coalesce((select jsonb_agg(jsonb_build_object('id', movement.id, 'movement_type', movement.movement_type,
        'shift_id', movement.shift_id, 'amount_cents', movement.amount_cents, 'created_at', movement.created_at) order by movement.created_at)
      from public.cash_movements movement where movement.correlation_id = p_correlation_id), '[]'::jsonb),
    'outbox', coalesce((select jsonb_agg(jsonb_build_object('topic', event.topic, 'status', event.status,
        'aggregate_type', event.aggregate_type, 'aggregate_id', event.aggregate_id, 'created_at', event.created_at) order by event.created_at)
      from (select * from public.outbox_events where payload ->> 'correlation_id' = p_correlation_id::text order by created_at limit 50) event), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.search_audit_logs(date, date, text, text, text, text, uuid, text, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_audit_correlation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.search_audit_logs(date, date, text, text, text, text, uuid, text, timestamptz, uuid, integer) to authenticated;
grant execute on function public.get_audit_correlation(uuid) to authenticated;
comment on function public.search_audit_logs(date, date, text, text, text, text, uuid, text, timestamptz, uuid, integer) is
  'AUD-001: audit search by São Paulo period, user, action prefix, entity, correlation and derived severity; keyset paginated.';
comment on function public.get_audit_correlation(uuid) is
  'AUD-001: every audit entry, sale, payment, stock movement, ledger entry, drawer movement and outbox event sharing a correlation.';
