import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

it("unit promotion saves deduplicate retries and serialize competing revisions",async()=>{
  const status=execFileSync(process.execPath,["tools/run-supabase.mjs","status","-o","env"],{encoding:"utf8"});
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL??status.match(/^API_URL="?([^"\r\n]+)"?$/m)?.[1];
  const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??status.match(/^PUBLISHABLE_KEY="?([^"\r\n]+)"?$/m)?.[1];
  if(!url||!key||!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url))throw new Error("Local Supabase required");
  const login=await fetch(`${url}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:key,"Content-Type":"application/json"},body:JSON.stringify({email:"admin.teste@institutojef.org.br",password:"Admin123!"})});
  expect(login.ok).toBe(true);const{access_token:token}=await login.json() as{access_token:string};const headers={apikey:key,Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  async function save(body:Record<string,unknown>){const response=await fetch(`${url}/rest/v1/rpc/save_unit_promotion`,{method:"POST",headers,body:JSON.stringify(body)});const result=await response.json() as{id:string;revision:number;rule:{type:string};message:string};return response.ok?{ok:true as const,value:{id:result.id,revision:result.revision,type:result.rule.type}}:{ok:false as const,message:result.message};}
  const create={p_promotion_id:null,p_expected_revision:null,p_code:`UNIT-RACE-${randomUUID()}`.toUpperCase(),p_name:"Percentual concorrente",p_description:null,p_active:false,p_publicable:false,p_priority:10,p_cumulative:false,p_valid_from:new Date().toISOString(),p_valid_to:null,p_global_redemption_limit:null,p_per_user_redemption_limit:null,p_product_ids:["33f00000-0000-4000-8000-000000000001"],p_channels:["PDV"],p_rule_type:"PERCENTUAL",p_percentage_basis_points:1_000,p_fixed_unit_price_cents:null,p_reason:"Teste de concorrência",p_idempotency_key:`promotion-unit-create:${randomUUID()}`,p_correlation_id:randomUUID()};
  const replay=await Promise.all([save(create),save({...create,p_correlation_id:randomUUID()})]);expect(replay.every((item)=>item.ok)).toBe(true);expect(replay[1]).toEqual(replay[0]);const created=replay[0];if(!created.ok)throw new Error("Promotion creation failed");expect(created.value.type).toBe("PERCENTUAL");
  const update={...create,p_promotion_id:created.value.id,p_expected_revision:1};
  const race=await Promise.all([
    save({...update,p_idempotency_key:`promotion-unit-edit:${randomUUID()}`,p_percentage_basis_points:1_500}),
    save({...update,p_idempotency_key:`promotion-unit-edit:${randomUUID()}`,p_rule_type:"VALOR_FIXO_UNITARIO",p_percentage_basis_points:null,p_fixed_unit_price_cents:1_990}),
  ]);
  expect(race.filter((item)=>item.ok)).toHaveLength(1);expect(race.filter((item)=>!item.ok)).toEqual([{ok:false,message:"PROMOTION_REVISION_CONFLICT"}]);expect(race.find((item)=>item.ok)?.value.revision).toBe(2);
});
