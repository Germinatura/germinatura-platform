-- Etapa 8.4 (RAF-006, spec 4.4, 5.11 e 15.5): raffle notices go to the sale's customer, never to the seller who
-- sold to a walk-in buyer; managers are told to contact a winner without an account; buyers are notified when a
-- raffle is cancelled or their purchase refunded. Communication runs from the outbox, after the draw committed,
-- so a failed notice never undoes the draw.

-- The raffle topics are handled here; every other topic keeps the existing processor.
alter function public.worker_process_outbox_event(uuid, text) set schema private;
alter function private.worker_process_outbox_event(uuid, text) rename to process_outbox_event_base;
revoke all on function private.process_outbox_event_base(uuid, text) from public, anon, authenticated, service_role;

create function public.worker_process_outbox_event(p_event_id uuid, p_worker_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.outbox_events%rowtype;
  v_campaign public.raffle_campaigns%rowtype;
  v_draw public.raffle_draws%rowtype;
  v_row record;
  v_count integer := 0;
begin
  perform private.assert_worker_role();
  select * into v_event from public.outbox_events
  where id = p_event_id and status = 'PROCESSING' and locked_by = p_worker_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'OUTBOX_CLAIM_MISMATCH';
  end if;
  if v_event.topic not in ('raffles.drawn', 'raffles.campaign.cancelled', 'raffles.sale.refunded') then
    return private.process_outbox_event_base(p_event_id, p_worker_id);
  end if;
  select * into v_event from public.outbox_events where id = p_event_id for update;

  if public.is_feature_enabled('notifications') then
    if v_event.topic = 'raffles.drawn' then
      select * into v_draw from public.raffle_draws where id = (v_event.payload ->> 'draw_id')::uuid;
      select * into v_campaign from public.raffle_campaigns where id = v_draw.campaign_id;
      for v_row in
        select sale.customer_id as recipient_id, bool_or(item.number = v_draw.winner_number) as won
        from public.raffle_numbers item
        join public.sales sale on sale.id = item.sale_id
        where item.campaign_id = v_draw.campaign_id and item.status = 'PAID' and sale.customer_id is not null
        group by sale.customer_id
      loop
        v_count := v_count + private.add_notification(v_event.id, v_row.recipient_id, 'RAFFLE_DRAWN',
          case when v_row.won then 'Você ganhou a rifa' else 'Sorteio da rifa concluído' end,
          case when v_row.won then 'Um dos seus números foi sorteado em ' || v_campaign.name || '.'
            else 'O sorteio de ' || v_campaign.name || ' foi concluído e o resultado está disponível.' end,
          jsonb_build_object('campaign_id', v_draw.campaign_id, 'draw_id', v_draw.id,
            'winner_number', v_draw.winner_number, 'won', v_row.won));
      end loop;
      -- A winner without an account is reached by the managers; the contact stays in Gestão de rifas.
      if exists (
        select 1 from public.raffle_numbers item join public.sales sale on sale.id = item.sale_id
        where item.campaign_id = v_draw.campaign_id and item.number = v_draw.winner_number and sale.customer_id is null
      ) then
        for v_row in select recipient_id from private.staff_with_permission('raffles.manage') loop
          v_count := v_count + private.add_notification(v_event.id, v_row.recipient_id, 'RAFFLE_WINNER_CONTACT',
            'Ganhador sem cadastro',
            'O número ' || v_draw.winner_number || ' de ' || v_campaign.name
              || ' foi vendido a um comprador sem cadastro. Veja o contato em Gestão de rifas.',
            jsonb_build_object('campaign_id', v_draw.campaign_id, 'draw_id', v_draw.id, 'winner_number', v_draw.winner_number));
        end loop;
      end if;
    elsif v_event.topic = 'raffles.campaign.cancelled' then
      select * into v_campaign from public.raffle_campaigns where id = v_event.aggregate_id::uuid;
      for v_row in
        select distinct sale.customer_id as recipient_id
        from public.raffle_numbers item join public.sales sale on sale.id = item.sale_id
        where item.campaign_id = v_campaign.id and item.status = 'PAID' and sale.customer_id is not null
        union
        select refund.customer_id from public.raffle_sale_refunds refund
        where refund.campaign_id = v_campaign.id and refund.customer_id is not null
      loop
        v_count := v_count + private.add_notification(v_event.id, v_row.recipient_id, 'RAFFLE_CANCELLED',
          'Rifa cancelada', v_campaign.name || ' foi cancelada. O valor pago pelos seus números será estornado.',
          jsonb_build_object('campaign_id', v_campaign.id));
      end loop;
      if coalesce((v_event.payload ->> 'paid_sales_to_refund')::integer, 0) > 0 then
        for v_row in select recipient_id from private.staff_with_permission('finance.manage') loop
          v_count := v_count + private.add_notification(v_event.id, v_row.recipient_id, 'RAFFLE_REFUNDS_PENDING',
            'Rifa cancelada com vendas pagas',
            v_campaign.name || ' foi cancelada com ' || (v_event.payload ->> 'paid_sales_to_refund')
              || ' venda(s) paga(s). Estorne-as em Financeiro › Vendas.',
            jsonb_build_object('campaign_id', v_campaign.id, 'paid_sales_to_refund', (v_event.payload ->> 'paid_sales_to_refund')::integer));
        end loop;
      end if;
    elsif v_event.topic = 'raffles.sale.refunded' then
      select * into v_campaign from public.raffle_campaigns where id = (v_event.payload ->> 'campaign_id')::uuid;
      v_count := v_count + private.add_notification(v_event.id, (v_event.payload ->> 'customer_id')::uuid, 'RAFFLE_REFUNDED',
        'Compra de rifa estornada', 'Sua compra de números em ' || v_campaign.name || ' foi estornada.',
        jsonb_build_object('campaign_id', v_campaign.id, 'sale_id', v_event.aggregate_id));
    end if;
  end if;

  perform private.ack_outbox_event(v_event.id, p_worker_id);
  return jsonb_build_object('event_id', v_event.id, 'topic', v_event.topic,
    'notifications_created', v_count, 'status', 'PUBLISHED');
end;
$$;
revoke all on function public.worker_process_outbox_event(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.worker_process_outbox_event(uuid, text) to service_role;

-- Spec 15.5: only raffle managers see who bought each number and how to reach walk-in buyers.
create function public.list_raffle_buyers(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_raffle_manager();
  if not exists (select 1 from public.raffle_campaigns where id = p_campaign_id) then
    raise exception using errcode = 'P0001', message = 'RAFFLE_CAMPAIGN_NOT_FOUND';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'sale_id', sale.id, 'numbers', to_jsonb(tickets.numbers), 'status', tickets.status, 'channel', sale.channel,
      'registered', sale.customer_id is not null,
      'buyer_name', coalesce(buyer.buyer_name, nullif(btrim(customer.display_name), ''), split_part(customer.email, '@', 1)),
      'buyer_contact', coalesce(buyer.buyer_contact, customer.email),
      'seller_name', case when sale.channel = 'PDV' then coalesce(nullif(btrim(seller.display_name), ''), split_part(seller.email, '@', 1)) end,
      'total_cents', sale.total_cents, 'created_at', sale.created_at,
      'won', tickets.status = 'PAID' and draw.winner_number = any(tickets.numbers)
    ) order by tickets.numbers[1], sale.id)
    from (
      select item.sale_id, array_agg(item.number order by item.number) numbers, min(item.status::text) status
      from public.raffle_numbers item where item.campaign_id = p_campaign_id and item.sale_id is not null
      group by item.sale_id
      union all
      select refund.sale_id, refund.numbers, 'REFUNDED' from public.raffle_sale_refunds refund where refund.campaign_id = p_campaign_id
    ) tickets
    join public.sales sale on sale.id = tickets.sale_id
    left join public.profiles customer on customer.id = sale.customer_id
    left join public.profiles seller on seller.id = sale.created_by
    left join public.raffle_sale_buyers buyer on buyer.sale_id = sale.id
    left join public.raffle_draws draw on draw.campaign_id = p_campaign_id
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_raffle_buyers(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_raffle_buyers(uuid) to authenticated;
comment on function public.list_raffle_buyers(uuid) is
  'Raffle managers only: buyers per sale with numbers, status, channel and contact (RAF-006, spec 15.5).';
