import { expect, test } from "@playwright/test";

const portal="http://127.0.0.1:3000";const endpoint=`${portal}/api/v1/admin/promotions`;const headers={Origin:portal,"Sec-Fetch-Site":"same-origin"};

test("administra promoção por quantidade com histórico e bloqueia papel indevido",async({page,browser},testInfo)=>{
  test.slow();expect((await page.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"admin.teste",password:"Admin123!"}})).status()).toBe(200);await page.setViewportSize({width:390,height:844});await page.goto(`${portal}/admin/promocoes`);await expect(page.getByRole("heading",{name:"Promoções",exact:true})).toBeVisible();
  const code=`E2E-${crypto.randomUUID()}`.toUpperCase();await page.getByLabel("Código").fill(code);await page.getByLabel("Nome").fill("Duas unidades em oferta");await page.getByLabel("Preço do grupo (R$)").fill("10,00");await page.getByLabel(/Item público A/).check();await page.getByLabel("Motivo").fill("Criar promoção para teste operacional");
  const createResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();const created=await createResponse;expect(created.status()).toBe(201);const result=await created.json() as{data:{id:string;revision:number}};await expect(page.getByRole("status")).toContainText("Promoção salva");const row=page.getByRole("listitem").filter({hasText:code});await expect(row).toContainText("Inativa");await row.getByRole("button",{name:"Editar"}).click();await page.getByLabel("Nome").fill("Três unidades em oferta");await page.getByLabel("Quantidade do grupo").fill("3");await page.getByLabel("Preço do grupo (R$)").fill("12,00");await page.getByLabel("Motivo").fill("Atualizar regra durante teste operacional");
  const updateResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();expect((await updateResponse).status()).toBe(200);await expect(page.getByRole("listitem").filter({hasText:code})).toContainText("3 por");
  const stale={id:result.data.id,expectedRevision:result.data.revision,code,name:"Edição antiga",description:null,active:false,publicable:false,priority:0,cumulative:false,validFrom:new Date().toISOString(),validTo:null,globalRedemptionLimit:null,perUserRedemptionLimit:null,productIds:["33f00000-0000-4000-8000-000000000001"],channels:["PDV"],rule:{type:"QUANTIDADE_PRECO",groupQuantity:2,groupPriceCents:1000,maxGroupsPerLine:null},reason:"Tentar edição antiga"};
  const conflict=await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":`promotion-stale:${crypto.randomUUID()}`},data:stale});expect(conflict.status()).toBe(409);expect((await conflict.json() as{code:string}).code).toBe("PROMOTION_REVISION_CONFLICT");expect((await page.request.post(endpoint,{headers:{Origin:"https://untrusted.invalid","Idempotency-Key":"promotion-origin"},data:stale})).status()).toBe(403);expect((await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":"promotion-unknown"},data:{...stale,totalCents:1}})).status()).toBe(422);await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath("promotion-mobile.png"),fullPage:true});
  const consumer=await browser.newContext();try{expect((await consumer.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"consumidor.teste",password:"Consumidor123!"}})).status()).toBe(200);expect((await consumer.request.post(endpoint,{headers:{...headers,"Idempotency-Key":"promotion-consumer"},data:stale})).status()).toBe(403);const consumerPage=await consumer.newPage();await consumerPage.goto(`${portal}/admin/promocoes`);await expect(consumerPage).toHaveURL(`${portal}/`);}finally{await consumer.close();}
});

test("administra percentual com arredondamento a favor do cliente e reflete na cotação pública",async({page,playwright})=>{
  test.slow();const productId="33f00000-0000-4000-8000-000000000001";
  expect((await page.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"admin.teste",password:"Admin123!"}})).status()).toBe(200);await page.goto(`${portal}/admin/promocoes`);
  const code=`E2E-PCT-${crypto.randomUUID()}`.toUpperCase();await page.getByLabel("Código").fill(code);await page.getByLabel("Nome").fill("Quinze por cento");await page.getByLabel("Tipo de regra").selectOption("PERCENTUAL");await page.getByLabel("Desconto (%)").fill("15");await page.getByLabel("PORTAL").check();await page.getByLabel(/Item público A/).check();await page.getByLabel("Ativa").check();await page.getByLabel("Publicável").check();await page.getByLabel("Prioridade").fill("1000");await page.getByLabel("Motivo").fill("Validar percentual no catálogo público");
  const createResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();const created=await createResponse;expect(created.status()).toBe(201);const promotion=await created.json() as{data:Record<string,unknown>&{id:string;revision:number}};await expect(page.getByRole("listitem").filter({hasText:code})).toContainText("15% no preço unitário");
  const anonymous=await playwright.request.newContext();
  try{
    const quote=async()=>(await anonymous.post(`${portal}/api/v1/pricing/quote`,{headers:{Origin:portal},data:{channel:"PORTAL",items:[{productId,quantity:2}]}})).json();
    // R$ 25,90 com 15% = R$ 22,015 por unidade -> R$ 22,01.
    await expect(quote()).resolves.toMatchObject({data:{rounding:"FLOOR_PER_UNIT",originalTotalCents:5180,discountTotalCents:778,totalCents:4402,lines:[{appliedPromotion:{promotionId:promotion.data.id,type:"PERCENTUAL",percentageBasisPoints:1500,discountedUnitPriceCents:2201,savingsCents:778}}]}});
  }finally{
    const{id,revision,correlationId:_correlationId,...current}=promotion.data;void _correlationId;
    const deactivate=await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":`promotion-pct-off:${crypto.randomUUID()}`},data:{...current,id,expectedRevision:revision,active:false,publicable:false,reason:"Encerrar promoção de teste"}});expect(deactivate.status()).toBe(200);
    await expect((await anonymous.post(`${portal}/api/v1/pricing/quote`,{headers:{Origin:portal},data:{channel:"PORTAL",items:[{productId,quantity:2}]}})).json()).resolves.toMatchObject({data:{totalCents:5180,rounding:"NONE"}});
    await anonymous.dispose();
  }
});

test("administra leve e pague e cobra só as unidades pagas na cotação pública",async({page,playwright})=>{
  test.slow();const productId="33f00000-0000-4000-8000-000000000001";
  expect((await page.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"admin.teste",password:"Admin123!"}})).status()).toBe(200);await page.goto(`${portal}/admin/promocoes`);
  const code=`E2E-LP-${crypto.randomUUID()}`.toUpperCase();await page.getByLabel("Código").fill(code);await page.getByLabel("Nome").fill("Leve 3, pague 2");await page.getByLabel("Tipo de regra").selectOption("LEVE_PAGUE");await page.getByLabel("Leve (unidades)").fill("3");await page.getByLabel("Pague (unidades)").fill("2");await page.getByLabel("PORTAL").check();await page.getByLabel(/Item público A/).check();await page.getByLabel("Ativa").check();await page.getByLabel("Publicável").check();await page.getByLabel("Prioridade").fill("1000");await page.getByLabel("Motivo").fill("Validar leve e pague no catálogo público");
  const createResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();const created=await createResponse;expect(created.status()).toBe(201);const promotion=await created.json() as{data:Record<string,unknown>&{id:string;revision:number}};await expect(page.getByRole("listitem").filter({hasText:code})).toContainText("leve 3, pague 2");
  const anonymous=await playwright.request.newContext();
  try{
    // 3 x R$ 25,90 com leve 3, pague 2 = R$ 51,80.
    await expect((await anonymous.post(`${portal}/api/v1/pricing/quote`,{headers:{Origin:portal},data:{channel:"PORTAL",items:[{productId,quantity:3}]}})).json()).resolves.toMatchObject({data:{rounding:"NONE",originalTotalCents:7770,discountTotalCents:2590,totalCents:5180,lines:[{appliedPromotion:{promotionId:promotion.data.id,type:"LEVE_PAGUE",buyQuantity:3,payQuantity:2,groups:1,freeQuantity:1,savingsCents:2590}}]}});
  }finally{
    const{id,revision,correlationId:_correlationId,...current}=promotion.data;void _correlationId;
    const deactivate=await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":`promotion-lp-off:${crypto.randomUUID()}`},data:{...current,id,expectedRevision:revision,active:false,publicable:false,reason:"Encerrar promoção de teste"}});expect(deactivate.status()).toBe(200);
    await expect((await anonymous.post(`${portal}/api/v1/pricing/quote`,{headers:{Origin:portal},data:{channel:"PORTAL",items:[{productId,quantity:3}]}})).json()).resolves.toMatchObject({data:{totalCents:7770}});
    await anonymous.dispose();
  }
});

test("administra escalonada com faixas e aplica a maior faixa atingida na cotação pública",async({page,playwright})=>{
  test.slow();const productId="33f00000-0000-4000-8000-000000000001";
  expect((await page.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"admin.teste",password:"Admin123!"}})).status()).toBe(200);await page.goto(`${portal}/admin/promocoes`);
  const code=`E2E-ESC-${crypto.randomUUID()}`.toUpperCase();await page.getByLabel("Código").fill(code);await page.getByLabel("Nome").fill("Escalonada por quantidade");await page.getByLabel("Tipo de regra").selectOption("ESCALONADA");
  await page.getByLabel("Faixa 1: a partir de (unidades)").fill("3");await page.getByLabel("Faixa 1: desconto (%)").fill("10");await page.getByRole("button",{name:"Adicionar faixa"}).click();await page.getByLabel("Faixa 2: a partir de (unidades)").fill("6");await page.getByLabel("Faixa 2: desconto (%)").fill("20");
  await page.getByLabel("PORTAL").check();await page.getByLabel(/Item público A/).check();await page.getByLabel("Ativa").check();await page.getByLabel("Publicável").check();await page.getByLabel("Prioridade").fill("1000");await page.getByLabel("Motivo").fill("Validar escalonada no catálogo público");
  const createResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();const created=await createResponse;expect(created.status()).toBe(201);const promotion=await created.json() as{data:Record<string,unknown>&{id:string;revision:number}};await expect(page.getByRole("listitem").filter({hasText:code})).toContainText("3+ = 10% · 6+ = 20%");
  const anonymous=await playwright.request.newContext();
  const quote=async(quantity:number)=>(await anonymous.post(`${portal}/api/v1/pricing/quote`,{headers:{Origin:portal},data:{channel:"PORTAL",items:[{productId,quantity}]}})).json();
  try{
    // 3 x R$ 25,90 com 10% = R$ 23,31 cada; 6 com 20% = R$ 20,72 cada.
    await expect(quote(3)).resolves.toMatchObject({data:{rounding:"FLOOR_PER_UNIT",totalCents:6993,discountTotalCents:777,lines:[{appliedPromotion:{promotionId:promotion.data.id,type:"ESCALONADA",minQuantity:3,percentageBasisPoints:1000,discountedUnitPriceCents:2331}}]}});
    await expect(quote(6)).resolves.toMatchObject({data:{totalCents:12432,lines:[{appliedPromotion:{minQuantity:6,percentageBasisPoints:2000,discountedUnitPriceCents:2072}}]}});
    await expect(quote(2)).resolves.toMatchObject({data:{totalCents:5180,lines:[{appliedPromotion:null}]}});
  }finally{
    const{id,revision,correlationId:_correlationId,...current}=promotion.data;void _correlationId;
    const deactivate=await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":`promotion-esc-off:${crypto.randomUUID()}`},data:{...current,id,expectedRevision:revision,active:false,publicable:false,reason:"Encerrar promoção de teste"}});expect(deactivate.status()).toBe(200);
    await expect(quote(3)).resolves.toMatchObject({data:{totalCents:7770}});
    await anonymous.dispose();
  }
});

test("administra combo e rateia o desconto proporcionalmente na cotação do PDV",async({page})=>{
  test.slow();const productA="33f00000-0000-4000-8000-000000000001";const productB="33f00000-0000-4000-8000-000000000002";
  expect((await page.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"admin.teste",password:"Admin123!"}})).status()).toBe(200);await page.goto(`${portal}/admin/promocoes`);
  const code=`E2E-COMBO-${crypto.randomUUID()}`.toUpperCase();await page.getByLabel("Código").fill(code);await page.getByLabel("Nome").fill("Combo A + B");await page.getByLabel("Tipo de regra").selectOption("COMBO_MIX");await page.getByLabel("Preço do combo (R$)").fill("35,00");
  await page.getByLabel(/Item público A/).check();await page.getByLabel(/Item não publicado/).check();await page.getByLabel("Ativa").check();await page.getByLabel("Publicável").check();await page.getByLabel("Prioridade").fill("1000");await page.getByLabel("Motivo").fill("Validar combo no PDV");
  const createResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();const created=await createResponse;expect(created.status()).toBe(201);const promotion=await created.json() as{data:Record<string,unknown>&{id:string;revision:number}};await expect(page.getByRole("listitem").filter({hasText:code})).toContainText("combo de 2 itens por");
  const quote=async()=>(await page.request.post(`${portal}/api/v1/pricing/quote`,{headers,data:{channel:"PDV",items:[{productId:productA,quantity:3},{productId:productB,quantity:2}]}})).json();
  try{
    // A R$ 25,90 x 3 + B R$ 19,90 x 2 = 117,50; 2 combos por R$ 35,00 -> desconto 21,60 rateado 12,21 / 9,39.
    await expect(quote()).resolves.toMatchObject({data:{originalTotalCents:11750,discountTotalCents:2160,totalCents:9590,lines:[
      {productId:productA,discountCents:1221,appliedPromotion:{promotionId:promotion.data.id,type:"COMBO_MIX",combos:2,componentQuantity:2,savingsCents:1221}},
      {productId:productB,discountCents:939,appliedPromotion:{type:"COMBO_MIX",combos:2,savingsCents:939}},
    ]}});
  }finally{
    const{id,revision,correlationId:_correlationId,...current}=promotion.data;void _correlationId;
    const deactivate=await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":`promotion-combo-off:${crypto.randomUUID()}`},data:{...current,id,expectedRevision:revision,active:false,publicable:false,reason:"Encerrar promoção de teste"}});expect(deactivate.status()).toBe(200);
    await expect(quote()).resolves.toMatchObject({data:{discountTotalCents:0}});
  }
});

test("administra cupom com limite e só o aplica quando o código é informado",async({page,playwright})=>{
  test.slow();const productId="33f00000-0000-4000-8000-000000000001";
  expect((await page.request.post(`${portal}/api/auth/login`,{headers,data:{identifier:"admin.teste",password:"Admin123!"}})).status()).toBe(200);await page.goto(`${portal}/admin/promocoes`);
  const couponCode=`E2E${crypto.randomUUID().replaceAll("-","").slice(0,10).toUpperCase()}`;
  const code=`E2E-CUPOM-${crypto.randomUUID()}`.toUpperCase();await page.getByLabel("Código",{exact:true}).fill(code);await page.getByLabel("Nome").fill("Cupom de formatura");await page.getByLabel("Tipo de regra").selectOption("CUPOM");
  await page.getByLabel("Código do cupom").fill(couponCode.toLowerCase());await page.getByLabel("Tipo de desconto do cupom").selectOption("PERCENTUAL");await page.getByLabel("Desconto do cupom (%)").fill("10");await page.getByLabel("Limite total de usos (opcional)").fill("5");
  await page.getByLabel("PORTAL").check();await page.getByLabel(/Item público A/).check();await page.getByLabel("Ativa").check();await page.getByLabel("Publicável").check();await page.getByLabel("Prioridade").fill("1000");await page.getByLabel("Motivo").fill("Validar cupom no catálogo público");
  const createResponse=page.waitForResponse((response)=>response.url()===endpoint&&response.request().method()==="POST");await page.getByRole("button",{name:"Salvar promoção"}).click();const created=await createResponse;expect(created.status()).toBe(201);const promotion=await created.json() as{data:Record<string,unknown>&{id:string;revision:number}};
  const row=page.getByRole("listitem").filter({hasText:code});await expect(row).toContainText(`cupom ${couponCode}: 10%`);await expect(row).toContainText("5 usos no total");
  const anonymous=await playwright.request.newContext();
  const quote=async(couponCodeValue?:string)=>(await anonymous.post(`${portal}/api/v1/pricing/quote`,{headers:{Origin:portal},data:{channel:"PORTAL",items:[{productId,quantity:2}],...(couponCodeValue?{couponCode:couponCodeValue}:{})}})).json();
  try{
    await expect(quote()).resolves.toMatchObject({data:{totalCents:5180,coupon:null}});
    // R$ 25,90 com 10% = R$ 23,31 cada.
    await expect(quote(couponCode.toLowerCase())).resolves.toMatchObject({data:{totalCents:4662,rounding:"FLOOR_PER_UNIT",coupon:{code:couponCode,applied:true},
      lines:[{appliedPromotion:{promotionId:promotion.data.id,type:"CUPOM",code:couponCode,discountKind:"PERCENTUAL",savingsCents:518},appliedCoupon:null}]}});
    await expect(quote("NAOEXISTE")).resolves.toMatchObject({data:{totalCents:5180,coupon:{code:"NAOEXISTE",applied:false}}});
  }finally{
    const{id,revision,correlationId:_correlationId,...current}=promotion.data;void _correlationId;
    const deactivate=await page.request.post(endpoint,{headers:{...headers,"Idempotency-Key":`promotion-coupon-off:${crypto.randomUUID()}`},data:{...current,id,expectedRevision:revision,active:false,publicable:false,reason:"Encerrar promoção de teste"}});expect(deactivate.status()).toBe(200);
    await anonymous.dispose();
  }
});
