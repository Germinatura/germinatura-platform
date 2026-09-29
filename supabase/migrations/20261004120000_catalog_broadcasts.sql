-- Spec 4.7 (NOTIF-005): optional broadcast notices for new products, promotions going live and new raffles.
-- Each source is announced at most once (broadcast_notices), only to users who can act on it and keep the
-- category on. Promotions scheduled for the future are announced only if they are saved while already live.

create table public.broadcast_notices (
  source_type text not null check (source_type in ('PRODUCT', 'PROMOTION', 'RAFFLE')),
  source_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (source_type, source_id)
);
create trigger broadcast_notices_immutable before update or delete on public.broadcast_notices
for each row execute function private.prevent_immutable_record_change();
alter table public.broadcast_notices enable row level security;
revoke all on public.broadcast_notices from public, anon, authenticated, service_role;

-- Records the notice and queues the outbox event only the first time a source qualifies.
create function private.queue_broadcast_once(p_source_type text, p_source_id uuid, p_topic text, p_aggregate_type text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.broadcast_notices (source_type, source_id) values (p_source_type, p_source_id)
  on conflict do nothing;
  if found then
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values (p_topic, p_aggregate_type, p_source_id::text, jsonb_build_object('source_id', p_source_id));
  end if;
end;
$$;

create function private.emit_product_published()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.active and new.published and (tg_op = 'INSERT' or not (old.active and old.published)) then
    perform private.queue_broadcast_once('PRODUCT', new.id, 'catalog.product.published', 'product');
  end if;
  return new;
end;
$$;
create trigger products_broadcast_published after insert or update of active, published on public.products
for each row execute function private.emit_product_published();

create function private.emit_promotion_live()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.active and new.publicable and new.valid_from <= now() and (new.valid_to is null or new.valid_to > now()) then
    perform private.queue_broadcast_once('PROMOTION', new.id, 'promotions.live', 'promotion');
  end if;
  return new;
end;
$$;
create trigger promotions_broadcast_live after insert or update of active, publicable, valid_from, valid_to on public.promotions
for each row execute function private.emit_promotion_live();

create function private.emit_raffle_opened()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'ACTIVE' then
    perform private.queue_broadcast_once('RAFFLE', new.id, 'raffles.campaign.opened', 'raffle_campaign');
  end if;
  return new;
end;
$$;
create trigger raffle_campaigns_broadcast_opened after insert on public.raffle_campaigns
for each row execute function private.emit_raffle_opened();

revoke all on function private.queue_broadcast_once(text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.emit_product_published() from public, anon, authenticated, service_role;
revoke all on function private.emit_promotion_live() from public, anon, authenticated, service_role;
revoke all on function private.emit_raffle_opened() from public, anon, authenticated, service_role;

-- The outbox worker delivers the broadcasts.
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
    -- NOTIF-005: optional broadcasts to people who can buy or reserve and keep the category on.
    elsif v_event.topic = 'catalog.product.published' then
      for v_staff in
        select recipient.recipient_id, product.name as source_name
        from private.staff_with_permission('reservations.manage.own') recipient
        join public.products product on product.id = v_event.aggregate_id::uuid
        where private.wants_notification(recipient.recipient_id, 'NOVOS_PRODUTOS')
      loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'NEW_PRODUCT',
          'Novidade no catálogo', v_staff.source_name || ' chegou ao catálogo.',
          jsonb_build_object('product_id', v_event.aggregate_id));
      end loop;
    elsif v_event.topic = 'promotions.live' then
      for v_staff in
        select recipient.recipient_id, promotion.name as source_name
        from private.staff_with_permission('reservations.manage.own') recipient
        join public.promotions promotion on promotion.id = v_event.aggregate_id::uuid
        where private.wants_notification(recipient.recipient_id, 'PROMOCOES')
          and promotion.active and promotion.publicable
      loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'PROMOTION_LIVE',
          'Promoção no ar', v_staff.source_name || ' já está valendo.',
          jsonb_build_object('promotion_id', v_event.aggregate_id));
      end loop;
    elsif v_event.topic = 'raffles.campaign.opened' and public.is_feature_enabled('raffles') then
      for v_staff in
        select recipient.recipient_id, campaign.name as source_name
        from private.staff_with_permission('raffles.buy') recipient
        join public.raffle_campaigns campaign on campaign.id = v_event.aggregate_id::uuid
        where private.wants_notification(recipient.recipient_id, 'RIFAS')
      loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'RAFFLE_OPENED',
          'Nova rifa', v_staff.source_name || ' está com números à venda.',
          jsonb_build_object('campaign_id', v_event.aggregate_id));
      end loop;
    end if;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;
