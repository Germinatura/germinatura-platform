"use client";

import { useState, useEffect } from "react";
import {
    History,
    Loader2,
    Plus,
    XCircle,
    Package,
    AlertCircle,
    X,
    Calendar,
    ArrowRight
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";
import { formatLocalDate, formatLocalTime } from "@/lib/date";

export default function ReservasPage() {
    const [reservas, setReservas] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [reservasAtivas, setReservasAtivas] = useState(true);
    const [isCancelling, setIsCancelling] = useState<string | null>(null);
    const [reservaParaCancelar, setReservaParaCancelar] = useState<any | null>(null);
    const { showToast } = useToast();

    const fetchReservas = async () => {
        try {
            const res = await fetch("/api/reservas");
            if (res.ok) {
                const data = await res.json();
                setReservas(data);
            }
        } catch (error: any) {
            console.error("Erro ao carregar reservas:", error);
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

    useEffect(() => {
        fetchConfig();
        fetchReservas();
    }, []);

    const handleCancelarReserva = async (id: string) => {
        setIsCancelling(id);
        try {
            const res = await fetch(`/api/reservas/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "CANCELADA" })
            });

            if (res.ok) {
                showToast("Reserva cancelada com sucesso", "success");
                setReservaParaCancelar(null);
                fetchReservas();
            } else {
                const error = await res.json();
                showToast(error.error || "Erro ao cancelar reserva", "error");
            }
        } catch (error: any) {
            showToast("Erro de conexão", "error");
        } finally {
            setIsCancelling(null);
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
            {/* Header Area - Fixed */}
            <div className="bg-white border-b border-slate-200 px-4 md:px-8 lg:px-12 py-6">
                <div className="max-w-4xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 flex items-center gap-3">
                            <History className="size-8 text-primary" />
                            Minhas Reservas
                        </h2>
                        <p className="text-slate-500 mt-1">Acompanhe suas solicitações de produtos.</p>
                    </div>

                    {reservasAtivas && (
                        <Link
                            href="/reservas/nova"
                            className="bg-primary hover:bg-primary/90 text-white px-6 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-primary/20 active:scale-95"
                        >
                            <Plus className="size-5" />
                            Nova Reserva
                        </Link>
                    )}
                </div>
            </div>

            {/* Scrollable Content Area */}
            <div className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-12 custom-scrollbar">
                <div className="max-w-4xl mx-auto space-y-6 pb-20">
                    {reservas.length === 0 ? (
                        <div className="bg-white rounded-3xl border border-slate-200 p-12 text-center shadow-sm">
                            <History className="size-16 text-slate-200 mx-auto mb-4" />
                            <h3 className="text-xl font-bold text-slate-900">Nenhuma reserva encontrada</h3>
                            <p className="text-slate-500 mt-2 mb-8">Você ainda não realizou nenhuma solicitação de produtos.</p>
                            {reservasAtivas && (
                                <Link
                                    href="/reservas/nova"
                                    className="inline-flex items-center gap-2 text-primary font-bold hover:underline"
                                >
                                    <Plus className="size-5" />
                                    Fazer minha primeira reserva
                                </Link>
                            )}
                        </div>
                    ) : (
                        reservas.map((reserva: any) => (
                            <div key={reserva.id} className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div className="p-6 border-b border-slate-50 flex flex-wrap items-center justify-between gap-4">
                                    <div className="flex items-center gap-4">
                                        <div className="size-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400">
                                            <Package className="size-6" />
                                        </div>
                                        <div>
                                            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Reserva #{reserva.id.slice(-6).toUpperCase()}</p>
                                            <p className="text-sm font-bold text-slate-900">
                                                {formatLocalDate(reserva.criadoEm)} às {formatLocalTime(reserva.criadoEm)}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3">
                                        <div className={`px-4 py-1.5 rounded-full text-xs font-black border uppercase tracking-wider ${reserva.status === 'PENDENTE' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                            reserva.status === 'APROVADA' ? 'bg-green-50 text-green-600 border-green-100' :
                                                reserva.status === 'CANCELADA' ? 'bg-red-50 text-red-600 border-red-100' :
                                                    reserva.status === 'CONCLUIDA' ? 'bg-blue-50 text-blue-600 border-blue-100' :
                                                        'bg-slate-50 text-slate-600 border-slate-100'
                                            }`}>
                                            {reserva.status}
                                        </div>

                                        {reserva.status === 'PENDENTE' && (
                                            <button
                                                onClick={() => setReservaParaCancelar(reserva)}
                                                className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all active:scale-90"
                                                title="Cancelar Reserva"
                                            >
                                                <XCircle className="size-5" />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="p-6 bg-slate-50/30">
                                    <div className="space-y-3">
                                        {reserva.itens.map((item: any) => (
                                            <div key={item.id} className="flex justify-between items-center bg-white p-3 rounded-xl border border-slate-100 shadow-sm gap-4">
                                                <div className="flex items-center gap-3 sm:gap-4 flex-1">
                                                    <div className="hidden sm:flex size-12 shrink-0 rounded-lg bg-slate-100 items-center justify-center overflow-hidden border border-slate-200">
                                                        {item.produto.imagemUrl ? (
                                                            <img src={item.produto.imagemUrl} alt={item.produto.nome} className="w-full h-full object-cover" />
                                                        ) : (
                                                            <Package className="size-5 text-slate-400" />
                                                        )}
                                                    </div>

                                                    <div className="flex flex-col">
                                                        <span className="font-black text-slate-900 uppercase text-sm truncate max-w-[200px] md:max-w-xs">
                                                            {item.produto.produtoPai?.nome || item.produto.nome}
                                                        </span>
                                                        {item.produto.produtoPai && (
                                                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider truncate max-w-[200px] md:max-w-xs mt-0.5">
                                                                {item.produto.nome}
                                                            </span>
                                                        )}
                                                        <div className="flex flex-wrap items-center gap-2 mt-1">
                                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Qtd: {item.quantidade}x</span>
                                                            <span className="text-slate-300 hidden sm:inline">•</span>
                                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Unit: {(item.produto.precos?.[0]?.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                                                            <span className="text-slate-300 hidden sm:inline">•</span>
                                                            <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Estoque: {item.produto.estoque}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="text-right shrink-0">
                                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Subtotal</span>
                                                    <span className="font-bold text-slate-900">
                                                        {((item.produto.precos?.[0]?.valor || 0) * item.quantidade).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="mt-6 pt-4 border-t border-slate-100 flex justify-between items-center">
                                        <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Valor Total da Reserva</span>
                                        <span className="text-2xl font-black text-primary">
                                            {reserva.itens.reduce((acc: number, item: any) => acc + (item.produto.precos?.[0]?.valor || 0) * item.quantidade, 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                        </span>
                                    </div>

                                    {reserva.status === 'CANCELADA' && (
                                        <div className="mt-4 p-3 bg-red-50 rounded-xl flex items-center gap-2 text-red-600 text-xs font-bold">
                                            <AlertCircle className="size-4" />
                                            Esta reserva foi cancelada e não pode ser processada.
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Custom Cancellation Modal */}
            {reservaParaCancelar && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4">
                    <div className="w-full max-w-md bg-white rounded-[32px] shadow-2xl animate-in zoom-in-95 duration-200 overflow-hidden ring-1 ring-slate-200">
                        <div className="p-8 text-center space-y-6">
                            <div className="size-20 bg-red-50 text-red-500 rounded-3xl flex items-center justify-center mx-auto mb-2 rotate-3 hover:rotate-0 transition-transform duration-500 group">
                                <AlertCircle className="size-10" />
                            </div>

                            <div className="space-y-2">
                                <h3 className="text-2xl font-black text-slate-900">Confirmar Cancelamento</h3>
                                <p className="text-slate-500">
                                    Deseja realmente cancelar a reserva <span className="font-bold text-slate-900">#{reservaParaCancelar.id.slice(-6).toUpperCase()}</span>?
                                </p>
                            </div>

                            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 space-y-3 text-left">
                                <div className="flex items-center gap-3 text-sm">
                                    <Calendar className="size-4 text-slate-400" />
                                    <span className="text-slate-600">{formatLocalDate(reservaParaCancelar.criadoEm)}</span>
                                </div>
                                <div className="flex items-center gap-3 text-sm">
                                    <Package className="size-4 text-slate-400" />
                                    <span className="text-slate-600">{reservaParaCancelar.itens.length} tipo(s) de produtos</span>
                                </div>
                                <div className="pt-2 border-t border-slate-200 flex justify-between items-center">
                                    <span className="text-xs font-black text-slate-400 uppercase">Total Estimado</span>
                                    <span className="text-lg font-black text-primary">
                                        {reservaParaCancelar.itens.reduce((acc: number, item: any) => acc + (item.produto.precos?.[0]?.valor || 0) * item.quantidade, 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                                    </span>
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setReservaParaCancelar(null)}
                                    className="flex-1 py-4 text-slate-500 font-bold rounded-2xl hover:bg-slate-50 transition-all active:scale-95"
                                >
                                    Manter Reserva
                                </button>
                                <button
                                    disabled={isCancelling === reservaParaCancelar.id}
                                    onClick={() => handleCancelarReserva(reservaParaCancelar.id)}
                                    className="flex-[1.5] py-4 bg-red-500 hover:bg-red-600 text-white font-black rounded-2xl transition-all shadow-xl shadow-red-200 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                                >
                                    {isCancelling === reservaParaCancelar.id ? (
                                        <Loader2 className="size-5 animate-spin" />
                                    ) : (
                                        <>
                                            <XCircle className="size-5" />
                                            Sim, Cancelar
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
