"use client";

import { useEffect, useState } from "react";
import {
    Search,
    Calendar,
    Filter,
    TrendingUp,
    TrendingDown,
    User as UserIcon,
    Loader2,
    FileText
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { formatLocalDate } from "@/lib/date";

interface Transaction {
    id: string;
    data: string;
    descricao: string;
    tipo: "ENTRADA" | "SAIDA";
    valor: number;
    categoria: string;
    usuario?: {
        nome: string;
    };
}

interface User {
    id: string;
    nome: string;
}

export default function TransacoesPage() {
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [totals, setTotals] = useState({ entrada: 0, saida: 0 });
    const [filters, setFilters] = useState({
        startDate: "",
        endDate: "",
        usuarioId: "",
        tipo: ""
    });
    const { showToast } = useToast();

    const fetchUsers = async () => {
        try {
            const res = await fetch("/api/usuarios");
            if (res.ok) {
                const data = await res.json();
                setUsers(data);
            }
        } catch (err) {
            console.error("Erro ao carregar usuários:", err);
        }
    };

    const fetchTransactions = async (isInitial = true) => {
        if (isInitial) {
            setLoading(true);
            setOffset(0);
            setHasMore(true);
        } else {
            setIsLoadingMore(true);
        }

        try {
            const currentOffset = isInitial ? 0 : offset;
            const params = new URLSearchParams();
            if (filters.startDate) params.append("startDate", filters.startDate);
            if (filters.endDate) params.append("endDate", filters.endDate);
            if (filters.usuarioId) params.append("usuarioId", filters.usuarioId);
            if (filters.tipo) params.append("tipo", filters.tipo);
            params.append("skip", currentOffset.toString());

            const res = await fetch(`/api/transacoes?${params.toString()}`);
            if (res.ok) {
                const data = await res.json();
                
                if (isInitial) {
                    setTransactions(data.transactions);
                    setTotals(data.totals);
                } else {
                    setTransactions(prev => [...prev, ...data.transactions]);
                }

                setHasMore(data.transactions.length === 50);
                setOffset(currentOffset + data.transactions.length);
            } else {
                const text = await res.text();
                console.error(`API Error (${res.status}):`, text.slice(0, 100));
                showToast(`Erro ao carregar transações (${res.status}).`, "error");
            }
        } catch (err) {
            console.error("Erro ao carregar transações:", err);
            showToast("Erro de conexão.", "error");
        } finally {
            setLoading(false);
            setIsLoadingMore(false);
        }
    };

    const handleExport = async () => {
        setIsLoadingMore(true);
        try {
            const params = new URLSearchParams();
            if (filters.startDate) params.append("startDate", filters.startDate);
            if (filters.endDate) params.append("endDate", filters.endDate);
            if (filters.usuarioId) params.append("usuarioId", filters.usuarioId);
            if (filters.tipo) params.append("tipo", filters.tipo);
            params.append("limit", "none");

            const res = await fetch(`/api/transacoes?${params.toString()}`);
            if (!res.ok) throw new Error("Erro ao carregar dados para exportação");
            
            const data = await res.json();
            const allTransactions = data.transactions;

            if (allTransactions.length === 0) {
                showToast("Nenhuma transação para exportar", "error");
                return;
            }

            // CSV Header
            const headers = ["Data", "Descrição", "Categoria", "Responsável", "Tipo", "Valor"];
            
            // CSV Rows
            const rows = allTransactions.map((t: any) => [
                new Date(t.data).toLocaleString("pt-BR"),
                t.descricao,
                t.categoria,
                t.usuario?.nome || "Sistema",
                t.tipo === "ENTRADA" ? "Entrada" : "Saída",
                t.valor.toFixed(2).replace(".", ",")
            ]);

            // Combine
            const csvContent = [
                headers.join(";"),
                ...rows.map((row: any) => row.join(";"))
            ].join("\n");

            // Download
            const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", `transacoes_gerais_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            showToast("Relatório geral exportado com sucesso!", "success");
        } catch (err) {
            console.error("Erro ao exportar:", err);
            showToast("Erro ao gerar relatório.", "error");
        } finally {
            setIsLoadingMore(false);
        }
    };

    useEffect(() => {
        fetchUsers();
        fetchTransactions();
    }, []);

    const handleApplyFilters = () => {
        fetchTransactions(true);
    };

    const handleScroll = (e: any) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        // Se estiver chegando perto do fim (100px de margem)
        if (scrollHeight - scrollTop <= clientHeight + 100) {
            if (!isLoadingMore && hasMore && !loading) {
                fetchTransactions(false);
            }
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            {/* Header / Filter Area */}
            <div className="bg-white border-b border-slate-200 p-3 md:p-8 shrink-0 relative z-30">
                <div className="max-w-6xl mx-auto">
                    <header className="mb-4 md:mb-8">
                        <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 uppercase">
                            Transações
                        </h2>
                        <p className="text-sm text-slate-500 mt-1">Histórico completo de movimentações financeiras.</p>
                    </header>

                    {/* Summary Cards */}
                    <div className="grid grid-cols-2 gap-2 md:gap-4 mb-4 md:mb-8">
                        <div className="bg-slate-50 p-3 md:p-5 rounded-2xl border border-slate-100 flex items-center gap-2 md:gap-5">
                            <div className="size-10 md:size-12 rounded-xl bg-emerald-500 text-white flex items-center justify-center shadow-lg shadow-emerald-200 shrink-0">
                                <TrendingUp className="size-5 md:size-6" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-widest md:tracking-[0.2em] truncate">Arrecadado</p>
                                <p className="text-base md:text-2xl font-black text-slate-900 truncate">
                                    R$ {totals.entrada.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                </p>
                            </div>
                        </div>
                        <div className="bg-slate-50 p-3 md:p-5 rounded-2xl border border-slate-100 flex items-center gap-2 md:gap-5">
                            <div className="size-10 md:size-12 rounded-xl bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-200 shrink-0">
                                <TrendingDown className="size-5 md:size-6" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-widest md:tracking-[0.2em] truncate">Gasto</p>
                                <p className="text-base md:text-2xl font-black text-slate-900 truncate">
                                    R$ {totals.saida.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 md:gap-4 items-end">
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] px-1 flex items-center gap-2">
                                <Calendar className="size-3" /> Data Início
                            </label>
                            <input
                                type="date"
                                value={filters.startDate}
                                onChange={(e: any) => setFilters({ ...filters, startDate: e.target.value })}
                                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-primary outline-none transition-all"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] px-1 flex items-center gap-2">
                                <Calendar className="size-3" /> Data Fim
                            </label>
                            <input
                                type="date"
                                value={filters.endDate}
                                onChange={(e: any) => setFilters({ ...filters, endDate: e.target.value })}
                                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-primary outline-none transition-all"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] px-1 flex items-center gap-2">
                                <UserIcon className="size-3" /> Responsável
                            </label>
                            <select
                                value={filters.usuarioId}
                                onChange={(e: any) => setFilters({ ...filters, usuarioId: e.target.value })}
                                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-primary outline-none transition-all cursor-pointer appearance-none"
                            >
                                <option value="">Todos os usuários</option>
                                {users.map((u: any) => (
                                    <option key={u.id} value={u.id}>{u.nome}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] px-1 flex items-center gap-2">
                                <Filter className="size-3" /> Tipo
                            </label>
                            <select
                                value={filters.tipo}
                                onChange={(e: any) => setFilters({ ...filters, tipo: e.target.value })}
                                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-primary outline-none transition-all cursor-pointer appearance-none"
                            >
                                <option value="">Todos</option>
                                <option value="ENTRADA">Entrada</option>
                                <option value="SAIDA">Saída</option>
                            </select>
                        </div>
                        <button
                            onClick={handleExport}
                            className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-black py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 active:scale-95 shadow-sm uppercase tracking-widest text-xs"
                        >
                            <FileText className="size-4" />
                            Exportar Excel
                        </button>
                        <button
                            onClick={handleApplyFilters}
                            className="bg-slate-900 hover:bg-black text-white font-black py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 active:scale-95 shadow-xl shadow-slate-200 uppercase tracking-widest text-xs"
                        >
                            <Filter className="size-4" />
                            Filtrar
                        </button>
                    </div>
                </div>
            </div>

            {/* Table Area - Full Height Scroll */}
            <div className="flex-1 overflow-hidden p-3 md:p-8 flex flex-col">
                <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div 
                        className="flex-1 overflow-auto custom-scrollbar"
                        onScroll={handleScroll}
                    >
                        <table className="w-full text-left border-collapse min-w-[800px]">
                            <thead className="sticky top-0 z-20">
                                <tr className="bg-slate-50/95 backdrop-blur-sm shadow-sm">
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Data</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Descrição / Categoria</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Responsável</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-center">Tipo</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-right">Valor</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {loading ? (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-20 text-center text-slate-400">
                                            <div className="flex flex-col items-center gap-4">
                                                <Loader2 className="size-10 animate-spin text-primary" />
                                                <p className="font-black uppercase tracking-widest text-xs">Atualizando dados...</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : transactions.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-20 text-center">
                                            <div className="flex flex-col items-center gap-4 opacity-20">
                                                <Search className="size-16" />
                                                <p className="font-black uppercase tracking-[0.2em] text-sm">Nada por aqui</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : (
                                    transactions.map((t: any) => (
                                        <tr key={t.id} className="hover:bg-slate-50/50 transition-colors group">
                                            <td className="px-6 py-5 whitespace-nowrap">
                                                <span className="text-sm font-black text-slate-900">
                                                    {formatLocalDate(t.data)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-5">
                                                <div className="flex flex-col">
                                                    <span className="text-sm font-bold text-slate-900 group-hover:text-primary transition-colors">{t.descricao}</span>
                                                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-0.5">{t.categoria}</span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5">
                                                <div className="flex items-center gap-3">
                                                    <div className="size-8 rounded-lg bg-slate-100 flex items-center justify-center text-[10px] font-black text-slate-500">
                                                        {t.usuario?.nome?.[0] || "?"}
                                                    </div>
                                                    <span className="text-sm font-bold text-slate-700">{t.usuario?.nome || "Sistema"}</span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5 text-center">
                                                <span className={`inline-block px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${t.tipo === "ENTRADA"
                                                    ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                                                    : "bg-rose-100 text-rose-700 border border-rose-200"
                                                    }`}>
                                                    {t.tipo === "ENTRADA" ? "Entrada" : "Saída"}
                                                </span>
                                            </td>
                                            <td className={`px-6 py-5 text-right font-black text-sm whitespace-nowrap ${t.tipo === "ENTRADA" ? "text-emerald-500" : "text-rose-500"
                                                }`}>
                                                {t.tipo === "ENTRADA" ? "+" : "-"} R$ {t.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                            </td>
                                        </tr>
                                    ))
                                )}
                                {isLoadingMore && (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-8 text-center">
                                            <div className="flex items-center justify-center gap-3">
                                                <Loader2 className="size-5 animate-spin text-primary" />
                                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Carregando mais...</span>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
