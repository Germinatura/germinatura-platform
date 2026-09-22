-- PROMO-001: transactional administration for the already executable quantity-price rule.
alter table public.promotions add column revision integer not null default 1 check (revision > 0);

create table public.promotion_versions (
  promotion_id uuid not null references public.promotions(id) on delete restrict,
  revision integer not null check (revision > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  actor_id uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(reason) between 4 and 500 and reason = btrim(reason)),
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (promotion_id, revision)
);
create index promotion_versions_created_idx on public.promotion_versions(promotion_id, created_at desc);
create trigger promotion_versions_immutable before update or delete on public.promotion_versions
for each row execute function private.prevent_immutable_record_change();
alter table public.promotion_versions enable row level security;
revoke all on public.promotion_versions from public, anon, authenticated, service_role;
grant select on public.promotion_versions to authenticated;
create policy promotion_versions_manager_read on public.promotion_versions for select to authenticated
using ((select public.has_permission('catalog.manage')));

create function private.promotion_snapshot(p_promotion_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'id', promotion.id, 'revision', promotion.revision, 'code', promotion.code,
    'name', promotion.name, 'description', promotion.description, 'active', promotion.active,
    'publicable', promotion.publicable, 'priority', promotion.priority,
    'cumulative', promotion.cumulative, 'validFrom', promotion.valid_from,
    'validTo', promotion.valid_to, 'globalRedemptionLimit', promotion.global_redemption_limit,
    'perUserRedemptionLimit', promotion.per_user_redemption_limit,
    'productIds', coalesce((select jsonb_agg(scope.product_id order by scope.product_id)
      from public.promotion_products scope where scope.promotion_id=promotion.id),'[]'::jsonb),
    'channels', coalesce((select jsonb_agg(scope.channel order by scope.channel)
      from public.promotion_channels scope where scope.promotion_id=promotion.id),'[]'::jsonb),
    'rule', (select jsonb_build_object('type', rule.rule_type, 'groupQuantity', rule.group_quantity,
      'groupPriceCents', rule.group_price_cents, 'maxGroupsPerLine', rule.max_groups_per_line)
      from public.promotion_quantity_price_rules rule where rule.promotion_id=promotion.id)
  ) from public.promotions promotion where promotion.id=p_promotion_id;
$$;

-- Child rows may only be replaced inside the audited command. Data API roles have no write grants.
create or replace function private.prevent_promotion_hard_delete()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('app.promotion_command', true) = 'on' then return old; end if;
  raise exception using errcode='P0001', message='PROMOTION_HARD_DELETE_FORBIDDEN';
end;
$$;

create function public.save_quantity_price_promotion(
  p_promotion_id uuid, p_expected_revision integer, p_code text, p_name text,
  p_description text, p_active boolean, p_publicable boolean, p_priority integer,
  p_cumulative boolean, p_valid_from timestamptz, p_valid_to timestamptz,
  p_global_redemption_limit bigint, p_per_user_redemption_limit integer,
  p_product_ids uuid[], p_channels public.promotion_channel[],
  p_group_quantity integer, p_group_price_cents bigint, p_max_groups_per_line integer,
  p_reason text, p_idempotency_key text, p_correlation_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_claim record; v_promotion public.promotions%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb;
begin
  if v_actor is null then raise exception using errcode='42501',message='AUTHENTICATION_REQUIRED'; end if;
  if not public.has_permission('catalog.manage') then raise exception using errcode='42501',message='PROMOTION_MANAGE_FORBIDDEN'; end if;
  if p_code is null or char_length(p_code) not between 1 and 80 or p_code<>btrim(p_code)
    or p_code!~'^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$'
    or p_name is null or char_length(p_name) not between 1 and 160 or p_name<>btrim(p_name)
    or (p_description is not null and (char_length(p_description) not between 1 and 2000 or p_description<>btrim(p_description)))
    or p_active is null or p_publicable is null or p_cumulative is null or p_cumulative
    or p_priority is null or p_priority not between 0 and 1000 or p_valid_from is null
    or (p_valid_to is not null and p_valid_to<=p_valid_from)
    or p_global_redemption_limit is not null or p_per_user_redemption_limit is not null
    or p_product_ids is null or cardinality(p_product_ids) not between 1 and 100
    or array_position(p_product_ids,null) is not null
    or cardinality(p_product_ids)<>(select count(distinct item) from unnest(p_product_ids) item)
    or p_channels is null or cardinality(p_channels) not between 1 and 3
    or array_position(p_channels,null) is not null
    or cardinality(p_channels)<>(select count(distinct item) from unnest(p_channels) item)
    or p_group_quantity is null or p_group_quantity<2
    or p_group_price_cents is null or p_group_price_cents not between 0 and 9007199254740991
    or (p_max_groups_per_line is not null and p_max_groups_per_line<1)
    or p_reason is null or char_length(p_reason) not between 4 and 500 or p_reason<>btrim(p_reason)
    or p_correlation_id is null
    or (p_promotion_id is null and p_expected_revision is not null)
    or (p_promotion_id is not null and (p_expected_revision is null or p_expected_revision<1)) then
    raise exception using errcode='22023',message='INVALID_PROMOTION';
  end if;
  if (select count(*) from public.products where id=any(p_product_ids))<>cardinality(p_product_ids) then
    raise exception using errcode='P0002',message='PROMOTION_PRODUCT_NOT_FOUND';
  end if;
  select * into v_claim from private.claim_idempotency(
    private.build_idempotency_scope('promotion','quantity_price_save',v_actor),p_idempotency_key,
    jsonb_build_object('id',p_promotion_id,'revision',p_expected_revision,'code',p_code,'name',p_name,
      'description',p_description,'active',p_active,'publicable',p_publicable,'priority',p_priority,
      'cumulative',p_cumulative,'valid_from',p_valid_from,'valid_to',p_valid_to,
      'global_limit',p_global_redemption_limit,'user_limit',p_per_user_redemption_limit,
      'products',p_product_ids,'channels',p_channels,'group_quantity',p_group_quantity,
      'group_price_cents',p_group_price_cents,'max_groups',p_max_groups_per_line,'reason',p_reason));
  if not v_claim.is_new then
    if v_claim.operation_status='IN_PROGRESS' then raise exception using errcode='P0001',message='IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_claim.stored_result;
  end if;
  if p_promotion_id is null then
    insert into public.promotions(code,name,description,active,publicable,priority,cumulative,valid_from,valid_to,
      global_redemption_limit,per_user_redemption_limit,created_by)
    values(p_code,p_name,p_description,p_active,p_publicable,p_priority,p_cumulative,p_valid_from,p_valid_to,
      p_global_redemption_limit,p_per_user_redemption_limit,v_actor) returning * into v_promotion;
  else
    select * into v_promotion from public.promotions where id=p_promotion_id for update;
    if not found then raise exception using errcode='P0002',message='PROMOTION_NOT_FOUND'; end if;
    if v_promotion.revision<>p_expected_revision then raise exception using errcode='P0001',message='PROMOTION_REVISION_CONFLICT'; end if;
    v_before:=private.promotion_snapshot(p_promotion_id);
    update public.promotions set code=p_code,name=p_name,description=p_description,active=p_active,
      publicable=p_publicable,priority=p_priority,cumulative=p_cumulative,valid_from=p_valid_from,
      valid_to=p_valid_to,global_redemption_limit=p_global_redemption_limit,
      per_user_redemption_limit=p_per_user_redemption_limit,revision=revision+1
    where id=p_promotion_id returning * into v_promotion;
    perform set_config('app.promotion_command','on',true);
    delete from public.promotion_products where promotion_id=p_promotion_id;
    delete from public.promotion_channels where promotion_id=p_promotion_id;
    delete from public.promotion_quantity_price_rules where promotion_id=p_promotion_id;
  end if;
  insert into public.promotion_products(promotion_id,product_id)
    select v_promotion.id,item from unnest(p_product_ids) item;
  insert into public.promotion_channels(promotion_id,channel)
    select v_promotion.id,item from unnest(p_channels) item;
  insert into public.promotion_quantity_price_rules(promotion_id,group_quantity,group_price_cents,max_groups_per_line)
    values(v_promotion.id,p_group_quantity,p_group_price_cents,p_max_groups_per_line);
  perform set_config('app.promotion_command','off',true);
  v_after:=private.promotion_snapshot(v_promotion.id);
  insert into public.promotion_versions(promotion_id,revision,snapshot,actor_id,reason,correlation_id)
    values(v_promotion.id,v_promotion.revision,v_after,v_actor,p_reason,p_correlation_id);
  insert into public.audit_logs(action,actor_id,entity_type,entity_id,correlation_id,metadata)
    values(case when p_promotion_id is null then 'promotion.created' else 'promotion.updated' end,
      v_actor,'promotion',v_promotion.id::text,p_correlation_id,
      jsonb_build_object('reason',p_reason,'before',v_before,'after',v_after));
  insert into public.outbox_events(topic,aggregate_type,aggregate_id,payload)
    values('promotion.changed','promotion',v_promotion.id::text,
      jsonb_build_object('promotion_id',v_promotion.id,'revision',v_promotion.revision,'active',v_promotion.active));
  v_result:=v_after||jsonb_build_object('correlationId',p_correlation_id);
  perform private.complete_idempotency(v_claim.record_id,'SUCCEEDED',v_result,null,'promotion',v_promotion.id::text);
  return v_result;
end;
$$;

-- Preserve an initial immutable snapshot for promotions created before this command existed.
insert into public.promotion_versions(promotion_id,revision,snapshot,actor_id,reason,correlation_id)
select promotion.id,promotion.revision,private.promotion_snapshot(promotion.id),promotion.created_by,
  'Snapshot inicial da promoção existente',gen_random_uuid() from public.promotions promotion
where private.promotion_snapshot(promotion.id) is not null on conflict do nothing;

revoke all on function private.promotion_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function public.save_quantity_price_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamptz,timestamptz,bigint,integer,uuid[],public.promotion_channel[],integer,bigint,integer,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_quantity_price_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamptz,timestamptz,bigint,integer,uuid[],public.promotion_channel[],integer,bigint,integer,text,text,uuid) to authenticated;

comment on table public.promotion_versions is 'Immutable snapshots for every administratively saved promotion revision.';
comment on function public.save_quantity_price_promotion(uuid,integer,text,text,text,boolean,boolean,integer,boolean,timestamptz,timestamptz,bigint,integer,uuid[],public.promotion_channel[],integer,bigint,integer,text,text,uuid) is 'Audited, idempotent quantity-price promotion administration with optimistic locking.';
