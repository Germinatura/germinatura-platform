"use client";

import { useEffect, useState } from "react";
import {
    Loader2,
    Package,
    Search,
    AlertCircle,
    PackageCheck,
    Edit,
    X,
    Plus,
    Minus,
    Check,
    RefreshCw,
    Eye,
    EyeOff
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface Product {
    id: string;
    nome: string;
    estoque: number;
    ativo: boolean;
    imagemUrl?: string;
    isPromocional?: boolean;
    isGroup?: boolean;
    produtoPaiId?: string | null;
}

type AdjustmentType = "ADD" | "SUB" | "SET";

export default function GestaoEstoque() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [adjustmentAmount, setAdjustmentAmount] = useState<number>(0);
    const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>("ADD");
    const [isSaving, setIsSaving] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const [showInactive, setShowInactive] = useState(false);

    const { showToast } = useToast();

    const loadProducts = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/produtos");
            const data = await res.json();
            setProducts(data.filter((p: Product) => p.isPromocional === false));
        } catch (err) {
            console.error("Erro ao carregar produtos:", err);
            showToast("Erro ao carregar produtos.", "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadProducts();
    }, []);

    const openEditModal = (product: Product) => {
        setSelectedProduct(product);
        setAdjustmentAmount(0);
        setAdjustmentType("ADD");
        setIsModalOpen(true);
    };

    const closeEditModal = () => {
        setIsModalOpen(false);
        setSelectedProduct(null);
        setAdjustmentAmount(0);
    };

    const handleSaveAdjustment = async () => {
        if (!selectedProduct) return;

        let novoEstoque = selectedProduct.estoque;

        if (adjustmentType === "ADD") {
            novoEstoque += adjustmentAmount;
        } else if (adjustmentType === "SUB") {
            novoEstoque = Math.max(0, novoEstoque - adjustmentAmount);
        } else {
            novoEstoque = Math.max(0, adjustmentAmount);
        }

        setIsSaving(true);
        try {
            const response = await fetch(`/api/produtos/${selectedProduct.id}/estoque`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ estoque: novoEstoque })
            });

            if (response.ok) {
                setProducts(products.map(p => p.id === selectedProduct.id ? { ...p, estoque: novoEstoque } : p));
                showToast("Estoque atualizado com sucesso!", "success");
                closeEditModal();
            } else {
                showToast("Erro ao atualizar estoque.", "error");
            }
        } catch (error) {
            console.error("Erro ao atualizar estoque:", error);
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const filteredProducts = products.filter(p =>
        p.nome.toLowerCase().includes(searchTerm.toLowerCase()) &&
        (showInactive ? true : p.ativo)
    );

    const toggleGroup = (id: string) => {
        setExpandedGroups(prev => ({ ...prev, [id]: !prev[id] }));
    };

    const topLevelProducts = filteredProducts.filter(p => !p.produtoPaiId);

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    const realProducts = products.filter(p => !p.isGroup);
    const totalEstoque = realProducts.reduce((acc, p) => acc + (p.estoque || 0), 0);
    const produtosSemEstoque = realProducts.filter(p => (p.estoque || 0) <= 0).length;

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            {/* Header Content - Fixed */}
            <div className="bg-white border-b border-slate-200 p-4 md:p-8 shrink-0">
                <div className="max-w-6xl mx-auto">
                    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                        <div>
                            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">Controle de Estoque</h2>
                            <p className="text-sm text-slate-500 mt-1">Monitore e ajuste o inventário de produtos em tempo real.</p>
                        </div>
                        <div className="flex items-center gap-3 w-full md:w-auto">
                            <button
                                onClick={() => setShowInactive(!showInactive)}
                                className={`p-2.5 rounded-lg border transition-all flex items-center gap-2 shrink-0 ${showInactive ? 'bg-primary/10 border-primary/20 text-primary' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                                title={showInactive ? "Ocultar inativos" : "Mostrar inativos"}
                            >
                                {showInactive ? <Eye className="size-5" /> : <EyeOff className="size-5" />}
                                <span className="text-sm font-bold hidden md:inline">{showInactive ? "Ver Todos" : "Apenas Ativos"}</span>
                            </button>
                            <div className="relative w-full md:w-80">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400" />
                                <input
                                    type="text"
                                    placeholder="Buscar produto..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full pl-12 pr-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium"
                                />
                            </div>
                        </div>
                    </header>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-blue-500/10 rounded-lg">
                                    <Package className="size-5 text-blue-600" />
                                </div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total em Estoque</span>
                            </div>
                            <span className="text-2xl font-black text-slate-900">{totalEstoque}</span>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-rose-500/10 rounded-lg">
                                    <AlertCircle className="size-5 text-rose-600" />
                                </div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Esgotados</span>
                            </div>
                            <span className="text-2xl font-black text-rose-500">{produtosSemEstoque}</span>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-emerald-500/10 rounded-lg">
                                    <PackageCheck className="size-5 text-emerald-600" />
                                </div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Disponíveis</span>
                            </div>
                            <span className="text-2xl font-black text-emerald-500">{realProducts.length - produtosSemEstoque}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Table Area - Full Height Scroll */}
            <div className="flex-1 overflow-hidden p-4 md:p-8 flex flex-col">
                <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="flex-1 overflow-auto custom-scrollbar">
                        <table className="w-full text-left border-collapse min-w-[700px]">
                            <thead className="sticky top-0 z-20">
                                <tr className="bg-slate-50/95 backdrop-blur-sm shadow-sm">
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Produto</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-center">Status</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-center">Quantidade Atual</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {topLevelProducts.map((product) => {
                                    if (product.isGroup) {
                                        const children = products.filter(p => p.produtoPaiId === product.id && (showInactive ? true : p.ativo));
                                        if (children.length === 0 && !searchTerm) return null; // Only show empty groups if not searching
                                        
                                        const totalGroupStock = children.reduce((acc, c) => acc + (c.estoque || 0), 0);
                                        const isExpanded = expandedGroups[product.id];

                                        return (
                                            <div key={product.id} className="contents group">
                                                <tr className={`hover:bg-slate-50 transition-colors cursor-pointer ${isExpanded ? 'bg-slate-50 border-b border-primary/10' : ''}`} onClick={() => toggleGroup(product.id)}>
                                                    <td className="px-6 py-5">
                                                        <div className="flex items-center gap-4">
                                                            <div className="size-12 rounded-xl bg-primary/5 border border-primary/20 overflow-hidden flex items-center justify-center">
                                                                {product.imagemUrl ? (
                                                                    <img src={product.imagemUrl} alt={product.nome} className="w-full h-full object-cover" />
                                                                ) : (
                                                                    <Package className="size-6 text-primary" />
                                                                )}
                                                            </div>
                                                            <div className="flex flex-col">
                                                                <span className="font-black text-slate-900 group-hover:text-primary transition-colors flex items-center gap-2">
                                                                    {product.nome}
                                                                    <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full uppercase tracking-tighter">Grupo</span>
                                                                </span>
                                                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                                                                    {children.length} Variações
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-5 text-center">
                                                        <span className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${totalGroupStock > 10
                                                            ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                                                            : totalGroupStock > 0
                                                                ? "bg-amber-50 text-amber-600 border-amber-100"
                                                                : "bg-rose-50 text-rose-600 border-rose-100"
                                                            }`}>
                                                            {totalGroupStock > 10 ? "Em Estoque" : totalGroupStock > 0 ? "Estoque Baixo" : "Esgotado"}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-5 text-center">
                                                        <span className="text-xl font-black text-slate-900">
                                                            {totalGroupStock}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-5 text-right">
                                                        <button
                                                            className="p-2.5 text-slate-400 flex items-center justify-end w-full"
                                                        >
                                                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                                                                {isExpanded ? <Minus className="size-4" /> : <Plus className="size-4" />}
                                                            </div>
                                                        </button>
                                                    </td>
                                                </tr>
                                                {isExpanded && children.map(child => (
                                                    <tr key={child.id} className="bg-slate-50/50 hover:bg-slate-50 transition-colors">
                                                        <td className="px-6 py-4 pl-12 rounded-bl-3xl">
                                                            <div className="flex items-center gap-4">
                                                                <div className="size-10 rounded-xl bg-white border border-slate-200 overflow-hidden flex items-center justify-center shrink-0 shadow-sm">
                                                                    {child.imagemUrl ? (
                                                                        <img src={child.imagemUrl} alt={child.nome} className="w-full h-full object-cover" />
                                                                    ) : (
                                                                        <Package className="size-5 text-slate-300" />
                                                                    )}
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="font-bold text-slate-700">{child.nome}</span>
                                                                    {!child.ativo && (
                                                                        <span className="text-[8px] font-black text-rose-500 bg-rose-50 border border-rose-100 px-1.5 py-0.5 rounded uppercase tracking-tighter w-fit mt-0.5">
                                                                            Inativo
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td className="px-6 py-4 text-center">
                                                            <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border ${child.estoque > 10
                                                                ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                                                                : child.estoque > 0
                                                                    ? "bg-amber-50 text-amber-600 border-amber-100"
                                                                    : "bg-rose-50 text-rose-600 border-rose-100"
                                                                }`}>
                                                                {child.estoque > 10 ? "Estoque ok" : child.estoque > 0 ? "Baixo" : "Esgotado"}
                                                            </span>
                                                        </td>
                                                        <td className="px-6 py-4 text-center">
                                                            <span className="text-lg font-black text-slate-700">
                                                                {child.estoque || 0}
                                                            </span>
                                                        </td>
                                                        <td className="px-6 py-4 text-right">
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); openEditModal(child); }}
                                                                className="p-2 text-slate-400 hover:text-primary transition-all hover:bg-primary/10 bg-white rounded-xl shadow-sm border border-slate-200"
                                                                title="Ajustar Estoque Variação"
                                                            >
                                                                <Edit className="size-4" />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </div>
                                        );
                                    }

                                    return (
                                    <tr key={product.id} className="hover:bg-slate-50/50 transition-colors group">
                                        <td className="px-6 py-5">
                                            <div className="flex items-center gap-4">
                                                <div className="size-12 rounded-xl bg-slate-50 border border-slate-100 overflow-hidden flex items-center justify-center">
                                                    {product.imagemUrl ? (
                                                        <img src={product.imagemUrl} alt={product.nome} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <Package className="size-6 text-slate-300" />
                                                    )}
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="font-black text-slate-900">{product.nome}</span>
                                                    {!product.ativo && (
                                                        <span className="text-[8px] font-black text-rose-500 bg-rose-50 border border-rose-100 px-1.5 py-0.5 rounded uppercase tracking-tighter w-fit mt-0.5">
                                                            Inativo
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-5 text-center">
                                            <span className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${product.estoque > 10
                                                ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                                                : product.estoque > 0
                                                    ? "bg-amber-50 text-amber-600 border-amber-100"
                                                    : "bg-rose-50 text-rose-600 border-rose-100"
                                                }`}>
                                                {product.estoque > 10 ? "Em Estoque" : product.estoque > 0 ? "Estoque Baixo" : "Esgotado"}
                                            </span>
                                        </td>
                                        <td className="px-6 py-5 text-center">
                                            <span className="text-xl font-black text-slate-900">
                                                {product.estoque || 0}
                                            </span>
                                        </td>
                                        <td className="px-6 py-5 text-right">
                                            <button
                                                onClick={() => openEditModal(product)}
                                                className="p-2.5 text-slate-400 hover:text-primary transition-all hover:bg-primary/5 rounded-xl group-hover:scale-110"
                                                title="Ajustar Estoque"
                                            >
                                                <Edit className="size-5" />
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

            {/* Modal de Ajuste de Estoque */}
            {isModalOpen && selectedProduct && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border-4 border-white flex flex-col max-h-[90vh]">
                        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-primary/10 rounded-2xl text-primary">
                                    <RefreshCw className="size-6" />
                                </div>
                                <h3 className="text-2xl font-black text-slate-900 uppercase">
                                    Ajustar Estoque
                                </h3>
                            </div>
                            <button
                                onClick={closeEditModal}
                                className="p-2 rounded-xl hover:bg-slate-200 text-slate-400 transition-colors"
                            >
                                <X className="size-6" />
                            </button>
                        </div>

                        <div className="p-8 space-y-8 overflow-y-auto flex-1 custom-scrollbar">
                            {/* Produto Info */}
                            <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                                <div className="size-16 rounded-xl bg-white border border-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                                    {selectedProduct.imagemUrl ? (
                                        <img src={selectedProduct.imagemUrl} alt={selectedProduct.nome} className="w-full h-full object-cover" />
                                    ) : (
                                        <Package className="size-8 text-slate-300" />
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Produto Selecionado</p>
                                    <h4 className="text-lg font-black text-slate-900 truncate">{selectedProduct.nome}</h4>
                                    <p className="text-sm font-bold text-primary">Estoque Atual: {selectedProduct.estoque}</p>
                                </div>
                            </div>

                            {/* Tipo de Ajuste */}
                            <div className="space-y-4">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">O que você deseja fazer?</label>
                                <div className="grid grid-cols-3 gap-3">
                                    <button
                                        onClick={() => setAdjustmentType("ADD")}
                                        className={`flex flex-col items-center justify-center gap-2 p-4 rounded-2xl border-2 transition-all ${adjustmentType === "ADD"
                                            ? "bg-emerald-50 border-emerald-500 text-emerald-700 shadow-md"
                                            : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50"
                                            }`}
                                    >
                                        <Plus className="size-6" />
                                        <span className="text-[10px] font-black uppercase">Adicionar</span>
                                    </button>
                                    <button
                                        onClick={() => setAdjustmentType("SUB")}
                                        className={`flex flex-col items-center justify-center gap-2 p-4 rounded-2xl border-2 transition-all ${adjustmentType === "SUB"
                                            ? "bg-rose-50 border-rose-500 text-rose-700 shadow-md"
                                            : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50"
                                            }`}
                                    >
                                        <Minus className="size-6" />
                                        <span className="text-[10px] font-black uppercase">Remover</span>
                                    </button>
                                    <button
                                        onClick={() => setAdjustmentType("SET")}
                                        className={`flex flex-col items-center justify-center gap-2 p-4 rounded-2xl border-2 transition-all ${adjustmentType === "SET"
                                            ? "bg-primary/5 border-primary text-primary shadow-md"
                                            : "bg-white border-slate-100 text-slate-500 hover:bg-slate-50"
                                            }`}
                                    >
                                        <RefreshCw className="size-6" />
                                        <span className="text-[10px] font-black uppercase">Definir</span>
                                    </button>
                                </div>
                            </div>

                            {/* Quantidade Input */}
                            <div className="space-y-4">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Quantidade</label>
                                <div className="relative group">
                                    <input
                                        type="number"
                                        min="0"
                                        value={adjustmentAmount || ""}
                                        onChange={(e) => setAdjustmentAmount(parseInt(e.target.value) || 0)}
                                        placeholder="0"
                                        className="w-full pl-6 pr-6 py-6 bg-slate-50 border-2 border-slate-100 rounded-[2rem] text-3xl font-black text-center focus:ring-8 focus:ring-primary/5 focus:border-primary outline-none transition-all placeholder:text-slate-200"
                                    />
                                </div>
                                <div className="flex justify-center">
                                    <p className="text-xs font-bold text-slate-500 bg-white px-4 py-2 rounded-full border border-slate-100 shadow-sm">
                                        Resultado Final: <span className="text-primary font-black">
                                            {adjustmentType === "ADD"
                                                ? selectedProduct.estoque + adjustmentAmount
                                                : adjustmentType === "SUB"
                                                    ? Math.max(0, selectedProduct.estoque - adjustmentAmount)
                                                    : adjustmentAmount
                                            }
                                        </span>
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-8 border-t border-slate-100 flex gap-4 bg-slate-50">
                            <button
                                onClick={closeEditModal}
                                className="flex-1 py-5 text-slate-500 font-bold rounded-2xl hover:bg-white transition-all border-2 border-slate-200 uppercase tracking-widest text-xs"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSaveAdjustment}
                                disabled={isSaving || (adjustmentAmount === 0 && adjustmentType !== "SET")}
                                className="flex-[1.5] py-5 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 shadow-xl shadow-primary/30 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 uppercase tracking-[0.2em] text-xs"
                            >
                                {isSaving ? (
                                    <Loader2 className="size-5 animate-spin" />
                                ) : (
                                    <>
                                        Confirmar Ajuste
                                        <Check className="size-5" />
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
