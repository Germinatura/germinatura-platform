import { describe, expect, it } from "vitest";
import { quantityPricePromotionSchema, saveQuantityPricePromotionSchema } from "./promotion-management";

const valid={id:null,expectedRevision:null,code:"DOIS-POR-DEZ",name:"Duas por dez",description:null,active:false,publicable:false,priority:10,cumulative:false as const,validFrom:"2026-09-22T12:00:00.000Z",validTo:null,globalRedemptionLimit:null,perUserRedemptionLimit:null,productIds:["33f00000-0000-4000-8000-000000000001"],channels:["PDV" as const],rule:{type:"QUANTIDADE_PRECO" as const,groupQuantity:2,groupPriceCents:1000,maxGroupsPerLine:null},reason:"Criar promoção"};

describe("quantity price promotion administration contract",()=>{
  it("accepts integer cents and an unlimited non-cumulative rule",()=>expect(saveQuantityPricePromotionSchema.parse(valid).rule.groupPriceCents).toBe(1000));
  it("requires optimistic revision for edits",()=>expect(saveQuantityPricePromotionSchema.safeParse({...valid,id:"60000000-0000-4000-8000-000000000001"}).success).toBe(false));
  it("rejects duplicate products and channels",()=>{
    expect(saveQuantityPricePromotionSchema.safeParse({...valid,productIds:[valid.productIds[0],valid.productIds[0]]}).success).toBe(false);
    expect(saveQuantityPricePromotionSchema.safeParse({...valid,channels:["PDV","PDV"]}).success).toBe(false);
  });
  it("does not advertise cumulative or limited rules before transactional consumption exists",()=>{
    expect(saveQuantityPricePromotionSchema.safeParse({...valid,cumulative:true}).success).toBe(false);
    expect(saveQuantityPricePromotionSchema.safeParse({...valid,globalRedemptionLimit:10}).success).toBe(false);
  });
  it("can display legacy limits without accepting an unsafe rewrite",()=>{
    const stored: Record<string, unknown> = {...valid};
    delete stored.expectedRevision;
    delete stored.reason;
    expect(quantityPricePromotionSchema.safeParse({...stored,id:"60000000-0000-4000-8000-000000000001",revision:1,cumulative:true,globalRedemptionLimit:10}).success).toBe(true);
  });
});
