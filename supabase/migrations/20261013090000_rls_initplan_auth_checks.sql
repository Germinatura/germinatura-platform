-- Supabase Free (docs/operations/supabase-free-performance.md): RLS policies that called auth.uid() or
-- public.has_permission('<literal>') directly were evaluated once per row. Wrapped in an uncorrelated
-- `(select ...)`, Postgres evaluates them once per statement (an InitPlan). Both functions are stable and depend
-- only on the request's JWT claims and the statement's snapshot, so the value is the same for every row: each
-- policy keeps exactly its current meaning, roles, command and permissive kind. Generated from pg_policy; only
-- the wrapping differs from the current definitions.

alter policy categories_manager_read on public.categories
  using ((select public.has_permission('catalog.manage'::text)));

alter policy commercial_reservations_manager_read on public.commercial_reservations
  using ((select public.has_permission('reservations.manage.all'::text)));

alter policy commercial_reservations_own_read on public.commercial_reservations
  using (((customer_id = (select auth.uid())) AND (select public.has_permission('reservations.manage.own'::text))));

alter policy financial_ledger_finance_read on public.financial_ledger_entries
  using ((select public.has_permission('finance.manage'::text)));

alter policy inventory_balances_manager_read on public.inventory_balances
  using ((select public.has_permission('inventory.manage'::text)));

alter policy inventory_balances_seller_read on public.inventory_balances
  using (((select public.has_permission('inventory.read'::text)) AND (EXISTS ( SELECT 1
   FROM public.stock_locations
  WHERE ((stock_locations.id = inventory_balances.location_id) AND (stock_locations.location_type = 'SELLER'::public.stock_location_type) AND (stock_locations.seller_id = (select auth.uid())))))));

alter policy notifications_owner_read on public.notifications
  using ((recipient_id = (select auth.uid())));

alter policy payment_reconciliations_finance_read on public.payment_reconciliations
  using ((select public.has_permission('finance.manage'::text)));

alter policy product_prices_manager_read on public.product_prices
  using ((select public.has_permission('catalog.manage'::text)));

alter policy products_manager_read on public.products
  using ((select public.has_permission('catalog.manage'::text)));

alter policy own_preferences on public.profile_preferences
  using (((profile_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = (select auth.uid())) AND profiles.active AND (profiles.onboarding_completed_at IS NOT NULL))))));

alter policy profiles_select_self on public.profiles
  using ((id = (select auth.uid())));

alter policy promotion_channels_manager_read on public.promotion_channels
  using ((select public.has_permission('catalog.manage'::text)));

alter policy promotion_products_manager_read on public.promotion_products
  using ((select public.has_permission('catalog.manage'::text)));

alter policy promotion_quantity_rules_manager_read on public.promotion_quantity_price_rules
  using ((select public.has_permission('catalog.manage'::text)));

alter policy promotions_manager_read on public.promotions
  using ((select public.has_permission('catalog.manage'::text)));

alter policy raffle_campaigns_authenticated_read on public.raffle_campaigns
  using (((select public.has_permission('raffles.manage'::text)) OR ((status <> 'DRAFT'::public.raffle_campaign_status) AND (select public.has_permission('raffles.buy'::text)))));

alter policy raffle_draws_authenticated_read on public.raffle_draws
  using (((select public.has_permission('raffles.buy'::text)) OR (select public.has_permission('raffles.manage'::text))));

alter policy sales_all_read on public.sales
  using ((select public.has_permission('sales.read.all'::text)));

alter policy sales_own_read on public.sales
  using (((select public.has_permission('sales.read.own'::text)) AND ((created_by = (select auth.uid())) OR (customer_id = (select auth.uid())))));

alter policy seller_closeouts_manager_read on public.seller_closeouts
  using ((select public.has_permission('closeouts.manage'::text)));

alter policy seller_closeouts_own_read on public.seller_closeouts
  using (((seller_id = (select auth.uid())) AND (select public.has_permission('closeouts.create'::text))));

alter policy stock_locations_manager_read on public.stock_locations
  using ((select public.has_permission('inventory.manage'::text)));

alter policy stock_locations_seller_read on public.stock_locations
  using (((location_type = 'SELLER'::public.stock_location_type) AND (seller_id = (select auth.uid())) AND (select public.has_permission('inventory.read'::text))));

alter policy stock_movements_manager_read on public.stock_movements
  using ((select public.has_permission('inventory.manage'::text)));

alter policy stock_movements_seller_read on public.stock_movements
  using (((select public.has_permission('inventory.read'::text)) AND (EXISTS ( SELECT 1
   FROM public.stock_locations
  WHERE ((stock_locations.seller_id = (select auth.uid())) AND (stock_locations.id = ANY (ARRAY[stock_movements.from_location_id, stock_movements.to_location_id])))))));

alter policy stock_reservations_manager_read on public.stock_reservations
  using (((select public.has_permission('inventory.manage'::text)) OR (select public.has_permission('reservations.manage.all'::text))));

alter policy stock_reservations_own_read on public.stock_reservations
  using (((actor_id = (select auth.uid())) AND (select public.has_permission('reservations.manage.own'::text))));

alter policy user_roles_select_self on public.user_roles
  using ((user_id = (select auth.uid())));

