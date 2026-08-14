"use client";

import React, { useEffect, useState } from "react";
import {
    Plus,
    Edit,
    Utensils,
    Beer,
    Cookie,
    Loader2,
    Check,
    ImageIcon,
    X,
    Eye,
    EyeOff,
    ChevronDown,
    ChevronRight,
    Layers
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface Product {
    id: string;
    nome: string;
    preco: number;
    ativo: boolean;
    imagemUrl?: string;
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

export default function GestaoProdutos() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [showInactive, setShowInactive] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

    const [newProduct, setNewProduct] = useState({
        nome: "",
        preco: "",
        ativo: true,
        imagemUrl: "",
        tipo: "PRODUTO" as "PRODUTO" | "GRUPO",
        produtoPaiId: ""
    });
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const { showToast } = useToast();

    const loadProducts = () => {
        setLoading(true);
        fetch("/api/produtos?adminView=true")
            .then(res => res.json())
            .then((data: any) => {
                setProducts(data);
                setLoading(false);
            })
            .catch((err: any) => {
                console.error("Erro ao carregar produtos:", err);
                setLoading(false);
            });
    };

    useEffect(() => {
        loadProducts();
    }, []);

    const toggleStatus = async (id: string, currentStatus: boolean) => {
        try {
            const isGroupToggle = products.find(p => p.id === id)?.isGroup;

            const newProducts = products.map((p: any) => {
                if (p.id === id) return { ...p, ativo: !currentStatus };
                if (isGroupToggle && p.produtoPaiId === id) return { ...p, ativo: !currentStatus };
                return p;
            });

            setProducts(newProducts);

            const response = await fetch(`/api/produtos/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ativo: !currentStatus })
            });

            if (response.ok) {
                showToast(`Produto ${!currentStatus ? "ativado" : "inativado"} com sucesso!`, "success");
            } else {
                setProducts(products);
                showToast("Erro ao atualizar status do produto.", "error");
            }
        } catch (error) {
            console.error("Erro ao atualizar status:", error);
            setProducts(products);
            showToast("Erro de conexão ao atualizar status.", "error");
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProduct.nome) {
            showToast("Nome é obrigatório.", "warning");
            return;
        }
        if (newProduct.tipo !== "GRUPO" && !newProduct.preco) {
            showToast("Preço é obrigatório.", "warning");
            return;
        }

        setIsSaving(true);
        try {
            const url = editingProduct ? `/api/produtos/${editingProduct.id}` : "/api/produtos";
            const method = editingProduct ? "PUT" : "POST";

            const formData = new FormData();
            formData.append("nome", newProduct.nome);
            formData.append("preco", newProduct.tipo === "GRUPO" ? "0" : newProduct.preco.replace(",", "."));
            formData.append("ativo", String(newProduct.ativo));
            
            const isGroupValue = newProduct.tipo === "GRUPO";
            formData.append("isGroup", String(isGroupValue));
            if (newProduct.tipo !== "GRUPO" && newProduct.produtoPaiId) {
                formData.append("produtoPaiId", newProduct.produtoPaiId);
            } else if (editingProduct && newProduct.tipo !== "GRUPO") {
                formData.append("produtoPaiId", ""); // clear if unselected
            }

            if (selectedFile) {
                formData.append("imagem", selectedFile);
            } else if (newProduct.imagemUrl) {
                formData.append("imagemUrl", newProduct.imagemUrl);
            }

            const response = await fetch(url, {
                method,
                body: formData
            });

            if (response.ok) {
                handleCloseModal();
                loadProducts();
                showToast(
                    editingProduct ? "Produto atualizado com sucesso!" : "Produto cadastrado com sucesso!",
                    "success"
                );
            } else {
                const errData = await response.json().catch(() => null);
                console.error("Erro API:", errData);
                showToast(
                    editingProduct ? "Erro ao atualizar produto." : "Erro ao cadastrar produto.",
                    "error"
                );
            }
        } catch (error) {
            console.error("Erro ao salvar:", error);
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const handleEdit = (product: Product) => {
        setEditingProduct(product);
        let tipo: "PRODUTO" | "GRUPO" = "PRODUTO";
        if (product.isGroup) tipo = "GRUPO";

        setNewProduct({
            nome: product.nome,
            preco: product.preco.toString().replace(".", ","),
            ativo: product.ativo,
            imagemUrl: product.imagemUrl || "",
            tipo,
            produtoPaiId: product.produtoPaiId || ""
        });
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setEditingProduct(null);
        setNewProduct({ nome: "", preco: "", ativo: true, imagemUrl: "", tipo: "PRODUTO", produtoPaiId: "" });
        setSelectedFile(null);
        setPreviewUrl(null);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedFile(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setPreviewUrl(reader.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    const toggleGroup = (id: string) => {
        setExpandedGroups(prev => ({ ...prev, [id]: !prev[id] }));
    };

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    const totalItens = products.filter(p => !p.isGroup).length;
    const itensAtivos = products.filter((p: any) => p.ativo && !p.isGroup).length;
    const groups = products.filter(p => p.isGroup);

    // Filtragem de inativos e ordenação (hierarquia)
    const visibleProducts = products.filter(p => showInactive ? true : p.ativo);
    const topLevelProducts = visibleProducts.filter(p => !p.produtoPaiId);

    const getChildren = (parentId: string) => visibleProducts.filter(p => p.produtoPaiId === parentId);

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            <div className="bg-white border-b border-slate-200 p-4 md:p-8 shrink-0">
                <div className="max-w-6xl mx-auto">
                    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                        <div>
                            <div className="flex justify-between items-center gap-4">
                                <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">Gestão de Cardápio</h2>
                            </div>
                            <p className="text-sm text-slate-500 mt-1">Gerencie os produtos e preços disponíveis para o evento.</p>
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
                                <span>Novo Produto</span>
                            </button>
                        </div>
                    </header>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total</span>
                            <span className="text-2xl font-black text-slate-900">{totalItens}</span>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ativos</span>
                            <span className="text-2xl font-black text-emerald-500">{itensAtivos}</span>
                        </div>
                        <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Geral</span>
                            <span className="text-2xl font-black text-primary">PDV</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-hidden p-4 md:p-8 flex flex-col">
                <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="flex-1 overflow-auto custom-scrollbar">
                        <table className="w-full text-left border-collapse min-w-[800px]">
                            <thead className="sticky top-0 z-20">
                                <tr className="bg-slate-50/95 backdrop-blur-sm shadow-sm">
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Produto</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Preço</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Status</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {topLevelProducts.map((product) => {
                                    const Icon = getIcon(product.nome, product.isGroup);
                                    const isExpanded = expandedGroups[product.id];
                                    const productChildren = getChildren(product.id);
                                    
                                    const ProductRow = ({ p, isChild = false }: { p: Product, isChild?: boolean }) => {
                                        const CIcon = getIcon(p.nome, p.isGroup);
                                        return (
                                            <tr key={p.id} className={`hover:bg-slate-50/50 transition-colors group ${isChild ? 'bg-slate-50/30' : ''}`}>
                                                <td className="px-6 py-5">
                                                    <div className={`flex items-center gap-4 ${isChild ? 'pl-8' : ''}`}>
                                                        {!isChild && p.isGroup && (
                                                            <button 
                                                                onClick={() => toggleGroup(p.id)}
                                                                className="p-1 rounded bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                                                            >
                                                                {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                                                            </button>
                                                        )}
                                                        <div className={`rounded-xl bg-slate-50 border border-slate-100 overflow-hidden flex items-center justify-center transition-all ${isChild ? 'size-8' : 'size-12'}`}>
                                                            {p.imagemUrl ? (
                                                                <img src={p.imagemUrl} alt={p.nome} className="w-full h-full object-cover" />
                                                            ) : (
                                                                <CIcon className={`${isChild ? 'size-4' : 'size-6'} text-slate-300`} />
                                                            )}
                                                        </div>
                                                        <span className={`${isChild ? 'font-bold text-sm' : 'font-black'} text-slate-900 flex items-center gap-2`}>
                                                            {p.nome}
                                                            {p.isGroup && <span className="bg-primary/10 text-primary text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider">GRUPO</span>}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-5">
                                                    {p.isGroup ? (
                                                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{productChildren.length} Opções</span>
                                                    ) : (
                                                        <span className="font-medium text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-100/50">
                                                            R$ {p.preco.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-5">
                                                    <div className="flex items-center gap-3">
                                                        <button
                                                            onClick={() => toggleStatus(p.id, p.ativo)}
                                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all shadow-inner cursor-pointer ${p.ativo ? "bg-primary" : "bg-slate-200"}`}
                                                        >
                                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${p.ativo ? "translate-x-6 shadow-[-2px_0_5px_rgba(0,0,0,0.1)]" : "translate-x-1 shadow-[2px_0_5px_rgba(0,0,0,0.1)]"}`} />
                                                        </button>
                                                        <span className={`text-[10px] font-black uppercase tracking-widest ${p.ativo ? "text-primary" : "text-slate-400"}`}>
                                                            {p.ativo ? "Ativo" : "Inativo"}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-5 text-right">
                                                    <div className="flex items-center justify-end gap-1">
                                                        {p.isGroup && (
                                                            <button
                                                                onClick={() => {
                                                                    setNewProduct({
                                                                        nome: "", preco: "", ativo: true, imagemUrl: "", tipo: "PRODUTO", produtoPaiId: p.id
                                                                    });
                                                                    setIsModalOpen(true);
                                                                }}
                                                                title="Adicionar Sabor"
                                                                className="p-2.5 text-slate-400 hover:text-emerald-500 transition-all hover:bg-emerald-50 rounded-xl group-hover:scale-110"
                                                            >
                                                                <Plus className="size-5" />
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => handleEdit(p)}
                                                            className="p-2.5 text-slate-400 hover:text-primary transition-all hover:bg-primary/5 rounded-xl group-hover:scale-110"
                                                        >
                                                            <Edit className="size-5" />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    }

                                    return (
                                        <React.Fragment key={product.id}>
                                            <ProductRow p={product} />
                                            {isExpanded && productChildren.map(child => (
                                                <ProductRow key={child.id} p={child} isChild={true} />
                                            ))}
                                        </React.Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border-4 border-white flex flex-col max-h-[90vh]">
                        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                            <h3 className="text-2xl font-black text-slate-900 uppercase">
                                {editingProduct ? "Editar" : "Novo"} Produto
                            </h3>
                            <button onClick={handleCloseModal} className="p-2 rounded-xl hover:bg-slate-200 text-slate-400 transition-colors">
                                <X className="size-6" />
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="p-8 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                            <div className="space-y-4">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Tipo do Item</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {['PRODUTO', 'GRUPO'].map((t) => (
                                        <button
                                            key={t}
                                            type="button"
                                            onClick={() => setNewProduct({ ...newProduct, tipo: t as any, produtoPaiId: "" })}
                                            className={`py-2 text-[10px] font-bold rounded-xl border-2 uppercase tracking-wide transition-all ${newProduct.tipo === t ? 'bg-primary/10 border-primary text-primary' : 'bg-slate-50 border-slate-100 text-slate-400 hover:bg-slate-100'}`}
                                        >
                                            {t === 'PRODUTO' ? 'Produto' : 'Grupo'}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {newProduct.tipo !== "GRUPO" && (
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Grupo Pertencente (Opcional)</label>
                                    <select
                                        value={newProduct.produtoPaiId}
                                        onChange={(e) => setNewProduct({ ...newProduct, produtoPaiId: e.target.value })}
                                        className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-bold"
                                    >
                                        <option value="">Nenhum (Produto Solto)</option>
                                        {groups.map(g => (
                                            <option key={g.id} value={g.id}>{g.nome}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            <div className="space-y-2">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">{newProduct.tipo === 'GRUPO' ? 'Nome do Grupo' : 'Nome do Produto'}</label>
                                <input
                                    required
                                    type="text"
                                    value={newProduct.nome}
                                    onChange={(e: any) => setNewProduct({ ...newProduct, nome: e.target.value })}
                                    placeholder={newProduct.tipo === 'GRUPO' ? 'Ex: Bolo de Pote' : 'Ex: Sabor Morango'}
                                    className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-bold"
                                />
                            </div>

                            {newProduct.tipo !== "GRUPO" && (
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Preço (R$)</label>
                                        <input
                                            required
                                            type="text"
                                            value={newProduct.preco}
                                            onChange={(e: any) => setNewProduct({ ...newProduct, preco: e.target.value })}
                                            placeholder="0,00"
                                            className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-black text-xl"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Status Inicial</label>
                                        <div className="flex items-center gap-4 py-3">
                                            <button
                                                type="button"
                                                onClick={() => setNewProduct({ ...newProduct, ativo: !newProduct.ativo })}
                                                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-all shadow-inner ${newProduct.ativo ? "bg-primary" : "bg-slate-200"}`}
                                            >
                                                <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-all ${newProduct.ativo ? "translate-x-6" : "translate-x-1"}`} />
                                            </button>
                                            <span className="text-xs font-black uppercase text-slate-500">
                                                {newProduct.ativo ? "Ativo" : "Inativo"}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {(newProduct.tipo === "GRUPO") && (
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Status Inicial</label>
                                    <div className="flex items-center gap-4 py-3">
                                        <button
                                            type="button"
                                            onClick={() => setNewProduct({ ...newProduct, ativo: !newProduct.ativo })}
                                            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-all shadow-inner ${newProduct.ativo ? "bg-primary" : "bg-slate-200"}`}
                                        >
                                            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-all ${newProduct.ativo ? "translate-x-6" : "translate-x-1"}`} />
                                        </button>
                                        <span className="text-xs font-black uppercase text-slate-500">
                                            {newProduct.ativo ? "Ativo" : "Inativo"}
                                        </span>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-4">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Imagem</label>
                                {(previewUrl || newProduct.imagemUrl) ? (
                                    <div className="relative aspect-video rounded-3xl overflow-hidden border-2 border-slate-100 bg-slate-50 group">
                                        <img src={previewUrl || newProduct.imagemUrl} alt="Preview" className="w-full h-full object-cover" />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelectedFile(null);
                                                setPreviewUrl(null);
                                                setNewProduct(prev => ({ ...prev, imagemUrl: "" }));
                                            }}
                                            className="absolute top-4 right-4 p-2 bg-white/95 rounded-xl shadow-lg hover:bg-white text-rose-500 transition-all font-black text-xs flex items-center gap-2"
                                        >
                                            <X className="size-4" /> REMOVER
                                        </button>
                                    </div>
                                ) : (
                                    <label className="flex flex-col items-center justify-center w-full h-40 border-4 border-dashed border-slate-100 rounded-[2.5rem] hover:bg-slate-50 hover:border-primary/30 transition-all cursor-pointer group">
                                        <div className="flex flex-col items-center justify-center text-center px-4">
                                            <ImageIcon className="size-10 text-slate-300 group-hover:text-primary transition-colors mb-2" />
                                            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Clique para enviar</p>
                                        </div>
                                        <input type="file" className="hidden" accept="image/*" onChange={handleFileChange} />
                                    </label>
                                )}
                            </div>
                        </form>

                        <div className="p-8 border-t border-slate-100 flex gap-4 bg-slate-50 shrink-0">
                            <button type="button" onClick={handleCloseModal} className="flex-1 py-5 text-slate-500 font-bold rounded-2xl hover:bg-white transition-all border-2 border-slate-200 uppercase tracking-widest text-xs">
                                Cancelar
                            </button>
                            <button type="submit" onClick={handleSubmit} disabled={isSaving} className="flex-[1.5] py-5 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 shadow-xl shadow-primary/30 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 uppercase tracking-[0.2em] text-xs">
                                {isSaving ? <Loader2 className="size-5 animate-spin" /> : editingProduct ? "Salvar Alterações" : "Cadastrar"}
                                {!isSaving && <Check className="size-5" />}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
