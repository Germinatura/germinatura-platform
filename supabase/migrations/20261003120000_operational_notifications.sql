-- Spec 5.15 (COMM-002): automatic operational notifications for the events that need someone to act:
-- reservation ready/delivered (customer), loss, count and return awaiting the stock team, transfer awaiting
-- the source seller, divergent reconciliation (finance) and closeout to review. In-app only in the MVP.

-- Active, onboarded users holding a permission (the same rule public.has_permission applies to the caller).
create function private.staff_with_permission(p_permission text)
returns table (recipient_id uuid) language sql stable set search_path = '' as $$
  select distinct profile.id
  from public.profiles profile
  join public.user_roles user_role on user_role.user_id = profile.id
  join public.role_permissions role_permission on role_permission.role_id = user_role.role_id
  join public.permissions permission on permission.id = role_permission.permission_id
  where profile.active and profile.onboarding_completed_at is not null and permission.key = p_permission;
$$;
revoke all on function private.staff_with_permission(text) from public, anon, authenticated, service_role;

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
    end if;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;
