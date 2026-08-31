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

Decisão detalhada: ADR 0009 — Acesso institucional e bootstrap administrativo.

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

### Estoque, compras e fornecedores

- **INV-001** — Estoque é ledger imutável; saldo deriva de movimentos e correções usam reversão/ajuste motivado.
- **INV-002** — Há estoque central e localizações por vendedor; transferência é uma operação atômica.
- **INV-003** — Reserva reduz disponível, expira e é consumida/liberada idempotentemente; nenhum saldo fica negativo.
- **INV-004** — Venda, transferência e inventário concorrentes usam lock ou atualização condicional no banco.
- **PROC-001** — Fornecedor, compra, itens, custos, lote e recebimento parcial explicam origem e custo do estoque.

### Vendas e PDV

- **PDV-001** — PDV é mobile-first, rápido, separado do Portal e bloqueia consumidor, usuário inativo ou conta institucional sem ativação administrativa de vendedor no servidor.
- **SALE-001** — Cobrar recalcula carrinho, reserva estoque e cria venda/tentativa com `Idempotency-Key` em uma transação.
- **SALE-002** — Venda só conclui com pagamento confirmado ou método manual autorizado; conclusão cria estoque e financeiro atomicamente.
- **SALE-003** — Cancelamento não exclui: registra motivo e cria reversões vinculadas, repetíveis sem duplicação.
- **CLOSE-001** — Fechamento compara estoque, vendas e pagamentos; divergência exige justificativa e reabertura é auditada.
- **PWA-001** — O PDV pode cachear shell/catálogo, mas nunca conclui operação crítica offline.

### Pagamentos PicPay

- **PAY-001** — O domínio usa interfaces neutras `PaymentProvider` e `CardPresentProvider`; produção configura somente PicPay.
- **PAY-002** — Tentativas distinguem `CREATED`, `PENDING`, `AWAITING_EXTERNAL_CONFIRMATION`, `APPROVED`, `DECLINED`, `CANCELLED`, `EXPIRED`, `REFUNDED`, `RECONCILIATION_PENDING` e `RECONCILED` conforme transições válidas.
- **PAY-003** — Toda tentativa registra valor em centavos, chave idempotente, canal, operador e origem de confirmação; confirmação manual nunca se apresenta como webhook/consulta.
- **PAY-004** — PicPay Checkout/E-commerce atende online somente quando habilitado e confirmado por webhook autenticado ou consulta oficial.
- **PAY-005** — Maquininha é o canal presencial principal; Tap é complementar e restrito. O MVP não pressupõe iniciação remota.
- **PAY-006** — V.A./V.R. fica desligado até credenciamento; rede é método dentro de PicPay e nunca é mascarada como crédito.
- **PAY-007** — Webhooks persistem receipt, validam autenticidade, deduplicam e permitem replay controlado.
- **PAY-008** — Adapter privado/TEF/SDK futuro substitui somente a borda de integração, sem reescrever venda, estoque ou financeiro.

### Financeiro e conciliação

- **FIN-001** — Venda/rifa paga, compra, taxa e reembolso geram lançamentos idempotentes e vinculados à origem.
- **FIN-002** — PicPay Empresas é conta principal; taxas, recebíveis, caixa físico e liquidação são separados.
- **FIN-003** — Divergências geram pendência de conciliação, não edição retroativa; importação preserva fonte e correlação.
- **FIN-004** — Open Finance, se adotado, auxilia conciliação e nunca autoriza/conclui venda.

### Reservas, rifas e crescimento

- **RES-001** — Reserva congela preço, bloqueia estoque e conclui/cancela/expira atomicamente.
- **RAF-001** — Número de rifa é reservado concorrentemente; pagamento integra financeiro; sorteio é auditável.
- **NOTIF-001** — Notificação in-app é MVP; e-mail/push são assíncronos e falhas não desfazem transação.
- **COMM-001** — A Rede Social Germinare começa como mural moderado para identidades institucionais verificadas, sem mensagens privadas no MVP; publicação, comentário e moderação respeitam papéis, flags e permissões.
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

Pós-MVP: Checkout online quando habilitado; automação SFTP; Web Push; cards; comunidade avançada; integração presencial privada oficial; Open Finance somente se conciliação justificar; app nativo/chat apenas com evidência de necessidade.

## Critérios de aceite transversais

Cada requisito só muda para DONE com código/migration quando aplicável, testes relevantes, lint, typecheck, build, segurança, documentação/roadmap e evidência reproduzível. Telas desabilitadas, stubs e mocks não contam como integração real.

Casos obrigatórios: última unidade disputada; duplo Cobrar; webhook/confirmar/cancelar duplicados; venda e transferência simultâneas; pagamento pendente não baixa definitivo; confirmação manual rotulada; voucher desligado sem credenciamento; domínio externo ou semelhante rejeitado; código de cadastro/recuperação expirado ou reutilizado rejeitado; username duplicado por variação de caixa rejeitado; login por e-mail e username não enumera contas; terceira solicitação de recuperação é bloqueada até ação administrativa; nova identidade institucional entra somente como `CONSUMIDOR`; consumidor é bloqueado no PDV até provisionamento/ativação administrativa de `VENDEDOR`; bootstrap administrativo aceita somente `theo.martins@institutojef.org.br` verificado e não duplica concessões.

## Riscos

- Integrações/condições comerciais PicPay podem mudar: verificar documentação oficial antes de implementar.
- Confirmação manual exige desenho de fraude, permissão e conciliação.
- Ausência de ledger/pricing torna qualquer checkout prematuro inseguro.
- Complexidade de escopo exige fases e PRs pequenos; comunidade e crescimento não podem antecipar invariantes P0.
