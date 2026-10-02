-- Rich DEV/LOCAL dataset helpers. Loaded by tools/dev-seed/rich-seed.mjs into a throwaway "devseed" schema of
-- the LOCAL database only. Every business operation goes through the public RPCs as the right user, so the
-- ledgers, locks, idempotency, audit and outbox behave exactly as in the product. Only identities (auth.users,
-- like supabase/seed.sql) are inserted directly. Never run against any other database.

drop schema if exists devseed cascade;
create schema devseed;

create table devseed.refs (kind text not null, key text not null, id uuid not null, primary key (kind, key));
create table devseed.log (seq bigserial primary key, op text not null, key text, ok boolean not null, detail text, at timestamptz not null default clock_timestamp());
-- Each batch is a (day, slot) of the simulated calendar; the remap moves the real seed time into it.
create table devseed.batches (seq serial primary key, day integer not null, slot integer not null, real_start timestamptz not null, target_start timestamptz not null);
create table devseed.settings (key text primary key, value text not null);

create function devseed.id(p_kind text, p_key text) returns uuid language sql stable as $$
  select id from devseed.refs where kind = p_kind and key = p_key;
$$;
create function devseed.remember(p_kind text, p_key text, p_id uuid) returns uuid language sql as $$
  insert into devseed.refs values (p_kind, p_key, p_id) on conflict (kind, key) do update set id = excluded.id returning id;
$$;
create function devseed.note(p_op text, p_key text, p_ok boolean, p_detail text) returns void language sql as $$
  insert into devseed.log (op, key, ok, detail) values (p_op, p_key, p_ok, p_detail);
$$;

create function devseed.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('role', 'authenticated', true);
end;
$$;
create function devseed.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('role', 'service_role', true);
end;
$$;
create function devseed.unset() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end;
$$;
create function devseed.admin() returns uuid language sql stable as $$ select '10000000-0000-4000-8000-000000000001'::uuid $$;
create function devseed.central() returns uuid language sql stable as $$
  select id from public.stock_locations where location_type = 'CENTRAL' and active limit 1;
$$;
create function devseed.location_of(p_user uuid) returns uuid language sql stable as $$
  select id from public.stock_locations where seller_id = p_user;
$$;
create function devseed.k(p_op text, p_key text) returns text language sql immutable as $$ select 'devseed:' || p_op || ':' || p_key $$;

-- Calendar -------------------------------------------------------------------------------------------------
create function devseed.batch(p_day integer, p_slot integer, p_days integer) returns void language plpgsql as $$
declare v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- Slots 0..3 start at 09h, 12h, 15h and 18h (Brasília) of the simulated day.
  insert into devseed.batches (day, slot, real_start, target_start)
  values (p_day, p_slot, clock_timestamp(),
    ((v_today - (p_days - p_day)) + make_interval(hours => 9 + 3 * p_slot)) at time zone 'America/Sao_Paulo');
end;
$$;

-- Identities (same direct pattern as supabase/seed.sql), then access through set_user_access ------------------
create function devseed.person(p_key text, p_name text, p_username text, p_roles text[]) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_email text := 'seed.' || p_username || '@institutojef.org.br';
begin
  select id into v_id from auth.users where email = v_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, phone_change_token,
      email_change_token_current, reauthentication_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt('SeedLocal123!', extensions.gen_salt('bf', 4)), now(), '', '', '', '', '', '', '',
      '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p_name, 'username', replace(p_username, '-', '.')), now(), now());
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id::text, v_id, jsonb_build_object('sub', v_id, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  end if;
  perform devseed.remember('user', p_key, v_id);
  if p_roles <> array['CONSUMIDOR'] then
    perform devseed.as_user(devseed.admin());
    perform public.set_user_access(v_id, p_roles, true, gen_random_uuid());
    perform devseed.unset();
  end if;
  return v_id;
end;
$$;

-- Catalog --------------------------------------------------------------------------------------------------
create function devseed.category(p_key text, p_name text, p_slug text, p_sort integer) returns void language plpgsql as $$
declare v_result jsonb;
begin
  perform devseed.as_user(devseed.admin());
  v_result := public.save_catalog_category(null, null, p_name, p_slug, true, p_sort, 'Dataset de desenvolvimento', devseed.k('category', p_key), gen_random_uuid());
  perform devseed.unset();
  perform devseed.remember('category', p_key, (v_result ->> 'id')::uuid);
end;
$$;

create function devseed.product(p_key text, p_category text, p_name text, p_slug text, p_description text,
  p_price bigint, p_reservable boolean, p_lots boolean) returns void language plpgsql as $$
declare v_result jsonb; v_id uuid;
begin
  perform devseed.as_user(devseed.admin());
  v_result := public.save_catalog_product(null, null, devseed.id('category', p_category), p_slug, p_name, p_description,
    true, false, false, p_reservable, p_lots, 'Dataset de desenvolvimento', devseed.k('product', p_key), gen_random_uuid());
  v_id := (v_result ->> 'id')::uuid;
  perform public.set_catalog_product_price(v_id, (v_result ->> 'revision')::integer, p_price, 'Preço inicial', devseed.k('price0', p_key), gen_random_uuid());
  perform devseed.unset();
  perform devseed.remember('product', p_key, v_id);
end;
$$;

-- Publication state: published + sellable (or a draft, an inactive product, or a public product kept out of the PDV).
create function devseed.product_state(p_key text, p_active boolean, p_published boolean, p_sellable boolean) returns void language plpgsql as $$
declare v_product public.products%rowtype;
begin
  select * into v_product from public.products where id = devseed.id('product', p_key);
  perform devseed.as_user(devseed.admin());
  perform public.save_catalog_product(v_product.id, v_product.revision, v_product.category_id, v_product.slug, v_product.name,
    v_product.description, p_active, p_published, p_sellable, v_product.reservable, v_product.tracks_lots,
    'Estado do dataset', devseed.k('state', p_key || ':' || v_product.revision), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('product_state', p_key, false, sqlerrm);
end;
$$;

create function devseed.reprice(p_key text, p_price bigint, p_tag text) returns void language plpgsql as $$
declare v_product public.products%rowtype;
begin
  select * into v_product from public.products where id = devseed.id('product', p_key);
  perform devseed.as_user(devseed.admin());
  perform public.set_catalog_product_price(v_product.id, v_product.revision, p_price, 'Reajuste do dataset', devseed.k('price', p_key || ':' || p_tag), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('reprice', p_key, false, sqlerrm);
end;
$$;

create function devseed.image(p_key text, p_image uuid, p_path text, p_alt text) returns void language plpgsql as $$
declare v_product public.products%rowtype;
begin
  select * into v_product from public.products where id = devseed.id('product', p_key);
  perform devseed.as_user(devseed.admin());
  perform public.add_catalog_product_image(v_product.id, v_product.revision, p_image, p_path, p_alt, 'Imagem do dataset', devseed.k('image', p_key), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('image', p_key, false, sqlerrm);
end;
$$;

-- Procurement: supplier, order, receipt (lots and costs) and payable settlement ---------------------------------
create function devseed.supplier(p_key text, p_name text, p_contact text) returns void language plpgsql as $$
declare v_result jsonb;
begin
  perform devseed.as_user(devseed.admin());
  v_result := public.save_supplier(null, null, p_name, p_contact, null, null, null, 'Fornecedor fictício do dataset', true,
    'Dataset de desenvolvimento', devseed.k('supplier', p_key), gen_random_uuid());
  perform devseed.unset();
  perform devseed.remember('supplier', p_key, (v_result ->> 'id')::uuid);
end;
$$;

-- p_items: [{"p":"p001","q":40,"c":350}]
create function devseed.purchase(p_key text, p_supplier text, p_items jsonb, p_freight bigint, p_method text) returns void language plpgsql as $$
declare v_result jsonb; v_items jsonb;
begin
  select jsonb_agg(jsonb_build_object('productId', devseed.id('product', item ->> 'p'), 'quantity', (item ->> 'q')::bigint, 'unitCostCents', (item ->> 'c')::bigint))
  into v_items from jsonb_array_elements(p_items) item;
  perform devseed.as_user(devseed.admin());
  v_result := public.create_purchase_order(devseed.id('supplier', p_supplier), (now() at time zone 'America/Sao_Paulo')::date, null,
    p_freight, 0, p_method, null, null, v_items, 'Reposição do dataset', devseed.k('order', p_key), gen_random_uuid());
  perform devseed.unset();
  perform devseed.remember('order', p_key, (v_result ->> 'id')::uuid);
exception when others then
  perform devseed.unset();
  perform devseed.note('purchase', p_key, false, sqlerrm);
end;
$$;

-- Receives a share of each item (1.0 = everything still open).
create function devseed.receive(p_key text, p_share numeric) returns void language plpgsql as $$
declare v_item record; v_quantity bigint; v_order uuid := devseed.id('order', p_key);
begin
  for v_item in
    select item.id, item.product_id, item.quantity - coalesce((select sum(receipt.quantity) from public.purchase_receipts receipt where receipt.order_item_id = item.id), 0) as open_quantity,
      product.tracks_lots
    from public.purchase_order_items item join public.products product on product.id = item.product_id
    where item.order_id = v_order order by item.id
  loop
    v_quantity := greatest(1, floor(v_item.open_quantity * p_share))::bigint;
    continue when v_item.open_quantity <= 0;
    v_quantity := least(v_quantity, v_item.open_quantity);
    begin
      perform devseed.as_user(devseed.admin());
      perform public.receive_purchase_order_item(v_order, v_item.id, v_quantity, (now() at time zone 'America/Sao_Paulo')::date,
        case when v_item.tracks_lots then upper(left(replace(p_key, '-', ''), 10)) || '-' || left(v_item.id::text, 4) else null end,
        case when v_item.tracks_lots then (now() at time zone 'America/Sao_Paulo')::date - 2 else null end,
        case when v_item.tracks_lots then (now() at time zone 'America/Sao_Paulo')::date + 60 else null end,
        'Recebimento do dataset', devseed.k('receive', p_key || ':' || v_item.id || ':' || p_share), gen_random_uuid());
      perform devseed.unset();
    exception when others then
      perform devseed.unset();
      perform devseed.note('receive', p_key, false, sqlerrm);
    end;
  end loop;
end;
$$;

create function devseed.cancel_order(p_key text) returns void language plpgsql as $$
begin
  perform devseed.as_user(devseed.admin());
  perform public.cancel_purchase_order(devseed.id('order', p_key), 'Pedido desistido no dataset', devseed.k('cancel-order', p_key), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('cancel_order', p_key, false, sqlerrm);
end;
$$;

-- Settles a share of every open payable of the order.
create function devseed.settle(p_key text, p_share numeric) returns void language plpgsql as $$
declare v_payable record;
begin
  for v_payable in
    select payable.id, payable.amount_cents - coalesce((select sum(case settlement.entry_type when 'SETTLEMENT' then settlement.amount_cents else -settlement.amount_cents end)
      from public.purchase_payable_settlements settlement where settlement.payable_id = payable.id), 0) as open_cents
    from public.purchase_payable_entries payable
    join public.purchase_receipts receipt on receipt.id = payable.receipt_id
    where receipt.order_id = devseed.id('order', p_key)
  loop
    continue when v_payable.open_cents <= 0;
    begin
      perform devseed.as_user(devseed.admin());
      perform public.settle_purchase_payable(v_payable.id, greatest(1, floor(v_payable.open_cents * p_share))::bigint,
        (now() at time zone 'America/Sao_Paulo')::date, 'PIX', 'PAG-' || upper(left(replace(p_key, '-', ''), 12)), 'Pagamento do dataset',
        devseed.k('settle', p_key || ':' || v_payable.id || ':' || p_share), gen_random_uuid());
      perform devseed.unset();
    exception when others then
      perform devseed.unset();
      perform devseed.note('settle', p_key, false, sqlerrm);
    end;
  end loop;
end;
$$;

-- Stock movements --------------------------------------------------------------------------------------------
create function devseed.distribute(p_tag text, p_seller text, p_product text, p_quantity bigint) returns void language plpgsql as $$
declare v_available bigint;
begin
  select available_quantity into v_available from public.inventory_balances
  where location_id = devseed.central() and product_id = devseed.id('product', p_product);
  if coalesce(v_available, 0) <= 0 then return; end if;
  perform devseed.as_user(devseed.admin());
  perform public.distribute_stock(devseed.central(), devseed.location_of(devseed.id('user', p_seller)), devseed.id('product', p_product),
    least(p_quantity, v_available), 'Separação para venda', devseed.k('distribute', p_tag), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('distribute', p_tag, false, sqlerrm);
end;
$$;

create function devseed.loss(p_tag text, p_seller text, p_product text, p_quantity bigint, p_reason text, p_approve boolean) returns void language plpgsql as $$
declare v_result jsonb; v_user uuid := devseed.id('user', p_seller); v_product uuid := devseed.id('product', p_product);
begin
  if coalesce((select available_quantity from public.inventory_balances where location_id = devseed.location_of(v_user)
    and product_id = devseed.id('product', p_product)), 0) < p_quantity then return; end if;
  perform devseed.as_user(v_user);
  v_result := public.report_stock_loss(v_product, p_quantity, p_reason, 'Registro do dataset de desenvolvimento', null,
    devseed.k('loss', p_tag), gen_random_uuid());
  perform devseed.unset();
  if v_result ->> 'status' = 'PENDING_APPROVAL' then
    perform devseed.as_user(devseed.admin());
    perform public.resolve_stock_loss((v_result ->> 'report_id')::uuid, case when p_approve then 'APPROVE' else 'REJECT' end,
      case when p_approve then 'Perda conferida' else 'Produto encontrado na conferência' end, devseed.k('loss-resolve', p_tag), gen_random_uuid());
    perform devseed.unset();
  end if;
exception when others then
  perform devseed.unset();
  perform devseed.note('loss', p_tag, false, sqlerrm);
end;
$$;

-- Central physical count: counts every product with stock, with a small shortage on some.
create function devseed.central_count(p_tag text, p_short_every integer, p_approve boolean) returns void language plpgsql as $$
declare v_items jsonb; v_result jsonb;
begin
  select jsonb_agg(jsonb_build_object('product_id', product_id, 'expected_on_hand_quantity', on_hand_quantity,
    'expected_reserved_quantity', reserved_quantity,
    'counted_on_hand_quantity', greatest(reserved_quantity, on_hand_quantity - case when position % p_short_every = 0 then 1 else 0 end)) order by position)
  into v_items
  from (select balance.product_id, balance.on_hand_quantity, balance.reserved_quantity, row_number() over (order by product.slug) as position
    from public.inventory_balances balance join public.products product on product.id = balance.product_id
    where balance.location_id = devseed.central() and balance.on_hand_quantity > 0 and product.slug like 'seed-%') counted;
  if v_items is null then return; end if;
  perform devseed.as_user(devseed.admin());
  v_result := public.submit_inventory_count(devseed.central(), v_items, 'Inventário do dataset', devseed.k('count', p_tag), gen_random_uuid());
  if v_result ->> 'status' = 'PENDING_APPROVAL' then
    perform public.resolve_inventory_count((v_result ->> 'count_id')::uuid, case when p_approve then 'APPROVE' else 'REJECT' end,
      'Conferência do inventário', devseed.k('count-resolve', p_tag), gen_random_uuid());
  end if;
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('central_count', p_tag, false, sqlerrm);
end;
$$;

-- Cash shifts ------------------------------------------------------------------------------------------------
create function devseed.open_shift(p_tag text, p_seller text, p_cash bigint) returns void language plpgsql as $$
declare v_user uuid := devseed.id('user', p_seller); v_location uuid := devseed.location_of(devseed.id('user', p_seller));
begin
  if exists (select 1 from public.seller_shifts where seller_id = v_user and status = 'OPEN') then return; end if;
  perform devseed.as_user(v_user);
  perform public.open_seller_shift(v_location, p_cash, devseed.k('shift-open', p_tag), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('open_shift', p_tag, false, sqlerrm);
end;
$$;

-- Closes with the expected cash, or a small difference with a justification.
create function devseed.close_shift(p_tag text, p_seller text, p_difference bigint) returns void language plpgsql as $$
declare v_user uuid := devseed.id('user', p_seller); v_shift public.seller_shifts%rowtype; v_expected bigint;
begin
  select * into v_shift from public.seller_shifts where seller_id = v_user and status = 'OPEN';
  if not found then return; end if;
  perform devseed.as_user(v_user);
  select (public.get_my_seller_shift() ->> 'expected_cash_cents')::bigint into v_expected;
  perform public.close_seller_shift(v_shift.id, greatest(0, coalesce(v_expected, v_shift.opening_cash_cents) + p_difference),
    case when p_difference <> 0 then 'Diferença de troco registrada no fechamento' else null end, devseed.k('shift-close', p_tag), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('close_shift', p_tag, false, sqlerrm);
end;
$$;

-- PDV sales --------------------------------------------------------------------------------------------------
-- p_items: [{"p":"p001","q":2}]; only items the seller has in stock are sold. p_channel: CREDITO, DEBITO, PIX, DINHEIRO.
create function devseed.sale(p_key text, p_seller text, p_items jsonb, p_channel text, p_coupon text, p_share text) returns void language plpgsql as $$
declare v_user uuid := devseed.id('user', p_seller); v_location uuid; v_items jsonb; v_result jsonb; v_sale uuid; v_total bigint;
  v_terminal uuid := (select id from public.payment_terminals where active order by code limit 1);
  v_share_code text := (select code from public.share_campaigns where id = devseed.id('share', p_share));
begin
  -- Lookups happen before acting as the seller, whose row-level access is narrower.
  v_location := devseed.location_of(v_user);
  select jsonb_agg(jsonb_build_object('product_id', product.id, 'quantity', (item ->> 'q')::bigint))
  into v_items
  from jsonb_array_elements(p_items) item
  join public.products product on product.id = devseed.id('product', item ->> 'p') and product.active and product.sellable_pdv
  join public.inventory_balances balance on balance.location_id = v_location and balance.product_id = product.id
    and balance.available_quantity >= (item ->> 'q')::bigint;
  if v_items is null then
    perform devseed.note('sale', p_key, false, 'NO_STOCK');
    return;
  end if;
  perform devseed.as_user(v_user);
  v_result := public.checkout_sale('PDV', v_location, v_items, devseed.k('sale', p_key), gen_random_uuid(), p_coupon);
  v_sale := (v_result ->> 'sale_id')::uuid;
  v_total := (v_result -> 'quote' ->> 'total_cents')::bigint;
  if p_channel = 'DINHEIRO' then
    perform public.confirm_cash_payment(v_sale, ((v_total + 999) / 1000) * 1000, devseed.k('pay', p_key), gen_random_uuid());
  elsif p_channel = 'PIX' then
    perform public.confirm_manual_payment(v_sale, 'PIX_AREA', 'PIX-' || upper(left(md5(p_key), 10)), null, null, devseed.k('pay', p_key), gen_random_uuid());
  else
    perform public.confirm_manual_payment(v_sale, 'MAQUININHA', 'NSU-' || upper(left(md5(p_key), 8)), p_channel::public.card_payment_method,
      v_terminal, devseed.k('pay', p_key), gen_random_uuid());
  end if;
  if p_share is not null then
    perform public.attribute_pdv_sale(v_sale, v_share_code, gen_random_uuid());
  end if;
  perform devseed.unset();
  perform devseed.remember('sale', p_key, v_sale);
exception when others then
  perform devseed.unset();
  perform devseed.note('sale', p_key, false, sqlerrm);
end;
$$;

create function devseed.refund(p_key text, p_reason text) returns void language plpgsql as $$
declare v_sale public.sales%rowtype; v_shift uuid; v_cash boolean;
begin
  select * into v_sale from public.sales where id = devseed.id('sale', p_key);
  if not found or v_sale.status <> 'CONFIRMED' then return; end if;
  select exists (select 1 from public.payment_attempts where sale_id = v_sale.id and integration_channel = 'DINHEIRO') into v_cash;
  perform devseed.as_user(devseed.admin());
  if v_cash then
    select id into v_shift from public.seller_shifts where seller_id = v_sale.created_by and status = 'OPEN';
    perform public.reverse_confirmed_sale(v_sale.id, p_reason, 'DEV-' || upper(left(md5(p_key), 8)), v_shift, devseed.k('refund', p_key), gen_random_uuid());
  else
    perform public.reverse_confirmed_sale(v_sale.id, p_reason, 'EST-' || upper(left(md5(p_key), 8)), null, devseed.k('refund', p_key), gen_random_uuid());
  end if;
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('refund', p_key, false, sqlerrm);
end;
$$;

create function devseed.closeout(p_tag text, p_seller text, p_since timestamptz) returns void language plpgsql as $$
declare v_user uuid := devseed.id('user', p_seller); v_counts jsonb;
begin
  select jsonb_agg(jsonb_build_object('product_id', product_id, 'counted_quantity', on_hand_quantity) order by product_id)
  into v_counts from public.inventory_balances where location_id = devseed.location_of(v_user);
  perform devseed.as_user(v_user);
  perform public.create_seller_closeout(p_since, clock_timestamp(), coalesce(v_counts, '[]'::jsonb), null, devseed.k('closeout', p_tag), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('closeout', p_tag, false, sqlerrm);
end;
$$;

-- Reservations (Portal, central stock) ---------------------------------------------------------------------------
-- p_fate: OPEN (left active), READY, PICKED_PIX, PICKED_CARD, CANCELLED.
create function devseed.reservation(p_key text, p_consumer text, p_items jsonb, p_fate text, p_share text) returns void language plpgsql as $$
declare v_user uuid := devseed.id('user', p_consumer); v_items jsonb; v_result jsonb; v_reservation uuid; v_total bigint;
  v_central uuid := devseed.central();
  v_terminal uuid := (select id from public.payment_terminals where active order by code limit 1);
  v_share_code text := (select code from public.share_campaigns where id = devseed.id('share', p_share));
begin
  select jsonb_agg(jsonb_build_object('product_id', product.id, 'quantity', (item ->> 'q')::bigint))
  into v_items
  from jsonb_array_elements(p_items) item
  join public.products product on product.id = devseed.id('product', item ->> 'p') and product.active and product.published and product.reservable
  join public.inventory_balances balance on balance.location_id = devseed.central() and balance.product_id = product.id
    and balance.available_quantity >= (item ->> 'q')::bigint;
  if v_items is null then
    perform devseed.note('reservation', p_key, false, 'NO_STOCK');
    return;
  end if;
  perform devseed.as_user(v_user);
  v_result := public.create_commercial_reservation(v_central, v_items, devseed.k('reservation', p_key), gen_random_uuid());
  v_reservation := coalesce((v_result ->> 'reservation_id')::uuid, (v_result ->> 'id')::uuid);
  if p_share is not null then
    perform public.attribute_reservation(v_reservation, v_share_code);
  end if;
  if p_fate = 'CANCELLED' then
    perform public.cancel_commercial_reservation(v_reservation, devseed.k('reservation-cancel', p_key), gen_random_uuid());
  end if;
  perform devseed.unset();
  if p_fate in ('READY', 'PICKED_PIX', 'PICKED_CARD') then
    perform devseed.as_user(devseed.admin());
    perform public.mark_commercial_reservation_ready(v_reservation, 'Balcão da comissão, no intervalo', devseed.k('reservation-ready', p_key), gen_random_uuid());
    if p_fate = 'PICKED_CARD' then
      perform public.complete_reservation_pickup(v_reservation, 'MAQUININHA', null, 'NSU-' || upper(left(md5(p_key), 8)), 'DEBITO', v_terminal,
        devseed.k('reservation-pickup', p_key), gen_random_uuid());
    elsif p_fate = 'PICKED_PIX' then
      perform public.complete_reservation_pickup(v_reservation, 'PIX_AREA', null, 'PIX-' || upper(left(md5(p_key), 10)), null, null,
        devseed.k('reservation-pickup', p_key), gen_random_uuid());
    end if;
    perform devseed.unset();
  end if;
  perform devseed.remember('reservation', p_key, v_reservation);
exception when others then
  perform devseed.unset();
  perform devseed.note('reservation', p_key, false, sqlerrm);
end;
$$;

-- Raffles ------------------------------------------------------------------------------------------------------
create function devseed.raffle(p_key text, p_name text, p_product text, p_numbers integer, p_days integer) returns void language plpgsql as $$
declare v_result jsonb;
begin
  perform devseed.as_user(devseed.admin());
  v_result := public.create_raffle_campaign(p_name, devseed.id('product', p_product), devseed.central(), p_numbers,
    now() - interval '1 minute', now() + make_interval(days => p_days), devseed.k('raffle', p_key), gen_random_uuid());
  perform public.transition_raffle_campaign((v_result ->> 'campaign_id')::uuid, 'PUBLISH', devseed.k('raffle-publish', p_key), gen_random_uuid());
  perform devseed.unset();
  perform devseed.remember('raffle', p_key, (v_result ->> 'campaign_id')::uuid);
exception when others then
  perform devseed.unset();
  perform devseed.note('raffle', p_key, false, sqlerrm);
end;
$$;

-- A seller sells numbers at the PDV to a registered consumer or a walk-in buyer, paid by card or PIX.
create function devseed.raffle_sale(p_key text, p_raffle text, p_seller text, p_numbers integer[], p_consumer text, p_channel text) returns void language plpgsql as $$
declare v_user uuid := devseed.id('user', p_seller); v_result jsonb; v_sale uuid; v_location uuid := devseed.location_of(devseed.id('user', p_seller));
  v_buyer uuid := devseed.id('user', p_consumer); v_raffle uuid := devseed.id('raffle', p_raffle);
  v_terminal uuid := (select id from public.payment_terminals where active order by code limit 1);
begin
  perform devseed.as_user(v_user);
  v_result := public.reserve_raffle_numbers_pdv(v_raffle, v_location, p_numbers,
    v_buyer, case when p_consumer is null then 'Comprador avulso' else null end,
    case when p_consumer is null then 'contato.avulso@exemplo.test' else null end, devseed.k('raffle-sale', p_key), gen_random_uuid());
  v_sale := (v_result ->> 'sale_id')::uuid;
  if p_channel = 'PIX' then
    perform public.confirm_manual_payment(v_sale, 'PIX_AREA', 'RIFA-' || upper(left(md5(p_key), 8)), null, null, devseed.k('raffle-pay', p_key), gen_random_uuid());
  elsif p_channel is not null then
    perform public.confirm_manual_payment(v_sale, 'MAQUININHA', 'NSU-' || upper(left(md5(p_key), 8)), p_channel::public.card_payment_method, v_terminal,
      devseed.k('raffle-pay', p_key), gen_random_uuid());
  end if;
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('raffle_sale', p_key, false, sqlerrm);
end;
$$;

-- p_action: PAUSE, CLOSE, DRAW (close then draw) or CANCEL.
create function devseed.raffle_finish(p_key text, p_action text) returns void language plpgsql as $$
declare v_raffle uuid := devseed.id('raffle', p_key);
begin
  perform devseed.as_user(devseed.admin());
  if p_action = 'CANCEL' then
    perform public.cancel_raffle_campaign(v_raffle, 'Campanha encerrada pela comissão', devseed.k('raffle-cancel', p_key), gen_random_uuid());
  elsif p_action = 'PAUSE' then
    perform public.transition_raffle_campaign(v_raffle, 'PAUSE', devseed.k('raffle-pause', p_key), gen_random_uuid());
  else
    perform public.close_raffle_campaign(v_raffle, devseed.k('raffle-close', p_key), gen_random_uuid());
    if p_action = 'DRAW' then
      perform public.draw_raffle_campaign(v_raffle, devseed.k('raffle-draw', p_key), gen_random_uuid());
    end if;
  end if;
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('raffle_finish', p_key, false, sqlerrm);
end;
$$;

-- Communication ----------------------------------------------------------------------------------------------
create function devseed.event(p_key text, p_kind text, p_title text, p_description text, p_days_ahead integer, p_location text,
  p_products text[], p_fate text) returns void language plpgsql as $$
declare v_result jsonb; v_event uuid;
begin
  perform devseed.as_user(devseed.admin());
  v_result := public.save_portal_event(null, null, p_kind::public.portal_event_kind, p_title, p_description,
    now() + make_interval(days => p_days_ahead, hours => 2), now() + make_interval(days => p_days_ahead, hours => 6), p_location, null,
    'Ver produtos', '/catalogo', coalesce((select array_agg(devseed.id('product', key)) from unnest(p_products) key), '{}'), '{}', '{}',
    devseed.k('event', p_key), gen_random_uuid());
  v_event := (v_result ->> 'id')::uuid;
  if p_fate in ('PUBLISHED', 'CANCELLED') then
    perform public.transition_portal_event(v_event, 'PUBLICAR', null, devseed.k('event-publish', p_key), gen_random_uuid());
  end if;
  if p_fate = 'CANCELLED' then
    perform public.transition_portal_event(v_event, 'CANCELAR', 'Data remarcada pela comissão', devseed.k('event-cancel', p_key), gen_random_uuid());
  end if;
  perform devseed.unset();
  perform devseed.remember('event', p_key, v_event);
exception when others then
  perform devseed.unset();
  perform devseed.note('event', p_key, false, sqlerrm);
end;
$$;

create function devseed.share(p_key text, p_title text, p_channel text, p_products text[], p_seller text, p_visits integer) returns void language plpgsql as $$
declare v_result jsonb; v_code text;
begin
  if p_seller is null then
    perform devseed.as_user(devseed.admin());
    v_result := public.create_share_campaign(p_title, p_channel::public.share_channel,
      (select array_agg(devseed.id('product', key)) from unnest(p_products) key), devseed.k('share', p_key), gen_random_uuid());
  else
    perform devseed.as_user(devseed.id('user', p_seller));
    v_result := public.create_seller_share_link(p_title, p_channel::public.share_channel,
      (select array_agg(devseed.id('product', key)) from unnest(p_products) key), devseed.k('share', p_key), gen_random_uuid());
  end if;
  perform devseed.unset();
  perform devseed.remember('share', p_key, (v_result ->> 'id')::uuid);
  select code into v_code from public.share_campaigns where id = (v_result ->> 'id')::uuid;
  for i in 1 .. p_visits loop
    perform set_config('role', 'anon', true);
    perform public.record_share_visit(v_code);
    perform devseed.unset();
  end loop;
exception when others then
  perform devseed.unset();
  perform devseed.note('share', p_key, false, sqlerrm);
end;
$$;

create function devseed.announce(p_key text, p_title text, p_body text, p_roles text[]) returns void language plpgsql as $$
begin
  perform devseed.as_user(devseed.admin());
  perform public.publish_announcement(p_title, p_body, p_roles is null, p_roles, null, devseed.k('announce', p_key), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('announce', p_key, false, sqlerrm);
end;
$$;

create function devseed.preference(p_consumer text, p_category text, p_enabled boolean) returns void language plpgsql as $$
begin
  perform devseed.as_user(devseed.id('user', p_consumer));
  perform public.set_notification_preference(p_category::public.notification_category, p_enabled);
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('preference', p_consumer, false, sqlerrm);
end;
$$;

-- Finance --------------------------------------------------------------------------------------------------------
create function devseed.entry(p_key text, p_kind text, p_category text, p_account text, p_counter text, p_cents bigint, p_description text) returns void language plpgsql as $$
declare v_result jsonb;
begin
  perform devseed.as_user(devseed.admin());
  v_result := public.record_finance_entry(p_kind::public.finance_manual_entry_kind, p_category::public.finance_category, p_account::public.finance_account,
    p_counter::public.finance_account, p_cents, (now() at time zone 'America/Sao_Paulo')::date, p_description, 'DOC-' || upper(left(md5(p_key), 6)),
    devseed.k('entry', p_key), gen_random_uuid());
  perform devseed.unset();
  perform devseed.remember('entry', p_key, coalesce((v_result ->> 'id')::uuid, (v_result ->> 'entry_id')::uuid));
exception when others then
  perform devseed.unset();
  perform devseed.note('entry', p_key, false, sqlerrm);
end;
$$;

create function devseed.reverse_entry(p_key text) returns void language plpgsql as $$
begin
  perform devseed.as_user(devseed.admin());
  perform public.reverse_finance_entry(devseed.id('entry', p_key), 'Lançamento duplicado na planilha', devseed.k('entry-reverse', p_key), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('reverse_entry', p_key, false, sqlerrm);
end;
$$;

create function devseed.terminal(p_code text, p_label text) returns void language plpgsql as $$
begin
  perform devseed.as_user(devseed.admin());
  perform public.save_payment_terminal(null, p_code, p_label, true, devseed.k('terminal', p_code), gen_random_uuid());
  perform devseed.unset();
exception when others then
  perform devseed.unset();
  perform devseed.note('terminal', p_code, false, sqlerrm);
end;
$$;

-- The jobs worker's loop: delivers notifications and every other outbox effect.
create function devseed.drain_outbox() returns integer language plpgsql as $$
declare v_event record; v_total integer := 0; v_round integer;
begin
  loop
    v_round := 0;
    perform devseed.as_service();
    for v_event in select id from public.worker_claim_outbox_events('devseed-worker', 100, 300) loop
      begin
        perform public.worker_process_outbox_event(v_event.id, 'devseed-worker');
      exception when others then
        perform public.worker_retry_outbox_event(v_event.id, 'devseed-worker', left(sqlerrm, 200), 1, 10);
      end;
      v_round := v_round + 1;
    end loop;
    perform devseed.unset();
    v_total := v_total + v_round;
    exit when v_round = 0;
  end loop;
  return v_total;
end;
$$;

-- Promotions of every kind. p_rule carries the kind-specific fields; channels default to PDV, PORTAL and RESERVA.
create function devseed.promotion(p_key text, p_code text, p_name text, p_products text[], p_rule jsonb, p_priority integer,
  p_valid_days integer, p_global_limit bigint) returns void language plpgsql as $$
declare
  v_products uuid[] := (select array_agg(devseed.id('product', key) order by key) from unnest(p_products) key);
  v_channels public.promotion_channel[] := array['PDV', 'PORTAL', 'RESERVA']::public.promotion_channel[];
  v_to timestamptz := case when p_valid_days is null then null else now() + make_interval(days => p_valid_days) end;
  v_kind text := p_rule ->> 'type';
  v_result jsonb;
begin
  perform devseed.as_user(devseed.admin());
  if v_kind = 'QUANTIDADE_PRECO' then
    v_result := public.save_quantity_price_promotion(null, null, p_code, p_name, 'Promoção do dataset', true, true, p_priority, false,
      now() - interval '1 minute', v_to, p_global_limit, null, v_products, v_channels,
      (p_rule ->> 'groupQuantity')::integer, (p_rule ->> 'groupPriceCents')::bigint, null, 'Dataset de desenvolvimento', devseed.k('promotion', p_key), gen_random_uuid());
  elsif v_kind in ('PERCENTUAL', 'VALOR_FIXO_UNITARIO') then
    v_result := public.save_unit_promotion(null, null, p_code, p_name, 'Promoção do dataset', true, true, p_priority, false,
      now() - interval '1 minute', v_to, p_global_limit, null, v_products, v_channels, v_kind::public.promotion_rule_type,
      (p_rule ->> 'percentageBasisPoints')::integer, (p_rule ->> 'fixedUnitPriceCents')::bigint, 'Dataset de desenvolvimento', devseed.k('promotion', p_key), gen_random_uuid());
  else
    if v_kind = 'COMBO_MIX' then
      p_rule := jsonb_set(p_rule, '{components}', (select jsonb_agg(jsonb_build_object('productId', devseed.id('product', component ->> 'p'), 'quantity', (component ->> 'q')::integer))
        from jsonb_array_elements(p_rule -> 'components') component));
    end if;
    v_result := public.save_promotion(null, null, p_code, p_name, 'Promoção do dataset', true, true, p_priority, v_kind = 'CUPOM',
      now() - interval '1 minute', v_to, p_global_limit, case when v_kind = 'CUPOM' then 1 else null end, v_products, v_channels, p_rule,
      'Dataset de desenvolvimento', devseed.k('promotion', p_key), gen_random_uuid());
  end if;
  perform devseed.unset();
  perform devseed.remember('promotion', p_key, coalesce((v_result ->> 'id')::uuid, (v_result ->> 'promotion_id')::uuid));
exception when others then
  perform devseed.unset();
  perform devseed.note('promotion', p_key, false, sqlerrm);
end;
$$;
