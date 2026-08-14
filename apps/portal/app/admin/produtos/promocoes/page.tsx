"use client";

import { useEffect, useState } from "react";
import {
    Plus,
    Tag,
    History,
    Calendar,
    Percent,
    Layers,
    Loader2,
    Check,
    X,
    Filter,
    ChevronRight,
    Eye,
    EyeOff,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { formatLocalDate } from "@/lib/date";

interface Promotion {
    id: string;
    produtoId: string;
    tipo: "VALOR" | "QUANTIDADE" | "COMBO_MIX" | "GRUPO" | "COMBO";
    valorDesconto: number;
    quantidadeMinima?: number;
    dataInicio: string;
    dataFim: string;
    ativo: boolean;
    produtos?: { nome: string }[];
}

interface Product {
    id: string;
    nome: string;
    preco: number;
    ativo: boolean;
    produtoPaiId?: string | null;
    isGroup?: boolean;
}

export default function GestaoPromocoes() {
    const [promotions, setPromotions] = useState<Promotion[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [showInactive, setShowInactive] = useState(false);

    const [newPromo, setNewPromo] = useState({
        produtoId: "",
        tipo: "VALOR" as "VALOR" | "QUANTIDADE" | "COMBO_MIX" | "GRUPO",
        valorDesconto: "",
        quantidadeMinima: "2",
        dataInicio: new Date().toISOString().split("T")[0],
        dataFim: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        itensCombo: [] as {produtoId: string, quantidade: number}[],
        comboName: "",
        imagemUrl: ""
    });

    const [reactivatePromo, setReactivatePromo] = useState<Promotion | null>(null);
    const [reactivateDates, setReactivateDates] = useState({
        dataInicio: new Date().toISOString().split("T")[0],
        dataFim: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    });

    const { showToast } = useToast();

    const loadData = async () => {
        setLoading(true);
        try {
            const [promoRes, prodRes] = await Promise.all([
                fetch("/api/admin/promocoes"),
                fetch("/api/produtos?adminView=true")
            ]);
            const promos = await promoRes.json();
            const prods = await prodRes.json();
            setPromotions(promos);
            // Filtrar apenas base (exceto promo fake)
            setProducts(prods.filter((p: any) => !p.isPromocional));
        } catch (err) {
            console.error("Erro ao carregar dados:", err);
            showToast("Erro ao carregar dados da página.", "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newPromo.tipo !== "COMBO_MIX" && !newPromo.produtoId) {
            showToast("Preencha o campo produto.", "warning");
            return;
        }
        if (!newPromo.valorDesconto) {
            showToast("Preencha o valor de desconto/combo.", "warning");
            return;
        }
        if (newPromo.tipo === "COMBO_MIX" && newPromo.itensCombo.length === 0) {
            showToast("O Combo Mix precisa de pelo menos 1 item.", "warning");
            return;
        }

        setIsSaving(true);
        try {
            const response = await fetch("/api/admin/promocoes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...newPromo,
                    valorDesconto: newPromo.valorDesconto.replace(",", "."),
                })
            });

            if (response.ok) {
                setIsModalOpen(false);
                setNewPromo({
                    ...newPromo,
                    produtoId: "",
                    valorDesconto: "",
                    itensCombo: [],
                    comboName: "",
                    imagemUrl: ""
                });
                loadData();
                showToast("Promoção cadastrada com sucesso!", "success");
            } else {
                const err = await response.json();
                showToast(err.error || "Erro ao cadastrar promoção.", "error");
            }
        } catch (error) {
            console.error("Erro ao salvar:", error);
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const toggleStatus = async (promo: Promotion) => {
        const currentStatus = promo.ativo;
        if (!currentStatus) {
            // It is inactive and being activated -> Request new dates
            setReactivateDates({
                dataInicio: new Date().toISOString().split("T")[0],
                dataFim: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
            });
            setReactivatePromo(promo);
            return;
        }

        // Deactivating
        try {
            const response = await fetch(`/api/admin/promocoes/${promo.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ativo: false })
            });

            if (response.ok) {
                setPromotions(promotions.map(p => p.id === promo.id ? { ...p, ativo: false } : p));
                showToast("Promoção inativada com sucesso!", "success");
            } else {
                showToast("Erro ao inativar promoção.", "error");
            }
        } catch (error) {
            showToast("Erro de conexão.", "error");
        }
    };

    const confirmReactivate = async () => {
        if (!reactivatePromo) return;
        setIsSaving(true);
        try {
            const response = await fetch(`/api/admin/promocoes/${reactivatePromo.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    ativo: true,
                    dataInicio: reactivateDates.dataInicio,
                    dataFim: reactivateDates.dataFim
                })
            });

            if (response.ok) {
                setPromotions(promotions.map(p => p.id === reactivatePromo.id ? { 
                    ...p, 
                    ativo: true,
                    dataInicio: new Date(reactivateDates.dataInicio).toISOString(),
                    dataFim: new Date(reactivateDates.dataFim).toISOString()
                } : p));
                showToast("Promoção ativada com sucesso!", "success");
                setReactivatePromo(null);
            } else {
                showToast("Erro ao ativar promoção.", "error");
            }
        } catch (error) {
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const deletePromotion = async (id: string) => {
        if (!confirm("Tem certeza que deseja excluir esta promoção? Produtos temporários associados também serão removidos.")) return;

        try {
            const response = await fetch(`/api/admin/promocoes/${id}`, {
                method: "DELETE"
            });
            if (response.ok) {
                setPromotions(promotions.filter(p => p.id !== id));
                showToast("Promoção excluída com sucesso!", "success");
            } else {
                showToast("Erro ao excluir promoção.", "error");
            }
        } catch (error) {
            showToast("Erro de conexão.", "error");
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
            {/* Header Content */}
            <div className="bg-white border-b border-slate-200 p-4 md:p-8 shrink-0">
                <div className="max-w-6xl mx-auto">
                    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                        <div>
                            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">Promoções & Combos</h2>
                            <p className="text-sm text-slate-500 mt-1">Configure descontos por valor ou crie combos por quantidade.</p>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setShowInactive(!showInactive)}
                                className={`p-2.5 rounded-lg border transition-all flex items-center gap-2 ${showInactive ? 'bg-primary/10 border-primary/20 text-primary' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                                title={showInactive ? "Ocultar inativos" : "Mostrar inativos"}
                            >
                                {showInactive ? <Eye className="size-5" /> : <EyeOff className="size-5" />}
                                <span className="text-sm font-bold hidden md:inline">{showInactive ? "Ver Todos" : "Apenas Ativos"}</span>
                            </button>
                            <button
                                onClick={() => setIsModalOpen(true)}
                                className="bg-primary hover:bg-primary/90 text-white px-6 py-2.5 rounded-lg font-semibold flex items-center gap-2 transition-all shadow-lg shadow-primary/20 hover:-translate-y-0.5"
                            >
                                <Plus className="size-5" />
                                <span>Nova Promoção</span>
                            </button>
                        </div>
                    </header>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ativas</span>
                            <span className="text-2xl font-black text-emerald-500">{promotions.filter(p => p.ativo).length}</span>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Histórico</span>
                            <span className="text-2xl font-black text-slate-900">{promotions.length}</span>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tipos</span>
                            <div className="flex gap-2">
                                <Percent className="size-4 text-blue-500" />
                                <Layers className="size-4 text-orange-500" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Table Area */}
            <div className="flex-1 overflow-hidden p-4 md:p-8 flex flex-col">
                <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="flex-1 overflow-auto custom-scrollbar">
                        <table className="w-full text-left border-collapse min-w-[900px]">
                            <thead className="sticky top-0 z-20">
                                <tr className="bg-slate-50/95 backdrop-blur-sm shadow-sm">
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Produto</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Tipo</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Detalhes</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Vigência</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Status</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {promotions
                                    .filter(p => showInactive ? true : p.ativo)
                                    .map((promo) => {
                                    const now = new Date();
                                    const isExpired = new Date(promo.dataFim) < now;
                                    const isFuture = new Date(promo.dataInicio) > now;
                                    const prodNome = products.find(p => p.id === promo.produtoId)?.nome || "Produto Removido";

                                    return (
                                        <tr key={promo.id} className="hover:bg-slate-50/50 transition-colors group">
                                            <td className="px-6 py-5">
                                                <div className="flex items-center gap-3">
                                                    <div className={`p-2 rounded-lg shrink-0 ${promo.tipo === "VALOR" ? "bg-blue-50 text-blue-600" : "bg-orange-50 text-orange-600"}`}>
                                                        {promo.tipo === "VALOR" ? <Percent className="size-4" /> : <Layers className="size-4" />}
                                                    </div>
                                                    <div className="flex flex-col">
                                                        {(() => {
                                                            if (promo.tipo === "COMBO_MIX" && promo.produtos && promo.produtos.length > 0) {
                                                                return (
                                                                    <span className="font-black text-purple-900 uppercase text-sm">
                                                                        {promo.produtos[0].nome}
                                                                    </span>
                                                                );
                                                            }
                                                            
                                                            const prod = products.find(p => p.id === promo.produtoId);
                                                            const grupoPai = prod?.produtoPaiId ? products.find(p => p.id === prod.produtoPaiId) : null;
                                                            return (
                                                                <>
                                                                    <span className="font-black text-slate-900 uppercase text-sm">
                                                                        {grupoPai?.nome || prod?.nome || "Produto Removido"}
                                                                    </span>
                                                                    {grupoPai && (
                                                                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                                                            {prod?.nome}
                                                                        </span>
                                                                    )}
                                                                </>
                                                            );
                                                        })()}
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5">
                                                <span className={`whitespace-nowrap text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md ${
                                                    promo.tipo === "VALOR" ? "bg-blue-100 text-blue-700" : 
                                                    promo.tipo === "COMBO_MIX" ? "bg-purple-100 text-purple-700" :
                                                    "bg-orange-100 text-orange-700"
                                                }`}>
                                                    {promo.tipo === "VALOR" ? "Desconto %" : promo.tipo === "COMBO_MIX" ? "Combo Mix" : "Combo Qtd"}
                                                </span>
                                            </td>
                                            <td className="px-6 py-5">
                                                {promo.tipo === "VALOR" ? (
                                                    <span className="font-bold text-slate-700">{promo.valorDesconto}% de desconto</span>
                                                ) : (
                                                    <span className="font-bold text-slate-700">{promo.quantidadeMinima} un. por R$ {promo.valorDesconto.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                                                )}
                                            </td>
                                            <td className="px-6 py-5">
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-xs font-bold text-slate-600 flex items-center gap-1 whitespace-nowrap">
                                                        <Calendar className="size-3 shrink-0" />
                                                        {formatLocalDate(promo.dataInicio)} - {formatLocalDate(promo.dataFim)}
                                                    </span>
                                                    {isExpired ? (
                                                        <span className="text-[9px] font-black text-rose-500 uppercase tracking-tighter">Expirada</span>
                                                    ) : isFuture ? (
                                                        <span className="text-[9px] font-black text-amber-500 uppercase tracking-tighter">Agendada</span>
                                                    ) : (
                                                        <span className="text-[9px] font-black text-emerald-500 uppercase tracking-tighter">Em Vigor</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-6 py-5">
                                                <div className="flex items-center gap-3">
                                                    <button
                                                        onClick={() => toggleStatus(promo)}
                                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${promo.ativo ? "bg-primary" : "bg-slate-200"}`}
                                                    >
                                                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-all ${promo.ativo ? "translate-x-5" : "translate-x-1"}`} />
                                                    </button>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5 text-right">
                                                <button
                                                    onClick={() => deletePromotion(promo.id)}
                                                    className="p-2 text-slate-300 hover:text-rose-500 transition-colors"
                                                >
                                                    <X className="size-5" />
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Modal Cadastro */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-xl bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border-4 border-white flex flex-col max-h-[95vh]">
                        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                            <div>
                                <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Nova Promoção</h3>
                                <p className="text-xs text-slate-500 mt-0.5">Configure as regras de desconto para o produto.</p>
                            </div>
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="p-2 rounded-xl hover:bg-slate-200 text-slate-400 transition-colors"
                            >
                                <X className="size-6" />
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="p-8 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                            {/* Produto */}
                            {newPromo.tipo !== "COMBO_MIX" && (
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Produto ou Grupo</label>
                                <select
                                    required
                                    value={newPromo.produtoId}
                                    onChange={(e) => setNewPromo({ ...newPromo, produtoId: e.target.value })}
                                    className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-bold appearance-none cursor-pointer"
                                >
                                    <option value="">Selecione um produto/grupo...</option>
                                    {products.map(p => (
                                        <option key={p.id} value={p.id}>{p.nome} {p.preco > 0 ? `(R$ ${p.preco.toFixed(2)})` : "(Grupo)"}</option>
                                    ))}
                                </select>
                            </div>
                            )}

                            {/* Tipo */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Tipo de Promoção</label>
                                <div className="grid grid-cols-3 gap-4">
                                    <button
                                        type="button"
                                        onClick={() => setNewPromo({ ...newPromo, tipo: "VALOR" })}
                                        className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${newPromo.tipo === "VALOR" ? "border-primary bg-primary/5 text-primary" : "border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200"}`}
                                    >
                                        <Percent className="size-6" />
                                        <span className="text-xs font-black uppercase text-center">Por Valor (%)</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setNewPromo({ ...newPromo, tipo: "QUANTIDADE" })}
                                        className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${newPromo.tipo === "QUANTIDADE" ? "border-primary bg-primary/5 text-primary" : "border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200"}`}
                                    >
                                        <Layers className="size-6" />
                                        <span className="text-[10px] sm:text-xs font-black uppercase text-center">Simples (Qtd)</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setNewPromo({ ...newPromo, tipo: "COMBO_MIX", produtoId: "" })}
                                        className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${newPromo.tipo === "COMBO_MIX" ? "border-primary bg-primary/5 text-primary" : "border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200"}`}
                                    >
                                        <Layers className="size-6" />
                                        <span className="text-xs font-black uppercase text-center">Combo Mix</span>
                                    </button>
                                </div>
                            </div>

                            {/* Detalhes Dinâmicos */}
                            {newPromo.tipo === "COMBO_MIX" ? (
                                (() => {
                                    let totalAvulso = 0;
                                    const itemsPreview = newPromo.itensCombo.map(item => {
                                        const prod = products.find(p => p.id === item.produtoId);
                                        if(!prod || !item.quantidade) return null;
                                        const subtotal = prod.preco * item.quantidade;
                                        totalAvulso += subtotal;
                                        return { nome: prod.nome, preco: prod.preco, subtotal, qtde: item.quantidade };
                                    }).filter(Boolean) as any[];
                                    
                                    const precoCombo = Number(newPromo.valorDesconto.replace(",", ".")) || 0;
                                    const diff = totalAvulso - precoCombo;
                                    const margem = totalAvulso > 0 ? (diff / totalAvulso) * 100 : 0;

                                    return (
                                        <div className="grid grid-cols-1 gap-6 p-6 bg-purple-50/50 rounded-3xl border border-purple-100 animate-in slide-in-from-top-2 duration-300">
                                            <div className="space-y-4">
                                                {/* Imagem */}
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest">Imagem (Opcional)</label>
                                                    <input
                                                        type="file"
                                                        accept="image/*"
                                                        onChange={(e) => {
                                                            const file = e.target.files?.[0];
                                                            if (file) {
                                                                const reader = new FileReader();
                                                                reader.onloadend = () => {
                                                                    setNewPromo({ ...newPromo, imagemUrl: reader.result as string });
                                                                };
                                                                reader.readAsDataURL(file);
                                                            }
                                                        }}
                                                        className="w-full px-3 py-2 bg-white border-2 border-purple-200/50 rounded-xl text-sm file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-purple-100 file:text-purple-700 hover:file:bg-purple-200"
                                                    />
                                                </div>

                                                {/* Nome do Combo */}
                                                <div className="space-y-2">
                                                    <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest">Nome do Combo Mix</label>
                                                    <input
                                                        type="text"
                                                        placeholder="Ex: Combo Família"
                                                        value={newPromo.comboName}
                                                        onChange={(e) => setNewPromo({ ...newPromo, comboName: e.target.value })}
                                                        className="w-full px-5 py-3 bg-white border-2 border-purple-200/50 rounded-xl focus:border-purple-500 outline-none transition-all font-bold text-sm text-purple-900"
                                                    />
                                                </div>

                                                {/* Itens do Combo */}
                                                <div className="space-y-2 pt-4 border-t border-purple-200/50">
                                                    <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest">Selecione os Produtos e Quantidades</label>
                                                    {newPromo.itensCombo.map((item, idx) => (
                                                        <div key={idx} className="flex gap-2 mb-2 items-center">
                                                            <select
                                                                value={item.produtoId}
                                                                onChange={(e) => {
                                                                    const newItens = [...newPromo.itensCombo];
                                                                    newItens[idx].produtoId = e.target.value;
                                                                    setNewPromo({ ...newPromo, itensCombo: newItens });
                                                                }}
                                                                className="flex-1 px-3 py-2 text-sm border-2 rounded-lg"
                                                            >
                                                                <option value="">Selecione um produto...</option>
                                                                {products.filter(p => !p.isGroup).map(p => (
                                                                    <option key={p.id} value={p.id}>{p.nome}</option>
                                                                ))}
                                                            </select>
                                                            <input 
                                                                type="number"
                                                                value={item.quantidade || ''}
                                                                onChange={(e) => {
                                                                    const val = parseInt(e.target.value);
                                                                    const newItens = [...newPromo.itensCombo];
                                                                    newItens[idx].quantidade = isNaN(val) ? 0 : val;
                                                                    setNewPromo({ ...newPromo, itensCombo: newItens });
                                                                }}
                                                                min={1}
                                                                placeholder="Qtd"
                                                                className="w-20 px-3 py-2 border-2 rounded-lg text-sm"
                                                            />
                                                            <button type="button" onClick={() => {
                                                                const newItens = [...newPromo.itensCombo];
                                                                newItens.splice(idx, 1);
                                                                setNewPromo({ ...newPromo, itensCombo: newItens });
                                                            }} className="p-2 text-red-500 bg-red-50 rounded-lg">
                                                                <X className="size-4" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                    <button
                                                        type="button"
                                                        onClick={() => setNewPromo({ ...newPromo, itensCombo: [...newPromo.itensCombo, { produtoId: "", quantidade: 1 }] })}
                                                        className="w-full py-2 bg-purple-100 hover:bg-purple-200 text-purple-700 font-bold rounded-xl text-xs flex justify-center items-center gap-1"
                                                    >
                                                        <Plus className="size-3" /> Adicionar Produto ao Mix
                                                    </button>
                                                </div>

                                                {/* Preço Final */}
                                                <div className="space-y-2 pt-4 border-t border-purple-200/50">
                                                    <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest">Preço Sugerido / Venda do Combo</label>
                                                    <input
                                                        type="text"
                                                        placeholder="R$ 0,00"
                                                        value={newPromo.valorDesconto}
                                                        onChange={(e) => setNewPromo({ ...newPromo, valorDesconto: e.target.value })}
                                                        className="w-full px-5 py-3 bg-white border-2 border-purple-200/50 rounded-xl focus:border-purple-500 outline-none transition-all font-black text-xl text-purple-600"
                                                    />
                                                </div>

                                                {/* Previsão do Desconto */}
                                                {itemsPreview.length > 0 && (
                                                    <div className="mt-6 bg-white p-4 rounded-2xl border-2 border-purple-100 shadow-inner">
                                                        <h4 className="text-[10px] font-black tracking-widest uppercase text-slate-400 mb-3 border-b pb-2">Previsão de Ticket Médio</h4>
                                                        <div className="space-y-2 mb-3">
                                                            {itemsPreview.map((ip, i) => (
                                                                <div key={i} className="flex justify-between items-center text-sm">
                                                                    <span className="text-slate-600 font-bold"><span className="text-purple-500 font-black mr-1">{ip.qtde}x</span> {ip.nome}</span>
                                                                    <span className="text-slate-900 font-black text-xs">R$ {ip.subtotal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                        <div className="border-t pt-3 flex flex-col gap-1">
                                                            <div className="flex justify-between items-center text-sm">
                                                                <span className="text-slate-500 font-bold">Valor Avulso:</span>
                                                                <span className="text-slate-400 font-black line-through">R$ {totalAvulso.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                                                            </div>
                                                            <div className="flex justify-between items-center text-[15px]">
                                                                <span className="text-slate-600 font-black">Será cobrado:</span>
                                                                <span className="text-purple-600 font-black">R$ {precoCombo.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                                                            </div>
                                                            <div className={`flex justify-between items-center mt-2 px-3 py-2 rounded-xl text-xs font-black transition-colors ${diff > 0 ? "bg-emerald-50 text-emerald-600" : diff < 0 ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"}`}>
                                                                <span>{diff >= 0 ? "O pacote concede um desconto de:" : "O pacote encarece o total em:"}</span>
                                                                <span>R$ {Math.abs(diff).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} ({margem.toFixed(1)}%)</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}

                                            </div>
                                        </div>
                                    );
                                })()
                            ) : newPromo.tipo === "QUANTIDADE" ? (
                                <div className="grid grid-cols-2 gap-6 p-6 bg-orange-50/50 rounded-3xl border border-orange-100 animate-in slide-in-from-top-2 duration-300">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-orange-500 uppercase tracking-widest">Qtd de Itens</label>
                                        <input
                                            type="number"
                                            value={newPromo.quantidadeMinima}
                                            onChange={(e) => setNewPromo({ ...newPromo, quantidadeMinima: e.target.value })}
                                            className="w-full px-5 py-3 bg-white border-2 border-orange-200/50 rounded-xl focus:border-orange-500 outline-none transition-all font-black text-xl text-orange-600"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-orange-500 uppercase tracking-widest">Preço do Combo</label>
                                        <input
                                            type="text"
                                            placeholder="0,00"
                                            value={newPromo.valorDesconto}
                                            onChange={(e) => setNewPromo({ ...newPromo, valorDesconto: e.target.value })}
                                            className="w-full px-5 py-3 bg-white border-2 border-orange-200/50 rounded-xl focus:border-orange-500 outline-none transition-all font-black text-xl text-orange-600"
                                        />
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-2 p-6 bg-blue-50/50 rounded-3xl border border-blue-100 animate-in slide-in-from-top-2 duration-300">
                                    <label className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Porcentagem de Desconto (%)</label>
                                    <div className="flex items-center gap-4">
                                        <input
                                            type="text"
                                            placeholder="Ex: 10"
                                            value={newPromo.valorDesconto}
                                            onChange={(e) => setNewPromo({ ...newPromo, valorDesconto: e.target.value })}
                                            className="flex-1 w-0 min-w-0 px-5 py-3 bg-white border-2 border-blue-200/50 rounded-xl focus:border-blue-500 outline-none transition-all font-black text-4xl text-blue-600"
                                        />
                                        <span className="text-4xl font-black text-blue-300 shrink-0">%</span>
                                    </div>
                                    <p className="text-[10px] font-bold text-blue-400 italic">Desconto aplicado diretamente no produto/grupo.</p>
                                </div>
                            )}

                            {/* Validade */}
                            <div className="grid grid-cols-2 gap-6">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Início da Vigência</label>
                                    <input
                                        type="date"
                                        value={newPromo.dataInicio}
                                        onChange={(e) => setNewPromo({ ...newPromo, dataInicio: e.target.value })}
                                        className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-primary outline-none transition-all font-bold"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Fim da Vigência</label>
                                    <input
                                        type="date"
                                        value={newPromo.dataFim}
                                        onChange={(e) => setNewPromo({ ...newPromo, dataFim: e.target.value })}
                                        className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-primary outline-none transition-all font-bold"
                                    />
                                </div>
                            </div>
                        </form>

                        <div className="p-8 border-t border-slate-100 flex gap-4 bg-slate-50 shrink-0">
                            <button
                                type="button"
                                onClick={() => setIsModalOpen(false)}
                                className="flex-1 py-5 text-slate-500 font-bold rounded-2xl hover:bg-white transition-all border-2 border-slate-200 uppercase tracking-widest text-xs"
                            >
                                Cancelar
                            </button>
                            <button
                                type="submit"
                                onClick={handleSubmit}
                                disabled={isSaving}
                                className="flex-[2] py-5 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 shadow-xl shadow-primary/30 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 uppercase tracking-[0.2em] text-xs"
                            >
                                {isSaving ? (
                                    <Loader2 className="size-5 animate-spin" />
                                ) : (
                                    "Ativar Promoção"
                                )}
                                {!isSaving && <Check className="size-5" />}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal Reactivate Promo */}
            {reactivatePromo && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-sm bg-white rounded-[2rem] shadow-2xl p-6 relative animate-in zoom-in-95 duration-200 border-4 border-white">
                        <button onClick={() => setReactivatePromo(null)} className="absolute top-4 right-4 p-2 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors">
                            <X className="size-5" />
                        </button>
                        <h3 className="text-xl font-black text-slate-900 mb-1">Nova Vigência</h3>
                        <p className="text-sm text-slate-500 mb-6 leading-relaxed">A promoção foi inativada/expirada. Defina o novo período para ativá-la.</p>
                        
                        <div className="space-y-4 mb-8">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Nova Data de Início</label>
                                <input
                                    type="date"
                                    value={reactivateDates.dataInicio}
                                    onChange={(e) => setReactivateDates({ ...reactivateDates, dataInicio: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:border-primary outline-none transition-all font-bold"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Nova Data de Fim</label>
                                <input
                                    type="date"
                                    value={reactivateDates.dataFim}
                                    onChange={(e) => setReactivateDates({ ...reactivateDates, dataFim: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:border-primary outline-none transition-all font-bold"
                                />
                            </div>
                        </div>

                        <button
                            onClick={confirmReactivate}
                            disabled={isSaving}
                            className="w-full bg-primary text-white font-black py-4 rounded-xl hover:bg-primary/90 flex items-center justify-center gap-2 shadow-lg shadow-primary/20 active:scale-95 disabled:opacity-50 tracking-widest uppercase text-xs transition-all"
                        >
                            {isSaving ? <Loader2 className="size-5 animate-spin" /> : <Calendar className="size-4" />}
                            Confirmar Reativação
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
