create type public.seller_closeout_status as enum ('CLOSED', 'REOPENED');

insert into public.permissions (key, description) values
  ('closeouts.create', 'Criar fechamento da própria operação'),
  ('closeouts.manage', 'Consultar e reabrir fechamentos')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role cross join public.permissions permission
where (role.key = 'VENDEDOR' and permission.key = 'closeouts.create')
   or (role.key = 'ADMIN' and permission.key in ('closeouts.create', 'closeouts.manage'))
   or (role.key = 'FINANCEIRO' and permission.key = 'closeouts.manage')
on conflict do nothing;

create table public.seller_closeouts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) on delete restrict,
  location_id uuid not null references public.stock_locations(id) on delete restrict,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status public.seller_closeout_status not null default 'CLOSED',
  confirmed_sales_count bigint not null,
  confirmed_sales_total_cents bigint not null,
  payment_count bigint not null,
  payment_total_cents bigint not null,
  payment_difference_cents bigint not null,
  stock_difference_units bigint not null,
  justification text,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  reopened_at timestamptz,
  reopened_by uuid references public.profiles(id) on delete restrict,
  reopen_reason text,
  constraint seller_closeouts_period_valid check (
    period_start < period_end and period_end - period_start <= interval '7 days'
  ),
  constraint seller_closeouts_counts_valid check (
    confirmed_sales_count >= 0 and payment_count >= 0
    and confirmed_sales_total_cents between 0 and 9007199254740991
    and payment_total_cents between 0 and 9007199254740991
    and payment_difference_cents = payment_total_cents - confirmed_sales_total_cents
  ),
  constraint seller_closeouts_justification_valid check (
    justification is null
    or (char_length(justification) between 4 and 500 and justification = btrim(justification))
  ),
  constraint seller_closeouts_reopen_valid check (
    (status = 'CLOSED' and reopened_at is null and reopened_by is null and reopen_reason is null)
    or (
      status = 'REOPENED' and reopened_at is not null and reopened_by is not null
      and reopen_reason is not null and char_length(reopen_reason) between 4 and 500
      and reopen_reason = btrim(reopen_reason)
    )
  )
);

create index seller_closeouts_seller_period_idx
  on public.seller_closeouts (seller_id, period_end desc, id);
create index seller_closeouts_location_period_idx
  on public.seller_closeouts (location_id, period_end desc, id);
create index seller_closeouts_status_created_idx
  on public.seller_closeouts (status, created_at desc, id);

create table public.seller_closeout_payment_summaries (
  closeout_id uuid not null references public.seller_closeouts(id) on delete restrict,
  integration_channel public.payment_integration_channel not null,
  payment_count bigint not null,
  total_cents bigint not null,
  primary key (closeout_id, integration_channel),
  constraint seller_closeout_payment_values_valid check (
    payment_count > 0 and total_cents between 0 and 9007199254740991
  )
);

create table public.seller_closeout_stock_counts (
  closeout_id uuid not null references public.seller_closeouts(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  expected_quantity bigint not null,
  counted_quantity bigint not null,
  difference_quantity bigint generated always as (counted_quantity - expected_quantity) stored,
  primary key (closeout_id, product_id),
  constraint seller_closeout_stock_values_valid check (
    expected_quantity between 0 and 9007199254740991
    and counted_quantity between 0 and 9007199254740991
  )
);

create or replace function private.guard_seller_closeout_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_HARD_DELETE_FORBIDDEN';
  end if;
  if old.status <> 'CLOSED' or new.status <> 'REOPENED'
    or new.id is distinct from old.id
    or new.seller_id is distinct from old.seller_id
    or new.location_id is distinct from old.location_id
    or new.period_start is distinct from old.period_start
    or new.period_end is distinct from old.period_end
    or new.confirmed_sales_count is distinct from old.confirmed_sales_count
    or new.confirmed_sales_total_cents is distinct from old.confirmed_sales_total_cents
    or new.payment_count is distinct from old.payment_count
    or new.payment_total_cents is distinct from old.payment_total_cents
    or new.payment_difference_cents is distinct from old.payment_difference_cents
    or new.stock_difference_units is distinct from old.stock_difference_units
    or new.justification is distinct from old.justification
    or new.correlation_id is distinct from old.correlation_id
    or new.created_at is distinct from old.created_at
    or new.reopened_at is null or new.reopened_by is null or new.reopen_reason is null then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger seller_closeouts_guard_change before update or delete
on public.seller_closeouts for each row execute function private.guard_seller_closeout_change();
create trigger seller_closeout_payment_summaries_immutable before update or delete
on public.seller_closeout_payment_summaries for each row execute function private.prevent_immutable_record_change();
create trigger seller_closeout_stock_counts_immutable before update or delete
on public.seller_closeout_stock_counts for each row execute function private.prevent_immutable_record_change();

create or replace function public.create_seller_closeout(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stock_counts jsonb,
  p_justification text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_location_id uuid;
  v_scope text;
  v_claim record;
  v_closeout_id uuid := gen_random_uuid();
  v_sales_count bigint;
  v_sales_total bigint;
  v_payment_count bigint;
  v_payment_total bigint;
  v_payment_difference bigint;
  v_stock_difference bigint;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('closeouts.create') then
    raise exception using errcode = '42501', message = 'SELLER_CLOSEOUT_REQUIRED';
  end if;
  if p_period_start is null or p_period_end is null or p_period_start >= p_period_end
    or p_period_end > clock_timestamp() or p_period_end - p_period_start > interval '7 days' then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_PERIOD';
  end if;
  if p_correlation_id is null or jsonb_typeof(p_stock_counts) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_INPUT';
  end if;
  if p_justification is not null and (
    char_length(p_justification) not between 4 and 500 or p_justification <> btrim(p_justification)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_JUSTIFICATION';
  end if;

  perform 1 from public.profiles where id = v_actor_id and active for update;
  if not found then
    raise exception using errcode = '42501', message = 'SELLER_INACTIVE';
  end if;
  select location.id into v_location_id
  from public.stock_locations location
  where location.seller_id = v_actor_id and location.location_type = 'SELLER' and location.active;
  if v_location_id is null then
    raise exception using errcode = 'P0001', message = 'SELLER_LOCATION_NOT_FOUND';
  end if;

  v_scope := private.build_idempotency_scope('closeouts', 'create', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object(
      'period_start', p_period_start,
      'period_end', p_period_end,
      'stock_counts', p_stock_counts,
      'justification', p_justification
    )
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;
  perform set_config('request.idempotency_key', p_idempotency_key, true);

  if exists (
    select 1 from public.seller_closeouts closeout
    where closeout.seller_id = v_actor_id and closeout.status = 'CLOSED'
      and tstzrange(closeout.period_start, closeout.period_end, '[)')
        && tstzrange(p_period_start, p_period_end, '[)')
  ) then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_PERIOD_OVERLAP';
  end if;

  if jsonb_array_length(p_stock_counts) <> (
    select count(*) from public.inventory_balances where location_id = v_location_id
  ) or exists (
    select 1
    from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
    left join public.inventory_balances balance
      on balance.location_id = v_location_id and balance.product_id = input.product_id
    where balance.id is null or input.counted_quantity is null or input.counted_quantity < 0
  ) or (
    select count(*) from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  ) <> (
    select count(distinct input.product_id) from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  ) then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_STOCK_COUNTS';
  end if;

  select count(*), coalesce(sum(sale.total_cents), 0)
  into v_sales_count, v_sales_total
  from public.sales sale
  where sale.created_by = v_actor_id and sale.location_id = v_location_id
    and sale.status = 'CONFIRMED' and sale.updated_at >= p_period_start and sale.updated_at < p_period_end;

  select count(*), coalesce(sum(attempt.amount_cents), 0)
  into v_payment_count, v_payment_total
  from public.payment_attempts attempt
  join public.sales sale on sale.id = attempt.sale_id
  where sale.created_by = v_actor_id and sale.location_id = v_location_id
    and attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
    and attempt.confirmed_at >= p_period_start and attempt.confirmed_at < p_period_end;

  select coalesce(sum(abs(input.counted_quantity - balance.on_hand_quantity)), 0)
  into v_stock_difference
  from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  join public.inventory_balances balance
    on balance.location_id = v_location_id and balance.product_id = input.product_id;
  v_payment_difference := v_payment_total - v_sales_total;

  if (v_payment_difference <> 0 or v_stock_difference <> 0) and p_justification is null then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_JUSTIFICATION_REQUIRED';
  end if;

  insert into public.seller_closeouts (
    id, seller_id, location_id, period_start, period_end,
    confirmed_sales_count, confirmed_sales_total_cents,
    payment_count, payment_total_cents, payment_difference_cents,
    stock_difference_units, justification, correlation_id
  ) values (
    v_closeout_id, v_actor_id, v_location_id, p_period_start, p_period_end,
    v_sales_count, v_sales_total, v_payment_count, v_payment_total, v_payment_difference,
    v_stock_difference, p_justification, p_correlation_id
  );

  insert into public.seller_closeout_payment_summaries (
    closeout_id, integration_channel, payment_count, total_cents
  )
  select v_closeout_id, attempt.integration_channel, count(*), sum(attempt.amount_cents)
  from public.payment_attempts attempt
  join public.sales sale on sale.id = attempt.sale_id
  where sale.created_by = v_actor_id and sale.location_id = v_location_id
    and attempt.status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED')
    and attempt.confirmed_at >= p_period_start and attempt.confirmed_at < p_period_end
    and attempt.integration_channel is not null
  group by attempt.integration_channel;

  insert into public.seller_closeout_stock_counts (
    closeout_id, product_id, expected_quantity, counted_quantity
  )
  select v_closeout_id, balance.product_id, balance.on_hand_quantity, input.counted_quantity
  from jsonb_to_recordset(p_stock_counts) as input(product_id uuid, counted_quantity bigint)
  join public.inventory_balances balance
    on balance.location_id = v_location_id and balance.product_id = input.product_id;

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'closeouts.created', v_actor_id, 'seller_closeout', v_closeout_id::text, p_correlation_id,
    jsonb_build_object(
      'location_id', v_location_id,
      'period_start', p_period_start,
      'period_end', p_period_end,
      'payment_difference_cents', v_payment_difference,
      'stock_difference_units', v_stock_difference
    )
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'closeouts.created', 'seller_closeout', v_closeout_id::text,
    jsonb_build_object(
      'closeout_id', v_closeout_id,
      'seller_id', v_actor_id,
      'location_id', v_location_id,
      'correlation_id', p_correlation_id
    )
  );

  select jsonb_build_object(
    'closeout_id', closeout.id,
    'seller_id', closeout.seller_id,
    'location_id', closeout.location_id,
    'status', closeout.status,
    'period_start', closeout.period_start,
    'period_end', closeout.period_end,
    'confirmed_sales_count', closeout.confirmed_sales_count,
    'confirmed_sales_total_cents', closeout.confirmed_sales_total_cents,
    'payment_count', closeout.payment_count,
    'payment_total_cents', closeout.payment_total_cents,
    'payment_difference_cents', closeout.payment_difference_cents,
    'stock_difference_units', closeout.stock_difference_units,
    'justification', closeout.justification,
    'payment_summaries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'integration_channel', summary.integration_channel,
        'payment_count', summary.payment_count,
        'total_cents', summary.total_cents
      ) order by summary.integration_channel)
      from public.seller_closeout_payment_summaries summary where summary.closeout_id = closeout.id
    ), '[]'::jsonb),
    'stock_counts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', stock.product_id,
        'expected_quantity', stock.expected_quantity,
        'counted_quantity', stock.counted_quantity,
        'difference_quantity', stock.difference_quantity
      ) order by stock.product_id)
      from public.seller_closeout_stock_counts stock where stock.closeout_id = closeout.id
    ), '[]'::jsonb),
    'correlation_id', closeout.correlation_id
  ) into v_result
  from public.seller_closeouts closeout where closeout.id = v_closeout_id;

  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_closeout', v_closeout_id::text
  );
  return v_result;
end;
$$;

create or replace function public.reopen_seller_closeout(
  p_closeout_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_closeout public.seller_closeouts%rowtype;
  v_scope text;
  v_claim record;
  v_result jsonb;
begin
  if v_actor_id is null or not public.has_permission('closeouts.manage') then
    raise exception using errcode = '42501', message = 'CLOSEOUT_MANAGE_REQUIRED';
  end if;
  if p_closeout_id is null or p_correlation_id is null or p_reason is null
    or char_length(p_reason) not between 4 and 500 or p_reason <> btrim(p_reason) then
    raise exception using errcode = '22023', message = 'INVALID_CLOSEOUT_REOPEN';
  end if;

  v_scope := private.build_idempotency_scope('closeouts', 'reopen', v_actor_id);
  select * into v_claim from private.claim_idempotency(
    v_scope, p_idempotency_key,
    jsonb_build_object('closeout_id', p_closeout_id, 'reason', p_reason)
  );
  if not v_claim.is_new then
    if v_claim.operation_status = 'IN_PROGRESS' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_IN_PROGRESS';
    end if;
    return v_claim.stored_result;
  end if;

  select * into v_closeout from public.seller_closeouts where id = p_closeout_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_NOT_FOUND';
  end if;
  if v_closeout.status <> 'CLOSED' then
    raise exception using errcode = 'P0001', message = 'CLOSEOUT_NOT_REOPENABLE';
  end if;

  update public.seller_closeouts
  set status = 'REOPENED', reopened_at = clock_timestamp(), reopened_by = v_actor_id, reopen_reason = p_reason
  where id = v_closeout.id
  returning * into v_closeout;

  insert into public.audit_logs (
    action, actor_id, entity_type, entity_id, correlation_id, metadata
  ) values (
    'closeouts.reopened', v_actor_id, 'seller_closeout', v_closeout.id::text, p_correlation_id,
    jsonb_build_object('seller_id', v_closeout.seller_id, 'reason', p_reason)
  );
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload)
  values (
    'closeouts.reopened', 'seller_closeout', v_closeout.id::text,
    jsonb_build_object(
      'closeout_id', v_closeout.id,
      'seller_id', v_closeout.seller_id,
      'reopened_by', v_actor_id,
      'correlation_id', p_correlation_id
    )
  );

  v_result := jsonb_build_object(
    'closeout_id', v_closeout.id,
    'status', v_closeout.status,
    'reopened_at', v_closeout.reopened_at,
    'reopened_by', v_closeout.reopened_by,
    'reopen_reason', v_closeout.reopen_reason,
    'correlation_id', p_correlation_id
  );
  perform private.complete_idempotency(
    v_claim.record_id, 'SUCCEEDED', v_result, null, 'seller_closeout', v_closeout.id::text
  );
  return v_result;
end;
$$;

alter table public.seller_closeouts enable row level security;
alter table public.seller_closeout_payment_summaries enable row level security;
alter table public.seller_closeout_stock_counts enable row level security;

revoke all on table public.seller_closeouts from public, anon, authenticated, service_role;
revoke all on table public.seller_closeout_payment_summaries from public, anon, authenticated, service_role;
revoke all on table public.seller_closeout_stock_counts from public, anon, authenticated, service_role;
grant select on table public.seller_closeouts to authenticated;
grant select on table public.seller_closeout_payment_summaries to authenticated;
grant select on table public.seller_closeout_stock_counts to authenticated;

create policy seller_closeouts_own_read on public.seller_closeouts for select to authenticated
using (seller_id = auth.uid() and public.has_permission('closeouts.create'));
create policy seller_closeouts_manager_read on public.seller_closeouts for select to authenticated
using (public.has_permission('closeouts.manage'));
create policy seller_closeout_payment_visible on public.seller_closeout_payment_summaries for select to authenticated
using (exists (select 1 from public.seller_closeouts where seller_closeouts.id = seller_closeout_payment_summaries.closeout_id));
create policy seller_closeout_stock_visible on public.seller_closeout_stock_counts for select to authenticated
using (exists (select 1 from public.seller_closeouts where seller_closeouts.id = seller_closeout_stock_counts.closeout_id));

revoke all on function private.guard_seller_closeout_change() from public, anon, authenticated, service_role;
revoke all on function public.create_seller_closeout(timestamptz, timestamptz, jsonb, text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.reopen_seller_closeout(uuid, text, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.create_seller_closeout(timestamptz, timestamptz, jsonb, text, text, uuid)
to authenticated;
grant execute on function public.reopen_seller_closeout(uuid, text, text, uuid)
to authenticated;

comment on table public.seller_closeouts is 'Immutable seller operation snapshot; reopening appends audited terminal metadata.';
comment on function public.create_seller_closeout(timestamptz, timestamptz, jsonb, text, text, uuid) is
  'Creates an idempotent closeout for the authenticated seller and requires justification for payment or stock divergence.';
comment on function public.reopen_seller_closeout(uuid, text, text, uuid) is
  'Reopens a closeout once for Admin or Financeiro while preserving its original snapshot.';
