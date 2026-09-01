create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete restrict,
  source_event_id uuid not null references public.outbox_events(id) on delete restrict,
  kind text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_kind_valid check (
    char_length(kind) between 1 and 64 and kind ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint notifications_title_valid check (char_length(title) between 1 and 160 and title = btrim(title)),
  constraint notifications_body_valid check (char_length(body) between 1 and 1000 and body = btrim(body)),
  constraint notifications_data_object check (jsonb_typeof(data) = 'object'),
  constraint notifications_source_unique unique (source_event_id, recipient_id, kind)
);

create index notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc, id desc);
create index notifications_recipient_unread_idx
  on public.notifications (recipient_id, created_at desc) where read_at is null;

create table public.feature_flags (
  key text primary key,
  description text not null,
  enabled boolean not null,
  updated_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feature_flags_key_valid check (
    char_length(key) between 1 and 64 and key ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  constraint feature_flags_description_valid check (
    char_length(description) between 1 and 240 and description = btrim(description)
  )
);

insert into public.feature_flags (key, description, enabled) values
  ('reservations', 'Reservas comerciais no Portal', true),
  ('raffles', 'Campanhas e compra de números de rifas', true),
  ('notifications', 'Notificações in-app materializadas pela outbox', true),
  ('card_present', 'Confirmação manual por Maquininha', true),
  ('pix_area_manual', 'Confirmação manual pela Área Pix', true),
  ('online_checkout', 'Checkout online no Portal', false),
  ('picpay_checkout', 'Checkout/API remoto do PicPay', false),
  ('picpay_tap', 'Iniciação remota de Tap PicPay', false),
  ('meal_voucher', 'V.A. e V.R. credenciados', false),
  ('community', 'Comunidade institucional', false),
  ('comments', 'Comentários da comunidade', false);

create or replace function private.prevent_notification_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.id is distinct from old.id
    or new.recipient_id is distinct from old.recipient_id
    or new.source_event_id is distinct from old.source_event_id
    or new.kind is distinct from old.kind
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.data is distinct from old.data
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'NOTIFICATION_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger notifications_guard before update or delete on public.notifications
for each row execute function private.prevent_notification_change();

create or replace function private.guard_feature_flag_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.key is distinct from old.key
    or new.description is distinct from old.description
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'FEATURE_FLAG_DEFINITION_IMMUTABLE';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger feature_flags_guard before update or delete on public.feature_flags
for each row execute function private.guard_feature_flag_change();

create or replace function private.require_feature(p_key text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not coalesce((select enabled from public.feature_flags where key = p_key), false) then
    raise exception using errcode = 'P0001', message = 'FEATURE_DISABLED';
  end if;
end;
$$;

create or replace function private.guard_commercial_reservation_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform private.require_feature('reservations');
  return new;
end;
$$;

create trigger commercial_reservations_feature_guard before insert on public.commercial_reservations
for each row execute function private.guard_commercial_reservation_feature();

create or replace function private.guard_raffle_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'raffle_campaigns'
    or (tg_table_name = 'raffle_numbers' and old.status::text = 'AVAILABLE' and new.status::text = 'RESERVED') then
    perform private.require_feature('raffles');
  end if;
  return new;
end;
$$;

create trigger raffle_campaigns_feature_guard before insert on public.raffle_campaigns
for each row execute function private.guard_raffle_feature();
create trigger raffle_numbers_feature_guard before update on public.raffle_numbers
for each row execute function private.guard_raffle_feature();

create or replace function private.guard_manual_payment_feature()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.confirmation_source is null and new.confirmation_source = 'MANUAL' then
    if new.integration_channel = 'MAQUININHA' then
      perform private.require_feature('card_present');
    elsif new.integration_channel = 'PIX_AREA' then
      perform private.require_feature('pix_area_manual');
    else
      raise exception using errcode = 'P0001', message = 'FEATURE_DISABLED';
    end if;
  end if;
  return new;
end;
$$;

create trigger payment_attempts_manual_feature_guard before update on public.payment_attempts
for each row execute function private.guard_manual_payment_feature();

create or replace function public.is_feature_enabled(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.feature_flags where key = p_key), false);
$$;

create or replace function public.update_feature_flag(
  p_key text,
  p_enabled boolean,
  p_reason text,
  p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_flag public.feature_flags%rowtype;
begin
  if v_actor_id is null or not public.has_permission('admin.access') then
    raise exception using errcode = '42501', message = 'FEATURE_FLAG_MANAGE_FORBIDDEN';
  end if;
  if p_enabled is null or p_correlation_id is null or p_reason is null
    or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_FEATURE_FLAG_CHANGE';
  end if;
  update public.feature_flags
  set enabled = p_enabled, updated_by = v_actor_id
  where key = p_key returning * into v_flag;
  if not found then
    raise exception using errcode = 'P0001', message = 'FEATURE_FLAG_NOT_FOUND';
  end if;
  insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
  values ('features.flag.changed', v_actor_id, 'feature_flag', p_key, p_correlation_id,
    jsonb_build_object('enabled', p_enabled, 'reason', p_reason));
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values ('features.flag.changed', 'feature_flag', p_key,
    jsonb_build_object('key', p_key, 'enabled', p_enabled, 'correlation_id', p_correlation_id));
  return jsonb_build_object('key', v_flag.key, 'enabled', v_flag.enabled, 'updated_at', v_flag.updated_at);
end;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_notification public.notifications%rowtype;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;
  update public.notifications set read_at = coalesce(read_at, now())
  where id = p_notification_id and recipient_id = v_actor_id
  returning * into v_notification;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOTIFICATION_NOT_FOUND';
  end if;
  return jsonb_build_object('notification_id', v_notification.id, 'read_at', v_notification.read_at);
end;
$$;

create or replace function private.assert_worker_role()
returns void language plpgsql stable set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'WORKER_SERVICE_ROLE_REQUIRED';
  end if;
end;
$$;

create or replace function private.expire_due_commercial_reservations(p_limit integer)
returns integer language plpgsql set search_path = '' as $$
declare
  v_reservation public.commercial_reservations%rowtype;
  v_count integer := 0;
begin
  for v_reservation in
    select * from public.commercial_reservations
    where status = 'ACTIVE' and expires_at <= clock_timestamp()
    order by expires_at, id for update skip locked limit p_limit
  loop
    perform private.finalize_stock_reservation(
      v_reservation.stock_reservation_id, 'EXPIRED', v_reservation.customer_id, v_reservation.correlation_id
    );
    update public.commercial_reservations set status = 'EXPIRED', expired_at = now()
    where id = v_reservation.id;
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('reservations.expired', v_reservation.customer_id, 'commercial_reservation', v_reservation.id::text,
      v_reservation.correlation_id, jsonb_build_object('expires_at', v_reservation.expires_at));
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('reservations.expired', 'commercial_reservation', v_reservation.id::text,
      jsonb_build_object('reservation_id', v_reservation.id, 'customer_id', v_reservation.customer_id,
        'correlation_id', v_reservation.correlation_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function private.expire_due_sales(p_limit integer)
returns integer language plpgsql set search_path = '' as $$
declare
  v_record record;
  v_attempt public.payment_attempts%rowtype;
  v_count integer := 0;
begin
  for v_record in
    select reservation.id as reservation_id, sale.*
    from public.stock_reservations reservation
    join public.sales sale on sale.id::text = reservation.origin_id
    where reservation.origin_type = 'sale' and reservation.status = 'ACTIVE'
      and reservation.expires_at <= clock_timestamp() and sale.status = 'AWAITING_PAYMENT'
    order by reservation.expires_at, reservation.id for update of reservation, sale skip locked limit p_limit
  loop
    perform private.finalize_stock_reservation(
      v_record.reservation_id, 'EXPIRED', v_record.created_by, v_record.correlation_id
    );
    select * into v_attempt from public.payment_attempts where sale_id = v_record.id for update;
    if found and v_attempt.status = 'CREATED' then
      update public.payment_attempts set status = 'CANCELLED' where id = v_attempt.id;
      insert into public.payment_attempt_status_history
        (attempt_id, from_status, to_status, actor_id, reason, correlation_id)
      values (v_attempt.id, 'CREATED', 'CANCELLED', v_record.created_by,
        'Cobrança expirada pelo worker', v_record.correlation_id);
    end if;
    update public.sales set status = 'CANCELLED' where id = v_record.id;
    insert into public.sale_status_history
      (sale_id, from_status, to_status, actor_id, reason, correlation_id)
    values (v_record.id, 'AWAITING_PAYMENT', 'CANCELLED', v_record.created_by,
      'Reserva de estoque expirada', v_record.correlation_id);
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('sales.expired', v_record.created_by, 'sale', v_record.id::text, v_record.correlation_id,
      jsonb_build_object('reservation_id', v_record.reservation_id));
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('sales.expired', 'sale', v_record.id::text,
      jsonb_build_object('sale_id', v_record.id, 'customer_id', v_record.customer_id,
        'correlation_id', v_record.correlation_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function private.expire_due_raffle_reservations(p_limit integer)
returns integer language plpgsql set search_path = '' as $$
declare
  v_record record;
  v_attempt public.payment_attempts%rowtype;
  v_numbers integer[];
  v_count integer := 0;
begin
  for v_record in
    select sale.*
    from public.sales sale
    where sale.status = 'AWAITING_PAYMENT'
      and exists (
        select 1 from public.raffle_numbers number
        where number.sale_id = sale.id and number.status = 'RESERVED'
          and number.expires_at <= clock_timestamp()
      )
    order by sale.id
    for update of sale skip locked limit p_limit
  loop
    select array_agg(number order by number) into v_numbers
    from public.raffle_numbers where sale_id = v_record.id and status = 'RESERVED';
    select * into v_attempt from public.payment_attempts where sale_id = v_record.id for update;
    if found and v_attempt.status = 'CREATED' then
      update public.payment_attempts set status = 'CANCELLED' where id = v_attempt.id;
      insert into public.payment_attempt_status_history
        (attempt_id, from_status, to_status, actor_id, reason, correlation_id)
      values (v_attempt.id, 'CREATED', 'CANCELLED', v_record.created_by,
        'Reserva de rifa expirada pelo worker', v_record.correlation_id);
    end if;
    update public.sales set status = 'CANCELLED' where id = v_record.id;
    insert into public.sale_status_history
      (sale_id, from_status, to_status, actor_id, reason, correlation_id)
    values (v_record.id, 'AWAITING_PAYMENT', 'CANCELLED', v_record.created_by,
      'Reserva de rifa expirada', v_record.correlation_id);
    update public.raffle_numbers set status = 'AVAILABLE', reserved_by = null, sale_id = null,
      payment_attempt_id = null, reserved_at = null, expires_at = null, paid_at = null
    where sale_id = v_record.id and status = 'RESERVED';
    insert into public.audit_logs (action, actor_id, entity_type, entity_id, correlation_id, metadata)
    values ('raffles.reservation.expired', v_record.created_by, 'sale', v_record.id::text,
      v_record.correlation_id, jsonb_build_object('numbers', v_numbers));
    insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
    values ('raffles.reservation.expired', 'sale', v_record.id::text,
      jsonb_build_object('sale_id', v_record.id, 'customer_id', v_record.customer_id,
        'numbers', v_numbers, 'correlation_id', v_record.correlation_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function private.expire_due_generic_stock_reservations(p_limit integer)
returns integer language plpgsql set search_path = '' as $$
declare
  v_reservation public.stock_reservations%rowtype;
  v_count integer := 0;
begin
  for v_reservation in
    select * from public.stock_reservations
    where status = 'ACTIVE' and expires_at <= clock_timestamp()
      and origin_type not in ('sale', 'commercial_reservation')
    order by expires_at, id for update skip locked limit p_limit
  loop
    perform private.finalize_stock_reservation(
      v_reservation.id, 'EXPIRED', v_reservation.actor_id, v_reservation.correlation_id
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.worker_expire_due_reservations(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_commercial integer;
  v_sales integer;
  v_raffles integer;
  v_generic integer;
begin
  perform private.assert_worker_role();
  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'INVALID_WORKER_LIMIT';
  end if;
  v_commercial := private.expire_due_commercial_reservations(p_limit);
  v_sales := private.expire_due_sales(p_limit);
  v_raffles := private.expire_due_raffle_reservations(p_limit);
  v_generic := private.expire_due_generic_stock_reservations(p_limit);
  return jsonb_build_object(
    'commercial_reservations', v_commercial,
    'sales', v_sales,
    'raffles', v_raffles,
    'generic_stock_reservations', v_generic,
    'total', v_commercial + v_sales + v_raffles + v_generic
  );
end;
$$;

create or replace function public.worker_claim_outbox_events(
  p_worker_id text,
  p_batch_size integer default 50,
  p_lease_seconds integer default 300
)
returns table(id uuid, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_worker_role();
  return query select event.id, event.attempts
  from private.claim_outbox_events(p_worker_id, p_batch_size, make_interval(secs => p_lease_seconds)) event;
end;
$$;

create or replace function private.add_notification(
  p_event_id uuid,
  p_recipient_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_data jsonb default '{}'::jsonb
)
returns integer language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  if p_recipient_id is null then return 0; end if;
  insert into public.notifications (recipient_id, source_event_id, kind, title, body, data)
  values (p_recipient_id, p_event_id, p_kind, p_title, p_body, coalesce(p_data, '{}'::jsonb))
  on conflict (source_event_id, recipient_id, kind) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.worker_process_outbox_event(p_event_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.outbox_events%rowtype;
  v_recipient_id uuid;
  v_count integer := 0;
  v_draw public.raffle_draws%rowtype;
  v_number record;
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
    end if;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;

create or replace function public.worker_retry_outbox_event(
  p_event_id uuid,
  p_worker_id text,
  p_error text,
  p_backoff_seconds integer,
  p_max_attempts integer default 10
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_event public.outbox_events%rowtype;
begin
  perform private.assert_worker_role();
  if p_backoff_seconds not between 1 and 86400 then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_BACKOFF';
  end if;
  v_event := private.retry_outbox_event(p_event_id, p_worker_id, left(p_error, 1000),
    now() + make_interval(secs => p_backoff_seconds), p_max_attempts);
  return jsonb_build_object('event_id', v_event.id, 'status', v_event.status,
    'attempts', v_event.attempts, 'available_at', v_event.available_at);
end;
$$;

create or replace function public.worker_outbox_metrics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_worker_role();
  return jsonb_build_object(
    'pending', (select count(*) from public.outbox_events where status = 'PENDING'),
    'processing', (select count(*) from public.outbox_events where status = 'PROCESSING'),
    'failed', (select count(*) from public.outbox_events where status = 'FAILED'),
    'delayed', (select count(*) from public.outbox_events
      where status = 'PENDING' and available_at <= now() - interval '5 minutes'),
    'oldest_pending_seconds', coalesce((select floor(extract(epoch from (now() - min(created_at))))::bigint
      from public.outbox_events where status = 'PENDING'), 0)
  );
end;
$$;

alter table public.notifications enable row level security;
alter table public.feature_flags enable row level security;

revoke all on table public.notifications, public.feature_flags from public, anon, authenticated, service_role;
grant select on table public.notifications, public.feature_flags to authenticated;

create policy notifications_owner_read on public.notifications for select to authenticated
using (recipient_id = auth.uid());
create policy feature_flags_authenticated_read on public.feature_flags for select to authenticated
using (true);

revoke all on function private.prevent_notification_change() from public, anon, authenticated, service_role;
revoke all on function private.guard_feature_flag_change() from public, anon, authenticated, service_role;
revoke all on function private.require_feature(text) from public, anon, authenticated, service_role;
revoke all on function private.guard_commercial_reservation_feature() from public, anon, authenticated, service_role;
revoke all on function private.guard_raffle_feature() from public, anon, authenticated, service_role;
revoke all on function private.guard_manual_payment_feature() from public, anon, authenticated, service_role;
revoke all on function private.assert_worker_role() from public, anon, authenticated, service_role;
revoke all on function private.expire_due_commercial_reservations(integer) from public, anon, authenticated, service_role;
revoke all on function private.expire_due_sales(integer) from public, anon, authenticated, service_role;
revoke all on function private.expire_due_raffle_reservations(integer) from public, anon, authenticated, service_role;
revoke all on function private.expire_due_generic_stock_reservations(integer) from public, anon, authenticated, service_role;
revoke all on function private.add_notification(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;

revoke all on function public.is_feature_enabled(text) from public, anon, authenticated, service_role;
revoke all on function public.update_feature_flag(text, boolean, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.mark_notification_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.worker_expire_due_reservations(integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_claim_outbox_events(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_process_outbox_event(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.worker_retry_outbox_event(uuid, text, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.worker_outbox_metrics() from public, anon, authenticated, service_role;

grant execute on function public.is_feature_enabled(text) to authenticated;
grant execute on function public.update_feature_flag(text, boolean, text, uuid) to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.worker_expire_due_reservations(integer) to service_role;
grant execute on function public.worker_claim_outbox_events(text, integer, integer) to service_role;
grant execute on function public.worker_process_outbox_event(uuid, text) to service_role;
grant execute on function public.worker_retry_outbox_event(uuid, text, text, integer, integer) to service_role;
grant execute on function public.worker_outbox_metrics() to service_role;

comment on table public.notifications is 'In-app notifications materialized idempotently from the transactional outbox.';
comment on table public.feature_flags is 'Server-side launch controls; flags never replace permissions or RLS.';
