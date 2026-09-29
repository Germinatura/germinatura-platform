-- Spec 5.15 (NOTIF-003): the communications team publishes in-app announcements to everyone, to roles or
-- to specific users (by e-mail). The audience is resolved and frozen when published; the outbox worker
-- delivers one notification per recipient. Publication is immediate (no scheduling infrastructure yet).

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 160 and title = btrim(title)),
  body text not null check (char_length(body) between 3 and 1000 and body = btrim(body)),
  audience_all boolean not null,
  audience_roles text[] not null default '{}',
  audience_emails text[] not null default '{}',
  recipient_count integer not null check (recipient_count >= 1),
  created_by uuid not null references public.profiles(id) on delete restrict,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint announcements_audience_valid check (audience_all or cardinality(audience_roles) > 0 or cardinality(audience_emails) > 0)
);
create table public.announcement_recipients (
  announcement_id uuid not null references public.announcements(id) on delete restrict,
  recipient_id uuid not null references public.profiles(id) on delete restrict,
  primary key (announcement_id, recipient_id)
);
create index announcements_created_idx on public.announcements (created_at desc, id desc);
create trigger announcements_immutable before update or delete on public.announcements
for each row execute function private.prevent_immutable_record_change();
create trigger announcement_recipients_immutable before update or delete on public.announcement_recipients
for each row execute function private.prevent_immutable_record_change();
alter table public.announcements enable row level security;
alter table public.announcement_recipients enable row level security;
revoke all on public.announcements, public.announcement_recipients from public, anon, authenticated, service_role;

create function public.publish_announcement(
  p_title text, p_body text, p_all boolean, p_roles text[], p_emails text[], p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid(); v_claim record; v_id uuid := gen_random_uuid(); v_result jsonb;
  v_title text := btrim(p_title); v_body text := btrim(p_body);
  v_roles text[] := coalesce((select array_agg(distinct role_key order by role_key) from unnest(coalesce(p_roles, '{}')) role_key), '{}');
  v_emails text[] := coalesce((select array_agg(distinct lower(btrim(email)) order by lower(btrim(email)))
    from unnest(coalesce(p_emails, '{}')) email where btrim(email) <> ''), '{}');
  v_unknown text[];
  v_recipients uuid[];
  v_count integer;
begin
  if v_actor_id is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_correlation_id is null or p_all is null or v_title is null or char_length(v_title) not between 3 and 160
    or v_body is null or char_length(v_body) not between 3 and 1000
    or (not p_all and cardinality(v_roles) = 0 and cardinality(v_emails) = 0)
    or cardinality(v_emails) > 200
    or exists (select 1 from unnest(v_roles) role_key where not exists (select 1 from public.roles role where role.key = role_key)) then
    raise exception using errcode = '22023', message = 'INVALID_ANNOUNCEMENT';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('communications', 'announcement', v_actor_id), p_idempotency_key,
    jsonb_build_object('title', v_title, 'body', v_body, 'all', p_all, 'roles', v_roles, 'emails', v_emails));
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  select array_agg(requested.address order by requested.address) into v_unknown from unnest(v_emails) as requested(address)
  where not exists (select 1 from public.profiles profile where lower(profile.email) = requested.address and profile.active);
  if v_unknown is not null then
    raise exception using errcode = 'P0001', message = 'ANNOUNCEMENT_UNKNOWN_RECIPIENTS', detail = array_to_string(v_unknown, ', ');
  end if;

  select array_agg(distinct profile.id) into v_recipients from public.profiles profile
  where profile.active and profile.onboarding_completed_at is not null and (
    p_all
    or lower(profile.email) = any (v_emails)
    or exists (select 1 from public.user_roles user_role join public.roles role on role.id = user_role.role_id
      where user_role.user_id = profile.id and role.key = any (v_roles)));
  v_count := coalesce(cardinality(v_recipients), 0);
  if v_count = 0 then
    raise exception using errcode = 'P0001', message = 'ANNOUNCEMENT_EMPTY_AUDIENCE';
  end if;
  insert into public.announcements (id, title, body, audience_all, audience_roles, audience_emails, recipient_count, created_by, correlation_id, created_at)
  values (v_id, v_title, v_body, p_all, v_roles, v_emails, v_count, v_actor_id, p_correlation_id, clock_timestamp());
  insert into public.announcement_recipients (announcement_id, recipient_id)
  select v_id, recipient_id from unnest(v_recipients) recipient_id;

  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('communications.announcement.published', v_actor_id, 'announcement', v_id::text, p_correlation_id,
    jsonb_build_object('all', p_all, 'roles', v_roles, 'emails', v_emails, 'recipient_count', v_count));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('communications.announcement.published', 'announcement', v_id::text,
    jsonb_build_object('announcement_id', v_id, 'recipient_count', v_count, 'correlation_id', p_correlation_id));
  v_result := jsonb_build_object('id', v_id, 'title', v_title, 'recipient_count', v_count, 'correlation_id', p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id, 'SUCCEEDED', v_result, null, 'announcement', v_id::text);
  return v_result;
end;
$$;

create function public.list_announcements(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_permission('communications.manage') then
    raise exception using errcode = '42501', message = 'COMMUNICATIONS_MANAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_ANNOUNCEMENT_FILTER';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', page.id, 'title', page.title, 'body', page.body, 'audience_all', page.audience_all,
      'audience_roles', to_jsonb(page.audience_roles), 'audience_emails', to_jsonb(page.audience_emails),
      'recipient_count', page.recipient_count, 'created_at', page.created_at,
      'created_by_name', coalesce(nullif(btrim(author.display_name), ''), author.email)) order by page.created_at desc, page.id desc)
    from (select * from public.announcements order by created_at desc, id desc limit p_limit) page
    join public.profiles author on author.id = page.created_by), '[]'::jsonb);
end;
$$;

revoke all on function public.publish_announcement(text, text, boolean, text[], text[], text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_announcements(integer) from public, anon, authenticated, service_role;
grant execute on function public.publish_announcement(text, text, boolean, text[], text[], text, uuid) to authenticated;
grant execute on function public.list_announcements(integer) to authenticated;

-- The outbox worker delivers announcements to their frozen audience.
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
      loop
        v_count := v_count + private.add_notification(v_event.id, v_staff.recipient_id, 'ANNOUNCEMENT',
          v_staff.title, v_staff.body, jsonb_build_object('announcement_id', v_event.aggregate_id));
      end loop;
    end if;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;
