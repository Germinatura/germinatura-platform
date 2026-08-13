"use client";

import { useEffect, useState } from "react";
import { Loader2, Ticket, Trophy, ArrowRight, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";

interface Rifa {
    id: string;
    titulo: string;
    descricao: string;
    imagemUrl?: string;
    precoPorNumero: number;
    status: string;
    ganhadorNome?: string | null;
}

export default function RifasConsumerPage() {
    const [rifas, setRifas] = useState<Rifa[]>([]);
    const [loading, setLoading] = useState(true);
    const { showToast } = useToast();

    useEffect(() => {
        const fetchRifas = async () => {
            try {
                const res = await fetch("/api/consumer/rifas");
                const data = await res.json();
                if (res.ok) {
                    setRifas(data);
                } else {
                    showToast(data.error || "Erro ao carregar catálogo.", "error");
                }
            } catch (error) {
                showToast("Erro de conexão.", "error");
            } finally {
                setLoading(false);
            }
        };
        fetchRifas();
    }, []);

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-auto custom-scrollbar">
            <div className="bg-white border-b border-slate-200 p-6 md:p-10 shrink-0">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div>
                        <h1 className="text-3xl md:text-4xl font-black tracking-tight text-slate-900">Rifas da Formatura</h1>
                        <p className="text-sm md:text-base text-slate-500 font-medium mt-2 max-w-xl">
                            Participe e concorra a prêmios incríveis! Escolha seus números da sorte e apoie nossa formatura.
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-6 md:p-10 max-w-7xl mx-auto w-full">
                {rifas.length === 0 ? (
                    <div className="bg-white rounded-3xl border border-slate-200 p-12 flex flex-col items-center justify-center text-center shadow-sm">
                        <div className="size-20 rounded-full bg-slate-50 flex items-center justify-center mb-6 border border-slate-100">
                            <Ticket className="size-10 text-slate-300" />
                        </div>
                        <h3 className="text-2xl font-black text-slate-900 mb-2">Nenhuma rifa no momento</h3>
                        <p className="text-slate-500 max-w-md">Fique de olho! Novas rifas serão adicionadas em breve pela comissão.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {rifas.map(rifa => (
                            <Link 
                                href={`/rifas/${rifa.id}`} 
                                key={rifa.id}
                                className="bg-white rounded-[2rem] border border-slate-200 overflow-hidden shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 group flex flex-col"
                            >
                                <div className="h-48 bg-slate-100 relative overflow-hidden flex items-center justify-center">
                                    {rifa.imagemUrl ? (
                                        <img src={rifa.imagemUrl} alt={rifa.titulo} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                    ) : (
                                        <ImageIcon className="size-12 text-slate-300" />
                                    )}
                                    <div className="absolute top-4 right-4 flex flex-col gap-2">
                                        <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-sm backdrop-blur-md ${
                                            rifa.status === 'ATIVA' ? 'bg-emerald-500/90 text-white' : 'bg-amber-500/90 text-white'
                                        }`}>
                                            {rifa.status}
                                        </span>
                                    </div>
                                </div>
                                <div className="p-6 flex flex-col flex-1">
                                    <h3 className="text-lg font-black text-slate-900 mb-2 line-clamp-1 group-hover:text-primary transition-colors">{rifa.titulo}</h3>
                                    <p className="text-xs text-slate-500 font-medium mb-6 line-clamp-2 flex-1">{rifa.descricao}</p>
                                    
                                    {rifa.status === 'FINALIZADA' && rifa.ganhadorNome ? (
                                        <div className="mt-auto bg-amber-50 rounded-2xl p-4 border border-amber-100 flex items-center gap-3">
                                            <div className="p-2 bg-amber-100 rounded-full text-amber-600">
                                                <Trophy className="size-5" />
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-black text-amber-600/70 uppercase tracking-widest mb-0.5">Ganhador</p>
                                                <p className="text-sm font-black text-amber-700 truncate">{rifa.ganhadorNome}</p>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="mt-auto flex items-center justify-between">
                                            <div>
                                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Valor do Número</p>
                                                <p className="text-xl font-black text-emerald-600 mt-auto">
                                                    {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(rifa.precoPorNumero)}
                                                </p>
                                            </div>
                                            <div className="size-12 rounded-2xl bg-primary/5 group-hover:bg-primary text-primary group-hover:text-white flex items-center justify-center transition-colors">
                                                <ArrowRight className="size-5" />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
