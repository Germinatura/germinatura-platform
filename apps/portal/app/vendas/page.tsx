"use client";

import { useEffect, useState } from "react";
import {
    ShoppingBag,
    Calendar,
    Search,
    ChevronRight,
    Loader2,
    X,
    Receipt,
    Trash2,
    AlertTriangle,
    FileText
} from "lucide-react";
import Link from "next/link";
import { useToast } from "@/components/ui/Toast";
import { formatLocalDate, formatLocalTime } from "@/lib/date";

interface ItemVenda {
    id: string;
    quantidade: number;
    precoUnitario: number;
    produto: {
        nome: string;
    };
}

interface Venda {
    id: string;
    total: number;
    criadoEm: string;
    itens: ItemVenda[];
    transacao?: {
        id: string;
    };
    usuario?: {
        nome: string;
    };
}

export default function VendasPage() {
    const [vendas, setVendas] = useState<Venda[]>([]);
    const [loading, setLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [selectedVenda, setSelectedVenda] = useState<Venda | null>(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [vendaParaExcluir, setVendaParaExcluir] = useState<Venda | null>(null);
    const [confirmacaoTexto, setConfirmacaoTexto] = useState("");
    const [excluindo, setExcluindo] = useState(false);
    const { showToast } = useToast();

    const fetchVendas = async (isInitial = true) => {
        if (isInitial) {
            setLoading(true);
            setOffset(0);
            setHasMore(true);
        } else {
            setIsLoadingMore(true);
        }

        try {
            const currentOffset = isInitial ? 0 : offset;
            const res = await fetch(`/api/vendas?skip=${currentOffset}`);
            
            if (!res.ok) {
                const text = await res.text();
                console.error(`API Error (${res.status}):`, text.slice(0, 100));
                showToast(`Erro do servidor (${res.status}).`, "error");
                if (isInitial) setVendas([]);
                return;
            }

            const data = await res.json();
            const newVendas = data.transactions || [];

            if (isInitial) {
                setVendas(newVendas);
            } else {
                setVendas(prev => [...prev, ...newVendas]);
            }

            setHasMore(newVendas.length === 50);
            setOffset(currentOffset + newVendas.length);
        } catch (error) {
            console.error("Erro ao carregar vendas:", error);
            if (isInitial) setVendas([]);
        } finally {
            setLoading(false);
            setIsLoadingMore(false);
        }
    };

    useEffect(() => {
        fetchVendas(true);
    }, []);

    const filteredVendas = vendas.filter((venda: any) =>
        venda.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        venda.usuario?.nome?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        venda.itens.some((item: any) => item.produto.nome.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const handleExcluirVenda = async () => {
        if (!vendaParaExcluir) return;

        setExcluindo(true);
        try {
            const res = await fetch(`/api/vendas/${vendaParaExcluir.id}`, {
                method: "DELETE",
            });

            if (res.ok) {
                setVendas(vendas.filter((v: any) => v.id !== vendaParaExcluir.id));
                setVendaParaExcluir(null);
                setConfirmacaoTexto("");
                showToast("Venda excluída com sucesso!", "success");
            } else {
                showToast("Erro ao excluir venda", "error");
            }
        } catch (error) {
            console.error("Erro ao excluir venda:", error);
            showToast("Erro de conexão ao excluir venda", "error");
        } finally {
            setExcluindo(false);
        }
    };

    const handleScroll = (e: any) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        if (scrollHeight - scrollTop <= clientHeight + 100) {
            if (!isLoadingMore && hasMore && !loading) {
                fetchVendas(false);
            }
        }
    };
    
    const handleExport = async () => {
        setIsLoadingMore(true);
        try {
            const res = await fetch("/api/vendas?limit=none");
            if (!res.ok) throw new Error("Erro na API.");

            const data = await res.json();
            const allVendas = data.transactions || [];

            if (allVendas.length === 0) {
                showToast("Nenhuma venda para exportar", "error");
                return;
            }

            // CSV Header
            const headers = ["ID", "Data", "Vendedor", "Itens", "Total"];
            
            // CSV Rows
            const rows = allVendas.map((venda: any) => [
                venda.id,
                new Date(venda.criadoEm).toLocaleString("pt-BR"),
                venda.usuario?.nome || "Sistema",
                venda.itens.reduce((acc: any, item: any) => acc + item.quantidade, 0),
                venda.total.toFixed(2).replace(".", ",")
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
            link.setAttribute("download", `vendas_detalhadas_${new Date().toISOString().split('T')[0]}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            showToast("Relatório de vendas exportado!", "success");
        } catch (err) {
            console.error("Erro export:", err);
            showToast("Falha ao exportar.", "error");
        } finally {
            setIsLoadingMore(false);
        }
    };

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            {/* Header Content - Fixed */}
            <div className="bg-white border-b border-slate-200 p-4 md:p-8 shrink-0">
                <div className="max-w-6xl mx-auto">
                    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                        <div>
                            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">
                                Histórico de Vendas
                            </h2>
                            <p className="text-sm text-slate-500 mt-1">Acompanhe todos os pedidos realizados no PDV.</p>
                        </div>
                        <div className="flex flex-col md:flex-row gap-3">
                            <button
                                onClick={handleExport}
                                className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-6 py-2.5 rounded-lg font-semibold flex items-center gap-2 transition-all shadow-sm"
                            >
                                <FileText className="size-5" />
                                <span>Exportar Excel</span>
                            </button>
                            <Link
                                href="/pdv"
                                className="bg-primary hover:bg-primary/90 text-white px-6 py-2.5 rounded-lg font-semibold flex items-center gap-2 transition-all shadow-lg shadow-primary/20 hover:-translate-y-0.5"
                            >
                                <ShoppingBag className="size-5" />
                                <span>Nova Venda (PDV)</span>
                            </Link>
                        </div>
                    </header>

                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 size-5" />
                        <input
                            type="text"
                            placeholder="Buscar por ID, produto ou vendedor..."
                            value={searchTerm}
                            onChange={(e: any) => setSearchTerm(e.target.value)}
                            className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary outline-none transition-all"
                        />
                    </div>
                </div>
            </div>

            {/* Table Area - Full Height Scroll */}
            <div className="flex-1 overflow-hidden p-4 md:p-8 flex flex-col">
                <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div 
                        className="flex-1 overflow-auto custom-scrollbar"
                        onScroll={handleScroll}
                    >
                        <table className="w-full text-left border-collapse min-w-[800px]">
                            <thead className="sticky top-0 z-20">
                                <tr className="bg-slate-50/95 backdrop-blur-sm shadow-sm">
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">ID Venda</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Data e Hora</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Vendedor</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Itens</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Total</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-right">Ação</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filteredVendas.map((venda: any) => (
                                    <tr key={venda.id} className="hover:bg-slate-50/50 transition-colors group">
                                        <td className="px-6 py-5">
                                            <span className="font-mono text-xs font-bold text-slate-400">#{venda.id.slice(-6).toUpperCase()}</span>
                                        </td>
                                        <td className="px-6 py-5">
                                            <div className="flex flex-col">
                                                <span className="text-sm font-bold text-slate-900">
                                                    {formatLocalDate(venda.criadoEm)}
                                                </span>
                                                <span className="text-[10px] font-bold text-slate-400 uppercase">
                                                    {formatLocalTime(venda.criadoEm)}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-5">
                                            <div className="flex items-center gap-2">
                                                <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-[10px] font-black text-primary">
                                                    {venda.usuario?.nome?.[0] || "?"}
                                                </div>
                                                <span className="text-sm font-bold text-slate-700">{venda.usuario?.nome || "Sistema"}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-5">
                                            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-black uppercase bg-slate-100 text-slate-600 border border-slate-200">
                                                {venda.itens.reduce((acc: any, item: any) => acc + item.quantidade, 0)} itens
                                            </span>
                                        </td>
                                        <td className="px-6 py-5">
                                            <span className="font-medium text-emerald-500">
                                                R$ {venda.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                            </span>
                                        </td>
                                        <td className="px-6 py-5 text-right">
                                            <button
                                                onClick={() => setSelectedVenda(venda)}
                                                className="p-2 text-slate-400 hover:text-primary transition-all hover:bg-primary/5 rounded-xl group-hover:scale-110"
                                                title="Detalhes"
                                            >
                                                <ChevronRight className="size-5" />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {filteredVendas.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-20 text-center">
                                            <div className="flex flex-col items-center gap-3 opacity-20">
                                                <ShoppingBag className="size-12" />
                                                <p className="font-black uppercase tracking-widest text-sm">Nenhuma venda encontrada</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {isLoadingMore && (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-8 text-center">
                                            <div className="flex items-center justify-center gap-3">
                                                <Loader2 className="size-5 animate-spin text-primary" />
                                                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Carregando mais vendas...</span>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Details Modal */}
            {selectedVenda && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/60 backdrop-blur-sm"
                    onClick={() => setSelectedVenda(null)}
                >
                    <div
                        className="w-full max-w-md h-full bg-white shadow-2xl animate-in slide-in-from-right duration-300 flex flex-col border-l border-slate-200"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                            <div>
                                <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Venda</h3>
                                <p className="text-[10px] font-black text-slate-400 mt-1 uppercase tracking-widest">ID: {selectedVenda.id}</p>
                            </div>
                            <button
                                onClick={() => setSelectedVenda(null)}
                                className="p-2 rounded-xl hover:bg-slate-200 text-slate-500 transition-colors"
                            >
                                <X className="size-6" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                            <div className="space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                                    <Receipt className="size-4" />
                                    Itens do Pedido
                                </h4>
                                <div className="space-y-3">
                                    {selectedVenda.itens.map((item: any) => (
                                        <div key={item.id} className="flex justify-between items-center p-4 rounded-2xl bg-slate-50 border border-slate-100 hover:border-primary/20 transition-all">
                                            <div className="flex flex-col">
                                                <span className="font-black text-slate-900 uppercase">
                                                    {item.produto.produtoPai?.nome || item.produto.nome}
                                                </span>
                                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                                    {item.produto.produtoPai && <span className="text-slate-500 mr-1.5">{item.produto.nome} •</span>}
                                                    {item.quantidade}x R$ {item.precoUnitario.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                </span>
                                            </div>
                                            <span className="font-black text-slate-900">
                                                R$ {(item.quantidade * item.precoUnitario).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="pt-8 border-t-2 border-dashed border-slate-100">
                                <div className="space-y-4">
                                    <div className="flex justify-between items-center">
                                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subtotal</span>
                                        <span className="font-bold text-slate-600">R$ {selectedVenda.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                                    </div>
                                    <div className="flex justify-between items-center p-6 bg-slate-900 rounded-2xl shadow-xl shadow-slate-200">
                                        <span className="text-xs font-black text-white uppercase tracking-[0.2em]">Total</span>
                                        <span className="text-2xl font-medium text-emerald-400">R$ {selectedVenda.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="p-6 rounded-2xl bg-slate-50 border border-slate-100 space-y-4">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Informações</p>
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-1">
                                        <p className="text-[10px] font-bold text-slate-400">DATA</p>
                                        <p className="text-sm font-black text-slate-900">{formatLocalDate(selectedVenda.criadoEm)}</p>
                                    </div>
                                    <div className="space-y-1">
                                        <p className="text-[10px] font-bold text-slate-400">VENDEDOR</p>
                                        <p className="text-sm font-black text-slate-900">{selectedVenda.usuario?.nome || "Sistema"}</p>
                                    </div>
                                    <div className="col-span-2 space-y-1">
                                        <p className="text-[10px] font-bold text-slate-400">STATUS</p>
                                        <p className="text-sm font-black text-emerald-500 uppercase flex items-center gap-2">
                                            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                                            Pagamento Concluído
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="p-8 border-t border-slate-100 space-y-3 shrink-0">
                            <button
                                onClick={() => {
                                    setVendaParaExcluir(selectedVenda);
                                    setConfirmacaoTexto("");
                                }}
                                className="w-full py-4 text-rose-500 font-black rounded-2xl hover:bg-rose-50 transition-all border-2 border-rose-100 flex items-center justify-center gap-2 uppercase tracking-widest text-xs"
                            >
                                <Trash2 className="size-5" />
                                Excluir Registro
                            </button>
                            <button
                                onClick={() => setSelectedVenda(null)}
                                className="w-full py-4 text-slate-500 font-bold rounded-2xl hover:bg-slate-100 transition-all border-2 border-slate-100 uppercase tracking-widest text-xs"
                            >
                                Fechar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation */}
            {vendaParaExcluir && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/70 backdrop-blur-md p-4">
                    <div className="w-full max-w-md bg-white rounded-[2.5rem] shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden border-4 border-white">
                        <div className="p-10 text-center space-y-8">
                            <div className="size-24 bg-rose-50 text-rose-500 rounded-[2.5rem] flex items-center justify-center mx-auto shadow-inner">
                                <AlertTriangle className="size-12" />
                            </div>

                            <div className="space-y-2">
                                <h3 className="text-3xl font-black text-slate-900 uppercase tracking-tight">Cuidado!</h3>
                                <p className="text-sm text-slate-500 font-medium">Esta ação removerá permanentemente os dados desta venda.</p>
                            </div>

                            <div className="bg-slate-50 p-6 rounded-3xl border border-slate-200 text-left space-y-3">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Confirme com a frase (ignorando maiúsculas e minúsculas):</p>
                                <p className="font-mono text-xs font-bold text-rose-600 bg-white p-4 rounded-xl border-2 border-rose-100 text-center select-all shadow-sm">
                                    excluir venda de {vendaParaExcluir.usuario?.nome || "Sistema"}
                                </p>
                            </div>

                            <input
                                type="text"
                                autoFocus
                                value={confirmacaoTexto}
                                onChange={(e: any) => setConfirmacaoTexto(e.target.value)}
                                placeholder="Digite aqui..."
                                className="w-full px-6 py-5 bg-slate-50 border-2 border-slate-200 focus:border-rose-500 rounded-2xl outline-none transition-all text-center font-black text-slate-900 tracking-widest text-xs"
                            />

                            <div className="flex gap-4">
                                <button
                                    onClick={() => {
                                        setVendaParaExcluir(null);
                                        setConfirmacaoTexto("");
                                    }}
                                    className="flex-1 py-5 text-slate-400 font-black rounded-3xl hover:bg-slate-50 transition-all active:scale-95 uppercase tracking-widest text-xs"
                                >
                                    Voltar
                                </button>
                                <button
                                    disabled={confirmacaoTexto.toLowerCase().trim() !== `excluir venda de ${vendaParaExcluir.usuario?.nome || "Sistema"}`.toLowerCase().trim() || excluindo}
                                    onClick={async () => {
                                        await handleExcluirVenda();
                                        setSelectedVenda(null);
                                    }}
                                    className="flex-[1.8] py-5 bg-rose-500 hover:bg-rose-600 disabled:opacity-30 disabled:grayscale text-white font-black rounded-3xl transition-all shadow-xl shadow-rose-200 flex items-center justify-center gap-2 active:scale-95 uppercase tracking-widest text-xs"
                                >
                                    {excluindo ? (
                                        <Loader2 className="size-5 animate-spin" />
                                    ) : (
                                        <>
                                            <Trash2 className="size-5" />
                                            Excluir
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
