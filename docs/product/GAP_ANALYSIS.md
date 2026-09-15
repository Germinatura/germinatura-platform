# Diagnóstico v2.2 — estado atual e conclusão

Auditoria atualizada em 14/09/2026: `main=95c4209`, `develop=1946889`, checkout limpo no início da fatia. A PR #63, o Quality pós-merge `34881831868` e o Deploy Staging `34881831884` estão verdes. Código, contratos, 29 migrations integradas e testes foram inspecionados; produção não foi acessada.

A [matriz de requisitos](REQUIREMENTS_MATRIX.md) é a referência detalhada de evidência por camada; o [roadmap](ROADMAP.md) define ordem e critérios. O diagnóstico anterior misturava auditoria de agosto com incrementos de setembro e foi substituído por esta base explícita.

| Área | Evidência atual | Lacuna real | Marco |
| --- | --- | --- | --- |
| Identidade | Cadastro verificado, credenciais, papéis, revogação, bootstrap e recuperação; gestão de usuários em staging | Homologação SMTP/bootstrap; UI de desbloqueio, conta/sessões e handoff seguro Portal→PDV | 9, 11 |
| Catálogo | Categorias, produtos, preços, imagens Storage e GET anônimo integrados | Smoke autenticado de uma oferta completa em staging | 1 |
| Estoque | Ledger, saldo/localizações, reservas, distribuição, transferência com aceite e devolução integrados; perdas completas localmente com aprovação, foto privada e concorrência | Integrar perdas; concluir inventário, ajustes aprovados e “Meu estoque” | 2 |
| Pricing | QUANTIDADE_PRECO na cotação e checkout | Demais regras, gestão e consumo concorrente dos limites | 4 |
| PDV | Checkout, confirmação Maquininha/Área Pix, fechamento e PWA read-only | Turno/histórico, caixa físico, método/terminal e dispositivos reais | 5 |
| Financeiro | Recebível/taxa/liquidação/divergência e reversão de venda comum transacionais | UI completa, contas/categorias/despesas/importação/CSV e custo real | 3, 6 |
| Reservas | Backend ACTIVE/CONVERTED/CANCELLED/EXPIRED e consulta/cancelamento próprio | Compra/pagamento, preparação, pronta retirada e entrega | 8 |
| Rifas | Reserva concorrente, financeiro, criação/encerramento/sorteio e consultas | Compra consumidor/PDV, publicação/pausa/cancelamento e reembolso específico | 8 |
| Indicadores | Resumo explícito de 100 vendas recentes e contagens operacionais | Relatórios integrais por período, conciliação, custo/margem/perdas/meta | 9 |
| Operação assíncrona | Worker claim/lease/retry/ack e expiração; notificações in-app | Alertas, retenção, restore ensaiado, preferências/avise-me/segmentação | 9–11 |
| Pagamentos online | Documentação pública Payment Link verificada; contrato neutro no repo | Adapter, receipt e sandbox real não implementados/validados | 7 |
| Crescimento/comunidade | Sem jornada completa | Vitrine, campanhas/eventos, links/QR, atribuição, mural/enquetes/moderação | 10 |

## Divergências resolvidas documentalmente

- DOCX login por código → ADR 0009/PRD/código credenciais: preservar a decisão posterior; código verifica cadastro/recuperação, login usa senha.
- Roadmap DONE de catálogo/estoque/promoções/financeiro → código parcial: decompor fundação e jornada; nenhuma tela de consulta comprova escrita operacional.
- Declarações antigas de staging bloqueado e apps shells → CI/deploy e interfaces atuais: removidas; os gates humanos ainda não comprovados continuam pendentes.
- Checkout genérico → documentação fornecida de Payment Link: registrar produto e contratos próprios no ADR 0010, sem inventar merchantChargeId nesse produto.
- Provider PicPay para todos os pagamentos → dinheiro físico aprovado: adquirência externa continua PicPay; caixa interno recebe identidade própria.
- Congelamento 10/09 e lançamento 11/09 → plano aprovado de conclusão não opcional por marcos; sem nova data artificial.

## Estratégia de redução do caminho crítico

Estoque/compras, promoções, pagamentos/financeiro, Portal consumidor/crescimento e gestão/qualidade avançam em trilhas paralelas com contratos explícitos. Custos e promoções desbloqueiam mais jornadas e entram antes das telas dependentes. Intenção de pagamento, receipt, deduplicação e adapter fail-closed avançam antes das credenciais; sandbox real continua sendo gate externo. Homologação acompanha cada merge em staging para evitar concentrar concorrência, acessibilidade, performance, dispositivos e restore no final.

## Bloqueios e riscos

Habilitação, credenciais e execução de sandbox ainda não foram comprovadas; não acessar segredos para produzir evidência documental. Confirmar schemas completos e comportamento de timeout/múltiplos pagamentos por link antes de ativar. Materiais públicos não autorizam integrações privadas de Tap/TEF/SDK, nem V.A./V.R. sem credenciamento.

Vinte e oito migrations formam o schema atual: promoção requer revisão cumulativa, sem reset/seeds de produção. Greenfield não autoriza apagar o histórico que vier a ser criado. Preservar restituições por evento compensatório e elegibilidade histórica de sorteios.
