"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
    ShoppingBag,
    Plus,
    Minus,
    Check,
    Loader2,
    Search,
    Package,
    ArrowLeft
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";

interface Produto {
    id: string;
    nome: string;
    imagemUrl?: string;
    estoque: number;
    preco: number;
    precoOriginal?: number;
    temDesconto?: boolean;
    promocao?: any;
    isGroup?: boolean;
    produtoPaiId?: string | null;
}

interface ItemCarrinho {
    produto: Produto;
    quantidade: number;
}

export default function NovaReservaPage() {
    const router = useRouter();
    const [produtos, setProdutos] = useState<Produto[]>([]);
    const [carrinho, setCarrinho] = useState<ItemCarrinho[]>([]);
    const [loading, setLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const [showCartMobile, setShowCartMobile] = useState(false);
    const [reservasAtivas, setReservasAtivas] = useState(true);
    const { showToast } = useToast();

    const fetchConfig = async () => {
        try {
            const res = await fetch("/api/configuracoes/reservas");
            if (res.ok) {
                const data = await res.json();
                setReservasAtivas(data.reservas_ativas);
            }
        } catch (error) {
            console.error("Erro ao carregar configurações:", error);
        }
    };

    const fetchProdutos = async () => {
        try {
            const res = await fetch("/api/produtos");
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    setProdutos(data.filter((p: any) => p.ativo && (p.estoque > 0 || p.isGroup)));
                }
            }
        } catch (error: any) {
            console.error("Erro ao carregar produtos:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchConfig();
        fetchProdutos();
    }, []);

    const addToCart = (produto: Produto) => {
        setCarrinho(prev => {
            const existing = prev.find(item => item.produto.id === produto.id);
            if (existing) {
                return prev.map(item =>
                    item.produto.id === produto.id
                        ? { ...item, quantidade: item.quantidade + 1 }
                        : item
                );
            }
            return [...prev, { produto, quantidade: 1 }];
        });
    };

    const updateQuantity = (id: string, delta: number) => {
        setCarrinho(prev => prev.map(item => {
            if (item.produto.id === id) {
                const newQty = Math.max(0, item.quantidade + delta);
                return { ...item, quantidade: newQty };
            }
            return item;
        }).filter(item => item.quantidade > 0));
    };

    const handleFinalizarReserva = async () => {
        if (carrinho.length === 0) return;
        setIsSaving(true);
        try {
            const res = await fetch("/api/reservas", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    itens: carrinho.map(item => ({
                        produtoId: item.produto.id,
                        quantidade: item.quantidade
                    }))
                })
            });

            if (res.ok) {
                showToast("Reserva enviada com sucesso!", "success");
                router.push("/reservas");
            } else {
                const errData = await res.json();
                showToast(errData.error || "Erro ao realizar reserva", "error");
            }
        } catch (error: any) {
            showToast("Erro de conexão", "error");
        } finally {
            setIsSaving(false);
        }
    };

    // --- Otimizações de Memória (useMemo) ---
    const parentMap = useMemo(() => {
        const map: Record<string, any> = {};
        produtos.forEach(p => map[p.id] = p);
        return map;
    }, [produtos]);

    const filteredProdutos = useMemo(() => {
        return produtos.filter(p => {
            if (!p.nome.toLowerCase().includes(searchTerm.toLowerCase())) return false;
            if (!p.produtoPaiId) return true;
            const parent = parentMap[p.produtoPaiId];
            return (p as any).isPromocional && parent && !parent.isGroup;
        });
    }, [produtos, parentMap, searchTerm]);

    const childrenMap = useMemo(() => {
        const map: Record<string, Produto[]> = {};
        produtos.forEach((p: Produto) => {
            if (p.produtoPaiId && parentMap[p.produtoPaiId]?.isGroup) {
                if (!map[p.produtoPaiId]) map[p.produtoPaiId] = [];
                map[p.produtoPaiId].push(p);
            }
        });
        Object.keys(map).forEach(k => map[k].sort((a, b) => a.preco - b.preco));
        return map;
    }, [produtos, parentMap]);
    // ----------------------------------------

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!reservasAtivas) {
        return (
            <div className="flex flex-col h-screen bg-slate-50 relative">
                <header className="bg-white border-b border-slate-200 p-4 md:p-8">
                    <Link href="/reservas" className="flex items-center gap-2 text-slate-500 hover:text-primary transition-colors mb-2 text-sm font-bold">
                        <ArrowLeft className="size-4" />
                        Voltar para minhas reservas
                    </Link>
                    <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">Catálogo de Produtos</h2>
                </header>
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-500">
                    <ShoppingBag className="size-16 opacity-20 mb-4" />
                    <h3 className="text-xl font-bold text-slate-900 mb-2">Reservas Desativadas</h3>
                    <p className="max-w-xs">A função de reservas está temporariamente desativada. Por favor, tente novamente mais tarde.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col lg:flex-row h-[100dvh] bg-slate-50 relative">
            {/* Lista de Produtos */}
            <div className={`flex-1 flex-col p-4 md:p-8 overflow-hidden ${showCartMobile ? 'hidden lg:flex' : 'flex'}`}>
                <header className="mb-8 flex-none flex items-center justify-between">
                    <div>
                        <Link href="/reservas" className="flex items-center gap-2 text-slate-500 hover:text-primary transition-colors mb-2 text-sm font-bold">
                            <ArrowLeft className="size-4" />
                            Voltar para minhas reservas
                        </Link>
                        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">Catálogo de Produtos</h2>
                        <p className="text-slate-500">Selecione os itens que deseja reservar.</p>
                    </div>
                </header>

                <div className="mb-6 flex-none relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 size-5" />
                    <input
                        type="text"
                        placeholder="Buscar produtos..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary outline-none transition-all shadow-sm"
                    />
                </div>

                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar flex justify-center">
                    <div className="flex flex-col gap-4 pb-32 lg:pb-8 w-full max-w-4xl">
                        {filteredProdutos.map(produto => {
                            if (produto.isGroup) {
                                const children = childrenMap[produto.id] || [];
                                if (children.length === 0) return null;
                                const minPrice = Math.min(...children.map(c => c.preco));
                                const totalStock = children.reduce((acc, c) => acc + c.estoque, 0);
                                const isExpanded = expandedGroups[produto.id];
                                
                                return (
                                    <div key={produto.id} className={`bg-white rounded-[1.5rem] border transition-all shadow-sm flex flex-col ${isExpanded ? 'border-primary/30 ring-2 ring-primary/5 shadow-md' : 'border-slate-200 hover:border-slate-300'}`}>
                                        <div className="p-4 flex gap-4 cursor-pointer group" onClick={() => setExpandedGroups(prev => ({...prev, [produto.id]: !isExpanded}))}>
                                            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-[1.2rem] bg-slate-50 flex items-center justify-center border border-slate-100 relative">
                                                {produto.imagemUrl ? (
                                                    <img src={produto.imagemUrl} alt={produto.nome} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                                ) : (
                                                    <Package className="size-8 text-slate-300 group-hover:text-primary/70 transition-colors" />
                                                )}
                                            </div>
                                            <div className="flex flex-col flex-1 py-1">
                                                <div className="flex justify-between items-start mb-1 gap-2">
                                                    <h3 className="text-[17px] font-black text-slate-900 leading-tight" title={produto.nome}>Grupo - {produto.nome}</h3>
                                                    <button className={`p-1.5 rounded-lg transition-colors shrink-0 ${isExpanded ? 'bg-primary/10 text-primary' : 'bg-slate-50 text-slate-400 group-hover:bg-slate-100'}`}>
                                                        {isExpanded ? <Minus className="size-4" /> : <Plus className="size-4" />}
                                                    </button>
                                                </div>
                                                <div className="flex justify-between items-end mt-auto">
                                                    <div>
                                                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">A PARTIR DE</span>
                                                        <p className="text-xl font-black text-primary leading-none">
                                                            {minPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                                        </p>
                                                    </div>
                                                    <span className={`text-[9px] font-black uppercase tracking-[0.1em] px-2 py-1 rounded-md shadow-sm border ${totalStock > 0 ? 'bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-600 border-emerald-200/50' : 'bg-rose-50 text-rose-600 border-rose-100'}`}>
                                                        Estoque: {totalStock}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'}`}>
                                            <div className="p-4 pt-0 border-t border-slate-100 bg-slate-50/50 rounded-b-[1.5rem] flex flex-col gap-3 relative mt-3">
                                                {children.map(child => {
                                                    const qtyInCart = carrinho.find(item => item.produto.id === child.id)?.quantidade || 0;
                                                    return (
                                                        <div key={child.id} className="flex gap-4 p-3 rounded-[1rem] bg-white border border-slate-200 shadow-sm transition-all hover:border-primary/20 items-center">
                                                            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-slate-50 flex items-center justify-center border border-slate-100 relative">
                                                                {child.imagemUrl ? (
                                                                    <img src={child.imagemUrl} alt={child.nome} className="w-full h-full object-cover transition-transform duration-500" />
                                                                ) : (
                                                                    <Package className="size-5 text-slate-300 transition-colors" />
                                                                )}
                                                            </div>
                                                            <div className="flex flex-col flex-1 min-w-0">
                                                                <h4 className="font-bold text-[15px] text-slate-800 leading-tight mb-1 truncate">{child.nome}</h4>
                                                                <div className="flex items-center gap-2 mt-1">
                                                                    {child.temDesconto ? (
                                                                        <div className="flex flex-col">
                                                                            <span className="font-bold text-slate-400 text-[11px] line-through leading-none">
                                                                                {(child.precoOriginal || 0).toLocaleString("pt-BR", { style: 'currency', currency: 'BRL' })}
                                                                            </span>
                                                                            <span className="font-black text-primary text-[15px] leading-none flex items-center gap-1.5">
                                                                                {(child.preco || 0).toLocaleString("pt-BR", { style: 'currency', currency: 'BRL' })}
                                                                                {child.promocao?.tipo && (
                                                                                    <span className="bg-primary/10 text-primary text-[8px] px-1 py-0.5 rounded uppercase tracking-wider font-extrabold border border-primary/20">
                                                                                        PROMO
                                                                                    </span>
                                                                                )}
                                                                            </span>
                                                                        </div>
                                                                    ) : (
                                                                        <span className="font-black text-primary text-[15px] leading-none">
                                                                            {(child.preco || 0).toLocaleString("pt-BR", { style: 'currency', currency: 'BRL' })}
                                                                        </span>
                                                                    )}
                                                                    <span className={`shrink-0 text-[8px] sm:text-[9px] font-black uppercase tracking-[0.1em] px-1.5 py-0.5 rounded border ${child.estoque > 5 ? 'bg-emerald-50 text-emerald-600 border-emerald-200/50' : child.estoque > 0 ? 'bg-amber-50 text-amber-600 border-amber-200/50' : 'bg-rose-50 text-rose-600 border-rose-100'}`}>
                                                                        Estoque: {child.estoque}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center shrink-0">
                                                                {qtyInCart > 0 ? (
                                                                    <div className="flex items-center gap-2 bg-slate-50 rounded-xl border border-slate-200 p-1">
                                                                        <button onClick={(e) => { e.stopPropagation(); updateQuantity(child.id, -1); }} className="size-8 flex items-center justify-center hover:bg-white rounded-lg text-slate-600 shadow-sm border border-transparent hover:border-slate-200 transition-all active:scale-95">
                                                                            <Minus className="size-3.5" strokeWidth={3} />
                                                                        </button>
                                                                        <span className="text-sm font-black w-4 text-center text-slate-800">{qtyInCart}</span>
                                                                        <button onClick={(e) => { e.stopPropagation(); updateQuantity(child.id, 1); }} disabled={child.estoque <= 0 || qtyInCart >= child.estoque} className="size-8 flex items-center justify-center bg-primary text-white rounded-lg shadow-sm hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 disabled:bg-slate-200 disabled:text-slate-400">
                                                                            <Plus className="size-3.5" strokeWidth={3} />
                                                                        </button>
                                                                    </div>
                                                                ) : (
                                                                    <button onClick={(e) => { e.stopPropagation(); addToCart(child); }} disabled={child.estoque <= 0} className="px-5 py-2.5 bg-slate-900 text-white rounded-xl text-[13px] font-bold hover:bg-primary transition-colors disabled:opacity-50 shadow-md">
                                                                        Adicionar
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                );
                            }

                            const qtyInCart = carrinho.find(item => item.produto.id === produto.id)?.quantidade || 0;
                            return (
                                <div key={produto.id} className="bg-white p-4 rounded-[1.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all group relative flex gap-4 items-center">
                                    <div className="h-24 w-24 shrink-0 overflow-hidden rounded-[1.2rem] bg-slate-50 flex items-center justify-center border border-slate-100 relative">
                                        {produto.estoque === 0 && (
                                            <div className="absolute top-1 left-1 right-1 text-center bg-red-100/90 backdrop-blur-sm text-red-600 text-[9px] font-black py-0.5 rounded-lg uppercase tracking-widest z-10 border border-red-200">
                                                Esgotado
                                            </div>
                                        )}
                                        {produto.imagemUrl ? (
                                            <img src={produto.imagemUrl} alt={produto.nome} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                        ) : (
                                            <Package className="size-8 text-slate-300 group-hover:text-primary/70 transition-colors" />
                                        )}
                                    </div>
                                    <div className="flex flex-col flex-1 py-1 min-w-0">
                                        <h3 className="text-[17px] font-black text-slate-900 leading-tight mb-2 truncate" title={produto.nome}>{produto.nome}</h3>
                                        <div className="flex justify-between items-end mt-auto">
                                            <div className="flex flex-col gap-1">
                                                {produto.temDesconto && (
                                                    <span className="text-[11px] font-bold text-slate-400 line-through leading-none">
                                                        {(produto.precoOriginal || 0).toLocaleString("pt-BR", { style: 'currency', currency: 'BRL' })}
                                                    </span>
                                                )}
                                                <div className="flex items-center gap-1.5">
                                                    <p className="text-xl font-black text-primary leading-none">
                                                        {(produto.preco || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                                    </p>
                                                    {(produto.temDesconto || produto.promocao?.tipo) && (
                                                        <span className="bg-primary/10 text-primary text-[8px] px-1 py-0.5 rounded uppercase tracking-wider font-extrabold border border-primary/20">
                                                            PROMO
                                                        </span>
                                                    )}
                                                </div>
                                                <span className={`w-fit text-[9px] font-black uppercase tracking-[0.1em] px-2 py-1 rounded-md shadow-sm border ${produto.estoque > 5 ? 'bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-600 border-emerald-200/50' : produto.estoque > 0 ? 'bg-gradient-to-r from-amber-50 to-amber-100 text-amber-600 border-amber-200/50' : 'bg-rose-50 text-rose-600 border-rose-100'}`}>
                                                    Estoque: {produto.estoque}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center shrink-0">
                                        {qtyInCart > 0 ? (
                                            <div className="flex items-center gap-3 bg-slate-50 rounded-[1rem] border border-slate-200 p-1.5 shadow-sm">
                                                <button onClick={(e) => { e.stopPropagation(); updateQuantity(produto.id, -1); }} className="size-9 flex items-center justify-center hover:bg-white rounded-lg text-slate-600 shadow-sm border border-transparent hover:border-slate-200 transition-all active:scale-95">
                                                    <Minus className="size-4" strokeWidth={3} />
                                                </button>
                                                <span className="text-base font-black w-5 text-center text-slate-800">{qtyInCart}</span>
                                                <button onClick={(e) => { e.stopPropagation(); updateQuantity(produto.id, 1); }} disabled={produto.estoque <= 0 || qtyInCart >= produto.estoque} className="size-9 flex items-center justify-center bg-primary text-white rounded-lg shadow-sm hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 disabled:bg-slate-200 disabled:text-slate-400">
                                                    <Plus className="size-4" strokeWidth={3} />
                                                </button>
                                            </div>
                                        ) : (
                                            <button onClick={() => addToCart(produto)} disabled={produto.estoque === 0} className="px-6 py-3 bg-slate-900 text-white rounded-[1rem] text-[14px] font-black hover:bg-primary transition-all active:scale-95 disabled:opacity-50 disabled:hover:bg-slate-900 shadow-md flex items-center gap-2">
                                                <Plus className="size-4" />
                                                Adicionar
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* Mobile Cart Floating Bar */}
            <div className={`lg:hidden fixed bottom-0 left-0 right-0 p-4 bg-white border-t border-slate-200 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)] z-40 transition-transform duration-300 ${showCartMobile ? 'translate-y-full' : 'translate-y-0'}`}>
                <button
                    onClick={() => setShowCartMobile(true)}
                    className="w-full py-3.5 bg-slate-900 text-white rounded-xl font-bold flex items-center justify-between px-6 hover:bg-slate-800 transition-colors shadow-lg shadow-slate-900/20 active:scale-[0.98]"
                >
                    <div className="flex items-center gap-3">
                        <div className="relative">
                            <ShoppingBag className="size-5" />
                            {carrinho.length > 0 && (
                                <span className="absolute -top-2 -right-2 bg-primary text-white text-[10px] font-black size-5 rounded-full flex items-center justify-center">
                                    {carrinho.reduce((acc, i) => acc + i.quantidade, 0)}
                                </span>
                            )}
                        </div>
                        <span>Ver Carrinho</span>
                    </div>
                    <span className="font-black">
                        {carrinho.reduce((acc, item) => acc + (item.produto.preco || 0) * item.quantidade, 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    </span>
                </button>
            </div>

            {/* Carrinho */}
            <aside className={`w-full lg:w-96 bg-white border-l border-slate-200 flex-col shadow-2xl z-50 fixed lg:relative inset-0 lg:inset-auto lg:h-auto ${showCartMobile ? 'flex' : 'hidden lg:flex'}`}>
                <div className="p-4 lg:p-6 border-b border-slate-100 flex items-center gap-3 bg-white">
                    <button 
                        onClick={() => setShowCartMobile(false)}
                        className="lg:hidden p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors"
                    >
                        <ArrowLeft className="size-5" />
                    </button>
                    <div className="size-8 lg:size-10 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
                        <ShoppingBag className="size-5 lg:size-6" />
                    </div>
                    <h3 className="text-lg lg:text-xl font-bold">Minha Reserva</h3>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    {carrinho.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center space-y-4">
                            <ShoppingBag className="size-16 opacity-20" />
                            <p className="font-medium">Seu carrinho está vazio.<br />Escolha produtos ao lado.</p>
                        </div>
                    ) : (
                        carrinho.map(item => (
                            <div key={item.produto.id} className="flex items-center gap-4 bg-slate-50 p-3 rounded-xl border border-slate-100 animate-in slide-in-from-right-4 duration-300">
                                <div className="flex-1 min-w-0">
                                    <p className="font-bold text-sm truncate text-slate-900">{item.produto.nome}</p>
                                    <p className="text-xs text-slate-500">
                                        {(item.produto.preco || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 bg-white rounded-lg border border-slate-200 p-1">
                                    <button
                                        onClick={() => updateQuantity(item.produto.id, -1)}
                                        className="p-1 hover:bg-slate-100 rounded text-slate-500"
                                    >
                                        <Minus className="size-3" />
                                    </button>
                                    <span className="text-sm font-bold w-6 text-center">{item.quantidade}</span>
                                    <button
                                        onClick={() => updateQuantity(item.produto.id, 1)}
                                        className="p-1 hover:bg-slate-100 rounded text-slate-500"
                                    >
                                        <Plus className="size-3" />
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="p-6 pb-12 lg:pb-6 border-t border-slate-100 bg-slate-50/50">
                    <div className="flex justify-between items-center mb-6">
                        <span className="text-slate-500 font-medium">Total Estimado</span>
                        <span className="text-2xl font-black text-slate-900">
                            {carrinho.reduce((acc, item) => acc + (item.produto.preco || 0) * item.quantidade, 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </span>
                    </div>
                    <button
                        onClick={handleFinalizarReserva}
                        disabled={carrinho.length === 0 || isSaving}
                        className="w-full py-4 mb-4 lg:mb-0 bg-primary text-white rounded-2xl font-black text-lg shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-3"
                    >
                        {isSaving ? <Loader2 className="size-6 animate-spin" /> : <Check className="size-6" />}
                        FINALIZAR RESERVA
                    </button>
                </div>
            </aside>
        </div>
    );
}
