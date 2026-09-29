-- Spec 4.2 / 4.7 (NOTIF-004): per-user notification preferences, "avise-me quando voltar" per product and a
-- yes/no Portal availability flag. Preferences only silence optional categories; operational notices and
-- transactional notices about the user's own reservations, payments and raffle numbers are always delivered.

create type public.notification_category as enum ('NOVOS_PRODUTOS', 'PROMOCOES', 'ESTOQUE_DE_VOLTA', 'EVENTOS', 'RIFAS', 'COMUNICADOS');

create table public.notification_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  category public.notification_category not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public, anon, authenticated, service_role;
grant select on public.notification_preferences to authenticated;
create policy notification_preferences_own_read on public.notification_preferences for select to authenticated
using (user_id = (select auth.uid()));

-- Every optional category is on until the user turns it off.
create function private.wants_notification(p_user_id uuid, p_category public.notification_category)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select enabled from public.notification_preferences where user_id = p_user_id and category = p_category), true);
$$;

create function public.get_my_notification_preferences()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  return (select jsonb_agg(jsonb_build_object('category', category, 'enabled', private.wants_notification(auth.uid(), category))
    order by category) from unnest(enum_range(null::public.notification_category)) category);
end;
$$;

create function public.set_notification_preference(p_category public.notification_category, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_category is null or p_enabled is null then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_PREFERENCE';
  end if;
  -- Setting a preference is naturally idempotent: the final state is the requested one.
  insert into public.notification_preferences (user_id, category, enabled) values (v_actor_id, p_category, p_enabled)
  on conflict (user_id, category) do update set enabled = excluded.enabled, updated_at = now();
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('notifications.preference.set', v_actor_id, 'profile', v_actor_id::text, gen_random_uuid(),
    jsonb_build_object('category', p_category, 'enabled', p_enabled));
  return jsonb_build_object('category', p_category, 'enabled', p_enabled);
end;
$$;

-- "Avise-me quando voltar": one pending alert per user and product; it fires once and can be renewed.
create table public.product_stock_alerts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (user_id, product_id)
);
create index product_stock_alerts_pending_idx on public.product_stock_alerts (product_id) where notified_at is null;
alter table public.product_stock_alerts enable row level security;
revoke all on public.product_stock_alerts from public, anon, authenticated, service_role;
grant select on public.product_stock_alerts to authenticated;
create policy product_stock_alerts_own_read on public.product_stock_alerts for select to authenticated
using (user_id = (select auth.uid()));

-- Portal availability is a yes/no answer about the central stock; quantities are never exposed.
create function public.portal_availability(p_product_ids uuid[])
returns table (product_id uuid, available boolean) language sql stable security definer set search_path = '' as $$
  select product.id, coalesce(balance.available_quantity > 0, false)
  from public.products product
  join public.stock_locations location on location.location_type = 'CENTRAL' and location.active
  left join public.inventory_balances balance on balance.product_id = product.id and balance.location_id = location.id
  where product.id = any (coalesce(p_product_ids, '{}')) and product.active and product.published
    and cardinality(coalesce(p_product_ids, '{}')) <= 100;
$$;

create function public.set_stock_alert(p_product_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null or not public.has_permission('catalog.read') then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  if p_product_id is null or p_enabled is null
    or not exists (select 1 from public.products where id = p_product_id and active and published) then
    raise exception using errcode = '22023', message = 'INVALID_STOCK_ALERT';
  end if;
  if p_enabled then
    if coalesce((select available from public.portal_availability(array[p_product_id])), false) then
      raise exception using errcode = 'P0001', message = 'PRODUCT_AVAILABLE';
    end if;
    insert into public.product_stock_alerts (user_id, product_id) values (v_actor_id, p_product_id)
    on conflict (user_id, product_id) do update set created_at = now(), notified_at = null;
  else
    delete from public.product_stock_alerts where user_id = v_actor_id and product_id = p_product_id;
  end if;
  return jsonb_build_object('product_id', p_product_id, 'enabled', p_enabled);
end;
$$;

-- A published product whose central stock goes from none to some wakes up its pending alerts.
create function private.emit_back_in_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.available_quantity <= 0 and new.available_quantity > 0
    and exists (select 1 from public.stock_locations where id = new.location_id and location_type = 'CENTRAL' and active)
    and exists (select 1 from public.product_stock_alerts where product_id = new.product_id and notified_at is null) then
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('catalog.product.back_in_stock', 'product', new.product_id::text,
      jsonb_build_object('product_id', new.product_id, 'location_id', new.location_id));
  end if;
  return new;
end;
$$;
create trigger inventory_balances_back_in_stock after update of on_hand_quantity, reserved_quantity on public.inventory_balances
for each row execute function private.emit_back_in_stock();

revoke all on function private.wants_notification(uuid, public.notification_category) from public, anon, authenticated, service_role;
revoke all on function private.emit_back_in_stock() from public, anon, authenticated, service_role;
revoke all on function public.get_my_notification_preferences() from public, anon, authenticated, service_role;
revoke all on function public.set_notification_preference(public.notification_category, boolean) from public, anon, authenticated, service_role;
revoke all on function public.set_stock_alert(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.portal_availability(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_my_notification_preferences() to authenticated;
grant execute on function public.set_notification_preference(public.notification_category, boolean) to authenticated;
grant execute on function public.set_stock_alert(uuid, boolean) to authenticated;
grant execute on function public.portal_availability(uuid[]) to anon, authenticated;

-- Announcements respect COMUNICADOS; back-in-stock alerts respect ESTOQUE_DE_VOLTA.
create or replace function public.worker_process_outbox_event(p_event_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.outbox_events%rowtype;
  v_recipient_id uuid;
  v_count integer := 0;
  v_draw public.raffle_draws%rowtype;
  v_number record;
  v_staff record;
begin
  perform private.assert_worker_role();
  select * into v_event from public.outbox_events
  where id = p_event_id and status = 'PROCESSING' and locked_by = p_worker_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'OUTBOX_CLAIM_MISMATCH';
  end if;

  if public.is_feature_enabled('notifications') then
    if v_event.topic in ('auth.roles.changed', 'auth.password_recovery.unlocked', 'auth.signup_code.unlocked') then
      v_recipient_id := v_event.aggregate_id::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id, 'ACCOUNT_UPDATED',
        'Sua conta foi atualizada', 'Uma configuração de acesso da sua conta foi alterada por um administrador.',
        jsonb_build_object('topic', v_event.topic));
    elsif v_event.topic in ('reservations.created', 'reservations.converted', 'reservations.expired') then
      select customer_id into v_recipient_id from public.commercial_reservations
      where id = v_event.aggregate_id::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id,
        case v_event.topic when 'reservations.created' then 'RESERVATION_CREATED'
          when 'reservations.converted' then 'RESERVATION_CONVERTED' else 'RESERVATION_EXPIRED' end,
        case v_event.topic when 'reservations.created' then 'Reserva criada'
          when 'reservations.converted' then 'Reserva convertida' else 'Reserva expirada' end,
        case v_event.topic when 'reservations.created' then 'Seus produtos ficaram reservados por tempo limitado.'
          when 'reservations.converted' then 'Sua reserva foi convertida em uma cobrança.'
          else 'O prazo da sua reserva terminou e o estoque foi liberado.' end,
        jsonb_build_object('reservation_id', v_event.aggregate_id));
    elsif v_event.topic = 'payments.manual.confirmed' then
      select sale.customer_id into v_recipient_id from public.payment_attempts attempt
      join public.sales sale on sale.id = attempt.sale_id where attempt.id = v_event.aggregate_id::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id, 'PAYMENT_CONFIRMED',
        'Pagamento confirmado', 'Seu pagamento foi confirmado e a venda foi concluída.',
        jsonb_build_object('sale_id', v_event.payload ->> 'sale_id'));
    elsif v_event.topic = 'closeouts.reopened' then
      v_recipient_id := (v_event.payload ->> 'seller_id')::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id, 'CLOSEOUT_REOPENED',
        'Fechamento reaberto', 'Um fechamento seu foi reaberto pela administração.',
        jsonb_build_object('closeout_id', v_event.aggregate_id));
    elsif v_event.topic in ('raffles.numbers.reserved', 'raffles.reservation.expired') then
      v_recipient_id := (v_event.payload ->> 'customer_id')::uuid;
      if v_recipient_id is null and v_event.payload ? 'sale_id' then
        select customer_id into v_recipient_id from public.sales where id = (v_event.payload ->> 'sale_id')::uuid;
      end if;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id,
        case when v_event.topic = 'raffles.numbers.reserved' then 'RAFFLE_RESERVED' else 'RAFFLE_EXPIRED' end,
        case when v_event.topic = 'raffles.numbers.reserved' then 'Números reservados' else 'Reserva de rifa expirada' end,
        case when v_event.topic = 'raffles.numbers.reserved'
          then 'Seus números aguardam a confirmação do pagamento.'
          else 'O prazo terminou e os números voltaram a ficar disponíveis.' end,
        v_event.payload - 'customer_id');
    elsif v_event.topic = 'raffles.drawn' then
      select * into v_draw from public.raffle_draws where id = (v_event.payload ->> 'draw_id')::uuid;
      for v_number in
        select distinct reserved_by as recipient_id,
          bool_or(number = v_draw.winner_number) as won
        from public.raffle_numbers
        where campaign_id = v_draw.campaign_id and status = 'PAID' and reserved_by is not null
        group by reserved_by
      loop
        v_count := v_count + private.add_notification(v_event.id, v_number.recipient_id, 'RAFFLE_DRAWN',
          case when v_number.won then 'Você ganhou a rifa' else 'Sorteio da rifa concluído' end,
          case when v_number.won then 'Um dos seus números foi sorteado.' else 'O sorteio foi concluído e o resultado está disponível.' end,
          jsonb_build_object('campaign_id', v_draw.campaign_id, 'draw_id', v_draw.id,
            'winner_number', v_draw.winner_number, 'won', v_number.won));
      end loop;
    -- COMM-002 (spec 5.15): automatic operational notices, in-app. Staff notices go to every active user
    -- holding the permission that acts on them; they are not optional for those users.
    elsif v_event.topic = 'reservations.ready' then
      select customer_id into v_recipient_id from public.commercial_reservations where id = v_event.aggregate_id::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id, 'RESERVATION_READY',
        'Reserva pronta para retirada',
        'Sua reserva foi separada. Retire até ' || to_char((v_event.payload ->> 'pickup_deadline')::timestamptz at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI')
          || ' (horário de Brasília).',
        jsonb_build_object('reservation_id', v_event.aggregate_id, 'pickup_deadline', v_event.payload ->> 'pickup_deadline'));
    elsif v_event.topic = 'reservations.completed' then
      select customer_id into v_recipient_id from public.commercial_reservations where id = v_event.aggregate_id::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id, 'RESERVATION_COMPLETED',
        'Reserva entregue', 'Seus produtos foram entregues e o pagamento foi registrado.',
        jsonb_build_object('reservation_id', v_event.aggregate_id, 'sale_id', v_event.payload ->> 'sale_id'));
    elsif v_event.topic = 'inventory.loss.reported' and v_event.payload ->> 'status' = 'PENDING_APPROVAL' then
      for v_staff in select recipient_id from private.staff_with_permission('inventory.manage') loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'LOSS_PENDING',
          'Perda aguardando aprovação', 'Um vendedor registrou uma perda de estoque que precisa da sua decisão.',
          jsonb_build_object('report_id', v_event.aggregate_id));
      end loop;
    elsif v_event.topic = 'inventory.count.submitted' then
      for v_staff in select recipient_id from private.staff_with_permission('inventory.manage') loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'COUNT_PENDING',
          'Contagem aguardando conferência', 'Uma contagem física foi enviada e aguarda aprovação.',
          jsonb_build_object('count_id', v_event.aggregate_id));
      end loop;
    elsif v_event.topic = 'inventory.return.requested' then
      for v_staff in select recipient_id from private.staff_with_permission('inventory.manage') loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'RETURN_PENDING',
          'Devolução a receber', 'Um vendedor enviou produtos de volta para a central; confira o recebimento.',
          jsonb_build_object('request_id', v_event.aggregate_id));
      end loop;
    elsif v_event.topic = 'inventory.seller_transfer.requested' then
      select location.seller_id into v_recipient_id from public.seller_stock_transfer_requests request
      join public.stock_locations location on location.id = request.from_location_id
      where request.id = v_event.aggregate_id::uuid;
      v_count := v_count + private.add_notification(v_event.id, v_recipient_id, 'TRANSFER_PENDING',
        'Transferência solicitada', 'Outro vendedor pediu produtos do seu estoque; responda no PDV.',
        jsonb_build_object('request_id', v_event.aggregate_id));
    elsif v_event.topic = 'finance.payment.reconciled' and v_event.payload ->> 'outcome' = 'DIVERGENT' then
      for v_staff in select recipient_id from private.staff_with_permission('finance.manage') loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'SALE_DIVERGENT',
          'Venda com divergência', 'A conciliação encontrou um valor diferente do esperado em uma venda.',
          jsonb_build_object('reconciliation_id', v_event.aggregate_id, 'attempt_id', v_event.payload ->> 'attempt_id'));
      end loop;
    elsif v_event.topic = 'closeouts.created' then
      for v_staff in select recipient_id from private.staff_with_permission('closeouts.manage') loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'CLOSEOUT_PENDING',
          'Fechamento para conferir', 'Um vendedor enviou o fechamento do período.',
          jsonb_build_object('closeout_id', v_event.aggregate_id, 'seller_id', v_event.payload ->> 'seller_id'));
      end loop;
    -- NOTIF-003: one notification per frozen recipient of a published announcement.
    elsif v_event.topic = 'communications.announcement.published' then
      for v_staff in
        select recipient.recipient_id, announcement.title, announcement.body
        from public.announcement_recipients recipient
        join public.announcements announcement on announcement.id = recipient.announcement_id
        where recipient.announcement_id = v_event.aggregate_id::uuid
          and private.wants_notification(recipient.recipient_id, 'COMUNICADOS')
      loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'ANNOUNCEMENT',
          v_staff.title, v_staff.body, jsonb_build_object('announcement_id', v_event.aggregate_id));
      end loop;
    -- NOTIF-004: each pending "avise-me" fires once, for users who keep the category on.
    elsif v_event.topic = 'catalog.product.back_in_stock' then
      for v_staff in
        update public.product_stock_alerts alert set notified_at = clock_timestamp()
        from public.products product
        where alert.product_id = v_event.aggregate_id::uuid and alert.notified_at is null and product.id = alert.product_id
        returning alert.user_id as recipient_id, product.name as product_name
      loop
        if private.wants_notification(v_staff.recipient_id, 'ESTOQUE_DE_VOLTA') then
          v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'PRODUCT_BACK_IN_STOCK',
            'Produto disponível', v_staff.product_name || ' voltou ao estoque. Reserve pelo catálogo.',
            jsonb_build_object('product_id', v_event.aggregate_id));
        end if;
      end loop;
    end if;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;
