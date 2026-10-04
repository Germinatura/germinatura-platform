-- Spec 4.3 / 5.10: a reservation can be prepared (ready for pickup) and completed at pickup.
alter type public.commercial_reservation_status add value if not exists 'READY';
alter type public.commercial_reservation_status add value if not exists 'COMPLETED';
