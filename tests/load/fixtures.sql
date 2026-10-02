-- Isolated fixtures for one staging load run. Everything is named after the run ("load.<run>.*", "Carga <run>")
-- and created through the product RPCs by a run-scoped administrator, so ledgers, audit and outbox stay coherent.
-- Only identities are inserted directly (like supabase/seed.sql); no e-mail is sent (accounts are pre-confirmed).
create schema if not exists loadtest;

create or replace function loadtest.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('role', 'authenticated', true);
end;
$$;
create or replace function loadtest.unset() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant usage on schema loadtest to public;
grant execute on all functions in schema loadtest to public;

create or replace function loadtest.person(p_run text, p_tag text, p_password text) returns uuid language plpgsql as $$
declare v_id uuid; v_email text := 'load.' || p_run || '.' || p_tag || '@institutojef.org.br';
begin
  select id into v_id from auth.users where email = v_email;
  if v_id is not null then return v_id; end if;
  v_id := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, phone_change_token, email_change_token_current, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf', 6)), now(), '', '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('name', 'Carga ' || p_tag, 'username', 'load' || p_run || p_tag), now(), now());
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id::text, v_id, jsonb_build_object('sub', v_id, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  return v_id;
end;
$$;

-- Creates the run: an administrator, sellers with stock, consumers, a catalog slice with central stock,
-- and the dedicated targets of each contention scenario. Returns every id the harness needs.
create or replace function loadtest.prepare(p_run text, p_password text, p_sellers integer, p_consumers integer) returns jsonb language plpgsql as $$
declare
  v_admin uuid; v_central uuid; v_category uuid; v_result jsonb; v_product uuid; v_revision integer;
  v_sellers jsonb := '[]'; v_consumers jsonb := '[]'; v_products jsonb := '{}'; v_user uuid; v_location uuid;
  v_raffle uuid; v_coupon_product uuid; v_promotion jsonb; v_terminal uuid;
  v_names text[] := array['volume_a', 'volume_b', 'volume_c', 'volume_d', 'volume_e', 'last_unit', 'sale_transfer', 'reserve_sale', 'coupon', 'replay', 'prize'];
  v_name text;
begin
  v_admin := loadtest.person(p_run, 'admin', p_password);
  insert into public.user_roles (user_id, role_id) select v_admin, id from public.roles where key = 'ADMIN' on conflict do nothing;
  select id into v_central from public.stock_locations where location_type = 'CENTRAL' and active;
  if v_central is null then raise exception 'LOAD_NO_CENTRAL_LOCATION'; end if;

  perform loadtest.as_user(v_admin);
  v_result := public.save_catalog_category(null, null, 'Carga ' || p_run, 'carga-' || p_run, true, 990, 'Teste de carga em staging', 'load:' || p_run || ':category', gen_random_uuid());
  v_category := (v_result ->> 'id')::uuid;
  foreach v_name in array v_names loop
    v_result := public.save_catalog_product(null, null, v_category, 'carga-' || p_run || '-' || replace(v_name, '_', '-'), 'Carga ' || p_run || ' ' || v_name,
      null, true, false, false, true, false, 'Teste de carga em staging', 'load:' || p_run || ':product:' || v_name, gen_random_uuid());
    v_product := (v_result ->> 'id')::uuid;
    v_result := public.set_catalog_product_price(v_product, (v_result ->> 'revision')::integer, 500, 'Preço da carga', 'load:' || p_run || ':price:' || v_name, gen_random_uuid());
    select revision into v_revision from public.products where id = v_product;
    perform public.save_catalog_product(v_product, v_revision, v_category, 'carga-' || p_run || '-' || replace(v_name, '_', '-'), 'Carga ' || p_run || ' ' || v_name,
      null, true, true, true, true, false, 'Publicar para a carga', 'load:' || p_run || ':publish:' || v_name, gen_random_uuid());
    -- Contention targets start with exactly the stock the scenario fights over.
    perform public.adjust_stock(v_central, v_product,
      case v_name when 'last_unit' then 1 when 'reserve_sale' then 1 when 'sale_transfer' then 1 when 'coupon' then 100 when 'prize' then 1 else 5000 end,
      'Estoque da carga', 'load:' || p_run || ':stock:' || v_name, gen_random_uuid());
    v_products := v_products || jsonb_build_object(v_name, v_product);
  end loop;
  v_coupon_product := (v_products ->> 'coupon')::uuid;
  v_promotion := public.save_promotion(null, null, upper('CARGA' || p_run), 'Cupom da carga ' || p_run, 'Limite global para o teste de concorrência', true, false, 990, true,
    now() - interval '1 minute', now() + interval '1 day', 5, null, array[v_coupon_product], array['RESERVA', 'PORTAL', 'PDV']::public.promotion_channel[],
    jsonb_build_object('type', 'CUPOM', 'code', upper('CARGA' || p_run), 'discount', jsonb_build_object('kind', 'PERCENTUAL', 'percentageBasisPoints', 1000)),
    'Teste de carga em staging', 'load:' || p_run || ':coupon', gen_random_uuid());
  v_result := public.create_raffle_campaign('Carga ' || p_run, (v_products ->> 'prize')::uuid, v_central, 20, now() - interval '1 minute', now() + interval '1 day',
    'load:' || p_run || ':raffle', gen_random_uuid());
  v_raffle := (v_result ->> 'campaign_id')::uuid;
  perform public.transition_raffle_campaign(v_raffle, 'PUBLISH', 'load:' || p_run || ':raffle-publish', gen_random_uuid());
  perform loadtest.unset();
  select id into v_terminal from public.payment_terminals where active order by code limit 1;

  for i in 1 .. p_sellers loop
    v_user := loadtest.person(p_run, 's' || lpad(i::text, 2, '0'), p_password);
    perform loadtest.as_user(v_admin);
    perform public.set_user_access(v_user, array['CONSUMIDOR', 'VENDEDOR'], true, gen_random_uuid());
    select id into v_location from public.stock_locations where seller_id = v_user;
    foreach v_name in array array['volume_a', 'volume_b', 'volume_c'] loop
      perform public.distribute_stock(v_central, v_location, (v_products ->> v_name)::uuid, 200, 'Estoque do vendedor de carga',
        'load:' || p_run || ':distribute:' || i || ':' || v_name, gen_random_uuid());
    end loop;
    if i = 1 then
      perform public.distribute_stock(v_central, v_location, (v_products ->> 'sale_transfer')::uuid, 1, 'Unidade disputada',
        'load:' || p_run || ':distribute-contested', gen_random_uuid());
    end if;
    perform loadtest.unset();
    v_sellers := v_sellers || jsonb_build_object('id', v_user, 'username', 'load' || p_run || 's' || lpad(i::text, 2, '0'), 'locationId', v_location);
  end loop;
  for i in 1 .. p_consumers loop
    v_user := loadtest.person(p_run, 'c' || lpad(i::text, 2, '0'), p_password);
    v_consumers := v_consumers || jsonb_build_object('id', v_user, 'username', 'load' || p_run || 'c' || lpad(i::text, 2, '0'));
  end loop;
  return jsonb_build_object('admin', jsonb_build_object('id', v_admin, 'username', 'load' || p_run || 'admin'), 'central', v_central,
    'category', v_category, 'products', v_products, 'raffle', v_raffle, 'coupon', upper('CARGA' || p_run), 'terminal', v_terminal,
    'sellers', v_sellers, 'consumers', v_consumers);
end;
$$;

-- Invariants scoped to the run's products and locations, plus the global ones.
create or replace function loadtest.check(p_run text) returns table (check_name text, violations bigint) language sql as $$
  with products as (select id from public.products where slug like 'carga-' || p_run || '-%')
  select 'stock negative or over-reserved', count(*) from public.inventory_balances
    where on_hand_quantity < 0 or reserved_quantity < 0 or reserved_quantity > on_hand_quantity
  union all
  select 'contested unit consumed twice', count(*) from (
    select balance.product_id from public.inventory_balances balance join products on products.id = balance.product_id
    join public.products product on product.id = balance.product_id
    where product.slug like any (array['%-last-unit', '%-reserve-sale', '%-sale-transfer', '%-prize'])
    group by balance.product_id having sum(balance.on_hand_quantity) > 1 or sum(balance.reserved_quantity) > 1) contested
  union all
  select 'raffle number with two owners', count(*) from (select campaign_id, number from public.raffle_numbers group by 1, 2 having count(*) > 1) duplicated
  union all
  select 'sale with more than one confirmed payment', count(*) from (select sale_id from public.payment_attempts
    where status in ('APPROVED', 'RECONCILIATION_PENDING', 'RECONCILED') group by sale_id having count(*) > 1) duplicated
  union all
  select 'payment recorded twice in the ledger', count(*) from (select payment_attempt_id, entry_type from public.financial_ledger_entries
    where entry_type in ('CASH_RECEIPT', 'RECEIVABLE_PICPAY') group by 1, 2 having count(*) > 1) duplicated
  union all
  select 'idempotency key with two results', count(*) from (select scope, key from public.idempotency_keys
    group by 1, 2 having count(*) > 1) duplicated
  union all
  select 'coupon redeemed over its global limit', greatest(0, count(*) - 5) from public.promotion_redemptions redemption
    join public.promotions promotion on promotion.id = redemption.promotion_id where promotion.code = upper('CARGA' || p_run)
  union all
  select 'outbox stuck in processing for more than 10 minutes', count(*) from public.outbox_events
    where status = 'PROCESSING' and locked_at < now() - interval '10 minutes';
$$;

-- Leaves the run inert: products unpublished, users inactive, raffle cancelled. History stays (ledgers are immutable).
create or replace function loadtest.retire(p_run text) returns jsonb language plpgsql as $$
declare v_admin uuid; v_product record; v_user uuid; v_users uuid[]; v_raffle uuid;
begin
  select id into v_admin from auth.users where email = 'load.' || p_run || '.admin@institutojef.org.br';
  if v_admin is null then return jsonb_build_object('retired', false); end if;
  select array_agg(id) into v_users from auth.users where email like 'load.' || p_run || '.%@institutojef.org.br' and id <> v_admin;
  perform loadtest.as_user(v_admin);
  for v_product in select * from public.products where slug like 'carga-' || p_run || '-%' and (published or active) loop
    perform public.save_catalog_product(v_product.id, v_product.revision, v_product.category_id, v_product.slug, v_product.name, v_product.description,
      false, false, false, v_product.reservable, v_product.tracks_lots, 'Fim do teste de carga', 'load:' || p_run || ':retire:' || v_product.id, gen_random_uuid());
  end loop;
  select id into v_raffle from public.raffle_campaigns where name = 'Carga ' || p_run and status in ('ACTIVE', 'PAUSED');
  if v_raffle is not null then
    perform public.cancel_raffle_campaign(v_raffle, 'Fim do teste de carga', 'load:' || p_run || ':raffle-cancel', gen_random_uuid());
  end if;
  foreach v_user in array coalesce(v_users, '{}') loop
    perform public.set_user_access(v_user, array['CONSUMIDOR'], false, gen_random_uuid());
  end loop;
  perform loadtest.unset();
  delete from public.user_roles where user_id = v_admin;
  update public.profiles set active = false where id = v_admin;
  return jsonb_build_object('retired', true);
end;
$$;

grant execute on all functions in schema loadtest to public;
