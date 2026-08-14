"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
    User,
    LogOut,
    Plus,
    Minus,
    ShoppingCart,
    X,
    CheckCircle2,
    Utensils,
    Beer,
    Cookie,
    Loader2,
    ArrowLeft,
    ChevronDown,
    ChevronUp,
    Layers,
    Ticket
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { montarPayloadPix } from "@/lib/pix";
import { useToast } from "@/components/ui/Toast";

interface Product {
    id: string;
    nome: string;
    preco: number;
    precoOriginal?: number;
    temDesconto?: boolean;
    isPromocional?: boolean;
    ativo: boolean;
    imagemUrl?: string;
    estoque: number;
    isGroup?: boolean;
    produtoPaiId?: string | null;
}

const getIcon = (nome: string, isGroup?: boolean) => {
    if (isGroup) return Layers;
    const n = nome.toLowerCase();
    if (n.includes("cachorro") || n.includes("quente") || n.includes("comida")) return Utensils;
    if (n.includes("refri") || n.includes("suco") || n.includes("bebida")) return Beer;
    return Cookie;
};

export default function PDVMobile() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [cart, setCart] = useState<Record<string, number>>({});
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const router = useRouter();

    const [user, setUser] = useState<any>(null);
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [isUpdatingStock, setIsUpdatingStock] = useState(false);

    const handleLogout = async () => {
        try {
            await fetch("/api/auth/logout", { method: "POST" });
            router.push("/login");
        } catch (error) {
            console.error("Erro ao fazer logout:", error);
        }
    };

    useEffect(() => {
        const fetchUser = async () => {
            try {
                const res = await fetch("/api/auth/me");
                if (res.ok) {
                    const data = await res.json();
                    setUser(data.user);

                    if (data.user?.perfil === "CONSUMER") {
                        router.push("/reservas");
                    }
                }
            } catch (err) {
                console.error("Erro ao carregar usuário:", err);
            }
        };

        fetchUser();

        fetch("/api/produtos")
            .then(res => res.json())
            .then((data: any) => {
                if (Array.isArray(data)) {
                    setProducts(data.filter((p: Product) => p.ativo && (p.estoque > 0 || p.isGroup)));
                } else {
                    console.error("API /api/produtos não retornou um array:", data);
                }
                setLoading(false);
            })
            .catch((err: any) => {
                console.error("Erro ao carregar produtos:", err);
                setLoading(false);
            });
    }, []);

    const cartItems = products.filter((p: any) => cart[p.id] > 0);

    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (isModalOpen && Object.keys(cart).length > 0) {
                const releaseData = {
                    action: "liberar",
                    itens: cartItems.map((p: any) => ({
                        produtoId: p.id,
                        quantidade: cart[p.id]
                    }))
                };
                const blob = new Blob([JSON.stringify(releaseData)], { type: 'application/json' });
                navigator.sendBeacon("/api/pdv/estoque", blob);
            }
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, [isModalOpen, cart, cartItems]);

    const total = useMemo(() => {
        return Object.entries(cart).reduce((acc: any, [id, qty]) => {
            const product = products.find((p: any) => p.id === id);
            return acc + (product?.preco || 0) * qty;
        }, 0);
    }, [cart, products]);

    const { showToast } = useToast();

    const updateQuantity = (id: string, delta: number) => {
        const product = products.find((p: any) => p.id === id);
        if (!product) return;

        setCart((prev: any) => {
            const current = prev[id] || 0;
            const next = Math.max(0, current + delta);

            if (next > product.estoque) {
                showToast(`Estoque insuficiente. Apenas ${product.estoque} disponível(is).`, "error");
                return prev;
            }

            if (next === 0) {
                const { [id]: _, ...rest } = prev;
                return rest;
            }
            return { ...prev, [id]: next };
        });
    };

    const pixPayload = useMemo(() => {
        if (total <= 0) return "";
        return montarPayloadPix({
            chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "",
            nome: process.env.NEXT_PUBLIC_PIX_NOME_RECEBEDOR || "Comissao GerminareTECH",
            cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "Sao Paulo",
            valor: total.toFixed(2)
        });
    }, [total]);

    const validateStock = async (): Promise<boolean> => {
        try {
            const res = await fetch("/api/produtos");
            if (!res.ok) throw new Error("Falha ao buscar produtos");
            const latestProducts: Product[] = await res.json();

            setProducts(latestProducts.filter((p) => p.ativo && (p.estoque > 0 || p.isGroup)));

            let isValid = true;
            let errorMessage = "";

            cartItems.forEach((cartItem) => {
                const latestProduct = latestProducts.find(p => p.id === cartItem.id);
                const requestedQty = cart[cartItem.id];
                const availableStock = latestProduct?.estoque || 0;

                if (requestedQty > availableStock) {
                    isValid = false;
                    errorMessage = `Estoque insuficiente for ${cartItem.nome}. Solicitado: ${requestedQty}, Disponível: ${availableStock}.`;

                    setCart((prev) => {
                        if (availableStock === 0) {
                            const { [cartItem.id]: _, ...rest } = prev;
                            return rest;
                        }
                        return { ...prev, [cartItem.id]: availableStock };
                    });
                }
            });

            if (!isValid) {
                showToast(errorMessage, "error");
                setIsModalOpen(false);
            }

            return isValid;
        } catch (error) {
            console.error("Erro ao validar estoque:", error);
            showToast("Erro ao verificar estoque atualizado.", "error");
            return false;
        }
    };

    const handleReleaseStock = async () => {
        if (Object.keys(cart).length === 0) return;

        const releaseData = {
            action: "liberar",
            itens: cartItems.map((p: any) => ({
                produtoId: p.id,
                quantidade: cart[p.id]
            }))
        };

        try {
            await fetch("/api/pdv/estoque", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(releaseData)
            });
        } catch (error) {
            console.error("Falha ao liberar:", error);
        }
    };

    const handleCloseModal = async () => {
        setIsSaving(true);
        await handleReleaseStock();
        fetch("/api/produtos")
            .then(res => res.json())
            .then((data: any[]) => setProducts(data.filter((p: Product) => p.ativo && (p.estoque > 0 || p.isGroup))));
        setIsSaving(false);
        setIsModalOpen(false);
    };

    const handleCheckout = async () => {
        if (total <= 0) return;

        setIsSaving(true);
        try {
            const reserveData = {
                action: "reservar",
                itens: cartItems.map((p: any) => ({
                    produtoId: p.id,
                    quantidade: cart[p.id]
                }))
            };

            const res = await fetch("/api/pdv/estoque", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(reserveData)
            });

            if (!res.ok) {
                const errorData = await res.json();
                showToast(errorData.error || "Erro ao reservar estoque.", "error");
                await validateStock();
                setIsSaving(false);
                return;
            }

            setIsModalOpen(true);
        } catch (error) {
            console.error("Erro ao reservar:", error);
            showToast("Erro de conexão ao reservar estoque.", "error");
        }

        setIsSaving(false);
    };

    const handleConfirmSale = async () => {
        if (isSaving) return;
        setIsSaving(true);

        try {
            const saleData = {
                total,
                itens: cartItems.map((p: any) => ({
                    produtoId: p.id,
                    quantidade: cart[p.id],
                    precoUnitario: p.preco
                })),
                estoqueJaDescontado: true
            };

            const response = await fetch("/api/vendas", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(saleData)
            });

            if (response.ok) {
                setCart({});
                setIsModalOpen(false);
                setShowConfirmation(true);
                setIsUpdatingStock(true);

                fetch("/api/produtos")
                    .then(res => res.json())
                    .then((data: any[]) => {
                        if (Array.isArray(data)) {
                            setProducts(data.filter((p: Product) => p.ativo && (p.estoque > 0 || p.isGroup)));
                        } else {
                            console.error("API /api/produtos não retornou um array (estoque visual):", data);
                        }
                        setIsUpdatingStock(false);
                    })
                    .catch(err => {
                        console.error("Erro ao atualizar estoque visual:", err);
                        setIsUpdatingStock(false);
                    });

            } else {
                showToast("Erro ao registrar venda.", "error");
            }
        } catch (error) {
            console.error("Erro ao salvar venda:", error);
            showToast("Erro de conexão ao salvar venda.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const toggleGroup = (id: string) => {
        setExpandedGroups(prev => ({ ...prev, [id]: !prev[id] }));
    };


    // --- Otimizações de Memória (useMemo) ---
    const parentMap = useMemo(() => {
        const map: Record<string, any> = {};
        products.forEach(p => map[p.id] = p);
        return map;
    }, [products]);

    const topLevelProducts = useMemo(() => {
        return products.filter((p: any) => {
            if (!p.produtoPaiId) return true;
            const parent = parentMap[p.produtoPaiId];
            return p.isPromocional && parent && !parent.isGroup;
        });
    }, [products, parentMap]);

    const childrenMap = useMemo(() => {
        const map: Record<string, any[]> = {};
        products.forEach((p: any) => {
            if (p.produtoPaiId && parentMap[p.produtoPaiId]?.isGroup) {
                if (!map[p.produtoPaiId]) map[p.produtoPaiId] = [];
                map[p.produtoPaiId].push(p);
            }
        });
        Object.keys(map).forEach(k => map[k].sort((a, b) => a.preco - b.preco));
        return map;
    }, [products, parentMap]);
    // ----------------------------------------

    let visibleItemCount = 0;

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background-light">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="relative mx-auto min-h-screen max-w-md bg-background-light pb-32 font-sans overflow-hidden">
            {showConfirmation && (
                <div className="fixed inset-0 z-[100] bg-white animate-in fade-in duration-300 flex flex-col items-center justify-between p-8 text-center min-h-screen max-w-md mx-auto">
                    <div className="flex-1 flex flex-col items-center justify-center space-y-8 mt-20">
                        <div className="relative size-48 flex items-center justify-center">
                            <div className="absolute inset-0 bg-emerald-100 rounded-full animate-in zoom-in-50 duration-500 fill-mode-both"></div>

                            <div className="relative size-24 text-emerald-500 overflow-hidden flex items-center justify-center">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full drop-shadow-sm">
                                    <path d="M20 6L9 17L4 12" className="animate-checkmark" style={{ strokeDasharray: 100, strokeDashoffset: 100, animation: 'checkmark 0.8s ease-in-out forwards 0.2s' }} />
                                </svg>
                            </div>
                        </div>

                        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300 fill-mode-both text-center flex flex-col items-center w-full">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tight">Venda Confirmada!</h2>
                            <p className="text-slate-500 font-medium max-w-[280px]">
                                O pagamento foi processado e a venda registrada com sucesso.
                            </p>
                        </div>
                    </div>

                    {isUpdatingStock ? (
                        <div className="flex flex-col items-center gap-2 py-5 animate-in fade-in duration-300">
                            <Loader2 className="size-6 animate-spin text-emerald-500" />
                            <span className="text-xs font-bold text-emerald-600 uppercase tracking-widest">Atualizando Estoque...</span>
                        </div>
                    ) : (
                        <button onClick={() => setShowConfirmation(false)} className="w-full py-5 bg-emerald-100 text-emerald-700 font-black rounded-3xl text-xl shadow-lg shadow-emerald-500/10 active:scale-[0.97] transition-all animate-in slide-in-from-bottom-8 duration-500 fill-mode-both uppercase tracking-widest">
                            Continuar
                        </button>
                    )}

                    <style jsx global>{`
                        @keyframes checkmark {
                            to {
                                stroke-dashoffset: 0;
                            }
                        }
                        .animate-checkmark {
                            animation: checkmark 0.8s ease-in-out forwards;
                        }
                    `}</style>
                </div>
            )}

            <header className="sticky top-0 z-30 flex items-center justify-between bg-white/80 px-4 py-4 backdrop-blur-md border-b border-slate-200 shadow-sm transition-all duration-300">
                <div className="flex items-center gap-3">
                    <button onClick={() => router.push("/")} className="cursor-pointer mr-1 p-2 rounded-full hover:bg-slate-100/50 text-slate-500 transition-colors" title="Voltar ao Painel">
                        <ArrowLeft className="size-5" />
                    </button>
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary border border-primary/20 shadow-inner">
                        <User className="size-5" />
                    </div>
                    <div>
                        <h1 className="text-base font-black leading-tight tracking-tight text-slate-900">
                            {user?.nome || "Vendedor do PDV"}
                        </h1>
                        <p className="text-[9px] font-black text-primary/80 uppercase tracking-[0.2em]">{user?.perfil === 'ADMIN' ? 'Administrador' : 'Vendedor'}</p>
                    </div>
                </div>
                <button onClick={handleLogout} className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 active:scale-95 border border-transparent hover:border-red-100">
                    <LogOut className="size-4" />
                </button>
            </header>

            <main className="p-4 space-y-5 animate-in fade-in duration-500 relative z-10 w-full">
                <div className="flex items-center justify-between py-2 sticky top-[72px] z-20 bg-background-light/95 backdrop-blur-md pb-2 pt-1 border-b border-transparent -mx-4 px-4 mb-4">
                    <h2 className="text-xl font-black tracking-tight text-slate-900 flex items-center gap-2">
                        Produtos
                        <span className="flex items-center justify-center bg-primary/10 text-primary text-[10px] px-2 py-0.5 rounded-md uppercase tracking-wider font-extrabold h-5">{products.length} ITENS</span>
                    </h2>
                    <button
                        onClick={() => router.push("/pdv/rifas")}
                        className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-700 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-colors"
                    >
                        <Ticket className="size-3.5" />
                        Rifas
                    </button>
                </div>

                <div className="grid gap-4">
                    {topLevelProducts.map((product: any) => {
                        if (product.isGroup) {
                            const children = childrenMap[product.id] || [];
                            if (children.length === 0) return null;

                            const minPrice = Math.min(...children.map(c => c.preco));
                            const totalStock = children.reduce((acc, c) => acc + c.estoque, 0);
                            const isExpanded = expandedGroups[product.id];
                            const Icon = getIcon(product.nome, true);

                            // Highlight group if any children are in cart
                            const hasItemsInCart = children.some(c => cart[c.id] > 0);
                            const totalItemsInCart = children.reduce((acc, c) => acc + (cart[c.id] || 0), 0);

                            return (
                                <div key={product.id} className={`flex flex-col rounded-[1.5rem] bg-white shadow-sm border transition-all duration-300 ${isExpanded ? 'border-primary/30 shadow-md ring-4 ring-primary/5' : hasItemsInCart ? 'border-primary/20 bg-primary/[0.02]' : 'border-slate-100 hover:border-slate-200'}`}>
                                    <div
                                        className="p-4 flex gap-4 cursor-pointer group"
                                        onClick={() => toggleGroup(product.id)}
                                    >
                                        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-[1rem] bg-slate-50 flex items-center justify-center border border-slate-100/60 shadow-inner group-hover:shadow-md transition-shadow relative">
                                            {hasItemsInCart && (
                                                <div className="absolute -top-1 -right-1 size-5 bg-primary text-white text-[10px] font-black rounded-full flex items-center justify-center shadow-lg border-2 border-white z-10 animate-in zoom-in">
                                                    {totalItemsInCart}
                                                </div>
                                            )}
                                            {product.imagemUrl ? (
                                                <img alt={product.nome} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" src={product.imagemUrl} />
                                            ) : (
                                                <Icon className="size-8 text-slate-300 group-hover:text-primary/70 transition-colors" />
                                            )}
                                        </div>
                                        <div className="flex flex-1 justify-between flex-col">
                                            <div className="flex justify-between items-start">
                                                <h3 className="text-[17px] font-black text-slate-900 leading-tight">
                                                    Grupo - {product.nome}
                                                </h3>
                                                <button className={`p-2 rounded-xl transition-colors ${isExpanded ? 'bg-primary/10 text-primary' : 'bg-slate-50 text-slate-400 group-hover:bg-slate-100'}`}>
                                                    {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                                                </button>
                                            </div>
                                            <div className="flex items-end justify-between">
                                                <div>
                                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">A PARTIR DE</span>
                                                    <p className="text-xl font-black text-primary leading-none tracking-tight">
                                                        R$ {minPrice.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                    </p>
                                                </div>
                                                <span className={`text-[9px] font-black uppercase tracking-[0.15em] px-2.5 py-1 rounded-md shadow-sm ${totalStock > 0 ? 'bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-600 border border-emerald-200/50' : 'bg-rose-50 text-rose-600 border border-rose-100'}`}>
                                                    Estoque: {totalStock}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Children Accordion */}
                                    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'}`}>
                                        <div className="p-4 pt-1 border-t border-slate-100/80 bg-slate-50/50 rounded-b-[1.5rem]">
                                            <div className="flex flex-col gap-3 mt-3">
                                                {children.map(child => {
                                                    const ChildIcon = getIcon(child.nome);
                                                    return (
                                                    <div key={child.id} className="flex items-center gap-3 p-3 rounded-[1rem] bg-white border border-slate-100 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all hover:border-primary/20">
                                                        {/* Child Product Image */}
                                                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[0.7rem] bg-slate-50 flex items-center justify-center border border-slate-100/60">
                                                            {child.imagemUrl ? (
                                                                <img alt={child.nome} className="h-full w-full object-cover" src={child.imagemUrl} />
                                                            ) : (
                                                                <ChildIcon className="size-5 text-slate-300" />
                                                            )}
                                                        </div>
                                                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                            <div className="font-bold text-slate-800 text-[15px] leading-tight flex items-center gap-2">
                                                                {child.nome}
                                                                {(child.temDesconto || child.isPromocional) && (
                                                                    <span className="bg-amber-100 text-amber-700 text-[8px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-tighter shrink-0 border border-amber-200">
                                                                        PROMO
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                {child.temDesconto && child.precoOriginal && (
                                                                    <span className="text-[10px] font-bold text-slate-400 line-through leading-none">
                                                                        R$ {child.precoOriginal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                                    </span>
                                                                )}
                                                                <span className="text-sm font-black text-slate-600">
                                                                    R$ {child.preco.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                                </span>
                                                                <span className={`text-[9px] font-black uppercase tracking-[0.1em] px-2 py-0.5 rounded-md shadow-sm border ${child.estoque > 5 ? 'bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-600 border-emerald-200/50' : child.estoque > 0 ? 'bg-gradient-to-r from-amber-50 to-amber-100 text-amber-600 border-amber-200/50' : 'bg-rose-50 text-rose-600 border-rose-100'}`}>
                                                                    Estoque: {child.estoque}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3 shrink-0 bg-slate-50/80 p-1 rounded-[1rem] border border-slate-100/50">
                                                            <button
                                                                onClick={() => updateQuantity(child.id, -1)}
                                                                disabled={!cart[child.id]}
                                                                className={`flex h-8 w-8 items-center justify-center rounded-[0.7rem] transition-all duration-200 active:scale-95 ${cart[child.id] ? "bg-white text-slate-900 shadow-[0_1px_3px_rgba(0,0,0,0.1)] active:bg-slate-100 border border-slate-200" : "bg-transparent text-slate-300 cursor-not-allowed"}`}
                                                            >
                                                                <Minus className="size-4" strokeWidth={3} />
                                                            </button>
                                                            <span className="w-5 text-center text-sm font-black text-slate-800">{cart[child.id] || 0}</span>
                                                            <button
                                                                onClick={() => updateQuantity(child.id, 1)}
                                                                disabled={child.estoque <= 0 || (cart[child.id] || 0) >= child.estoque}
                                                                className={`flex h-8 w-8 items-center justify-center rounded-[0.7rem] transition-all duration-200 active:scale-95 shadow-[0_2px_5px_rgba(0,0,0,0.08)] ${child.estoque <= 0 || (cart[child.id] || 0) >= child.estoque ? "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200/50 shadow-none" : "bg-primary text-white hover:bg-primary/95 hover:shadow-primary/30 active:bg-primary/90"}`}
                                                            >
                                                                <Plus className="size-4" strokeWidth={3} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        } else {
                            // Render Simple Product Card
                            const Icon = getIcon(product.nome);
                            const hasItemsInCart = cart[product.id] > 0;

                            return (
                                <div key={product.id} className={`flex flex-col gap-4 rounded-[1.5rem] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.02)] border transition-all duration-300 hover:shadow-md ${hasItemsInCart ? 'border-primary/20 bg-primary/[0.02]' : 'border-slate-100 hover:border-slate-200'}`}>
                                    <div className="flex gap-4">
                                        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-[1.2rem] bg-slate-50 flex items-center justify-center border border-slate-100 shadow-inner group">
                                            {product.imagemUrl ? (
                                                <img alt={product.nome} className="h-full w-full object-cover transition-transform duration-500 hover:scale-110" src={product.imagemUrl} />
                                            ) : (
                                                <Icon className="size-8 text-slate-300 transition-colors" />
                                            )}
                                        </div>
                                        <div className="flex flex-1 flex-col justify-between py-1">
                                            <div>
                                                <h3 className="text-[17px] font-black text-slate-900 flex items-center gap-2 leading-tight tracking-tight mb-1">
                                                    {product.nome}
                                                    {(product.temDesconto || product.isPromocional) && (
                                                        <span className="bg-amber-100 text-amber-700 text-[8px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-tighter shrink-0 border border-amber-200">
                                                            PROMO
                                                        </span>
                                                    )}
                                                </h3>
                                                <div className="flex justify-between items-start mt-2">
                                                    <div className="flex flex-col">
                                                        {product.temDesconto && product.precoOriginal && (
                                                            <span className="text-[10px] font-bold text-slate-400 line-through leading-none mb-0.5">
                                                                R$ {product.precoOriginal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                            </span>
                                                        )}
                                                        <p className="text-lg font-black text-primary leading-none tracking-tight">
                                                            R$ {product.preco.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                        </p>
                                                    </div>
                                                    <span className={`text-[9px] font-black uppercase tracking-[0.15em] px-2 py-1 rounded-md shadow-sm border ${product.estoque > 5 ? 'bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-600 border-emerald-200/50' : product.estoque > 0 ? 'bg-gradient-to-r from-amber-50 to-amber-100 text-amber-600 border-amber-200/50' : 'bg-rose-50 text-rose-600 border-rose-100'}`}>
                                                        Estoque: {product.estoque}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-end gap-3 mt-3">
                                                <div className="flex items-center gap-3 bg-slate-50/80 p-1.5 rounded-[1rem] border border-slate-100">
                                                    <button
                                                        onClick={() => updateQuantity(product.id, -1)}
                                                        disabled={!cart[product.id]}
                                                        className={`flex h-9 w-9 items-center justify-center rounded-[0.8rem] transition-all active:scale-95 ${cart[product.id] ? "bg-white text-slate-900 shadow-[0_2px_5px_rgba(0,0,0,0.06)] active:bg-slate-100 border border-slate-200/80" : "bg-transparent text-slate-300 cursor-not-allowed"}`}
                                                    >
                                                        <Minus className="size-4" strokeWidth={3} />
                                                    </button>
                                                    <span className="w-5 text-center text-base font-black text-slate-800">{cart[product.id] || 0}</span>
                                                    <button
                                                        onClick={() => updateQuantity(product.id, 1)}
                                                        disabled={product.estoque <= 0 || (cart[product.id] || 0) >= product.estoque}
                                                        className={`flex h-9 w-9 items-center justify-center rounded-[0.8rem] shadow-[0_2px_6px_rgba(0,0,0,0.08)] active:scale-95 transition-all ${product.estoque <= 0 || (cart[product.id] || 0) >= product.estoque ? "bg-slate-100 text-slate-400 cursor-not-allowed shadow-none border border-slate-200/50" : "bg-primary text-white hover:bg-primary/95 hover:shadow-primary/30 active:bg-primary/90"}`}
                                                    >
                                                        <Plus className="size-4" strokeWidth={3} />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        }
                    })}
                </div>
            </main>

            {/* Fixed Footer */}
            <footer className="fixed bottom-0 left-0 right-0 z-40 mx-auto max-w-md border-t border-slate-200 bg-white/95 backdrop-blur-md p-4 pt-3 pb-6 shadow-[0_-10px_40px_rgba(0,0,0,0.06)] rounded-t-[1.5rem]">
                <div className="mb-3 flex items-center justify-between px-2">
                    <span className="text-slate-500 font-bold text-sm tracking-wide">Total do Pedido</span>
                    <span className="text-2xl font-black text-slate-900 tracking-tight">
                        R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                    </span>
                </div>
                <button
                    onClick={handleCheckout}
                    disabled={total === 0 || isSaving}
                    className={`flex w-full items-center justify-center gap-3 rounded-[1.2rem] py-4.5 h-[56px] text-[17px] font-black text-white shadow-xl transition-all duration-300 active:scale-[0.98] tracking-widest uppercase ${total > 0 && !isSaving ? "bg-primary shadow-primary/30 hover:bg-primary/95" : "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none"}`}
                >
                    {isSaving ? <Loader2 className="size-6 animate-spin" /> : <ShoppingCart className="size-5" />}
                    Ir para Pagamento
                </button>
            </footer>

            {/* Payment Modal (Bottom Sheet) */}
            <div className={`fixed inset-0 z-50 flex flex-col items-center justify-end bg-slate-900/40 backdrop-blur-sm transition-all duration-500 ${isModalOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}>
                <div className={`w-full max-w-md transform rounded-t-[2rem] bg-white p-6 pb-12 transition-transform duration-500 shadow-[0_-20px_60px_rgba(0,0,0,0.15)] ease-[cubic-bezier(0.32,0.72,0,1)] ${isModalOpen ? "translate-y-0" : "translate-y-full"}`}>
                    <div className="mx-auto mb-6 h-1.5 w-14 rounded-full bg-slate-200"></div>

                    <div className="flex justify-between items-start mb-6">
                        <div className="text-left">
                            <h3 className="text-2xl font-black tracking-tight text-slate-900">Resumo da Venda</h3>
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Escaneie para pagar</p>
                        </div>
                        <button onClick={handleCloseModal} className="p-2.5 rounded-full hover:bg-slate-100 text-slate-400 transition-colors bg-slate-50 border border-slate-100">
                            <X className="size-5" strokeWidth={3} />
                        </button>
                    </div>

                    <div className="my-6 space-y-3 rounded-[1.2rem] bg-slate-50 p-5 border border-slate-100 shadow-inner">
                        {cartItems.map((p: any) => (
                            <div key={p.id} className="flex justify-between text-[15px] items-center">
                                <span className="text-slate-700 font-bold flex items-center gap-2">
                                    <span className="bg-white text-slate-500 text-[11px] font-black px-1.5 py-0.5 rounded-md border shadow-sm">
                                        {cart[p.id]}x
                                    </span>
                                    {p.nome}
                                    {(p.temDesconto || p.isPromocional) && (
                                        <span className="bg-amber-100 text-amber-700 text-[8px] font-black px-1.5 py-0.5 rounded uppercase shrink-0 border border-amber-200/50">
                                            PROMO
                                        </span>
                                    )}
                                </span>
                                <span className="font-black text-slate-900 tracking-tight">
                                    R$ {(p.preco * cart[p.id]).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                </span>
                            </div>
                        ))}
                        <div className="mt-4 border-t border-slate-200/60 pt-4 flex justify-between items-end">
                            <span className="font-bold text-slate-400 uppercase text-xs tracking-widest">Total a Pagar</span>
                            <span className="font-black text-primary text-2xl tracking-tight leading-none">R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                        </div>
                    </div>

                    <div className="flex flex-col items-center gap-4 py-4">
                        <div className="relative rounded-[2rem] border-8 border-slate-50 p-4 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
                            {pixPayload && (
                                <QRCodeSVG value={pixPayload} size={200} level="M" includeMargin={false} />
                            )}
                        </div>
                        <span className="text-[10px] font-black text-slate-400 tracking-[0.2em] uppercase bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200/50">
                            PIX DINÂMICO GERADO
                        </span>
                    </div>

                    <div className="mt-8 flex flex-col gap-3">
                        <button onClick={handleConfirmSale} disabled={isSaving} className="flex w-full items-center justify-center rounded-[1.2rem] h-[56px] bg-emerald-500 text-[17px] font-black text-white shadow-xl shadow-emerald-500/20 active:scale-[0.98] disabled:opacity-50 transition-all duration-300 uppercase tracking-widest">
                            {isSaving ? <Loader2 className="size-5 animate-spin mr-3" /> : <CheckCircle2 className="size-6 mr-3" />}
                            Confirmar Pagamento
                        </button>
                        <button onClick={handleCloseModal} className="w-full h-[48px] text-[13px] font-black text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-[1.2rem] transition-colors uppercase tracking-widest">
                            Cancelar Venda
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
