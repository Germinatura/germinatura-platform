-- OPS (stability homologation of 02/10/2026): the jobs worker processed the outbox with one HTTP call per event,
-- at most 50 events per minute. Under a moderate soak the backlog grew to more than 1,300 events with the oldest
-- waiting about 25 minutes, and a full cycle crossed the Workers subrequest limit, leaving claimed events stuck in
-- PROCESSING until their lease expired. This RPC claims and processes a batch inside the database: each event in
-- its own subtransaction, a failure going to the same retry path, so one call handles up to 100 events.
create function public.worker_process_outbox_batch(p_worker_id text, p_batch_size integer default 100,
  p_lease_seconds integer default 300, p_max_attempts integer default 8)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event record;
  v_retry jsonb;
  v_claimed integer := 0;
  v_published integer := 0;
  v_retried integer := 0;
  v_failed integer := 0;
begin
  perform private.assert_worker_role();
  if p_batch_size is null or p_batch_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_OUTBOX_BATCH';
  end if;
  for v_event in
    select claimed.id, claimed.attempts
    from private.claim_outbox_events(p_worker_id, p_batch_size, make_interval(secs => p_lease_seconds)) claimed
  loop
    v_claimed := v_claimed + 1;
    begin
      perform public.worker_process_outbox_event(v_event.id, p_worker_id);
      v_published := v_published + 1;
    exception when others then
      -- Same capped exponential backoff as the worker (5 s doubling up to 15 min); the error text stays generic.
      v_retry := public.worker_retry_outbox_event(v_event.id, p_worker_id, 'OUTBOX_PROCESSING_FAILED',
        least(900, 5 * power(2, greatest(0, v_event.attempts - 1)))::integer, p_max_attempts);
      if v_retry ->> 'status' = 'FAILED' then v_failed := v_failed + 1; else v_retried := v_retried + 1; end if;
    end;
  end loop;
  return jsonb_build_object('claimed', v_claimed, 'published', v_published, 'retried', v_retried, 'failed', v_failed);
end;
$$;

revoke all on function public.worker_process_outbox_batch(text, integer, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.worker_process_outbox_batch(text, integer, integer, integer) to service_role;
