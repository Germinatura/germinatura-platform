// Single source of the Portal navigation: the Sidebar and the command palette render the same entries.
// Visibility only shapes navigation; pages and APIs keep enforcing permissions on the server.
import { Banknote, Bell, BookOpenText, Boxes, CalendarClock, CalendarDays, ChartNoAxesColumn, ClipboardCheck, CreditCard, FileSearch, FileUp, GraduationCap, HandCoins, LayoutDashboard, Link2, Megaphone, PackageSearch, PartyPopper, Percent, Receipt, Settings, Share2, ShieldCheck, ShoppingBag, Store, Ticket, TrendingUp, Truck, UserRoundCog, Wallet, type LucideIcon } from "lucide-react";
import { experienceHome, type PortalExperience } from "./portal-experience";

export interface NavigationContext {
  roles: string[];
  experience: PortalExperience;
  features: string[];
  pdvUrl: string;
}

export type NavigationSectionId = "principal" | "catalogo" | "financeiro" | "comunicacao" | "conta" | "pdv";

export interface NavigationItem {
  id: string;
  section: NavigationSectionId;
  label: string;
  href: string;
  icon: LucideIcon;
  keywords: string[];
  external?: boolean;
  /** Entries reachable only from the search (the Sidebar shows them elsewhere or not at all). */
  searchOnly?: boolean;
  active: (pathname: string) => boolean;
}

export interface NavigationSection {
  id: NavigationSectionId;
  label: string;
  items: NavigationItem[];
}

interface ItemDefinition extends Omit<NavigationItem, "label" | "href" | "active"> {
  label: string | ((context: NavigationContext) => string);
  href: string | ((context: NavigationContext) => string);
  match?: "exact" | "prefix";
  active?: (pathname: string, context: NavigationContext) => boolean;
  visible: (context: NavigationContext) => boolean;
}

// ADR 0011: ADMIN_MASTER counts as ADMIN in every cohort; the database still checks each action.
const hasAny = (context: NavigationContext, roles: string[]) => context.roles.some((role) => roles.includes(role))
  || (roles.includes("ADMIN") && context.roles.includes("ADMIN_MASTER"));
const isMasterExperience = (context: NavigationContext) => context.roles.includes("ADMIN_MASTER") && context.experience === "admin";
// ADR 0011: ADMIN_MASTER has the administrative experience in every cohort.
const hasAdminRole = (context: NavigationContext) => context.roles.includes("ADMIN") || context.roles.includes("ADMIN_MASTER");
const isAdminExperience = (context: NavigationContext) => hasAdminRole(context) && context.experience === "admin";
// An administrator browsing as a consumer does not see staff areas; other staff roles always do.
const staffScope = (context: NavigationContext) => context.experience !== "consumer" || !hasAdminRole(context);
const homeHref = (context: NavigationContext) => isAdminExperience(context) ? "/" : "/inicio";

const sectionLabels: Record<NavigationSectionId, (context: NavigationContext) => string> = {
  principal: (context) => isAdminExperience(context) ? "Operação" : "Explorar",
  catalogo: () => "Catálogo e estoque",
  financeiro: () => "Financeiro",
  comunicacao: () => "Comunicação",
  conta: () => "Conta",
  pdv: () => "PDV",
};

const definitions: ItemDefinition[] = [
  { id: "home", section: "principal", icon: LayoutDashboard, label: (context) => isAdminExperience(context) ? "Visão geral" : "Início", href: homeHref, keywords: ["inicio", "home", "painel", "dashboard", "vitrine"], visible: () => true, active: (pathname, context) => pathname === homeHref(context) || (!hasAdminRole(context) && pathname === "/") },
  { id: "catalog", section: "principal", icon: ShoppingBag, label: "Catálogo", href: "/catalogo", match: "exact", keywords: ["produtos", "comprar", "cardapio", "loja"], visible: (context) => !isAdminExperience(context) && hasAny(context, ["ADMIN", "CONSUMIDOR", "VENDEDOR", "ESTOQUE"]) },
  { id: "my-reservations", section: "principal", icon: CalendarClock, label: "Minhas reservas", href: "/reservas", match: "exact", keywords: ["reserva", "retirada", "pedidos"], visible: (context) => !isAdminExperience(context) && hasAny(context, ["ADMIN", "CONSUMIDOR", "VENDEDOR"]) },
  { id: "raffles", section: "principal", icon: Ticket, label: "Rifas", href: "/rifas", match: "exact", keywords: ["bilhetes", "numeros", "sorteio"], visible: (context) => !isAdminExperience(context) && context.features.includes("raffles") && hasAny(context, ["ADMIN", "CONSUMIDOR", "VENDEDOR"]) },
  { id: "events", section: "principal", icon: PartyPopper, label: "Eventos e campanhas", href: "/eventos", keywords: ["evento", "campanha", "agenda", "convite"], visible: (context) => context.features.includes("events") },
  { id: "admin-reservations", section: "principal", icon: CalendarClock, label: "Gestão de reservas", href: "/admin/reservas", keywords: ["reservas", "retiradas", "pedidos", "entrega"], visible: (context) => isAdminExperience(context) && context.features.includes("reservations") },
  { id: "admin-raffles", section: "principal", icon: Ticket, label: "Gestão de rifas", href: "/admin/rifas", keywords: ["rifa", "sorteio", "bilhetes", "compradores"], visible: (context) => isAdminExperience(context) && context.features.includes("raffles") },
  { id: "users", section: "principal", icon: UserRoundCog, label: "Usuários e vendedores", href: "/admin/usuarios", keywords: ["usuarios", "vendedores", "papeis", "permissoes", "bloqueio", "convite"], visible: isAdminExperience },
  { id: "cohorts", section: "principal", icon: GraduationCap, label: "Turmas", href: "/admin/turmas", keywords: ["turma", "geracao", "ano", "arquivar", "admin master"], visible: isMasterExperience },
  { id: "audit", section: "principal", icon: FileSearch, label: "Auditoria", href: "/admin/auditoria", keywords: ["log", "historico", "registro", "trilha"], visible: isAdminExperience },
  { id: "admin-catalog", section: "catalogo", icon: PackageSearch, label: "Catálogo", href: "/admin/catalogo", keywords: ["produtos", "categorias", "precos", "imagens", "publicar"], visible: isAdminExperience },
  { id: "promotions", section: "catalogo", icon: Percent, label: "Promoções", href: "/admin/promocoes", keywords: ["desconto", "cupom", "combo", "oferta"], visible: isAdminExperience },
  { id: "inventory", section: "catalogo", icon: Boxes, label: "Estoque", href: "/admin/estoque", keywords: ["saldo", "lotes", "transferencia", "perdas", "inventario", "distribuicao"], visible: (context) => staffScope(context) && hasAny(context, ["ADMIN", "ESTOQUE"]) },
  { id: "procurement", section: "catalogo", icon: Truck, label: "Compras e fornecedores", href: "/admin/compras", keywords: ["compra", "fornecedor", "recebimento", "pedido de compra", "custo"], visible: (context) => staffScope(context) && hasAny(context, ["ADMIN", "ESTOQUE"]) && context.features.includes("procurement") },
  ...financeItems(),
  { id: "notices", section: "comunicacao", icon: Megaphone, label: "Avisos", href: "/admin/comunicacao/avisos", keywords: ["aviso", "comunicado", "notificacao", "mensagem"], visible: communicationScope },
  { id: "share", section: "comunicacao", icon: Share2, label: "Divulgação", href: "/admin/comunicacao/divulgacao", keywords: ["link", "qr code", "campanha", "atribuicao", "origem"], visible: communicationScope },
  { id: "admin-events", section: "comunicacao", icon: CalendarDays, label: "Gestão de eventos", href: "/admin/comunicacao/eventos", keywords: ["evento", "campanha", "destaque", "vitrine", "capa"], visible: (context) => communicationScope(context) && context.features.includes("events") },
  { id: "profile", section: "conta", icon: ShieldCheck, label: "Perfil e segurança", href: "/perfil", match: "exact", keywords: ["perfil", "senha", "sessoes", "preferencias", "conta"], visible: () => true },
  { id: "notifications", section: "conta", icon: Bell, label: "Notificações", href: "/notificacoes", searchOnly: true, keywords: ["avisos", "mensagens", "alertas"], visible: () => true },
  { id: "switch-experience", section: "conta", icon: UserRoundCog, label: (context) => isAdminExperience(context) ? "Visão do consumidor" : "Visão administrativa", href: (context) => experienceHome(isAdminExperience(context) ? "consumer" : "admin"), searchOnly: true, keywords: ["trocar visao", "alternar", "experiencia"], visible: hasAdminRole, active: () => false },
  { id: "pdv", section: "pdv", icon: Store, label: "Abrir PDV", href: (context) => context.pdvUrl, external: true, keywords: ["ponto de venda", "vender", "caixa", "vendedor"], visible: (context) => hasAny(context, ["ADMIN", "VENDEDOR"]), active: () => false },
];

function communicationScope(context: NavigationContext) {
  return staffScope(context) && hasAny(context, ["ADMIN", "COMUNICACAO"]);
}

function financeItems(): ItemDefinition[] {
  const visible = (context: NavigationContext) => staffScope(context) && hasAny(context, ["ADMIN", "FINANCEIRO"]);
  const entries: Array<[string, LucideIcon, string, string, string[]]> = [
    ["indicators", TrendingUp, "Indicadores", "/admin/financeiro/indicadores", ["lucro", "meta", "resultado", "graficos", "pendencias"]],
    ["settings", Settings, "Configurações", "/admin/configuracoes", ["flags", "funcionalidades", "parametros", "meta"]],
    ["balances", Wallet, "Saldo e conferência", "/admin/financeiro/saldo", ["saldo", "cofrinho", "abertura", "conferencia", "recebiveis"]],
    ["sales", Receipt, "Vendas", "/admin/financeiro/vendas", ["venda", "estorno", "pagamento", "recibo"]],
    ["entries", BookOpenText, "Lançamentos", "/admin/financeiro/lancamentos", ["despesa", "receita", "lancamento manual", "transferencia"]],
    ["statement", ChartNoAxesColumn, "Extrato", "/admin/financeiro/extrato", ["extrato", "saldo", "contas", "movimentos"]],
    ["picpay-reconciliation", FileUp, "Conciliação PicPay", "/admin/financeiro/conciliacao-picpay", ["importar", "csv", "conciliacao", "picpay", "minhas vendas", "recebiveis", "extrato", "taxa"]],
    ["closeouts", ClipboardCheck, "Fechamentos", "/admin/fechamentos", ["fechamento", "periodo", "conferencia"]],
    ["payables", Banknote, "Contas a pagar", "/admin/financeiro/contas-a-pagar", ["boleto", "fornecedor", "vencimento", "pagar"]],
    ["shifts", HandCoins, "Turnos de caixa", "/admin/financeiro/turnos", ["turno", "caixa", "dinheiro", "troco", "conferencia"]],
    ["terminals", CreditCard, "Maquininhas", "/admin/financeiro/maquininhas", ["maquininha", "terminal", "cartao"]],
    ["online-payments", Link2, "Pagamentos online", "/admin/financeiro/pagamentos-online", ["link de pagamento", "picpay", "online"]],
  ];
  return entries.map(([id, icon, label, href, keywords]) => ({ id, section: "financeiro" as const, icon, label, href, keywords, visible }));
}

const sectionOrder: NavigationSectionId[] = ["principal", "catalogo", "financeiro", "comunicacao", "conta", "pdv"];

/** Entries the current user may navigate to, grouped by section and without empty sections. */
export function navigationFor(context: NavigationContext): NavigationSection[] {
  return sectionOrder.map((id) => ({
    id,
    label: sectionLabels[id](context),
    items: definitions.filter((item) => item.section === id && item.visible(context)).map((item) => resolve(item, context)),
  })).filter((section) => section.items.length > 0);
}

function resolve(item: ItemDefinition, context: NavigationContext): NavigationItem {
  const href = typeof item.href === "function" ? item.href(context) : item.href;
  const custom = item.active;
  const active = custom ? (pathname: string) => custom(pathname, context) : item.match === "exact" ? (pathname: string) => pathname === href : (pathname: string) => pathname.startsWith(href);
  return { id: item.id, section: item.section, icon: item.icon, keywords: item.keywords, external: item.external, searchOnly: item.searchOnly, label: typeof item.label === "function" ? item.label(context) : item.label, href, active };
}

export function activeSection(sections: NavigationSection[], pathname: string): NavigationSectionId | null {
  return sections.find((section) => section.items.some((item) => !item.searchOnly && item.active(pathname)))?.id ?? null;
}

const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export interface NavigationMatch { item: NavigationItem; sectionLabel: string; }

/** Screen search: names, section and keywords of the visible entries; never searches system data. */
export function searchNavigation(sections: NavigationSection[], query: string): NavigationMatch[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const all = sections.flatMap((section) => section.items.map((item) => ({ item, sectionLabel: section.label })));
  if (terms.length === 0) return all;
  return all
    .map((match) => {
      const label = normalize(match.item.label);
      const haystack = [label, normalize(match.sectionLabel), ...match.item.keywords.map(normalize)].join(" ");
      if (!terms.every((term) => haystack.includes(term))) return null;
      const score = terms.reduce((total, term) => total + (label.startsWith(term) ? 3 : label.includes(term) ? 2 : 1), 0);
      return { match, score };
    })
    .filter((entry): entry is { match: NavigationMatch; score: number } => entry !== null)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.match);
}
