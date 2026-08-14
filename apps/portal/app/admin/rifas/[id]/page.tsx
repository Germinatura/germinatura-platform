"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import {
    Loader2,
    Ticket,
    ChevronLeft,
    Check,
    X,
    Search,
    User,
    Trophy,
    Shuffle,
    ShoppingCart
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";

interface Usuario {
    id: string;
    nome: string;
    email: string;
}

interface NumeroRifa {
    id: string;
    numero: number;
    status: string;
    usuario?: Usuario;
}

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
    numeroSorteado?: number | null;
    numeros: NumeroRifa[];
}

export default function EditarRifa({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const { showToast } = useToast();

    const [rifa, setRifa] = useState<Rifa | null>(null);
    const [loading, setLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [isSorteando, setIsSorteando] = useState(false);
    const [searchNumber, setSearchNumber] = useState("");

    const [formData, setFormData] = useState({
        titulo: "",
        descricao: "",
        imagemUrl: "",
        status: "",
        dataSorteio: ""
    });

    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string>("");

    const loadRifa = async () => {
        try {
            const res = await fetch(`/api/rifas/${id}`);
            const data = await res.json();
            if (res.ok) {
                setRifa(data);
                setFormData({
                    titulo: data.titulo,
                    descricao: data.descricao,
                    imagemUrl: data.imagemUrl || "",
                    status: data.status,
                    dataSorteio: data.dataSorteio ? new Date(data.dataSorteio).toISOString().split('T')[0] : ""
                });
            } else {
                showToast(data.error || "Erro ao carregar rifa.", "error");
                router.push("/admin/rifas");
            }
        } catch (error) {
            console.error(error);
            showToast("Erro ao carregar rifa.", "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadRifa();
    }, [id]);

    const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setSelectedFile(file);
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!rifa) return;
        setIsSaving(true);

        try {
            const submitData = new FormData();
            submitData.append("titulo", formData.titulo);
            submitData.append("descricao", formData.descricao);
            submitData.append("status", formData.status);
            submitData.append("dataSorteio", formData.dataSorteio);
            submitData.append("precoPorNumero", String(rifa.precoPorNumero));

            if (selectedFile) {
                submitData.append("imagem", selectedFile);
            } else if (formData.imagemUrl) {
                submitData.append("imagemUrl", formData.imagemUrl);
            }

            const response = await fetch(`/api/rifas/${id}`, {
                method: "PUT",
                body: submitData
            });
            const data = await response.json();

            if (response.ok) {
                showToast("Rifa atualizada com sucesso!", "success");
                setSelectedFile(null);
                setPreviewUrl("");
                loadRifa();
            } else {
                showToast(data.error || "Erro ao atualizar.", "error");
            }
        } catch (error) {
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const handleSortear = async () => {
        if (!rifa) return;
        const vendidos = rifa.numeros.filter(n => n.status === 'VENDIDO');
        if (vendidos.length === 0) {
            showToast("Nenhum número vendido para sortear.", "warning");
            return;
        }
        const confirm = window.confirm(`Realizar sorteio da rifa "${rifa.titulo}" entre ${vendidos.length} números vendidos? Esta ação é irreversível.`);
        if (!confirm) return;

        setIsSorteando(true);
        try {
            const res = await fetch(`/api/rifas/${id}/sortear`, { method: "POST" });
            const data = await res.json();
            if (res.ok) {
                showToast(`🏆 Ganhador: Número ${String(data.numeroSorteado).padStart(3,'0')} — ${data.ganhador?.nome || 'Desconhecido'}${data.emailSent ? ' · E-mail enviado!' : ''}`, "success");
                loadRifa();
            } else {
                showToast(data.error || "Erro ao sortear.", "error");
            }
        } catch {
            showToast("Erro de conexão.", "error");
        } finally {
            setIsSorteando(false);
        }
    };

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!rifa) return null;

    const filteredNumeros = rifa.numeros?.filter(n => {
        if (!searchNumber) return true;
        const numStr = n.numero.toString();
        const nomeStr = n.usuario?.nome?.toLowerCase() || "";
        const search = searchNumber.toLowerCase();
        return numStr.includes(search) || nomeStr.includes(search);
    });

    const numVendidos = rifa.numeros?.filter(n => n.status === "VENDIDO").length || 0;
    const numReservados = rifa.numeros?.filter(n => n.status === "RESERVADO").length || 0;
    const numDisponiveis = rifa.numeros?.filter(n => n.status === "DISPONIVEL").length || 0;
    const ganhadorNum = rifa.numeros?.find(n => n.numero === rifa.numeroSorteado);

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            <div className="bg-white border-b border-slate-200 p-4 md:p-6 shrink-0">
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <Link href="/admin/rifas" className="p-2 lg:p-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500 hover:text-primary transition-colors">
                            <ChevronLeft className="size-5" />
                        </Link>
                        <div>
                            <h2 className="text-xl md:text-2xl font-extrabold tracking-tight text-slate-900">Detalhes da Rifa</h2>
                            <p className="text-xs text-slate-500 font-medium mt-1">Edite as informações e acompanhe os bilhetes.</p>
                        </div>
                    </div>
                    {rifa.status === 'ATIVA' && (
                        <Link
                            href={`/pdv/rifas/${id}`}
                            className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest shadow-md shadow-emerald-500/20 transition-all active:scale-95"
                        >
                            <ShoppingCart className="size-4" />
                            <span className="hidden md:inline">Vender no PDV</span>
                        </Link>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4 md:p-6 custom-scrollbar">
                <div className="max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-3 gap-6">
                    {/* Linha Esquerda - Formulário + Sorteio */}
                    <div className="xl:col-span-1 space-y-6">
                        {/* Winner Banner */}
                        {rifa.status === 'FINALIZADA' && rifa.numeroSorteado && (
                            <div className="bg-gradient-to-br from-amber-400 to-amber-500 rounded-3xl p-6 shadow-lg text-white">
                                <div className="flex items-center gap-3 mb-3">
                                    <Trophy className="size-7" />
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Número Sorteado</p>
                                        <p className="text-3xl font-black">{String(rifa.numeroSorteado).padStart(3,'0')}</p>
                                    </div>
                                </div>
                                {ganhadorNum?.usuario && (
                                    <div className="bg-white/20 rounded-2xl px-4 py-3">
                                        <p className="text-[10px] font-black uppercase tracking-widest opacity-80 mb-0.5">Ganhador</p>
                                        <p className="font-black text-sm">{ganhadorNum.usuario.nome}</p>
                                        <p className="text-xs opacity-75">{ganhadorNum.usuario.email}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Draw Button - Only when ATIVA */}
                        {rifa.status === 'ATIVA' && (
                            <button
                                onClick={handleSortear}
                                disabled={isSorteando}
                                className="w-full py-4 bg-gradient-to-br from-amber-500 to-amber-600 text-white font-black rounded-2xl hover:from-amber-600 hover:to-amber-700 shadow-lg shadow-amber-500/30 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 uppercase tracking-[0.1em] text-xs"
                            >
                                {isSorteando
                                    ? <><Loader2 className="size-4 animate-spin" /> Sorteando...</>
                                    : <><Shuffle className="size-4" /> Realizar Sorteio</>}
                            </button>
                        )}
                        <form onSubmit={handleSave} className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                            <div className="p-5 md:p-6 border-b border-slate-100 flex items-center gap-3">
                                <div className="p-2.5 bg-primary/10 rounded-xl text-primary">
                                    <Ticket className="size-5" />
                                </div>
                                <h3 className="text-lg font-black text-slate-900">Informações da Rifa</h3>
                            </div>
                            
                            <div className="p-5 md:p-6 space-y-5 flex-1">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 px-1">Título</label>
                                    <input
                                        type="text"
                                        required
                                        value={formData.titulo}
                                        onChange={(e) => setFormData({ ...formData, titulo: e.target.value })}
                                        className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold text-sm"
                                    />
                                </div>
                                
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 px-1">Descrição</label>
                                    <textarea
                                        required
                                        rows={3}
                                        value={formData.descricao}
                                        onChange={(e) => setFormData({ ...formData, descricao: e.target.value })}
                                        className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold text-sm resize-none custom-scrollbar"
                                    />
                                </div>
                                
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 px-1">Imagem Principal</label>
                                    <div className="space-y-3">
                                        <input
                                            type="file"
                                            accept="image/*"
                                            onChange={handleImageChange}
                                            className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl file:mr-4 file:py-1.5 file:px-4 file:rounded-lg file:border-0 file:text-[10px] file:font-bold file:bg-primary file:text-white hover:file:bg-primary/90 transition-all cursor-pointer text-xs font-semibold"
                                        />
                                        {(previewUrl || formData.imagemUrl) && (
                                            <div className="relative w-full h-40 rounded-xl overflow-hidden border border-slate-200 group">
                                                <img src={previewUrl || formData.imagemUrl} alt="Preview" className="w-full h-full object-cover" />
                                                <button type="button" onClick={() => { setPreviewUrl(""); setSelectedFile(null); setFormData({...formData, imagemUrl: ""}); }} className="absolute top-2 right-2 bg-rose-500 hover:bg-rose-600 text-white p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-md">
                                                    <X className="size-3" />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 px-1">Status</label>
                                        <select
                                            value={formData.status}
                                            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold text-xs"
                                        >
                                            <option value="RASCUNHO">Rascunho</option>
                                            <option value="ATIVA">Ativa</option>
                                            <option value="FINALIZADA">Finalizada</option>
                                            <option value="CANCELADA">Cancelada</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 px-1">Data Sorteio</label>
                                        <input
                                            type="date"
                                            value={formData.dataSorteio}
                                            onChange={(e) => setFormData({ ...formData, dataSorteio: e.target.value })}
                                            className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-semibold text-xs"
                                        />
                                    </div>
                                </div>

                                {/* Immutable Info Blocks */}
                                <div className="grid grid-cols-2 gap-4 pt-2">
                                    <div className="bg-slate-100 p-3 rounded-xl border border-slate-200 flex flex-col justify-center items-center text-center">
                                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Preço do Número</p>
                                        <p className="text-sm font-black text-emerald-600">
                                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(rifa.precoPorNumero)}
                                        </p>
                                        <p className="text-[8px] text-slate-400 mt-1">* Imutável</p>
                                    </div>
                                    <div className="bg-slate-100 p-3 rounded-xl border border-slate-200 flex flex-col justify-center items-center text-center">
                                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Total de Números</p>
                                        <p className="text-sm font-black text-slate-700">{rifa.quantidadeNumeros}</p>
                                        <p className="text-[8px] text-slate-400 mt-1">* Imutável</p>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="p-4 bg-slate-50 border-t border-slate-100 shrink-0">
                                <button
                                    type="submit"
                                    disabled={isSaving}
                                    className="w-full py-4 bg-primary text-white font-black rounded-xl hover:bg-primary/90 shadow-lg shadow-primary/20 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 uppercase tracking-[0.1em] text-xs"
                                >
                                    {isSaving ? <Loader2 className="size-4 animate-spin" /> : <><Check className="size-4" /> Atualizar Informações</>}
                                </button>
                            </div>
                        </form>
                    </div>

                    {/* Direita - Tabela de Números */}
                    <div className="xl:col-span-2 flex flex-col gap-6">
                        {/* Summary Cards */}
                        <div className="grid grid-cols-3 gap-3 md:gap-4">
                            <div className="bg-white p-4 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center text-center justify-center">
                                <span className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Disponíveis</span>
                                <span className="text-2xl font-black text-slate-900">{numDisponiveis}</span>
                            </div>
                            <div className="bg-white p-4 rounded-3xl border border-slate-200 shadow-sm flex flex-col items-center text-center justify-center">
                                <span className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Reservados</span>
                                <span className="text-2xl font-black text-amber-500">{numReservados}</span>
                            </div>
                            <div className="bg-white p-4 rounded-3xl border border-emerald-100 shadow-sm flex flex-col items-center text-center justify-center bg-emerald-50/30">
                                <span className="text-[9px] md:text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Vendidos</span>
                                <span className="text-2xl font-black text-emerald-500">{numVendidos}</span>
                            </div>
                        </div>

                        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-[500px] xl:h-[calc(100vh-220px)]">
                            <div className="p-4 md:p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
                                <div>
                                    <h3 className="text-lg font-black text-slate-900">Gerenciar Números</h3>
                                    <p className="text-xs text-slate-500 font-medium mt-1">Acompanhe as vendas ou procure compradores.</p>
                                </div>
                                <div className="relative w-full md:w-64 shrink-0">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-400" />
                                    <input
                                        type="text"
                                        placeholder="Buscar número ou nome..."
                                        value={searchNumber}
                                        onChange={(e) => setSearchNumber(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all font-medium text-xs text-slate-900 placeholder:text-slate-400"
                                    />
                                </div>
                            </div>

                            <div className="flex-1 overflow-auto custom-scrollbar p-0">
                                <table className="w-full text-left border-collapse min-w-[500px]">
                                    <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur-sm shadow-sm">
                                        <tr>
                                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 w-24 text-center">Nº</th>
                                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200 w-32 text-center">Status</th>
                                            <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-slate-200">Comprador</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {filteredNumeros && filteredNumeros.length > 0 ? (
                                            filteredNumeros.map((num) => (
                                                <tr key={num.id} className="hover:bg-slate-50/50 transition-colors">
                                                    <td className="px-6 py-4 text-center">
                                                        <span className="text-sm font-black text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                                                            {String(num.numero).padStart(3, '0')}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        <span className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest border ${
                                                            num.status === 'VENDIDO' ? "bg-emerald-50 text-emerald-600 border-emerald-100" :
                                                            num.status === 'RESERVADO' ? "bg-amber-50 text-amber-600 border-amber-100" :
                                                            "bg-slate-50 text-slate-500 border-slate-200"
                                                        }`}>
                                                            {num.status}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        {num.usuario ? (
                                                            <div className="flex items-center gap-3">
                                                                <div className="size-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0 border border-slate-200">
                                                                    <User className="size-4" />
                                                                </div>
                                                                <div className="min-w-0">
                                                                    <p className="text-xs font-bold text-slate-900 truncate">{num.usuario.nome}</p>
                                                                    <p className="text-[10px] text-slate-500 truncate mt-0.5">{num.usuario.email}</p>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <span className="text-[11px] font-bold text-slate-400 italic">Disponível para venda</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))
                                        ) : (
                                            <tr>
                                                <td colSpan={3} className="px-6 py-12 text-center text-sm font-semibold text-slate-400">
                                                    Nenhum número encontrado para sua busca.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
