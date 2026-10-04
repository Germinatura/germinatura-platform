-- Every consumer now reads public.get_pricing_inputs (quote) or private.price_cart (checkout/reservation),
-- so the superseded quote input versions are removed. No table or data is affected.
drop function public.get_pricing_quote_inputs(public.promotion_channel,uuid[]);
drop function public.get_pricing_quote_inputs_v2(public.promotion_channel,uuid[]);
drop function public.get_pricing_quote_inputs_v3(public.promotion_channel,uuid[]);
drop function public.get_pricing_quote_inputs_v4(public.promotion_channel,uuid[]);
