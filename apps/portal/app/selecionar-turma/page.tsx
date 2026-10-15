import { redirect } from "next/navigation";
import { CohortChooser } from "@/components/layout/CohortChooser";
import { requireSession } from "@/lib/auth";
import { cohortOnlyReason, safeNextPath, screenAllowedInAll } from "@/lib/consolidated-screens";

export const dynamic = "force-dynamic";

/**
 * ADR 0011 (PR 4): a screen that works inside one cohort was opened in "Todas as turmas". The person chooses the cohort
 * explicitly and goes back to the screen; nothing of the screen is read before that.
 */
export default async function ChooseCohortPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await requireSession();
  const next = safeNextPath((await searchParams).next);
  const path = next.split("?")[0] ?? "/";
  if (user.cohortMode === "COHORT" || (user.cohortMode === "ALL" && screenAllowedInAll(path))) redirect(next);
  const cohorts = user.cohorts.filter((cohort) => cohort.status !== "ARCHIVED");
  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <p className="text-sm font-semibold text-[var(--g-brand-primary)]">Turma necessária</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Escolha a turma para continuar</h1>
          <p className="mt-2 text-base text-[var(--g-text-secondary)]">{user.cohortMode === "NONE" && screenAllowedInAll(path)
            ? "Nenhuma turma está selecionada. Escolha a turma em que vai trabalhar."
            : cohortOnlyReason(path)}</p>
        </header>
        <CohortChooser cohorts={cohorts} next={next} allowAll={user.adminMaster && screenAllowedInAll(path)} />
      </div>
    </div>
  );
}
