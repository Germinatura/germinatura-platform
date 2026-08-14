"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Ticket, ArrowLeft, Trophy, Clock, Copy, Check, X } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface PedidoRifaData {
    id: string;
    status: string;
    pixKey: string | null;
    pixQrCodeUrl: string | null;
    abacatePayId: string | null;
    valorTotal: number;
    criadoEm: string;
}

interface RifaBase {
    id: string;
    titulo: string;
    imagemUrl?: string;
    status: string;
    dataSorteio?: string;
    numeroSorteado?: number | null;
}

interface NumeroRifa {
    id: string;
    numero: number;
    status: string;
    criadoEm: string;
    rifa: RifaBase;
    pedidoRifa: PedidoRifaData | null;
}

interface BilheteGroup {
    key: string;
    rifa: RifaBase;
    numeros: NumeroRifa[];
    pedido: PedidoRifaData | null;
    status: string; // dominant status
}

const PIX_TIMEOUT_MS = 15 * 60 * 1000;

function groupBilhetes(bilhetes: NumeroRifa[]): BilheteGroup[] {
    const groups = new Map<string, BilheteGroup>();

    for (const b of bilhetes) {
        // Group key: pedidoRifaId if exists, otherwise "rifa_<rifaId>_<status>"
        const key = b.pedidoRifa
            ? `pedido_${b.pedidoRifa.id}`
            : `rifa_${b.rifa.id}_${b.status}`;

        if (!groups.has(key)) {
            groups.set(key, {
                key,
                rifa: b.rifa,
                numeros: [],
                pedido: b.pedidoRifa,
                status: b.status,
            });
        }
        groups.get(key)!.numeros.push(b);
    }

    // Sort: RESERVADO first, then VENDIDO
    return Array.from(groups.values()).sort((a, b) => {
        if (a.status === "RESERVADO" && b.status !== "RESERVADO") return -1;
        if (b.status === "RESERVADO" && a.status !== "RESERVADO") return 1;
        return 0;
    });
}

function ResumePaymentModal({ group, onClose, onExpired }: {
    group: BilheteGroup;
    onClose: () => void;
    onExpired: () => void;
}) {
    const { showToast } = useToast();
    const [copied, setCopied] = useState(false);
    const [timeLeft, setTimeLeft] = useState(0);
    const [pollingStatus, setPollingStatus] = useState<string>("PENDENTE");
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const pollRef = useRef<NodeJS.Timeout | null>(null);

    const pedido = group.pedido;
    const criadoEm = pedido ? new Date(pedido.criadoEm).getTime() : 0;
    const expiresAt = criadoEm + PIX_TIMEOUT_MS;

    useEffect(() => {
        const update = () => {
            const remaining = expiresAt - Date.now();
            if (remaining <= 0) { setTimeLeft(0); onExpired(); return; }
            setTimeLeft(remaining);
        };
        update();
        intervalRef.current = setInterval(update, 1000);
        return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [expiresAt, onExpired]);

    useEffect(() => {
        if (!pedido) return;
        const poll = async () => {
            try {
                const res = await fetch(`/api/consumer/pedidos/${pedido.id}/status`);
                const data = await res.json();
                if (data.status === "PAGO") {
                    setPollingStatus("PAGO");
                    if (pollRef.current) clearInterval(pollRef.current);
                }
            } catch {}
        };
        poll();
        pollRef.current = setInterval(poll, 5000);
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [pedido]);

    const handleCopy = async () => {
        if (!pedido?.pixKey) return;
        await navigator.clipboard.writeText(pedido.pixKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        showToast("Código copiado!", "success");
    };

    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);

    if (!pedido) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200">
                <div className="p-6 pb-0 flex items-start justify-between">
                    <div>
                        <h3 className="text-xl font-black text-slate-900">
                            {pollingStatus === "PAGO" ? "✅ Pagamento Confirmado!" : "Finalizar Pagamento"}
                        </h3>
                        <p className="text-sm text-slate-500 mt-1">
                            {group.rifa.titulo} · {group.numeros.length} número{group.numeros.length > 1 ? 's' : ''}
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">
                        <X className="size-5" />
                    </button>
                </div>

                {pollingStatus === "PAGO" ? (
                    <div className="p-6 text-center">
                        <div className="text-6xl mb-4">🎉</div>
                        <p className="text-slate-600 font-medium">
                            Números {group.numeros.map(n => String(n.numero).padStart(3,'0')).join(', ')} confirmados!
                        </p>
                        <button onClick={onClose} className="mt-6 w-full bg-primary text-white font-black py-3 rounded-2xl uppercase tracking-widest text-xs">
                            Fechar
                        </button>
                    </div>
                ) : (
                    <div className="p-6 space-y-4">
                        <div className={`flex items-center justify-center gap-2 py-2 px-4 rounded-xl font-black text-sm ${timeLeft < 60000 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                            <Clock className="size-4" />
                            Expira em {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
                        </div>

                        {/* Numbers */}
                        <div className="flex flex-wrap gap-2 justify-center py-1">
                            {group.numeros.map(n => (
                                <span key={n.id} className="bg-slate-900 text-white font-black text-base px-3.5 py-1.5 rounded-xl tabular-nums">
                                    {String(n.numero).padStart(3, '0')}
                                </span>
                            ))}
                        </div>

                        <div className="flex items-center justify-between px-2 pt-2 border-t border-slate-100">
                            <div className="flex flex-col">
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total</span>
                                <span className="text-[9px] text-primary font-bold">Inclui taxa de R$ 0,80</span>
                            </div>
                            <span className="text-xl font-black text-emerald-600">R$ {pedido.valorTotal.toFixed(2)}</span>
                        </div>

                        <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4 flex items-center justify-center min-h-[180px]">
                            {pedido.pixQrCodeUrl ? (
                                <img src={pedido.pixQrCodeUrl} alt="QR Code Pix" className="w-40 h-40 object-contain" />
                            ) : (
                                <div className="text-center text-slate-400">
                                    <Ticket className="size-10 mx-auto mb-2 opacity-30" />
                                    <p className="text-xs font-medium">QR Code indisponível</p>
                                </div>
                            )}
                        </div>

                        {pedido.pixKey && (
                            <div>
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Pix Copia e Cola</p>
                                <div className="flex gap-2">
                                    <input readOnly value={pedido.pixKey} className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-600 font-mono" />
                                    <button onClick={handleCopy} className="bg-primary text-white px-4 rounded-xl flex items-center gap-1 font-bold text-xs hover:bg-primary/90 transition-colors">
                                        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-center gap-2 text-slate-400 text-xs font-medium">
                            <Loader2 className="size-3 animate-spin" />
                            Aguardando confirmação automática...
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function MinhasRifasPage() {
    const [bilhetes, setBilhetes] = useState<NumeroRifa[]>([]);
    const [loading, setLoading] = useState(true);
    const [resuming, setResuming] = useState<BilheteGroup | null>(null);
    const { showToast } = useToast();
    const router = useRouter();

    const fetchMeusBilhetes = useCallback(async () => {
        try {
            const res = await fetch("/api/consumer/rifas/minhas");
            const data = await res.json();
            if (res.ok) setBilhetes(data);
            else showToast(data.error || "Erro ao carregar bilhetes.", "error");
        } catch {
            showToast("Erro de conexão.", "error");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchMeusBilhetes(); }, []);

    const isExpired = (group: BilheteGroup) => {
        if (!group.pedido) return false;
        return (Date.now() - new Date(group.pedido.criadoEm).getTime()) > PIX_TIMEOUT_MS;
    };

    const handleClickGroup = (group: BilheteGroup) => {
        if (group.status === "RESERVADO") {
            if (isExpired(group)) {
                showToast("Este Pix expirou. Os números foram liberados.", "warning");
                fetchMeusBilhetes();
                return;
            }
            setResuming(group);
            return;
        }
        router.push(`/rifas/${group.rifa.id}`);
    };

    if (loading) {
        return <div className="flex h-screen items-center justify-center"><Loader2 className="size-8 animate-spin text-primary" /></div>;
    }

    const groups = groupBilhetes(bilhetes.filter(b => b.status !== "CANCELADO"));

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-auto custom-scrollbar">
            {resuming && (
                <ResumePaymentModal
                    group={resuming}
                    onClose={() => { setResuming(null); fetchMeusBilhetes(); }}
                    onExpired={() => { setResuming(null); showToast("Pix expirado. Os números foram liberados.", "warning"); fetchMeusBilhetes(); }}
                />
            )}

            <div className="bg-white border-b border-slate-200 p-6 md:p-10 shrink-0">
                <div className="max-w-5xl mx-auto flex items-center gap-4">
                    <button onClick={() => router.back()} className="p-3 rounded-2xl border border-slate-200 hover:bg-slate-50 text-slate-500 hover:text-primary transition-colors">
                        <ArrowLeft className="size-5" />
                    </button>
                    <div>
                        <h1 className="text-2xl md:text-3xl font-black tracking-tight text-slate-900">Meus Bilhetes</h1>
                        <p className="text-xs md:text-sm text-slate-500 font-medium mt-1">Acompanhe seus números e sorteios.</p>
                    </div>
                </div>
            </div>

            <div className="p-6 md:p-10 max-w-5xl mx-auto w-full">
                {groups.length === 0 ? (
                    <div className="bg-white rounded-3xl border border-slate-200 p-12 flex flex-col items-center justify-center text-center shadow-sm">
                        <div className="size-20 rounded-full bg-slate-50 flex items-center justify-center mb-6 border border-slate-100">
                            <Ticket className="size-10 text-slate-300" />
                        </div>
                        <h3 className="text-2xl font-black text-slate-900 mb-2">Você ainda não tem bilhetes</h3>
                        <p className="text-slate-500 max-w-sm mb-8">Participe de uma rifa agora mesmo e concorra a prêmios!</p>
                        <Link href="/rifas" className="bg-primary hover:bg-primary/90 text-white font-black px-8 py-4 rounded-2xl shadow-xl shadow-primary/20 transition-all uppercase tracking-widest text-xs">
                            Ver Rifas Disponíveis
                        </Link>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        {groups.map((group) => {
                            const expired = group.status === "RESERVADO" && isExpired(group);
                            const isPending = group.status === "RESERVADO" && !expired;
                            return (
                                <div
                                    key={group.key}
                                    onClick={() => handleClickGroup(group)}
                                    className={`bg-white rounded-3xl border p-5 md:p-6 flex flex-col gap-5 transition-colors shadow-sm cursor-pointer group ${
                                        isPending ? "border-amber-200 hover:border-amber-400" : "border-slate-200 hover:border-primary/30"
                                    }`}
                                >
                                    {/* Header row */}
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="flex items-center gap-4">
                                            <div className="size-14 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center overflow-hidden shrink-0">
                                                {group.rifa.imagemUrl ? (
                                                    <img src={group.rifa.imagemUrl} alt="Capa" className="w-full h-full object-cover" />
                                                ) : (
                                                    <Ticket className="size-6 text-slate-300" />
                                                )}
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Rifa</p>
                                                <h4 className="text-base font-black text-slate-900 group-hover:text-primary transition-colors leading-tight">{group.rifa.titulo}</h4>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border ${
                                                        group.rifa.status === 'ATIVA' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-amber-50 text-amber-600 border-amber-100'
                                                    }`}>{group.rifa.status}</span>
                                                    <span className="text-[9px] font-bold text-slate-400">{group.numeros.length} número{group.numeros.length > 1 ? 's' : ''}</span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Status badge */}
                                        <div className="shrink-0 text-right">
                                            {isPending && (
                                                <span className="text-xs font-bold text-amber-600 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-100 animate-pulse block">
                                                    Clique para pagar
                                                </span>
                                            )}
                                            {expired && (
                                                <span className="text-xs font-bold text-slate-400 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200 block">Pix Expirado</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Numbers row */}
                                    <div className="flex flex-wrap gap-2">
                                        {group.numeros.map(n => (
                                            <div key={n.id} className="relative">
                                                <div className={`font-black text-base px-3.5 py-2 rounded-xl tabular-nums ${
                                                    isPending ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                                                    group.rifa.status === 'FINALIZADA' && group.rifa.numeroSorteado === n.numero
                                                        ? 'bg-amber-400 text-white border border-amber-500'
                                                        : 'bg-slate-900 text-white'
                                                }`}>
                                                    {String(n.numero).padStart(3, '0')}
                                                </div>
                                                {group.rifa.status === 'FINALIZADA' && group.rifa.numeroSorteado === n.numero && (
                                                    <Trophy className="size-3 text-amber-600 absolute -top-1.5 -right-1.5" />
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
