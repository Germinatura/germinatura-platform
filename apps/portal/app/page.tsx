"use client";

import { useEffect, useState } from "react";
import {
  Wallet,
  PiggyBank,
  ShoppingCart,
  Search,
  Bell,
  Settings,
  TrendingUp,
  Loader2,
  Pencil,
  Check,
  X as CloseIcon
} from "lucide-react";
import { KPICard } from "@/components/ui/KPICard";
import { TransactionTable } from "@/components/ui/TransactionTable";
import { useToast } from "@/components/ui/Toast";
import { formatCustomDate } from "@/lib/date";
import { LineChart, Line, Tooltip, ResponsiveContainer, XAxis } from "recharts";

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const val = payload[0].value;
    return (
      <div className="bg-white text-slate-900 text-xs font-bold px-4 py-3 rounded-xl shadow-lg border border-slate-200">
        <p className="text-slate-500 mb-1">{label}</p>
        <p className={`text-sm ${val >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
          Lucro: R$ {val.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
        </p>
      </div>
    );
  }
  return null;
};

export default function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [newMeta, setNewMeta] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);
  const [user, setUser] = useState<any>(null);
  const { showToast } = useToast();

  const fetchDashboardData = async () => {
    try {
      // Busca dados do dashboard e perfil do usuário em paralelo
      const [dashRes, userRes] = await Promise.all([
        fetch("/api/dashboard"),
        fetch("/api/auth/me")
      ]);

      const dashJson = await dashRes.json();
      const userJson = await userRes.json();

      if (!dashRes.ok) throw new Error(dashJson.error || "Erro ao carregar dashboard");

      setData(dashJson);
      setNewMeta(dashJson.meta?.toString() || "60000");
      
      if (userRes.ok) {
        setUser(userJson.user);
      }
    } catch (err) {
      console.error("Erro ao carregar dashboard:", err);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleUpdateMeta = async () => {
    const valorMeta = parseFloat(newMeta.replace(",", "."));

    if (isNaN(valorMeta) || valorMeta <= 0) {
      showToast("Por favor, insira um valor válido para a meta.", "warning");
      return;
    }

    setSavingMeta(true);
    try {
      const res = await fetch("/api/configuracoes/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valor: valorMeta })
      });

      if (res.ok) {
        setIsEditingMeta(false);
        showToast("Meta atualizada com sucesso!", "success");
        fetchDashboardData();
      } else {
        const json = await res.json();
        showToast(json.error || "Erro ao atualizar meta", "error");
      }
    } catch (err) {
      console.error("Erro ao atualizar meta:", err);
      showToast("Erro de conexão ao atualizar meta", "error");
    } finally {
      setSavingMeta(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!data) return <div className="p-8 text-center text-red-500">Erro ao carregar dados do dashboard.</div>;

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
      {/* Header Area - Fixed */}
      <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-4 md:px-8 shrink-0 z-10 transition-all duration-300">
        <div className="flex items-center gap-4">
          <h2 className="text-lg md:text-xl font-black tracking-tight text-slate-900 uppercase">Dashboard</h2>
          {/* <span className="hidden xs:inline-block bg-primary text-white border-2 border-primary/20 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-lg shadow-primary/20">
            Admin
          </span> */}
        </div>

        <div className="flex items-center gap-2 md:gap-4">
          <div className="relative hidden lg:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 size-4" />
            <input
              className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold focus:ring-2 focus:ring-primary w-64 outline-none transition-all"
              placeholder="Pesquisar..."
              type="text"
            />
          </div>
          <button className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors">
            <Bell className="size-5" />
          </button>
          <button className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors">
            <Settings className="size-5" />
          </button>
        </div>
      </header>

      {/* Main Content - Scrollable */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 custom-scrollbar">
        <div className="max-w-6xl mx-auto space-y-8">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <KPICard
              label="Saldo Atual"
              value={`R$ ${(data.saldoAtual ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`}
              variant="success"
              icon={Wallet}
              trend={{ value: "Saldo consolidado", isUp: true }}
            />
            <KPICard
              label="Total Arrecadado"
              value={`R$ ${(data.totalArrecadado ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`}
              variant="success"
              icon={PiggyBank}
              subtext="Entradas totais no sistema"
            />
            <KPICard
              label="Total Gasto"
              value={`R$ ${(data.totalGasto ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`}
              variant="danger"
              icon={ShoppingCart}
              subtext="Saídas totais registradas"
            />
          </div>

          {/* Lucro Semanal & Meta da Formatura */}
          <div className="flex flex-col gap-6 mb-8">

            {/* Goal Progress */}
            <div className="w-full bg-white p-8 rounded-3xl border border-slate-200 shadow-sm relative overflow-hidden group flex flex-col justify-center">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-black text-xl text-slate-900 uppercase tracking-tight">Meta da Formatura</h4>
                    {user?.perfil === "ADMIN" && (
                      <button
                        onClick={() => setIsEditingMeta(true)}
                        className="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/5 rounded-lg transition-all"
                        title="Editar Meta"
                      >
                        <Pencil className="size-4" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm border-l-2 border-primary/30 pl-3 mt-1 text-slate-500 font-medium">Progresso de arrecadação dos alunos</p>
                </div>
                <div className="text-right">
                  <span className="text-4xl font-black text-primary">
                    {Math.min(100, Math.max(0, Math.round(((data.saldoAtual || 0) / (data.meta || 60000)) * 100)))}%
                  </span>
                  <span className="text-xs font-bold text-slate-400 ml-1 uppercase tracking-widest">Saldo Atual</span>
                </div>
              </div>

              <div className="w-full bg-slate-100 h-6 rounded-2xl overflow-hidden p-1.5 border border-slate-50">
                <div
                  className="bg-primary h-full rounded-xl transition-all duration-1000 ease-out shadow-lg shadow-primary/30 relative"
                  style={{ width: `${Math.min(100, Math.max(0, ((data.saldoAtual || 0) / (data.meta || 60000)) * 100))}%` }}
                >
                  <div className="absolute inset-0 bg-white/20 animate-pulse" />
                </div>
              </div>

              <div className="flex justify-between mt-4">
                <div className="flex flex-col">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Atual</span>
                  <span className="text-slate-900 border-l-2 border-emerald-500 pl-2">R$ {(data.saldoAtual ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex flex-col text-right">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Objetivo</span>
                  <span className="text-slate-500">R$ {(data.meta ?? 60000).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

              {/* Edit Meta Overlay */}
              {isEditingMeta && (
                <div className="absolute inset-0 bg-white/95 backdrop-blur-md z-20 flex items-center justify-center p-6 animate-in fade-in zoom-in-95 duration-200">
                  <div className="w-full max-w-xs space-y-6">
                    <div className="text-center">
                      <h5 className="font-black text-xl text-slate-900 uppercase tracking-tight leading-none mb-1">Editar Meta</h5>
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Defina o novo objetivo</p>
                    </div>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-black">R$</span>
                      <input
                        autoFocus
                        type="number"
                        value={newMeta}
                        onChange={(e: any) => setNewMeta(e.target.value)}
                        className="w-full pl-12 pr-4 py-4 bg-slate-50 border-2 border-slate-100 focus:border-primary rounded-2xl font-black text-xl text-slate-900 outline-none transition-all"
                      />
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={() => {
                          setIsEditingMeta(false);
                          setNewMeta(data.meta.toString());
                        }}
                        className="flex-1 py-4 text-slate-500 font-bold rounded-2xl hover:bg-slate-50 transition-all active:scale-95"
                      >
                        Cancelar
                      </button>
                      <button
                        disabled={savingMeta}
                        onClick={handleUpdateMeta}
                        className="flex-1 py-4 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 transition-all shadow-xl shadow-primary/20 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                      >
                        {savingMeta ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
                        SALVAR
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Lucro Semanal */}
            <div className="w-full flex flex-col bg-white rounded-3xl p-6 md:p-8 relative overflow-hidden group shadow-sm border border-slate-200">
              <div className="flex justify-between items-start mb-6 relative z-10">
                <div>
                  <span className="text-slate-400 text-xs font-bold tracking-[0.2em] uppercase">Lucro Semanal</span>
                  <h3 className="text-3xl font-black text-slate-900 mt-1">
                    R$ {((data.lucrosNasSemanas?.[data.lucrosNasSemanas.length - 1]?.lucro) ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                  </h3>
                </div>
                <div className="size-12 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
                  <TrendingUp className="size-6" />
                </div>
              </div>

              <div className="w-full h-[160px] mt-auto -mx-2 mb-[-10px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.lucrosNasSemanas || []}>
                    <XAxis dataKey="semana" hide />
                    <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(0,0,0,0.05)', strokeWidth: 2 }} />
                    <Line
                      type="monotone"
                      dataKey="lucro"
                      stroke="#10b981"
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 6, fill: "#10b981", stroke: "#ffffff", strokeWidth: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Transactions Table */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-50 flex items-center justify-between">
              <h4 className="font-black text-lg text-slate-900 uppercase tracking-tight">Transações Recentes</h4>
              <TrendingUp className="size-5 text-primary" />
            </div>
            <TransactionTable
              transactions={(data?.transacoesRecentes || []).map((t: any) => ({
                ...t,
                data: formatCustomDate(t.data, { day: "2-digit", month: "short", year: "numeric" })
              }))}
            />
          </div>

          <footer className="py-8 text-center">
            <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.2em]">
              © 2026 Comissão de Formatura • Germinatura
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
