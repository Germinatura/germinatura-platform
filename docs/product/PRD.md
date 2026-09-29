# PRD — Germinatura v2.2

Status: vigente. Fonte: `docs/specs/Germinatura_Especificacao_Funcional_Tecnica_v2.2.docx`. O ADR 0001 prevalece sobre qualquer trecho que pressuponha migração de dados legados: a plataforma é greenfield.

## Visão, problema e objetivos

A Germinatura é o sistema operacional da comissão de formatura. Deve permitir vender, receber, distribuir produtos e prestar contas com rapidez para vendedores e compradores, mas com consistência, rastreabilidade e autoridade do servidor para administradores.

Objetivos: operação simultânea sem estoque negativo; preço correto; pagamentos PicPay controlados e conciliáveis; estoque e financeiro auditáveis; Portal e PDV especializados; evolução incremental e observável.

Não objetivos do MVP: microserviços, app nativo, chat privado, Open Finance como autorização, múltiplos adquirentes, iniciação remota não documentada de Maquininha/Tap, automação não oficial de WhatsApp ou migração do legado.

## Usuários e papéis

- Acesso institucional: qualquer pessoa que comprove um e-mail no domínio exato `@institutojef.org.br` pode criar uma conta de consumidor no Portal. O código de e-mail verifica cadastro ou recuperação; o login cotidiano usa e-mail ou username com senha.
- Consumidor: compra, reserva, rifa, histórico e preferências.
- Vendedor: PDV, próprio estoque/vendas, transferências, perdas e fechamento.
- Estoque, Financeiro, Comunicação e Moderador: capacidades específicas e de menor privilégio.
- Admin: configuração e exceções auditadas, sem substituir controles do provedor.
- Uma única identidade pode acumular papéis. O acesso institucional concede somente o papel base `CONSUMIDOR`; o papel `VENDEDOR` e o acesso ao PDV exigem ativação explícita por administrador.

Decisão detalhada: ADR 0009 — Acesso institucional e bootstrap administrativo. Pagamentos e caixa: ADR 0010 — Payment Link e dinheiro físico (07/09/2026).

## Requisitos funcionais

### Plataforma, identidade e segurança

- **GOV-001** — A v2.2 é a fonte funcional/técnica vigente; PRD, roadmap, ADRs, issues e testes devem referenciar IDs deste documento.
- **ARCH-001** — Portal e PDV são apps separados no monorepo e compartilham domínio, contratos, identidade e banco.
- **ARCH-002** — O backend é monólito modular; operações críticas permanecem próximas ao PostgreSQL.
- **AUTH-001** — Usar Supabase Auth; usuário pode ter múltiplos papéis e ser inativado sem perder histórico.
- **AUTH-002** — Toda ação protegida exige autorização server-side e RLS quando exposta pela Data API.
- **AUTH-003** — O cadastro do Portal começa pela verificação, por código de uso único, de um endereço no domínio exato `@institutojef.org.br`. Depois da verificação, o usuário conclui nome, senha e username único; foto é opcional e o e-mail verificado não pode ser trocado nessa etapa. Login cotidiano no Portal e no PDV aceita e-mail ou username com senha e nunca cria conta implicitamente.
- **AUTH-004** — A identidade criada pelo próprio usuário recebe somente `CONSUMIDOR` e pode acumular outros papéis. O domínio institucional, isoladamente, nunca concede acesso ao PDV: a conta operacional e o papel `VENDEDOR` dependem de provisionamento/ativação explícitos por administrador, com auditoria. O PDV não usa código no login.
- **AUTH-005** — O bootstrap greenfield define `theo.martins@institutojef.org.br` como primeiro administrador. A elevação ocorre uma única vez, somente após verificação do endereço, de forma idempotente e auditável, sem senha, código ou segredo versionado; depois do bootstrap, novas concessões administrativas seguem o fluxo normal de permissões.
- **AUTH-006** — “Esqueci minha senha” envia código somente ao e-mail institucional da conta, com respostas sem enumeração. Cada ciclo admite no máximo dois envios; a terceira solicitação permanece bloqueada até um administrador desbloquear e reiniciar a recuperação de forma auditada. O administrador não lê nem define a nova senha.
- **SEC-001** — Segredos ficam somente no backend; logs, auditoria e respostas não expõem tokens, cartão ou benefício.
- **SEC-002** — Mutações por cookie têm proteção CSRF/origin; login, checkout e webhook recebem rate limit apropriado.

### Portal, catálogo e administração

- **PORTAL-001** — Portal oferece vitrine, catálogo/compra, reservas, rifas, campanhas, Rede Social Germinare/mural, notificações, conta e administração conforme flags/permissões.
- **CAT-001** — Produtos e categorias são normalizados, inativáveis, publicáveis por canal e mantêm histórico de preço.
- **CAT-002** — A API pública versionada lista somente produtos publicados em categoria ativa e com preço vigente, usando visão anônima consistente, paginação por cursor e limite máximo de 50 itens.
- **ADMIN-001** — Dashboard deriva indicadores de eventos conciliados e ledger, nunca de números manuais desconectados.
- **AUD-001** — Ajuste, perda, cancelamento, reabertura, sorteio, login, falha de autorização e permissão são investigáveis por correlação.

### Pricing e promoções

- **PRICE-001** — Dinheiro usa centavos inteiros ou decimal definido, nunca Float; arredondamento é explícito.
- **PRICE-002** — O servidor recalcula preço, desconto e total; valores enviados pelo cliente não são autoridade.
- **PROMO-001** — Promoções são regras sobre produtos reais, com vigência, canal, prioridade, cumulatividade e limites.
- **PROMO-002** — “2 por R$10” sobre item de R$15 calcula 3 unidades como R$25 e explica a economia.
- **PROMO-003** — `PERCENTUAL` aplica o percentual (em basis points, de 0,01% a 99,99%) ao preço unitário elegível e arredonda o preço unitário com desconto para baixo, ao centavo, a favor do cliente; o total da linha é esse preço vezes a quantidade (ex.: 10% sobre R$15,05 → R$13,54 por unidade). `VALOR_FIXO_UNITARIO` substitui o preço unitário e não arredonda. `ESCALONADA` aplica o percentual da maior faixa atingida a todas as unidades com o mesmo piso por unidade. A cotação declara a regra aplicada (`FLOOR_PER_UNIT` ou `NONE`). Decisão registrada em 27/09/2026.
- **PROMO-004** — Política de concorrência e cumulatividade (decisão de 27/09/2026): (1) promoções são não cumulativas por padrão; (2) entre promoções concorrentes não cumulativas vence a de maior `priority`, em empate a de menor total efetivo para o cliente e, em novo empate, o menor `promotion_id` (ordem estável de bytes do UUID, igual no banco e no domínio); a “política de melhor preço” da especificação é esse desempate fixo, não uma opção por promoção; (3) `cumulative=true` não autoriza compor promoções de produto: cada item/conjunto elegível continua com uma única regra vencedora; (4) cupom só acumula com a promoção vencedora quando o próprio cupom estiver configurado como cumulativo; caso contrário, concorre pela mesma política; (5) nenhuma combinação pode gerar preço negativo, aumento de preço, aplicação duplicada da mesma regra ou resultado dependente da ordem de consulta; (6) limites globais e por usuário são reservados e consumidos atomicamente no checkout, seguros sob concorrência; (7) a cotação explica todas as regras efetivamente aplicadas e a economia resultante. Promoções de produto marcadas como cumulativas (configuração legada) continuam fora do preço (falha fechada); cupons e limites seguem PROMO-006 e PROMO-007.
- **PROMO-005** — `COMBO_MIX` (decisão de 28/09/2026): o combo reúne de 2 a 10 produtos distintos, com quantidade por produto, por um preço em centavos e limite opcional de combos por carrinho. O desconto do combo é rateado entre as linhas proporcionalmente ao valor cheio de cada uma no combo; os centavos de sobra seguem os maiores restos, com empate pela linha de maior valor e depois pelo `product_id`. Reembolsar um item devolve o valor efetivamente pago por ele. Na precedência PROMO-004, o combo compete com as regras de linha dos seus componentes (prioridade, depois menor total do carrinho, depois id); cada linha entra em no máximo um combo e as unidades excedentes dessa linha ficam com o preço cheio.
- **PROMO-006** — `CUPOM`: código único, normalizado em maiúsculas e comparado sem diferenciar maiúsculas; desconto percentual (basis points) ou valor fixo em centavos, restrito aos produtos elegíveis. O cupom só é considerado quando o código é informado na cotação, no checkout ou na reserva. Não cumulativo, concorre pelas linhas elegíveis como regra de conjunto (PROMO-004); cumulativo, só se configurado explicitamente, aplica sobre o total já promocional de cada linha elegível. No percentual cumulativo, o total da linha é arredondado para baixo a favor do cliente (`FLOOR_PER_LINE`); no valor fixo, o rateio segue o PROMO-005. Nenhuma linha fica negativa. Os códigos não são legíveis publicamente.
- **PROMO-007** — Limites de uso: cada venda (ou reserva comercial) usa no máximo uma vez cada promoção aplicada, registrada no ledger `promotion_redemptions` como `RESERVED` no checkout ou na reserva, `CONSUMED` na confirmação da venda e `RELEASED` no cancelamento ou expiração anteriores à confirmação. Um uso já `CONSUMED` nunca é liberado automaticamente, inclusive no estorno de venda confirmada, salvo regra explícita futura. Limites globais e por cliente contam `RESERVED` + `CONSUMED`; checkout e reserva travam as promoções limitadas em ordem de id antes de precificar, então a última unidade de limite é disputada com segurança e a promoção sem capacidade simplesmente não entra no preço. O limite por cliente exige comprador identificado: venda anônima do PDV nunca recebe promoção com limite por cliente. A reserva comercial convertida transfere seu uso para a venda.

### Estoque, compras e fornecedores

- **INV-001** — Estoque é ledger imutável; saldo deriva de movimentos e correções usam reversão/ajuste motivado.
- **INV-002** — Há estoque central e localizações por vendedor; transferência é uma operação atômica.
- **INV-003** — Reserva reduz disponível, expira e é consumida/liberada idempotentemente; nenhum saldo fica negativo.
- **INV-004** — Venda, transferência e inventário concorrentes usam lock ou atualização condicional no banco.
- **PROC-001** — Fornecedor, compra, itens, custos, lote e recebimento parcial explicam origem e custo do estoque.

### Vendas e PDV

- **PDV-001** — PDV é mobile-first, rápido, separado do Portal e bloqueia consumidor, usuário inativo ou conta institucional sem ativação administrativa de vendedor no servidor.
- **PDV-002** — "Minhas vendas" (spec 6.10, 28/09/2026): lista paginada somente das vendas PDV do próprio vendedor, com status, método de pagamento, itens e total; vendas aguardando pagamento e pagamentos pendentes de conciliação ficam destacados e contados. O vendedor cancela apenas a própria venda ainda não paga (liberando a reserva); venda concluída só é estornada pelo financeiro (supervisor), sem janela de cancelamento pelo vendedor.
- **SALE-001** — Cobrar recalcula carrinho, reserva estoque e cria venda/tentativa com `Idempotency-Key` em uma transação.
- **SALE-002** — Venda só conclui com pagamento confirmado ou método manual autorizado; conclusão cria estoque e financeiro atomicamente.
- **SALE-003** — Cancelamento não exclui: registra motivo e cria reversões vinculadas, repetíveis sem duplicação.
- **SALE-004** — Administração de vendas (etapa 6, 28/09/2026): quem tem `sales.read.all` consulta todas as vendas (exceto rascunhos) por situação, canal, pendência e período em dias de São Paulo (início e fim inclusivos, aplicados como intervalo fechado-aberto), com vendedor, local e método; o detalhe mostra itens, pagamento, lançamentos, movimentos de caixa e histórico. O estorno de venda concluída é feito pelo financeiro nessa tela, com motivo e referência não sensível, informando se o valor voltou por outro meio ou em dinheiro por um turno aberto (PAY-009a); a tela só oferece o estorno quando o comando o aceitaria.
- **CLOSE-001** — Fechamento compara estoque, vendas e pagamentos; divergência exige justificativa e reabertura é auditada.
- **PWA-001** — O PDV pode cachear shell/catálogo, mas nunca conclui operação crítica offline.

### Pagamentos PicPay

- **PAY-001** — O domínio usa interfaces neutras `PaymentProvider` e `CardPresentProvider`; produção configura somente PicPay.
- **PAY-002** — Tentativas distinguem `CREATED`, `PENDING`, `AWAITING_EXTERNAL_CONFIRMATION`, `APPROVED`, `DECLINED`, `CANCELLED`, `EXPIRED`, `REFUNDED`, `RECONCILIATION_PENDING` e `RECONCILED` conforme transições válidas.
- **PAY-003** — Toda tentativa registra valor em centavos, chave idempotente, canal, operador e origem de confirmação; confirmação manual nunca se apresenta como webhook/consulta.
- **PAY-004** — PicPay Payment Link é o primeiro canal online (ADR 0010), habilitado somente após homologação de sandbox/conta e confirmado por webhook autenticado ou consulta oficial. Documentação pública não comprova integração ou credenciais válidas.
- **PAY-005** — Maquininha é o canal presencial principal; Tap é complementar e restrito. O MVP não pressupõe iniciação remota.
- **PAY-005a** — Método e terminal da Maquininha (spec 6.7, 28/09/2026): toda confirmação manual na Maquininha registra o método do cartão (crédito ou débito; V.A./V.R. só com a flag `meal_voucher`, após credenciamento), além da referência não sensível já exigida; Área Pix não tem método nem terminal. O financeiro mantém o cadastro interno de maquininhas (código e nome, sem exclusão, só desativação); com ao menos uma maquininha ativa, o vendedor precisa informar qual usou, e maquininha inativa não recebe pagamentos. A confirmação nunca altera o total calculado pelo servidor e nenhum dado de cartão é guardado. Tap continua indisponível até a flag `picpay_tap` e a decisão correspondente.
- **PAY-006** — V.A./V.R. fica desligado até credenciamento; rede é método dentro de PicPay e nunca é mascarada como crédito.
- **PAY-007** — Webhooks persistem receipt, validam autenticidade, deduplicam e permitem replay controlado. Payment Link usa API Key no header authorization conforme contrato oficial, sem presumir HMAC; pagamento tardio, valor divergente e resultado incerto entram em recuperação/conciliação sem duplicar efeitos.
- **PAY-008** — Adapter privado/TEF/SDK futuro substitui somente a borda de integração, sem reescrever venda, estoque ou financeiro.

- **PAY-009a** — Operação do dinheiro físico (28/09/2026): o recebimento em dinheiro exige turno aberto do vendedor no local da venda; o turno abre com fundo de troco opcional (padrão R$ 0), cada venda registra valor recebido e troco em centavos (troco = recebido − total, nunca negativo) e o caixa esperado é fundo + recebimentos em dinheiro − devoluções físicas em dinheiro. O fechamento informa o valor contado; diferença diferente de zero exige justificativa e o turno fechado é imutável. O dinheiro usa o canal interno `DINHEIRO` e o lançamento `CASH_RECEIPT`, nunca recebível PicPay. Revisão de 28/09/2026 (estorno de venda paga em dinheiro): o `SALE_RECEIPT` original nunca é alterado nem excluído. Quando o estorno confirmado devolve dinheiro físico pelo caixa, o financeiro indica o turno aberto de onde o dinheiro saiu e o estorno grava, na mesma transação, um novo movimento negativo e imutável `REFUND_PAYOUT` vinculado à venda, à tentativa de pagamento e ao lançamento `REFUND`; há no máximo uma devolução física por venda e ela não pode exceder o dinheiro do caixa daquele turno. Reembolso por outro meio não altera o caixa. Turno fechado nunca é recalculado nem recebe movimentos: devolução ocorrida depois do fechamento pertence ao turno aberto em que a saída física efetivamente ocorreu ou segue o fluxo financeiro administrativo (outro meio). O financeiro confere os turnos (fundo, recebimentos, devoluções, esperado, contado e diferença) em Financeiro › Turnos de caixa.
- **PAY-009** — Dinheiro físico é método interno com conta própria, recebimento e troco em centavos, autoria/idempotência e conferência por turno. Não identificar caixa físico como provider PicPay. Somente papéis autorizados registram e corrigem movimentos por reversão.

### Financeiro e conciliação

- **FIN-001** — Venda/rifa paga, compra, taxa e reembolso geram lançamentos idempotentes e vinculados à origem.
- **FIN-002** — PicPay Empresas é conta principal; taxas, recebíveis, caixa físico e liquidação são separados.
- **FIN-003** — Divergências geram pendência de conciliação, não edição retroativa; importação preserva fonte e correlação.
- **FIN-004** — Open Finance, se adotado, auxilia conciliação e nunca autoriza/conclui venda.
- **FIN-005** — Plano simplificado e lançamentos manuais (spec 5.8, 28/09/2026): categorias fixas (Venda PDV, Venda Online, Reserva, Rifa, Evento, Fornecedor, Taxas, Mensalidades, Transporte, Materiais, Reembolso, Ajuste, Outros) e contas/caixas (PicPay Empresas, dinheiro físico, recebíveis PicPay, pendente de liquidação). O financeiro registra despesas, outras receitas e transferências de tesouraria (que movem dinheiro entre contas e nunca são receita), em centavos, com data em dia de São Paulo não futura, descrição e referência não sensível; auditoria e outbox em cada comando. Receita de Venda PDV, Venda Online, Reserva e Rifa vem só dos eventos automáticos, nunca de lançamento manual. Lançamentos são imutáveis: a correção é um único estorno vinculado, datado no dia da correção. Transferências de tesouraria não contam como entrada nem saída.
- **FIN-006** — Extrato consolidado (spec 5.8, 29/09/2026): relatório por período em dias de São Paulo que classifica, sem gravar nada novo, os eventos automáticos e os lançamentos manuais nas mesmas categorias e contas. Regras: venda paga no PicPay entra em Recebíveis PicPay e venda em dinheiro em Dinheiro físico, na categoria do canal (Venda PDV, Venda Online, Reserva; Rifa quando a venda tem números de rifa); taxa vai para Taxas em Recebíveis; divergência de conciliação vai para Ajuste em Recebíveis; liquidação é transferência de Recebíveis para PicPay Empresas; estorno vai para Reembolso, saindo de Dinheiro físico quando devolvido pelo caixa, de PicPay Empresas quando o recebível já foi liquidado ou a venda foi em dinheiro, e de Recebíveis nos demais casos; pagamento a fornecedor vai para Fornecedor, saindo de Dinheiro físico quando o método informado contém "dinheiro" e de PicPay Empresas nos demais casos. O extrato exporta CSV real (UTF-8 com BOM, separador `;`, valores em reais com vírgula, texto protegido contra fórmulas).

### Reservas, rifas e crescimento

- **RES-001** — Reserva congela preço, bloqueia estoque e conclui/cancela/expira atomicamente.
- **RAF-001** — Número de rifa é reservado concorrentemente; pagamento integra financeiro; sorteio é auditável.
- **NOTIF-001** — Notificação in-app é MVP; e-mail/push são assíncronos e falhas não desfazem transação.
- **COMM-001** (Marco 2) — A Rede Social Germinare começa como mural moderado para identidades institucionais verificadas, sem mensagens privadas no MVP; publicação, comentário e moderação respeitam papéis, flags e permissões.
- **GROW-001** — Campanhas podem gerar texto, links rastreáveis e QR; cards automáticos são posteriores.

## Requisitos não funcionais

- **CONC-001** — Última unidade, número de rifa e transferência/venda simultânea resultam em exatamente um vencedor e saldo não negativo.
- **IDEM-001** — Duplo clique, webhook, confirmação e cancelamento repetidos não duplicam efeitos.
- **OBS-001** — Operações críticas usam `request_id/correlation_id`, logs estruturados e audit log separado.
- **PERF-001** — Interações locais do PDV são imediatas; tarefas secundárias ocorrem após commit por outbox.
- **ACC-001** — Portal administrativo suporta teclado/labels/contraste e estados não dependem só de cor.
- **DATA-001** — Timestamps são UTC/timestamptz e relatórios exibem `America/Sao_Paulo` com intervalos fechado-aberto.

## Feature flags e dependências externas

Flags mínimas: `online_checkout`, `picpay_checkout`, `pix_area_manual`, `card_present`, `picpay_tap`, `meal_voucher`, `reservations`, `raffles`, `community`, `comments`, `notifications`. Flags não substituem autorização, credenciamento ou configuração válida.

Bloqueados externamente: conta/KYC e representante legal; termos e habilitação do PicPay Checkout; credenciais/sandbox oficiais; Maquininha/terminais; credenciamento Alelo/Ticket; SFTP ou integração privada/TEF/SDK. Nenhuma credencial financeira pertence a vendedor.

## MVP e pós-MVP

MVP: fundação segura; cadastro institucional verificado e login por e-mail/username + senha; recuperação limitada e desbloqueio administrativo; bootstrap controlado do primeiro administrador; papéis cumulativos com provisionamento/ativação administrativa do vendedor; catálogo; centavos/pricing; ledger/localizações/reservas; checkout/venda; tentativa PicPay; PIX manual controlado e Maquininha manual auditada; idempotência/outbox; financeiro/conciliação básica; fechamento; reservas/rifas essenciais; notificações in-app.

Lançamento v2.2 replanejado: incluir Payment Link homologado, dinheiro físico, todas as jornadas administrativas/comerciais, compras/custos e as campanhas operacionais.

**Decisão de escopo (28/09/2026):** o primeiro go-live (Marco 1) não depende da Rede Social Germinare. Mural, posts, comentários, sugestões, enquetes, denúncias e moderação social (COMM-001) são Marco 2, depois do site operacional em produção. Campanhas e notificações necessárias a cardápio, pedidos, reservas e vendas continuam no Marco 1. Depois das promoções, a ordem do Marco 1 é: PDV/caixa → comercial/financeiro essencial → cliente/cardápio/pedidos → comunicação operacional → Payment Link → gestão/release. As datas anteriores de 10/09 e 11/09 foram substituídas por marcos no ROADMAP. O recorte MVP acima descreve a base histórica, não o escopo final do lançamento.

Evoluções condicionais: automação SFTP, Web Push, cards automáticos, comunidade avançada, integração presencial privada oficial, Open Finance somente se conciliação justificar e app nativo/chat apenas com evidência de necessidade.

## Critérios de aceite transversais

Cada requisito só muda para DONE com código/migration quando aplicável, testes relevantes, lint, typecheck, build, segurança, documentação/roadmap e evidência reproduzível. Telas desabilitadas, stubs e mocks não contam como integração real.

Casos obrigatórios: última unidade disputada; duplo Cobrar; webhook/confirmar/cancelar duplicados; venda e transferência simultâneas; pagamento pendente não baixa definitivo; confirmação manual rotulada; voucher desligado sem credenciamento; domínio externo ou semelhante rejeitado; código de cadastro/recuperação expirado ou reutilizado rejeitado; username duplicado por variação de caixa rejeitado; login por e-mail e username não enumera contas; terceira solicitação de recuperação é bloqueada até ação administrativa; nova identidade institucional entra somente como `CONSUMIDOR`; consumidor é bloqueado no PDV até provisionamento/ativação administrativa de `VENDEDOR`; bootstrap administrativo aceita somente `theo.martins@institutojef.org.br` verificado e não duplica concessões.

## Riscos

- Integrações/condições comerciais PicPay podem mudar: verificar documentação oficial antes de implementar.
- Confirmação manual exige desenho de fraude, permissão e conciliação.
- Ausência de ledger/pricing torna qualquer checkout prematuro inseguro.
- Complexidade de escopo exige fases e PRs pequenos; comunidade e crescimento não podem antecipar invariantes P0.
