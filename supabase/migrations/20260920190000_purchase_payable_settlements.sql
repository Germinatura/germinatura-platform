-- Purchase receipts create immutable obligations. Settlements and their
-- corrections are separate immutable entries so payment never rewrites cost.
create table public.purchase_payable_settlements (
  id uuid primary key default gen_random_uuid(),
  payable_id uuid not null references public.purchase_payable_entries(id) on delete restrict,
  entry_type text not null check (entry_type in ('SETTLEMENT','REVERSAL')),
  amount_cents bigint not null check (amount_cents between 1 and 9007199254740991),
  effective_on date not null,
  payment_method text not null check (char_length(payment_method) between 2 and 100 and payment_method=btrim(payment_method)),
  reference text not null check (char_length(reference) between 2 and 160 and reference=btrim(reference)),
  reversal_of uuid references public.purchase_payable_settlements(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (char_length(reason) between 4 and 500 and reason=btrim(reason)),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint purchase_payable_settlement_shape check (
    (entry_type='SETTLEMENT' and reversal_of is null)
    or (entry_type='REVERSAL' and reversal_of is not null)
  )
);
create index purchase_payable_settlements_payable_idx
  on public.purchase_payable_settlements(payable_id,created_at desc,id desc);
create unique index purchase_payable_settlement_single_reversal
  on public.purchase_payable_settlements(reversal_of) where reversal_of is not null;

create trigger purchase_payable_settlements_immutable before update or delete
on public.purchase_payable_settlements for each row
execute function private.prevent_immutable_record_change();

alter table public.purchase_payable_settlements enable row level security;
create policy purchase_payable_settlements_finance_read on public.purchase_payable_settlements
for select to authenticated using ((select public.has_permission('finance.manage')));
create policy purchase_payable_settlements_procurement_read on public.purchase_payable_settlements
for select to authenticated using ((select public.has_permission('procurement.manage')));
create policy suppliers_finance_read on public.suppliers
for select to authenticated using ((select public.has_permission('finance.manage')));
revoke all on public.purchase_payable_settlements from public,anon,authenticated,service_role;
grant select on public.purchase_payable_settlements to authenticated;

create view public.purchase_payable_balances with (security_invoker=true) as
select payable.id,payable.receipt_id,payable.supplier_id,supplier.name as supplier_name,
  payable.amount_cents,payable.payment_method as expected_payment_method,payable.created_at,
  coalesce(sum(case settlement.entry_type when 'SETTLEMENT' then settlement.amount_cents else -settlement.amount_cents end),0)::bigint as settled_cents,
  (payable.amount_cents-coalesce(sum(case settlement.entry_type when 'SETTLEMENT' then settlement.amount_cents else -settlement.amount_cents end),0))::bigint as outstanding_cents,
  case when payable.amount_cents=coalesce(sum(case settlement.entry_type when 'SETTLEMENT' then settlement.amount_cents else -settlement.amount_cents end),0)
    then 'SETTLED' else 'PENDING' end as status
from public.purchase_payable_entries payable
join public.suppliers supplier on supplier.id=payable.supplier_id
left join public.purchase_payable_settlements settlement on settlement.payable_id=payable.id
group by payable.id,supplier.name;
revoke all on public.purchase_payable_balances from public,anon,authenticated,service_role;
grant select on public.purchase_payable_balances to authenticated;

create function public.settle_purchase_payable(
  p_payable_id uuid,p_amount_cents bigint,p_effective_on date,p_payment_method text,
  p_reference text,p_reason text,p_idempotency_key text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();
  v_claim record;
  v_payable public.purchase_payable_entries%rowtype;
  v_received_on date;
  v_settled bigint;
  v_remaining bigint;
  v_settlement_id uuid;
  v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('finance.manage') then raise exception using errcode='42501',message='FINANCE_MANAGE_FORBIDDEN'; end if;
  if p_payable_id is null or p_amount_cents is null or p_amount_cents not between 1 and 9007199254740991
    or p_effective_on is null or p_effective_on>(now() at time zone 'America/Sao_Paulo')::date
    or p_payment_method is null or p_payment_method<>btrim(p_payment_method) or char_length(p_payment_method) not between 2 and 100
    or p_reference is null or p_reference<>btrim(p_reference) or char_length(p_reference) not between 2 and 160
    or p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 4 and 500
    or p_correlation_id is null then
    raise exception using errcode='22023',message='INVALID_PAYABLE_SETTLEMENT';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance','purchase_payable_settle',v_actor),p_idempotency_key,
    jsonb_build_object('payable_id',p_payable_id,'amount_cents',p_amount_cents,'effective_on',p_effective_on,
      'payment_method',p_payment_method,'reference',p_reference,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_payable from public.purchase_payable_entries where id=p_payable_id for update;
  if not found then raise exception using errcode='P0002',message='PURCHASE_PAYABLE_NOT_FOUND'; end if;
  select received_on into v_received_on from public.purchase_receipts where id=v_payable.receipt_id;
  if p_effective_on<v_received_on then raise exception using errcode='22023',message='INVALID_PAYABLE_SETTLEMENT'; end if;
  select coalesce(sum(case entry_type when 'SETTLEMENT' then amount_cents else -amount_cents end),0)::bigint
    into v_settled from public.purchase_payable_settlements where payable_id=p_payable_id;
  v_remaining:=v_payable.amount_cents-v_settled;
  if v_remaining<=0 then raise exception using errcode='P0001',message='PURCHASE_PAYABLE_ALREADY_SETTLED'; end if;
  if p_amount_cents>v_remaining then raise exception using errcode='P0001',message='PURCHASE_PAYABLE_AMOUNT_EXCEEDED'; end if;
  insert into public.purchase_payable_settlements(payable_id,entry_type,amount_cents,effective_on,payment_method,reference,actor_id,reason,correlation_id)
    values(p_payable_id,'SETTLEMENT',p_amount_cents,p_effective_on,p_payment_method,p_reference,v_actor,p_reason,p_correlation_id)
    returning id into v_settlement_id;
  v_remaining:=v_remaining-p_amount_cents;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values('finance.purchase_payable.settled',v_actor,'purchase_payable_settlement',v_settlement_id::text,p_correlation_id,
      jsonb_build_object('payable_id',p_payable_id,'amount_cents',p_amount_cents,'remaining_cents',v_remaining,
        'effective_on',p_effective_on,'payment_method',p_payment_method,'reference',p_reference,'reason',p_reason));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('finance.purchase_payable.settled','purchase_payable',p_payable_id::text,
      jsonb_build_object('settlement_id',v_settlement_id,'payable_id',p_payable_id,'amount_cents',p_amount_cents,
        'remaining_cents',v_remaining,'correlation_id',p_correlation_id));
  v_result:=jsonb_build_object('id',v_settlement_id,'payableId',p_payable_id,'amountCents',p_amount_cents,
    'remainingCents',v_remaining,'status',case when v_remaining=0 then 'SETTLED' else 'PENDING' end,
    'correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'purchase_payable',p_payable_id::text);
  return v_result;
end;
$$;
revoke all on function public.settle_purchase_payable(uuid,bigint,date,text,text,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.settle_purchase_payable(uuid,bigint,date,text,text,text,text,uuid) to authenticated;

create function public.reverse_purchase_payable_settlement(
  p_settlement_id uuid,p_effective_on date,p_reason text,p_idempotency_key text,p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();
  v_claim record;
  v_original public.purchase_payable_settlements%rowtype;
  v_payable public.purchase_payable_entries%rowtype;
  v_reversal_id uuid;
  v_settled bigint;
  v_remaining bigint;
  v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('finance.manage') then raise exception using errcode='42501',message='FINANCE_MANAGE_FORBIDDEN'; end if;
  if p_settlement_id is null or p_effective_on is null or p_effective_on>(now() at time zone 'America/Sao_Paulo')::date
    or p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 4 and 500
    or p_correlation_id is null then raise exception using errcode='22023',message='INVALID_PAYABLE_REVERSAL'; end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('finance','purchase_payable_reverse',v_actor),p_idempotency_key,
    jsonb_build_object('settlement_id',p_settlement_id,'effective_on',p_effective_on,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  select * into v_original from public.purchase_payable_settlements where id=p_settlement_id for update;
  if not found then raise exception using errcode='P0002',message='PAYABLE_SETTLEMENT_NOT_FOUND'; end if;
  if v_original.entry_type<>'SETTLEMENT' then raise exception using errcode='P0001',message='PAYABLE_REVERSAL_TARGET_INVALID'; end if;
  if p_effective_on<v_original.effective_on then raise exception using errcode='22023',message='INVALID_PAYABLE_REVERSAL'; end if;
  select * into v_payable from public.purchase_payable_entries where id=v_original.payable_id for update;
  if exists(select 1 from public.purchase_payable_settlements where reversal_of=p_settlement_id) then
    raise exception using errcode='P0001',message='PAYABLE_SETTLEMENT_ALREADY_REVERSED';
  end if;
  insert into public.purchase_payable_settlements(payable_id,entry_type,amount_cents,effective_on,payment_method,reference,reversal_of,actor_id,reason,correlation_id)
    values(v_original.payable_id,'REVERSAL',v_original.amount_cents,p_effective_on,v_original.payment_method,v_original.reference,p_settlement_id,v_actor,p_reason,p_correlation_id)
    returning id into v_reversal_id;
  select coalesce(sum(case entry_type when 'SETTLEMENT' then amount_cents else -amount_cents end),0)::bigint
    into v_settled from public.purchase_payable_settlements where payable_id=v_original.payable_id;
  v_remaining:=v_payable.amount_cents-v_settled;
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values('finance.purchase_payable.settlement_reversed',v_actor,'purchase_payable_settlement',v_reversal_id::text,p_correlation_id,
      jsonb_build_object('payable_id',v_original.payable_id,'reversal_of',p_settlement_id,
        'amount_cents',v_original.amount_cents,'remaining_cents',v_remaining,'effective_on',p_effective_on,'reason',p_reason));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('finance.purchase_payable.settlement_reversed','purchase_payable',v_original.payable_id::text,
      jsonb_build_object('reversal_id',v_reversal_id,'reversal_of',p_settlement_id,'payable_id',v_original.payable_id,
        'amount_cents',v_original.amount_cents,'remaining_cents',v_remaining,'correlation_id',p_correlation_id));
  v_result:=jsonb_build_object('id',v_reversal_id,'payableId',v_original.payable_id,'reversalOf',p_settlement_id,
    'amountCents',v_original.amount_cents,'remainingCents',v_remaining,'status','PENDING','correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'purchase_payable',v_original.payable_id::text);
  return v_result;
end;
$$;
revoke all on function public.reverse_purchase_payable_settlement(uuid,date,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.reverse_purchase_payable_settlement(uuid,date,text,text,uuid) to authenticated;

comment on table public.purchase_payable_settlements is
  'Immutable cash settlement and reversal entries for procurement obligations.';
