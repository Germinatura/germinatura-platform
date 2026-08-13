"use client";

import { useState, useEffect, useMemo } from "react";
import {
    History,
    Search,
    Loader2,
    CheckCircle2,
    XCircle,
    Clock,
    User,
    ChevronDown,
    ChevronUp,
    Package,
    X,
    AlertCircle,
    ShoppingBag
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { montarPayloadPix } from "@/lib/pix";
import { useToast } from "@/components/ui/Toast";
import { formatLocalDate, formatLocalTime } from "@/lib/date";
import * as Switch from '@radix-ui/react-switch';

interface ReservaItem {
    id: string;
    quantidade: number;
    produto: {
        nome: string;
        estoque: number;
        precos: { valor: number }[];
        produtoPai?: { nome: string } | null;
    };
}

interface Reserva {
    id: string;
    usuario: { nome: string; email: string };
    status: "PENDENTE" | "APROVADA" | "CANCELADA" | "CONCLUIDA";
    criadoEm: string;
    itens: ReservaItem[];
}

export default function AdminReservasPage() {
    const [reservas, setReservas] = useState<Reserva[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [expandedReserva, setExpandedReserva] = useState<string | null>(null);
    const [paymentReserva, setPaymentReserva] = useState<Reserva | null>(null);
    const [cancelReserva, setCancelReserva] = useState<Reserva | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string>("PENDENTE");
    const [skip, setSkip] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [reservasAtivas, setReservasAtivas] = useState(true);
    const [isTogglingConfig, setIsTogglingConfig] = useState(false);
    const { showToast } = useToast();

    const fetchReservas = async (isLoadMore = false) => {
        const nextSkip = isLoadMore ? skip + 50 : 0;
        if (!isLoadMore) setLoading(true);

        try {
            const res = await fetch(`/api/reservas?all=true&take=50&skip=${nextSkip}`);
            if (res.ok) {
                const data = await res.json();
                if (isLoadMore) {
                    setReservas(prev => [...prev, ...data]);
                } else {
                    setReservas(data);
                }
                setSkip(nextSkip);
                setHasMore(data.length === 50);
            }
        } catch (error) {
            console.error("Erro ao carregar reservas:", error);
            showToast("Erro ao carregar reservas", "error");
        } finally {
            setLoading(false);
        }
    };

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

    const toggleReservasAtivas = async () => {
        if (isTogglingConfig) return;
        setIsTogglingConfig(true);
        const nextState = !reservasAtivas;
        try {
            const res = await fetch("/api/configuracoes/reservas", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ativa: nextState })
            });
            if (res.ok) {
                const data = await res.json();
                setReservasAtivas(data.reservas_ativas);
                showToast(nextState ? "Reservas ativadas" : "Reservas desativadas", "success");
            } else {
                showToast("Erro ao alterar configuração", "error");
            }
        } catch (error) {
            showToast("Erro de conexão", "error");
        } finally {
            setIsTogglingConfig(false);
        }
    };

    useEffect(() => {
        fetchReservas();
        fetchConfig();
    }, []);

    const toggleReserva = (id: string) => {
        setExpandedReserva(expandedReserva === id ? null : id);
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case "PENDENTE": return <Clock className="size-4 text-orange-500" />;
            case "APROVADA": return <CheckCircle2 className="size-4 text-green-500" />;
            case "CANCELADA": return <XCircle className="size-4 text-red-500" />;
            case "CONCLUIDA": return <CheckCircle2 className="size-4 text-blue-500" />;
            default: return null;
        }
    };

    const getStatusStyle = (status: string) => {
        switch (status) {
            case "PENDENTE": return "bg-orange-50 text-orange-700 border-orange-200";
            case "APROVADA": return "bg-green-50 text-green-700 border-green-200";
            case "CANCELADA": return "bg-red-50 text-red-700 border-red-200";
            case "CONCLUIDA": return "bg-blue-50 text-blue-700 border-blue-200";
            default: return "bg-slate-50 text-slate-700 border-slate-200";
        }
    };

    const calcTotal = (itens: ReservaItem[]) =>
        itens.reduce((acc, item) => acc + (item.produto.precos?.[0]?.valor || 0) * item.quantidade, 0);

    const pixPayload = useMemo(() => {
        if (!paymentReserva) return "";
        const total = calcTotal(paymentReserva.itens);
        if (total <= 0) return "";
        return montarPayloadPix({
            chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "",
            nome: process.env.NEXT_PUBLIC_PIX_NOME_RECEBEDOR || "Germinatura",
            cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "Sao Paulo",
            valor: total.toFixed(2)
        });
    }, [paymentReserva]);

    const handleConfirmVenda = async () => {
        if (!paymentReserva || isSaving) return;
        setIsSaving(true);
        try {
            const res = await fetch(`/api/reservas/${paymentReserva.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "CONCLUIDA" })
            });
            if (res.ok) {
                showToast("Venda registrada e reserva concluída com sucesso!", "success");
                setPaymentReserva(null);
                setExpandedReserva(null);
                await fetchReservas();
            } else {
                const err = await res.json();
                showToast(err.error || "Erro ao concluir reserva", "error");
            }
        } catch {
            showToast("Erro de conexão", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancelarReserva = async () => {
        if (!cancelReserva || isSaving) return;
        setIsSaving(true);
        try {
            const res = await fetch(`/api/reservas/${cancelReserva.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "CANCELADA" })
            });
            if (res.ok) {
                showToast("Reserva cancelada e estoque devolvido.", "success");
                setCancelReserva(null);
                setExpandedReserva(null);
                await fetchReservas();
            } else {
                const err = await res.json();
                showToast(err.error || "Erro ao cancelar reserva", "error");
            }
        } catch {
            showToast("Erro de conexão", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const filteredReservas = reservas.filter(r => {
        const matchesSearch =
            r.usuario.nome.toLowerCase().includes(searchTerm.toLowerCase()) ||
            r.id.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = statusFilter === "TODAS" || r.status === statusFilter;
        return matchesSearch && matchesStatus;
    });

    const countByStatus = (s: string) => reservas.filter(r => r.status === s).length;

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            {/* Header */}
            <div className="bg-white border-b border-slate-200 p-4 md:p-8 lg:p-12 pb-6 shrink-0">
                <div className="max-w-6xl mx-auto">
                    <header className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900">
                                Gestão de Reservas
                            </h2>
                            <p className="text-sm text-slate-500 mt-1">Visualize e gerencie as solicitações de produtos dos clientes.</p>
                        </div>
                        
                        <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200 shadow-sm shrink-0">
                            <div className="flex flex-col">
                                <span className="text-sm font-bold text-slate-900">Função de Reservas</span>
                                <span className="text-xs text-slate-500">
                                    {reservasAtivas ? "Ativada para consumidores" : "Desativada temporariamente"}
                                </span>
                            </div>
                            <Switch.Root
                                checked={reservasAtivas}
                                onCheckedChange={toggleReservasAtivas}
                                disabled={isTogglingConfig}
                                className={`w-[42px] h-[24px] rounded-full relative shadow-sm border focus:ring-2 focus:ring-primary focus:outline-none transition-colors duration-200 ease-in-out cursor-pointer ${
                                    reservasAtivas ? 'bg-primary border-primary' : 'bg-slate-200 border-slate-300'
                                } disabled:opacity-50`}
                            >
                                <Switch.Thumb className={`block w-[18px] h-[18px] bg-white rounded-full transition-transform duration-200 ease-in-out shadow-md ${
                                    reservasAtivas ? 'translate-x-[20px]' : 'translate-x-[2px]'
                                }`} />
                            </Switch.Root>
                        </div>
                    </header>
                    <div className="relative mb-4">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 size-5" />
                        <input
                            type="text"
                            placeholder="Buscar por cliente ou ID da reserva..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary outline-none transition-all shadow-sm"
                        />
                    </div>

                    {/* Status filter tabs */}
                    <div className="flex flex-wrap gap-2">
                        {([
                            { key: "TODAS", label: "Todas", count: reservas.length, active: "bg-slate-900 text-white border-slate-900", idle: "bg-white text-slate-600 border-slate-200 hover:border-slate-400" },
                            { key: "PENDENTE", label: "Pendentes", count: countByStatus("PENDENTE"), active: "bg-orange-500 text-white border-orange-500", idle: "bg-white text-orange-600 border-orange-200 hover:border-orange-400" },
                            { key: "CONCLUIDA", label: "Concluídas", count: countByStatus("CONCLUIDA"), active: "bg-blue-500 text-white border-blue-500", idle: "bg-white text-blue-600 border-blue-200 hover:border-blue-400" },
                            { key: "CANCELADA", label: "Canceladas", count: countByStatus("CANCELADA"), active: "bg-red-500 text-white border-red-500", idle: "bg-white text-red-600 border-red-200 hover:border-red-400" },
                        ] as const).map(({ key, label, count, active, idle }) => (
                            <button
                                key={key}
                                onClick={() => setStatusFilter(key)}
                                className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-black border transition-all ${statusFilter === key ? active : idle
                                    }`}
                            >
                                {label}
                                <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${statusFilter === key ? "bg-white/20" : "bg-slate-100"
                                    }`}>
                                    {count}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-12 custom-scrollbar">
                <div className="max-w-6xl mx-auto pb-12">
                    <div className="space-y-4">
                        {filteredReservas.length === 0 ? (
                            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                                <History className="size-16 text-slate-200 mx-auto mb-4" />
                                <p className="text-slate-500 font-medium">Nenhuma reserva encontrada.</p>
                            </div>
                        ) : (
                            filteredReservas.map(reserva => (
                                <div key={reserva.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden transition-all hover:border-primary/30">
                                    {/* Card Header */}
                                    <div
                                        onClick={() => toggleReserva(reserva.id)}
                                        className="p-4 md:p-6 flex items-start md:items-center justify-between gap-3 cursor-pointer hover:bg-slate-50 transition-colors"
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="size-10 md:size-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
                                                <User className="size-5 md:size-6" />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="font-bold text-slate-900 truncate">{reserva.usuario.nome}</h3>
                                                <p className="text-xs text-slate-500 truncate">
                                                    <span className="hidden sm:inline">{reserva.usuario.email} • </span>
                                                    ID: {reserva.id.slice(-8).toUpperCase()}
                                                </p>
                                                <p className="text-xs text-slate-400 mt-0.5 sm:hidden">
                                                    {formatLocalDate(reserva.criadoEm)} às {formatLocalTime(reserva.criadoEm)}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 md:gap-4 shrink-0">
                                            <div className="text-right hidden sm:block">
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Data</p>
                                                <p className="text-sm font-bold text-slate-900">
                                                    {formatLocalDate(reserva.criadoEm)}
                                                    <span className="text-slate-400 font-normal ml-1">
                                                        {formatLocalTime(reserva.criadoEm)}
                                                    </span>
                                                </p>
                                            </div>
                                            <div className={`px-2.5 py-1 md:px-3 md:py-1.5 rounded-full border text-[9px] md:text-[10px] font-black uppercase flex items-center gap-1.5 ${getStatusStyle(reserva.status)}`}>
                                                {getStatusIcon(reserva.status)}
                                                <span>{reserva.status}</span>
                                            </div>
                                            {expandedReserva === reserva.id ? <ChevronUp className="size-4 md:size-5 text-slate-400" /> : <ChevronDown className="size-4 md:size-5 text-slate-400" />}
                                        </div>
                                    </div>

                                    {/* Expanded details */}
                                    {expandedReserva === reserva.id && (
                                        <div className="px-4 md:px-6 pb-4 md:pb-6 pt-2 border-t border-slate-50 animate-in slide-in-from-top-2 duration-200">
                                            <div className="bg-slate-50 rounded-2xl p-3 md:p-4 space-y-2">
                                                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 px-1">Itens da Reserva</h4>
                                                {reserva.itens.map(item => (
                                                    <div key={item.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2 px-3 bg-white rounded-xl border border-slate-100 gap-2">
                                                        <div className="flex items-center gap-2">
                                                            <Package className="size-4 text-slate-400 shrink-0" />
                                                            <div className="flex flex-col">
                                                                <span className="font-black text-slate-900 uppercase text-sm">
                                                                    {item.produto.produtoPai?.nome || item.produto.nome}
                                                                </span>
                                                                {item.produto.produtoPai && (
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                                                        {item.produto.nome}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center justify-between sm:justify-end gap-4 sm:gap-6 text-right pl-6 sm:pl-0">
                                                            <div className="flex flex-col">
                                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Unit.</span>
                                                                <span className="text-slate-600 text-xs font-bold">
                                                                    {(item.produto.precos?.[0]?.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                                                </span>
                                                            </div>
                                                            <div className="flex flex-col items-end">
                                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Qtd.</span>
                                                                <span className="text-slate-900 text-xs font-black">{item.quantidade}</span>
                                                            </div>
                                                            <div className="flex flex-col items-end">
                                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subtotal</span>
                                                                <span className="font-black text-emerald-600 text-sm">
                                                                    {((item.produto.precos?.[0]?.valor || 0) * item.quantidade).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                                <div className="pt-4 flex justify-between items-center px-1 border-t border-slate-200 mt-2">
                                                    <span className="text-slate-500 font-bold uppercase text-[10px] tracking-widest">Total:</span>
                                                    <span className="text-lg md:text-xl font-black text-emerald-600">
                                                        {calcTotal(reserva.itens).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Action buttons — only show for active reservations */}
                                            {(reserva.status === "PENDENTE" || reserva.status === "APROVADA") && (
                                                <div className="mt-4 flex flex-col sm:flex-row gap-3">
                                                    <button
                                                        onClick={() => setPaymentReserva(reserva)}
                                                        className="flex-1 py-3.5 md:py-4 bg-primary text-white font-black rounded-2xl hover:bg-primary/90 transition-all shadow-xl shadow-primary/20 active:scale-95 text-sm md:text-base flex items-center justify-center gap-2"
                                                    >
                                                        <ShoppingBag className="size-5" />
                                                        APROVAR E COBRAR
                                                    </button>
                                                    <button
                                                        onClick={() => setCancelReserva(reserva)}
                                                        className="flex-1 py-3.5 md:py-4 bg-white border border-red-200 text-red-500 font-bold rounded-2xl hover:bg-red-50 transition-all active:scale-95 text-sm md:text-base flex items-center justify-center gap-2"
                                                    >
                                                        <XCircle className="size-5" />
                                                        CANCELAR RESERVA
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}

                        {/* Pagination */}
                        {hasMore && filteredReservas.length > 0 && searchTerm === "" && statusFilter === "TODAS" && (
                            <div className="pt-8 flex justify-center pb-12">
                                <button
                                    onClick={() => fetchReservas(true)}
                                    disabled={loading}
                                    className="px-8 py-3 bg-white border border-slate-200 text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-all active:scale-95 flex items-center gap-2 shadow-sm"
                                >
                                    {loading ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                                    Carregar Mais
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* QR Code Payment Modal */}
            {paymentReserva && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
                    <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-slate-200">
                        <div className="p-6">
                            {/* Modal Header */}
                            <div className="flex items-start justify-between mb-5">
                                <div>
                                    <h3 className="text-xl font-bold text-slate-900">Cobrar Reserva</h3>
                                    <p className="text-sm text-slate-500 mt-0.5">Escaneie o QR Code PIX para confirmar</p>
                                </div>
                                <button
                                    onClick={() => setPaymentReserva(null)}
                                    className="p-2 rounded-full hover:bg-slate-100 text-slate-400 transition-colors"
                                >
                                    <X className="size-5" />
                                </button>
                            </div>

                            {/* Items summary */}
                            <div className="bg-slate-50 rounded-2xl p-4 space-y-2 mb-5 border border-slate-100">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                                    {paymentReserva.usuario.nome} — #{paymentReserva.id.slice(-6).toUpperCase()}
                                </p>
                                {paymentReserva.itens.map(item => (
                                    <div key={item.id} className="flex justify-between text-sm">
                                        <span className="text-slate-600">{item.quantidade}x {item.produto.nome}</span>
                                        <span className="font-bold text-slate-900">
                                            {((item.produto.precos?.[0]?.valor || 0) * item.quantidade).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                        </span>
                                    </div>
                                ))}
                                <div className="pt-2 border-t border-slate-200 flex justify-between">
                                    <span className="font-bold text-slate-700">Total</span>
                                    <span className="font-black text-primary text-lg">
                                        {calcTotal(paymentReserva.itens).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                    </span>
                                </div>
                            </div>

                            {/* QR Code */}
                            <div className="flex flex-col items-center gap-3 py-2 mb-5">
                                <div className="relative rounded-2xl border-4 border-slate-100 p-3 bg-white shadow-inner">
                                    {pixPayload && (
                                        <QRCodeSVG
                                            value={pixPayload}
                                            size={192}
                                            level="L"
                                            includeMargin={false}
                                        />
                                    )}
                                </div>
                                <span className="text-xs font-mono text-slate-400 tracking-widest uppercase">
                                    PIX Dinâmico Gerado
                                </span>
                            </div>

                            {/* Actions */}
                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={handleConfirmVenda}
                                    disabled={isSaving}
                                    className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 text-white font-black rounded-2xl transition-all shadow-xl shadow-emerald-500/20 active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {isSaving ? <Loader2 className="size-5 animate-spin" /> : <CheckCircle2 className="size-5" />}
                                    Confirmar Venda
                                </button>
                                <button
                                    onClick={() => setPaymentReserva(null)}
                                    className="w-full py-2.5 text-sm font-semibold text-slate-500 hover:text-red-500 transition-colors"
                                >
                                    Cancelar Pagamento
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Cancel Confirmation Modal */}
            {cancelReserva && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4">
                    <div className="w-full max-w-sm bg-white rounded-[32px] shadow-2xl animate-in zoom-in-95 duration-200 ring-1 ring-slate-200 overflow-hidden">
                        <div className="p-8 text-center space-y-5">
                            <div className="size-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto">
                                <AlertCircle className="size-8" />
                            </div>
                            <div>
                                <h3 className="text-xl font-black text-slate-900">Cancelar Reserva?</h3>
                                <p className="text-slate-500 text-sm mt-2">
                                    A reserva <span className="font-bold text-slate-900">#{cancelReserva.id.slice(-6).toUpperCase()}</span> de{" "}
                                    <span className="font-bold text-slate-900">{cancelReserva.usuario.nome}</span> será cancelada e o estoque devolvido automaticamente.
                                </p>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setCancelReserva(null)}
                                    className="flex-1 py-3.5 text-slate-500 font-bold rounded-2xl hover:bg-slate-50 transition-all border border-slate-200"
                                >
                                    Manter
                                </button>
                                <button
                                    disabled={isSaving}
                                    onClick={handleCancelarReserva}
                                    className="flex-[1.5] py-3.5 bg-red-500 hover:bg-red-600 text-white font-black rounded-2xl transition-all shadow-lg shadow-red-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                                >
                                    {isSaving ? <Loader2 className="size-5 animate-spin" /> : <XCircle className="size-5" />}
                                    Cancelar
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
