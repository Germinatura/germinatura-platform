import Link from "next/link";
import { ArrowRight, Bell, ShieldCheck, Store, UserRound } from "lucide-react";
import { Badge, Card } from "@germinatura/ui";
import { requireSession } from "@/lib/auth";
import { BootstrapAdminCard } from "@/components/auth/BootstrapAdminCard";

export const dynamic = "force-dynamic";

const roleLabels: Record<string, string> = {
  ADMIN: "Administrador", VENDEDOR: "Vendedor", ESTOQUE: "Estoque", FINANCEIRO: "Financeiro",
  COMUNICACAO: "Comunicação", MODERADOR: "Moderador", CONSUMIDOR: "Consumidor",
};

export default async function HomePage() {
  const user = await requireSession();
  const pdvUrl = process.env.NEXT_PUBLIC_PDV_URL ?? "http://127.0.0.1:3001";
  const canAccessPdv = user.roles.some((role) => role === "ADMIN" || role === "VENDEDOR");
  const canBootstrap = user.email === "theo.martins@institutojef.org.br" && !user.roles.includes("ADMIN");

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-[var(--g-content-standard)] space-y-8">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Sua conta</p>
            <h2 className="mt-1 text-3xl font-bold tracking-tight text-[var(--g-text-primary)]">Olá, {user.name}</h2>
            <p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Acesse os recursos disponíveis para o seu perfil e acompanhe as atividades importantes.</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Papéis do usuário">{user.roles.map((role) => <Badge key={role} tone="info">{roleLabels[role] ?? role}</Badge>)}</div>
        </header>

        {canBootstrap && <BootstrapAdminCard />}

        <section aria-labelledby="quick-actions-title">
          <div className="mb-4"><h3 id="quick-actions-title" className="text-xl font-bold text-[var(--g-text-primary)]">Comece por aqui</h3><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Atalhos disponíveis para a sua conta.</p></div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Card className="group relative overflow-hidden p-6 transition-transform hover:-translate-y-0.5">
              <span className="absolute inset-y-0 right-0 w-1 bg-[var(--g-brand-primary)]" />
              <span className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><UserRound className="size-5" /></span>
              <h4 className="mt-5 text-lg font-semibold text-[var(--g-text-primary)]">Perfil e segurança</h4>
              <p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">Mantenha sua senha protegida e revise os dados da sua conta.</p>
              <Link href="/trocar-senha" className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--g-brand-primary)]">Acessar segurança <ArrowRight className="size-4" /></Link>
            </Card>
            <Card className="relative overflow-hidden p-6">
              <span className="absolute inset-y-0 right-0 w-1 bg-[var(--g-accent-aqua)]" />
              <span className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-accent-aqua-soft)] text-[var(--g-accent-aqua-foreground)]"><Bell className="size-5" /></span>
              <h4 className="mt-5 text-lg font-semibold text-[var(--g-text-primary)]">Notificações</h4>
              <p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">As atualizações recentes ficam disponíveis no sino da barra superior.</p>
            </Card>
            {canAccessPdv && (
              <Card className="group relative overflow-hidden p-6 transition-transform hover:-translate-y-0.5">
                <span className="absolute inset-y-0 right-0 w-1 bg-[var(--g-operation-primary)]" />
                <span className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-status-success-soft)] text-[var(--g-status-success-foreground)]"><Store className="size-5" /></span>
                <h4 className="mt-5 text-lg font-semibold text-[var(--g-text-primary)]">Ponto de venda</h4>
                <p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">Entre no ambiente operacional para realizar vendas autorizadas.</p>
                <Link href={pdvUrl} className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--g-brand-primary)]">Abrir PDV <ArrowRight className="size-4" /></Link>
              </Card>
            )}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]" aria-label="Informações da conta">
          <Card className="p-6"><div className="flex items-start gap-4"><span className="flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"><ShieldCheck className="size-5" /></span><div><h3 className="text-lg font-semibold text-[var(--g-text-primary)]">Acesso protegido</h3><p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">As funcionalidades exibidas respeitam as permissões e ativações vinculadas à sua conta.</p></div></div></Card>
          <Card tone="subtle" className="p-6"><p className="text-sm font-semibold text-[var(--g-text-primary)]">Precisa de ajuda?</p><p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">Se um acesso esperado não aparecer, entre em contato com um administrador.</p></Card>
        </section>
      </div>
    </div>
  );
}
