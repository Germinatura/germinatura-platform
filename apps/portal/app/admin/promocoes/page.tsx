import { hasPermission } from "@germinatura/auth";
import { managedPromotionSchema } from "@germinatura/contracts";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PromotionManagement } from "@/components/admin/PromotionManagement";
import { requireSession } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const promotionRows = z.array(z.object({ id:z.uuid(),revision:z.number().int(),code:z.string(),name:z.string(),description:z.string().nullable(),active:z.boolean(),publicable:z.boolean(),priority:z.number().int(),cumulative:z.boolean(),valid_from:z.string(),valid_to:z.string().nullable(),global_redemption_limit:z.number().nullable(),per_user_redemption_limit:z.number().nullable() }));
const productRows = z.array(z.object({ id:z.uuid(),sku:z.string(),name:z.string(),active:z.boolean() }));
const scopeRows = z.array(z.object({ promotion_id:z.uuid(),product_id:z.uuid() }));
const channelRows = z.array(z.object({ promotion_id:z.uuid(),channel:z.enum(["PORTAL","PDV","RESERVA"]) }));
const ruleRows = z.array(z.object({ promotion_id:z.uuid(),rule_type:z.literal("QUANTIDADE_PRECO"),group_quantity:z.number().int(),group_price_cents:z.number(),max_groups_per_line:z.number().int().nullable() }));
const percentageRows=z.array(z.object({promotion_id:z.uuid(),rule_type:z.literal("PERCENTUAL"),percentage_basis_points:z.number().int()}));
const fixedRows=z.array(z.object({promotion_id:z.uuid(),rule_type:z.literal("VALOR_FIXO_UNITARIO"),fixed_unit_price_cents:z.number().int()}));
const buyPayRows=z.array(z.object({promotion_id:z.uuid(),rule_type:z.literal("LEVE_PAGUE"),buy_quantity:z.number().int(),pay_quantity:z.number().int(),max_groups_per_line:z.number().int().nullable()}));

export default async function PromotionsPage({ searchParams }:{ searchParams:Promise<{ after?:string }> }) {
  const user=await requireSession();
  if(!hasPermission(user,"catalog.manage")) redirect("/");
  const {after}=await searchParams;
  const cursor=z.uuid().safeParse(after);
  const client=await createSupabaseServerClient();
  let query=client.from("promotions").select("id,revision,code,name,description,active,publicable,priority,cumulative,valid_from,valid_to,global_redemption_limit,per_user_redemption_limit").order("id").limit(51);
  if(cursor.success) query=query.gt("id",cursor.data);
  const promotionsResult=await query;
  const parsedPromotions=promotionRows.safeParse(promotionsResult.data);
  const ids=parsedPromotions.success?parsedPromotions.data.map((item)=>item.id):[];
  const [productsResult,scopesResult,channelsResult,rulesResult,percentagesResult,fixedResult,buyPayResult]=await Promise.all([
    client.from("products").select("id,sku,name,active").order("name"),
    ids.length?client.from("promotion_products").select("promotion_id,product_id").in("promotion_id",ids):Promise.resolve({data:[],error:null}),
    ids.length?client.from("promotion_channels").select("promotion_id,channel").in("promotion_id",ids):Promise.resolve({data:[],error:null}),
    ids.length?client.from("promotion_quantity_price_rules").select("promotion_id,rule_type,group_quantity,group_price_cents,max_groups_per_line").in("promotion_id",ids):Promise.resolve({data:[],error:null}),
    ids.length?client.from("promotion_percentage_rules").select("promotion_id,rule_type,percentage_basis_points").in("promotion_id",ids):Promise.resolve({data:[],error:null}),
    ids.length?client.from("promotion_fixed_unit_price_rules").select("promotion_id,rule_type,fixed_unit_price_cents").in("promotion_id",ids):Promise.resolve({data:[],error:null}),
    ids.length?client.from("promotion_buy_pay_rules").select("promotion_id,rule_type,buy_quantity,pay_quantity,max_groups_per_line").in("promotion_id",ids):Promise.resolve({data:[],error:null}),
  ]);
  const products=productRows.safeParse(productsResult.data);
  const scopes=scopeRows.safeParse(scopesResult.data);
  const channels=channelRows.safeParse(channelsResult.data);
  const rules=ruleRows.safeParse(rulesResult.data);
  const percentages=percentageRows.safeParse(percentagesResult.data);
  const fixed=fixedRows.safeParse(fixedResult.data);
  const buyPay=buyPayRows.safeParse(buyPayResult.data);
  const invalidAfter=Boolean(after&&!cursor.success);
  const unavailable=Boolean(invalidAfter||promotionsResult.error||productsResult.error||scopesResult.error||channelsResult.error||rulesResult.error||percentagesResult.error||fixedResult.error||buyPayResult.error||!parsedPromotions.success||!products.success||!scopes.success||!channels.success||!rules.success||!percentages.success||!fixed.success||!buyPay.success);
  const page=parsedPromotions.success?parsedPromotions.data.slice(0,50):[];
  const mapped=page.map((item)=>{
    const quantityRule=rules.success?rules.data.find((row)=>row.promotion_id===item.id):undefined;
    const percentageRule=percentages.success?percentages.data.find((row)=>row.promotion_id===item.id):undefined;
    const fixedRule=fixed.success?fixed.data.find((row)=>row.promotion_id===item.id):undefined;
    const buyPayRule=buyPay.success?buyPay.data.find((row)=>row.promotion_id===item.id):undefined;
    const rule=quantityRule?{type:"QUANTIDADE_PRECO" as const,groupQuantity:quantityRule.group_quantity,
      groupPriceCents:quantityRule.group_price_cents,maxGroupsPerLine:quantityRule.max_groups_per_line}
      :percentageRule?{type:"PERCENTUAL" as const,percentageBasisPoints:percentageRule.percentage_basis_points}
      :fixedRule?{type:"VALOR_FIXO_UNITARIO" as const,fixedUnitPriceCents:fixedRule.fixed_unit_price_cents}
      :buyPayRule?{type:"LEVE_PAGUE" as const,buyQuantity:buyPayRule.buy_quantity,payQuantity:buyPayRule.pay_quantity,
        maxGroupsPerLine:buyPayRule.max_groups_per_line}:undefined;
    return managedPromotionSchema.safeParse({
      id:item.id,revision:item.revision,code:item.code,name:item.name,description:item.description,
      active:item.active,publicable:item.publicable,priority:item.priority,cumulative:item.cumulative,
      validFrom:item.valid_from,validTo:item.valid_to,globalRedemptionLimit:item.global_redemption_limit,
      perUserRedemptionLimit:item.per_user_redemption_limit,
      productIds:scopes.success?scopes.data.filter((row)=>row.promotion_id===item.id).map((row)=>row.product_id):[],
      channels:channels.success?channels.data.filter((row)=>row.promotion_id===item.id).map((row)=>row.channel):[],
      rule,
    });
  });
  const valid=mapped.every((item)=>item.success);
  const promotions=valid?mapped.map((item)=>item.data):[];
  const failed=unavailable||!valid;
  const next=!failed&&parsedPromotions.success&&parsedPromotions.data.length>50?promotions.at(-1)?.id:undefined;
  return <PromotionManagement promotions={promotions} products={products.success?products.data:[]} unavailable={failed} after={after} next={next}/>;
}
