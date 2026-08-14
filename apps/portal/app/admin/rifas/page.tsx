"use client";

import { useEffect, useState } from "react";
import {
    Loader2,
    Ticket,
    Search,
    Edit,
    X,
    Plus,
    Check,
    Trash2,
    RefreshCw,
    ExternalLink,
    ShoppingCart
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";

interface Rifa {
    id: string;
    titulo: string;
    descricao: string;
    imagemUrl?: string;
    precoPorNumero: number;
    quantidadeNumeros: number;
    status: string;
    dataSorteio?: string;
    criadoEm: string;
    _count?: { numeros: number };
}

export default function GestaoRifas() {
    const [rifas, setRifas] = useState<Rifa[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    
    // Modal state
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingRifa, setEditingRifa] = useState<Rifa | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    
    // Form state
    const [formData, setFormData] = useState({
        titulo: "",
        descricao: "",
        imagemUrl: "",
        precoPorNumero: 0,
        quantidadeNumeros: 100,
        status: "RASCUNHO",
        dataSorteio: ""
    });

    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string>("");

    const [isUploading, setIsUploading] = useState(false);

    // Delete confirmation state
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const { showToast } = useToast();

    const loadRifas = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/rifas");
            const data = await res.json();
            if (res.ok) {
                setRifas(data);
            } else {
                showToast(data.error || "Erro ao carregar rifas", "error");
            }
        } catch (err) {
            console.error(err);
            showToast("Erro ao carregar rifas.", "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadRifas();
    }, []);

    const openCreateForm = () => {
        setFormData({
            titulo: "",
            descricao: "",
            imagemUrl: "",
            precoPorNumero: 0,
            quantidadeNumeros: 100,
            status: "RASCUNHO",
            dataSorteio: ""
        });
        setSelectedFile(null);
        setPreviewUrl("");
        setIsFormOpen(true);
    };

    const closeForm = () => {
        setIsFormOpen(false);
    };

    const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setSelectedFile(file);
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            const url = "/api/rifas";
            const method = "POST";
            
            const submitData = new FormData();
            submitData.append("titulo", formData.titulo);
            submitData.append("descricao", formData.descricao);
            submitData.append("precoPorNumero", String(formData.precoPorNumero));
            submitData.append("quantidadeNumeros", String(formData.quantidadeNumeros));
            submitData.append("status", formData.status);
            if (formData.dataSorteio) submitData.append("dataSorteio", formData.dataSorteio);
            
            if (selectedFile) {
                submitData.append("imagem", selectedFile);
            } else if (formData.imagemUrl) {
                 submitData.append("imagemUrl", formData.imagemUrl);
            }

            const response = await fetch(url, {
                method,
                body: submitData
            });

            const data = await response.json();

            if (response.ok) {
                showToast(`Rifa criada com sucesso!`, "success");
                closeForm();
                loadRifas();
            } else {
                showToast(data.error || "Erro ao salvar rifa.", "error");
            }
        } catch (error) {
            console.error(error);
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        setDeletingId(null);
        setIsSaving(true);
        try {
            const response = await fetch(`/api/rifas/${id}`, { method: "DELETE" });
            if (response.ok) {
                showToast("Rifa excluída com sucesso!", "success");
                loadRifas();
            } else {
                showToast("Erro ao excluir rifa.", "error");
            }
        } catch (error) {
            console.error(error);
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const filteredRifas = rifas.filter(r =>
        r.titulo.toLowerCase().includes(searchTerm.toLowerCase())
    );

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
                <div className="max-w-7xl mx-auto">
                    <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">Gestão de Rifas</h2>
                            <p className="text-sm text-slate-500 mt-1">Crie e gerencie as rifas da plataforma.</p>
                        </div>
                        <div className="flex items-center gap-4 w-full md:w-auto">
                            <div className="relative flex-1 md:w-80">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400" />
                                <input
                                    type="text"
                                    placeholder="Buscar rifa..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full pl-12 pr-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium"
                                />
                            </div>
                            <button
                                onClick={openCreateForm}
                                className="bg-primary hover:bg-primary/90 text-white p-3 md:px-6 rounded-2xl shadow-lg shadow-primary/20 transition-all flex items-center justify-center gap-2 font-bold uppercase tracking-wider text-xs whitespace-nowrap"
                            >
                                <Plus className="size-5" />
                                <span className="hidden md:inline">Nova Rifa</span>
                            </button>
                        </div>
                    </header>
                </div>
            </div>

            {/* Table Area */}
            <div className="flex-1 overflow-auto p-4 md:p-8 custom-scrollbar">
                <div className="max-w-7xl mx-auto flex flex-col gap-4">
                    {filteredRifas.length === 0 ? (
                        <div className="bg-white rounded-3xl border border-slate-200 p-12 flex flex-col items-center justify-center text-center">
                            <div className="size-24 rounded-full bg-slate-50 flex items-center justify-center mb-6 border border-slate-100">
                                <Ticket className="size-12 text-slate-300" />
                            </div>
                            <h3 className="text-xl font-black text-slate-900 mb-2">Nenhuma rifa encontrada</h3>
                            <p className="text-sm font-medium text-slate-500 max-w-sm">
                                Comece criando sua primeira rifa para oferecê-la aos participantes da formatura.
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
                            <table className="w-full text-left border-collapse min-w-[800px]">
                                <thead>
                                    <tr className="bg-slate-50/80 border-b border-slate-200">
                                        <th className="px-6 py-5 text-[10px] font-black uppercase tracking-widest text-slate-500">Rifa</th>
                                        <th className="px-6 py-5 text-[10px] font-black uppercase tracking-widest text-slate-500">Números</th>
                                        <th className="px-6 py-5 text-[10px] font-black uppercase tracking-widest text-slate-500">Valor/Num</th>
                                        <th className="px-6 py-5 text-[10px] font-black uppercase tracking-widest text-slate-500 text-center">Status</th>
                                        <th className="px-6 py-5 text-[10px] font-black uppercase tracking-widest text-slate-500 text-right">Ações</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {filteredRifas.map((rifa) => (
                                        <tr key={rifa.id} className="hover:bg-slate-50/50 transition-colors group">
                                            <td className="px-6 py-5">
                                                <div className="flex items-center gap-4">
                                                    <div className="size-14 rounded-2xl bg-slate-50 border border-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                                                        {rifa.imagemUrl ? (
                                                            <img src={rifa.imagemUrl} alt={rifa.titulo} className="w-full h-full object-cover" />
                                                        ) : (
                                                            <Ticket className="size-6 text-slate-300" />
                                                        )}
                                                    </div>
                                                    <div>
                                                        <h4 className="font-black text-slate-900 group-hover:text-primary transition-colors line-clamp-1">{rifa.titulo}</h4>
                                                        <p className="text-xs font-semibold text-slate-400 mt-1 line-clamp-1 max-w-[200px]">{rifa.descricao}</p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-5">
                                                <span className="text-sm font-black text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                                                    {rifa.quantidadeNumeros}
                                                </span>
                                            </td>
                                            <td className="px-6 py-5">
                                                <span className="text-sm font-black text-emerald-600">
                                                    {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(rifa.precoPorNumero)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-5 text-center">
                                                <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border ${
                                                    rifa.status === 'ATIVA' ? "bg-emerald-50 text-emerald-600 border-emerald-100" :
                                                    rifa.status === 'RASCUNHO' ? "bg-amber-50 text-amber-600 border-amber-100" :
                                                    rifa.status === 'FINALIZADA' ? "bg-blue-50 text-blue-600 border-blue-100" :
                                                    "bg-rose-50 text-rose-600 border-rose-100"
                                                }`}>
                                                    {rifa.status}
                                                </span>
                                            </td>
                                            <td className="px-6 py-5 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    {rifa.status === 'ATIVA' && (
                                                        <Link
                                                            href={`/pdv/rifas/${rifa.id}`}
                                                            className="p-2 sm:p-2.5 bg-white text-slate-400 hover:text-emerald-600 border border-slate-200 hover:border-emerald-200 hover:bg-emerald-50 rounded-xl transition-all inline-flex items-center gap-1.5"
                                                            title="Vender no PDV"
                                                        >
                                                            <ShoppingCart className="size-4" />
                                                        </Link>
                                                    )}
                                                    <Link
                                                        href={`/admin/rifas/${rifa.id}`}
                                                        className="p-2 sm:p-2.5 bg-white text-slate-400 hover:text-primary border border-slate-200 hover:border-primary/30 rounded-xl transition-all hover:shadow-md hover:shadow-primary/10 inline-flex"
                                                        title="Detalhes e Edição"
                                                    >
                                                        <ExternalLink className="size-4" />
                                                    </Link>
                                                    <button
                                                        onClick={() => setDeletingId(rifa.id)}
                                                        className="p-2 sm:p-2.5 bg-white text-slate-400 hover:text-rose-500 border border-slate-200 hover:border-rose-200 hover:bg-rose-50 rounded-xl transition-all"
                                                        title="Excluir"
                                                    >
                                                        <Trash2 className="size-4" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Modal de Formulário */}
            {isFormOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-2xl bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
                        <div className="p-6 md:p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <div className="flex items-center gap-4">
                                <div className="p-3 bg-primary/10 rounded-2xl text-primary">
                                    <Ticket className="size-6" />
                                </div>
                                <h3 className="text-xl md:text-2xl font-black text-slate-900 uppercase">
                                    Nova Rifa
                                </h3>
                            </div>
                            <button
                                onClick={closeForm}
                                className="p-2 rounded-xl hover:bg-slate-200 text-slate-400 transition-colors"
                            >
                                <X className="size-6" />
                            </button>
                        </div>

                        <div className="p-6 md:p-8 overflow-y-auto flex-1 custom-scrollbar">
                            <form id="rifa-form" onSubmit={handleSave} className="space-y-6">
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Título da Rifa</label>
                                        <input
                                            type="text"
                                            required
                                            value={formData.titulo}
                                            onChange={(e) => setFormData({ ...formData, titulo: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold"
                                            placeholder="Ex: Rifa do Carro 0km"
                                        />
                                    </div>
                                    
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Descrição</label>
                                        <textarea
                                            required
                                            rows={3}
                                            value={formData.descricao}
                                            onChange={(e) => setFormData({ ...formData, descricao: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold resize-none custom-scrollbar"
                                            placeholder="Detalhes da rifa, prêmios, regras..."
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Imagem da Rifa</label>
                                        <div className="flex flex-col gap-3">
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={handleImageChange}
                                                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-primary file:text-white hover:file:bg-primary/90 transition-all cursor-pointer text-sm font-semibold disabled:opacity-50"
                                            />
                                            {(previewUrl || formData.imagemUrl) && (
                                                <div className="relative w-32 h-32 rounded-2xl overflow-hidden border-2 border-slate-200 group shadow-sm bg-slate-100">
                                                    <img src={previewUrl || formData.imagemUrl} alt="Preview" className="w-full h-full object-cover" />
                                                    <button type="button" onClick={() => { setPreviewUrl(""); setSelectedFile(null); setFormData({...formData, imagemUrl: ""}); }} className="absolute top-2 right-2 bg-rose-500 hover:bg-rose-600 text-white p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-md active:scale-95" title="Remover imagem">
                                                        <X className="size-3" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Preço por Número (R$)</label>
                                            <input
                                                type="number"
                                                min="0.01"
                                                step="0.01"
                                                required
                                                value={formData.precoPorNumero || ""}
                                                onChange={(e) => setFormData({ ...formData, precoPorNumero: parseFloat(e.target.value) })}
                                                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold"
                                                placeholder="0.00"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Qtd. de Números</label>
                                            <input
                                                type="number"
                                                min="1"
                                                max="10000"
                                                required
                                                value={formData.quantidadeNumeros || ""}
                                                onChange={(e) => setFormData({ ...formData, quantidadeNumeros: parseInt(e.target.value) })}
                                                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Status</label>
                                            <select
                                                required
                                                value={formData.status}
                                                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                                                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold"
                                            >
                                                <option value="RASCUNHO">Rascunho</option>
                                                <option value="ATIVA">Ativa</option>
                                                <option value="FINALIZADA">Finalizada</option>
                                                <option value="CANCELADA">Cancelada</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 px-1">Data do Sorteio (Opcional)</label>
                                            <input
                                                type="date"
                                                value={formData.dataSorteio}
                                                onChange={(e) => setFormData({ ...formData, dataSorteio: e.target.value })}
                                                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </form>
                        </div>

                        <div className="p-6 md:p-8 border-t border-slate-100 flex gap-4 bg-slate-50 shrink-0">
                            <button
                                type="button"
                                onClick={closeForm}
                                className="flex-1 py-4 text-slate-500 font-bold rounded-2xl hover:bg-white transition-all border-2 border-slate-200 uppercase tracking-widest text-xs"
                            >
                                Cancelar
                            </button>
                            <button
                                type="submit"
                                form="rifa-form"
                                disabled={isSaving}
                                className="flex-[1.5] py-4 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 shadow-xl shadow-primary/30 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 uppercase tracking-[0.1em] sm:tracking-[0.2em] text-xs"
                            >
                                {isSaving ? (
                                    <Loader2 className="size-5 animate-spin" />
                                ) : (
                                    <>
                                        Criar Rifa
                                        <Check className="size-5" />
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal de Confirmação de Exclusão */}
            {deletingId && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 p-6 flex flex-col items-center text-center">
                        <div className="size-16 rounded-full bg-rose-50 flex items-center justify-center border-4 border-rose-100 mb-4">
                            <Trash2 className="size-6 text-rose-500" />
                        </div>
                        <h3 className="text-xl font-black text-slate-900 mb-2">Excluir Rifa?</h3>
                        <p className="text-sm font-medium text-slate-500 mb-8">
                            Tem certeza que deseja excluir esta rifa? Esta ação não pode ser desfeita.
                        </p>
                        <div className="flex gap-3 w-full">
                            <button
                                onClick={() => setDeletingId(null)}
                                className="flex-1 py-3 text-slate-500 font-bold rounded-xl hover:bg-slate-50 transition-all border-2 border-slate-100 uppercase tracking-wider text-xs"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={() => handleDelete(deletingId)}
                                disabled={isSaving}
                                className="flex-1 py-3 bg-rose-500 text-white font-black rounded-xl hover:bg-rose-600 shadow-lg shadow-rose-500/30 transition-all uppercase tracking-wider text-xs flex items-center justify-center"
                            >
                                {isSaving ? <Loader2 className="size-4 animate-spin" /> : 'Excluir'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
