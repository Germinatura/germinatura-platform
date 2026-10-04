-- Module flags (decision of 01/10/2026, PRD "Flags de módulos gerenciais"): a simpler operation may switch off
-- cash shifts, procurement or events. Off, a flag refuses NEW operations of the module in the database; it never
-- refuses what closes or corrects work already started, and history stays readable. Flags never replace RBAC/RLS.

insert into public.feature_flags (key, description, enabled) values
  ('procurement', 'Compras e fornecedores: cadastro de fornecedores, pedidos de compra e recebimentos', true),
  ('events', 'Eventos e campanhas no Portal: criação, publicação e exibição aos consumidores', true)
on conflict (key) do nothing;

-- Cash shifts exist only for physical cash, so cash_payment also governs opening them (no redundant flag).
-- Flag definitions are immutable; Configurações explains the wider effect.

create function private.guard_cash_shift_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform private.require_feature('cash_payment');
  return new;
end;
$$;
-- Only opening is guarded: an open shift can always be closed and checked.
create trigger seller_shifts_feature_guard before insert on public.seller_shifts
for each row execute function private.guard_cash_shift_feature();

create function private.guard_procurement_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform private.require_feature('procurement');
  return new;
end;
$$;
-- New suppliers, supplier edits, new purchase orders and receipts. Cancelling an open order and paying or
-- reversing payables stay available, so switching the module off never strands a debt.
create trigger suppliers_feature_guard before insert or update on public.suppliers
for each row execute function private.guard_procurement_feature();
create trigger purchase_orders_feature_guard before insert on public.purchase_orders
for each row execute function private.guard_procurement_feature();
create trigger purchase_receipts_feature_guard before insert on public.purchase_receipts
for each row execute function private.guard_procurement_feature();

create function private.guard_events_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Cancelling a published event stays possible with the module off.
  if tg_op = 'UPDATE' and new.status = 'CANCELADO' and old.status <> 'CANCELADO' then
    return new;
  end if;
  perform private.require_feature('events');
  return new;
end;
$$;
create trigger portal_events_feature_guard before insert or update on public.portal_events
for each row execute function private.guard_events_feature();

revoke all on function private.guard_cash_shift_feature() from public, anon, authenticated, service_role;
revoke all on function private.guard_procurement_feature() from public, anon, authenticated, service_role;
revoke all on function private.guard_events_feature() from public, anon, authenticated, service_role;
