"use client";

import { useState, useEffect } from "react";
import { ArrowLeft, Loader2, Ticket, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { apiFetch } from "@/lib/api";
import Link from "next/link";

interface Rifa {
    id: string;
    titulo: string;
    descricao: string;
    imagemUrl?: string;
    precoPorNumero: number;
    quantidadeNumeros: number;
    status: string;
    _count?: { numeros: number };
}

export default function PDVRifasListPage() {
    const [rifas, setRifas] = useState<Rifa[]>([]);
    const [loading, setLoading] = useState(true);
    const router = useRouter();
    const { showToast } = useToast();

    useEffect(() => {
        const fetchRifas = async () => {
            try {
                const res = await apiFetch("/api/pdv/rifas");
                const data = await res.json();
                if (res.ok) {
                    setRifas(data);
                } else {
                    showToast(data.error || "Erro ao carregar rifas.", "error");
                }
            } catch {
                showToast("Erro de conexão.", "error");
            } finally {
                setLoading(false);
            }
        };
        fetchRifas();
    }, []);

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background-light">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="relative mx-auto min-h-screen max-w-md bg-background-light font-sans">
            {/* Header */}
            <header className="sticky top-0 z-30 flex items-center gap-3 bg-white/80 px-4 py-4 backdrop-blur-md border-b border-slate-200 shadow-sm">
                <button
                    onClick={() => router.back()}
                    className="p-2 rounded-full hover:bg-slate-100/50 text-slate-500 transition-colors"
                >
                    <ArrowLeft className="size-5" />
                </button>
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary border border-primary/20 shadow-inner">
                    <Ticket className="size-5" />
                </div>
                <div>
                    <h1 className="text-base font-black tracking-tight text-slate-900">PDV de Rifas</h1>
                    <p className="text-[9px] font-black text-primary/80 uppercase tracking-[0.2em]">Venda Presencial</p>
                </div>
            </header>

            {/* Content */}
            <main className="p-4 space-y-4 animate-in fade-in duration-500">
                <div className="flex items-center justify-between py-2">
                    <h2 className="text-xl font-black tracking-tight text-slate-900">Rifas Ativas</h2>
                    <span className="flex items-center justify-center bg-primary/10 text-primary text-[10px] px-2 py-0.5 rounded-md uppercase tracking-wider font-extrabold">
                        {rifas.length} {rifas.length === 1 ? "rifa" : "rifas"}
                    </span>
                </div>

                {rifas.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
                        <div className="size-20 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center">
                            <Ticket className="size-10 text-slate-300" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-900 text-lg">Nenhuma rifa ativa</h3>
                            <p className="text-sm text-slate-500 font-medium mt-1 max-w-xs">
                                Não há rifas ativas no momento. Crie ou ative uma rifa no painel administrativo.
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="grid gap-3">
                        {rifas.map(rifa => (
                            <Link
                                key={rifa.id}
                                href={`/rifas/${rifa.id}`}
                                className="flex gap-4 rounded-[1.5rem] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.02)] border border-slate-100 hover:border-primary/20 hover:shadow-md transition-all duration-300 group"
                            >
                                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-[1rem] bg-slate-50 flex items-center justify-center border border-slate-100/60 shadow-inner">
                                    {rifa.imagemUrl ? (
                                        <img src={rifa.imagemUrl} alt={rifa.titulo} className="h-full w-full object-cover" />
                                    ) : (
                                        <Ticket className="size-8 text-slate-300" />
                                    )}
                                </div>
                                <div className="flex flex-1 flex-col justify-between py-1">
                                    <div>
                                        <h3 className="text-[17px] font-black text-slate-900 leading-tight tracking-tight group-hover:text-primary transition-colors truncate max-w-[180px]">
                                            {rifa.titulo}
                                        </h3>
                                        <p className="text-xs text-slate-500 font-medium mt-0.5 line-clamp-1">
                                            {rifa.descricao}
                                        </p>
                                    </div>
                                    <div className="flex items-center justify-between mt-1">
                                        <span className="text-xs font-black text-emerald-600">
                                            R$ {rifa.precoPorNumero.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}/num
                                        </span>
                                        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-600 border border-emerald-200/50">
                                            ATIVA
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center text-slate-300 group-hover:text-primary transition-colors self-center">
                                    <ChevronRight className="size-5" />
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
}
