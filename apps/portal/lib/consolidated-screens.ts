/**
 * ADR 0011 (PR 4): which Portal screens work in "Todas as turmas". A consolidated screen labels every record with its
 * cohort and computes aggregates inside each cohort (never one figure mixing cohorts); any other screen works inside
 * one cohort only, and the proxy sends "all" there to the cohort selection. Fail-closed: a screen not listed is
 * cohort-only.
 */
export const consolidatedScreens: readonly { path: string; label: string }[] = [
  { path: "/", label: "Visão geral: comparação das turmas" },
  { path: "/admin/turmas", label: "Turmas" },
  { path: "/admin/usuarios", label: "Usuários, vínculos e papéis por turma" },
  { path: "/admin/auditoria", label: "Auditoria, com a turma de cada registro" },
  { path: "/admin/financeiro/vendas", label: "Vendas, com a turma de cada venda" },
  { path: "/admin/financeiro/indicadores", label: "Indicadores lado a lado por turma" },
  // Personal screens read nothing of a cohort.
  { path: "/perfil", label: "Perfil" },
  { path: "/notificacoes", label: "Notificações" },
  { path: "/trocar-senha", label: "Senha" },
  { path: "/selecionar-turma", label: "Seleção de turma" },
];

/** Why a screen stays inside one cohort (shown on the selection page and documented in ADR 0011). */
const cohortOnlyReasons: readonly { prefix: string; reason: string }[] = [
  { prefix: "/admin/financeiro/contas-a-pagar", reason: "Contas a pagar são obrigações do livro de uma turma; somar turmas sugeriria um caixa único que não existe." },
  { prefix: "/admin/financeiro/saldo", reason: "Os saldos são o livro de cada turma. A conta PicPay é global e o extrato não se divide por turma." },
  { prefix: "/admin/financeiro/extrato", reason: "O extrato PicPay é evidência global; a classificação de cada linha acontece dentro da turma a que ela pertence." },
  { prefix: "/admin/financeiro/importar-extrato", reason: "A importação registra evidência global, mas a revisão e a atribuição das linhas são feitas dentro de uma turma." },
  { prefix: "/admin/financeiro/conciliacao-picpay", reason: "A conciliação atribui evidência global aos livros de uma turma; nunca é feita para várias de uma vez." },
  { prefix: "/admin/financeiro", reason: "Lançamentos, turnos, maquininhas e pagamentos online pertencem ao livro de uma turma." },
  { prefix: "/admin/estoque", reason: "Estoque, contagens, perdas e devoluções são operações nos locais de uma turma." },
  { prefix: "/admin/fechamentos", reason: "Fechamentos conferem o caixa e o estoque de vendedores de uma turma." },
  { prefix: "/admin/compras", reason: "Compras, recebimentos e fornecedores pertencem a uma turma." },
  { prefix: "/admin/catalogo", reason: "Cada turma tem o próprio catálogo, preços e imagens." },
  { prefix: "/admin/promocoes", reason: "Promoções e cupons valem dentro de uma turma." },
  { prefix: "/admin/reservas", reason: "Reservas usam o estoque e o catálogo de uma turma." },
  { prefix: "/admin/rifas", reason: "Rifas são campanhas de uma turma, com produto, local e compradores dela." },
  { prefix: "/admin/comunicacao", reason: "Avisos, divulgação e eventos se dirigem aos membros de uma turma." },
  { prefix: "/admin/configuracoes", reason: "As configurações e os módulos ligados valem por turma." },
];

export function screenAllowedInAll(path: string): boolean {
  return consolidatedScreens.some((screen) => screen.path === path);
}

export function cohortOnlyReason(path: string): string {
  return cohortOnlyReasons.find((item) => path === item.prefix || path.startsWith(`${item.prefix}/`))?.reason
    ?? "Esta tela mostra e altera dados de uma turma.";
}

/** A same-origin path to return to after choosing a cohort; anything else goes home. */
export function safeNextPath(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}
