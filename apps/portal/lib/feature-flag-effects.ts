// What each functional switch does, shown in Configurações. Off always blocks new operations in the database;
// work already started can be finished and history stays readable (PRD "Flags de módulos gerenciais").
export interface FeatureFlagEffect {
  on: string;
  off: string;
  history?: { href: string; label: string };
}

export const featureFlagEffects: Record<string, FeatureFlagEffect> = {
  reservations: {
    on: "Consumidores reservam produtos pelo Portal, e a equipe separa e entrega as reservas.",
    off: "Novas reservas são recusadas e a Gestão de reservas sai do menu. Reservas já feitas seguem até a retirada ou a expiração.",
    history: { href: "/admin/reservas", label: "Consultar reservas" },
  },
  raffles: {
    on: "Rifas podem ser criadas e os números vendidos no Portal e no PDV.",
    off: "Novas rifas e reservas de números são recusadas, e as rifas saem do menu. Vendas já pagas e sorteios ficam registrados.",
    history: { href: "/admin/rifas", label: "Consultar rifas" },
  },
  notifications: {
    on: "Avisos automáticos, manuais e novidades chegam ao sino de cada pessoa, conforme as preferências.",
    off: "Nenhum aviso novo é criado. Os eventos continuam sendo processados e a central mantém os avisos antigos.",
  },
  card_present: {
    on: "O PDV confirma pagamentos feitos na Maquininha, com método e terminal.",
    off: "O PDV não confirma novos pagamentos na Maquininha. Vendas já pagas e estornos não mudam.",
  },
  pix_area_manual: {
    on: "O PDV confirma pagamentos conferidos na Área Pix do app PicPay.",
    off: "O PDV não confirma novos pagamentos pela Área Pix. Vendas já pagas e estornos não mudam.",
  },
  cash_payment: {
    on: "O PDV recebe em dinheiro físico, dentro de um turno de caixa aberto pelo vendedor.",
    off: "O PDV esconde Dinheiro e a aba Caixa, e o banco recusa receber em dinheiro e abrir turno. Turnos abertos ainda podem ser fechados, e devoluções em dinheiro de estornos continuam.",
    history: { href: "/admin/financeiro/turnos", label: "Conferir turnos" },
  },
  procurement: {
    on: "Cadastro de fornecedores, pedidos de compra e recebimentos, com lotes, custos e contas a pagar.",
    off: "Compras e fornecedores sai do menu, e o banco recusa fornecedor novo ou editado, pedido novo e recebimento. Pedidos abertos podem ser cancelados, e as contas a pagar continuam em Financeiro.",
    history: { href: "/admin/compras", label: "Consultar compras" },
  },
  events: {
    on: "Eventos e campanhas aparecem no Portal e na vitrine do Início, e a Comunicação os cria e publica.",
    off: "O Portal deixa de mostrar eventos, a gestão sai do menu, e o banco recusa criar, editar ou publicar. Eventos publicados ainda podem ser cancelados.",
    history: { href: "/admin/comunicacao/eventos", label: "Consultar eventos" },
  },
  payment_link: {
    on: "O PDV e o Portal geram link de pagamento PicPay. Ligue só depois da homologação.",
    off: "Nenhum link novo é gerado. Os links já emitidos continuam sendo conciliados.",
  },
  meal_voucher: {
    on: "Sem uso no Marco 1.",
    off: "Cartões de benefício (V.A./V.R.) são cobrados na função Crédito e registrados como Crédito (PAY-006).",
  },
  online_checkout: { on: "Sem uso no Marco 1.", off: "Não há checkout online fora do link de pagamento." },
  picpay_checkout: { on: "Sem uso no Marco 1.", off: "Não há integração de checkout remoto com o PicPay." },
  picpay_tap: { on: "Sem uso no Marco 1.", off: "Tap PicPay indisponível." },
  community: { on: "Reservada para a Rede Social (Marco 2).", off: "Sem efeito no Marco 1." },
  comments: { on: "Reservada para a Rede Social (Marco 2).", off: "Sem efeito no Marco 1." },
};
