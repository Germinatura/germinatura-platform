"use client";

import { useState, useEffect, use, useMemo } from "react";
import {
    ArrowLeft,
    Loader2,
    Ticket,
    CheckCircle2,
    User,
    X,
    ShoppingCart,
    Check,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { montarPayloadPix } from "@/lib/pix";

interface NumeroRifa {
    id: string;
    numero: number;
    status: string;
}

interface Rifa {
    id: string;
    titulo: string;
    descricao: string;
    imagemUrl?: string;
    precoPorNumero: number;
    quantidadeNumeros: number;
    status: string;
    numeros: NumeroRifa[];
}

type Step = "SELECTION" | "PAYMENT" | "BUYER_INFO" | "SUCCESS";

export default function PDVRifaPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const { showToast } = useToast();

    const [rifa, setRifa] = useState<Rifa | null>(null);
    const [loading, setLoading] = useState(true);
    const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
    const [step, setStep] = useState<Step>("SELECTION");

    // Buyer info form — state kept here so typing doesn't cause re-mount
    const [buyerNome, setBuyerNome] = useState("");
    const [buyerEmail, setBuyerEmail] = useState("");
    const [buyerTelefone, setBuyerTelefone] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    const fetchRifa = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/pdv/rifas/${id}`);
            const data = await res.json();
            if (res.ok) {
                if (data.status !== "ATIVA") {
                    showToast("Esta rifa não está ativa.", "error");
                    router.back();
                    return;
                }
                setRifa(data);
            } else {
                showToast(data.error || "Erro ao carregar rifa.", "error");
                router.back();
            }
        } catch {
            showToast("Erro de conexão.", "error");
            router.back();
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchRifa();
    }, [id]);

    const toggleNumber = (numero: number) => {
        setSelectedNumbers(prev =>
            prev.includes(numero) ? prev.filter(n => n !== numero) : [...prev, numero]
        );
    };

    const total = useMemo(() => {
        if (!rifa) return 0;
        return selectedNumbers.length * rifa.precoPorNumero;
    }, [selectedNumbers, rifa]);

    const pixPayload = useMemo(() => {
        if (total <= 0) return "";
        return montarPayloadPix({
            chave: process.env.NEXT_PUBLIC_PIX_CHAVE || "",
            nome: process.env.NEXT_PUBLIC_PIX_NOME_RECEBEDOR || "Comissao GerminareTECH",
            cidade: process.env.NEXT_PUBLIC_PIX_CIDADE || "Sao Paulo",
            valor: total.toFixed(2),
        });
    }, [total]);

    const handleGoToPayment = () => {
        if (selectedNumbers.length === 0) {
            showToast("Selecione pelo menos um número.", "warning");
            return;
        }
        setStep("PAYMENT");
    };

    const handleFinalizeSale = async () => {
        if (!buyerNome.trim() || !buyerEmail.trim() || !buyerTelefone.trim()) {
            showToast("Preencha todos os dados do comprador.", "warning");
            return;
        }
        setIsSaving(true);
        try {
            const res = await fetch("/api/pdv/rifas/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    rifaId: id,
                    numeros: selectedNumbers,
                    nome: buyerNome,
                    email: buyerEmail,
                    telefone: buyerTelefone,
                }),
            });
            const data = await res.json();
            if (res.ok) {
                setStep("SUCCESS");
                fetchRifa();
            } else {
                showToast(data.error || "Erro ao finalizar venda.", "error");
            }
        } catch {
            showToast("Erro de conexão ao finalizar venda.", "error");
        } finally {
            setIsSaving(false);
        }
    };

    const handleNewSale = () => {
        setSelectedNumbers([]);
        setBuyerNome("");
        setBuyerEmail("");
        setBuyerTelefone("");
        setStep("SELECTION");
    };

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background-light">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!rifa) return null;

    const numDisponiveis = rifa.numeros.filter(n => n.status === "DISPONIVEL").length;

    return (
        <div className="relative mx-auto min-h-screen max-w-md bg-background-light pb-36 font-sans overflow-hidden">

            {/* ==================== SUCCESS OVERLAY ==================== */}
            {step === "SUCCESS" && (
                <div className="fixed inset-0 z-[100] bg-white flex flex-col items-center justify-between p-8 text-center animate-in fade-in duration-300">
                    <div className="flex-1 flex flex-col items-center justify-center space-y-8 mt-12">
                        <div className="relative size-48 flex items-center justify-center">
                            <div className="absolute inset-0 bg-emerald-100 rounded-full animate-in zoom-in-50 duration-500" />
                            <div className="relative size-24 text-emerald-500 flex items-center justify-center">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full drop-shadow-sm">
                                    <path d="M20 6L9 17L4 12" style={{ strokeDasharray: 100, strokeDashoffset: 0 }} />
                                </svg>
                            </div>
                        </div>
                        <div className="space-y-3 text-center flex flex-col items-center w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                            <h2 className="text-3xl font-black text-slate-900 tracking-tight">Venda Registrada!</h2>
                            <p className="text-slate-500 font-medium max-w-[280px]">
                                Os números foram vinculados ao comprador com sucesso.
                            </p>
                            <div className="mt-4 bg-slate-50 rounded-2xl border border-slate-200 p-4 w-full text-left">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Resumo</p>
                                <p className="font-bold text-slate-800">{buyerNome}</p>
                                <p className="text-xs text-slate-500 mt-0.5">{buyerEmail}</p>
                                <p className="text-xs text-slate-500">{buyerTelefone}</p>
                                <div className="mt-3 flex flex-wrap gap-1">
                                    {[...selectedNumbers].sort((a, b) => a - b).map(n => (
                                        <span key={n} className="bg-primary/10 text-primary text-[10px] font-black px-2 py-1 rounded-md border border-primary/20">
                                            {String(n).padStart(3, "0")}
                                        </span>
                                    ))}
                                </div>
                                <p className="mt-3 text-sm font-black text-emerald-600">
                                    Total: R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="w-full flex flex-col gap-3 pb-4 animate-in slide-in-from-bottom-8 duration-500">
                        <button onClick={handleNewSale} className="w-full py-5 bg-primary text-white font-black rounded-3xl text-lg shadow-xl shadow-primary/20 active:scale-[0.97] transition-all uppercase tracking-widest">
                            Nova Venda
                        </button>
                        <button onClick={() => router.back()} className="w-full py-4 bg-slate-100 text-slate-600 font-bold rounded-3xl text-sm transition-all">
                            Voltar
                        </button>
                    </div>
                </div>
            )}

            {/* ==================== PAYMENT MODAL ==================== */}
            {step === "PAYMENT" && (
                <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-slate-900/50 backdrop-blur-sm">
                    <div className="w-full max-w-md bg-white rounded-t-[2rem] p-6 pb-10 shadow-[0_-20px_60px_rgba(0,0,0,0.15)] animate-in slide-in-from-bottom duration-300">
                        <div className="mx-auto mb-6 h-1.5 w-14 rounded-full bg-slate-200" />
                        <div className="flex justify-between items-start mb-5">
                            <div>
                                <h3 className="text-2xl font-black tracking-tight text-slate-900">Pagamento</h3>
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Mostre o QR Code para o comprador</p>
                            </div>
                            <button onClick={() => setStep("SELECTION")} className="p-2.5 rounded-full hover:bg-slate-100 text-slate-400 transition-colors bg-slate-50 border border-slate-100">
                                <X className="size-5" strokeWidth={3} />
                            </button>
                        </div>
                        <div className="mb-5 space-y-2 rounded-[1.2rem] bg-slate-50 p-4 border border-slate-100">
                            <div className="flex items-center justify-between text-sm">
                                <span className="font-bold text-slate-500">{selectedNumbers.length} número{selectedNumbers.length > 1 ? "s" : ""}</span>
                                <span className="font-black text-slate-900">R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
                            </div>
                            <div className="flex flex-wrap gap-1 pt-1 border-t border-slate-200">
                                {[...selectedNumbers].sort((a, b) => a - b).map(n => (
                                    <span key={n} className="bg-primary/10 text-primary text-[10px] font-black px-1.5 py-0.5 rounded border border-primary/20">
                                        {String(n).padStart(3, "0")}
                                    </span>
                                ))}
                            </div>
                        </div>
                        <div className="flex flex-col items-center gap-3 py-3">
                            <div className="relative rounded-[1.5rem] border-8 border-slate-50 p-3 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
                                {pixPayload && <QRCodeSVG value={pixPayload} size={190} level="M" includeMargin={false} />}
                            </div>
                            <span className="text-[10px] font-black text-slate-400 tracking-[0.2em] uppercase bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200/50">
                                PIX · R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                            </span>
                        </div>
                        <div className="mt-6 flex flex-col gap-3">
                            <button
                                onClick={() => setStep("BUYER_INFO")}
                                className="flex w-full items-center justify-center gap-2 h-[56px] bg-emerald-500 text-white font-black rounded-2xl text-[16px] shadow-xl shadow-emerald-500/20 active:scale-[0.98] transition-all uppercase tracking-widest"
                            >
                                <CheckCircle2 className="size-6" />
                                Confirmar Pagamento
                            </button>
                            <button onClick={() => setStep("SELECTION")} className="w-full h-[48px] text-slate-400 hover:text-red-500 hover:bg-red-50 font-black rounded-2xl transition-colors text-sm uppercase tracking-widest">
                                Cancelar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ==================== BUYER INFO MODAL ==================== */}
            {step === "BUYER_INFO" && (
                <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-slate-900/50 backdrop-blur-sm">
                    <div className="w-full max-w-md bg-white rounded-t-[2rem] p-6 pb-10 shadow-[0_-20px_60px_rgba(0,0,0,0.15)] animate-in slide-in-from-bottom duration-300">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="p-2.5 bg-primary/10 rounded-2xl text-primary">
                                <User className="size-5" />
                            </div>
                            <div>
                                <h3 className="text-xl font-black text-slate-900">Dados do Comprador</h3>
                                <p className="text-xs font-semibold text-slate-400">Preencha para registrar a venda</p>
                            </div>
                        </div>
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                    Nome Completo
                                </label>
                                <input
                                    autoFocus
                                    value={buyerNome}
                                    onChange={e => setBuyerNome(e.target.value)}
                                    placeholder="Ex: João da Silva"
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-sm font-semibold text-slate-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                    E-mail
                                </label>
                                <input
                                    type="email"
                                    value={buyerEmail}
                                    onChange={e => setBuyerEmail(e.target.value)}
                                    placeholder="joao@email.com"
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-sm font-semibold text-slate-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                    Telefone / WhatsApp
                                </label>
                                <input
                                    type="tel"
                                    value={buyerTelefone}
                                    onChange={e => setBuyerTelefone(e.target.value)}
                                    placeholder="(11) 99999-9999"
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-sm font-semibold text-slate-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 transition-all"
                                />
                            </div>
                        </div>
                        <div className="flex flex-col gap-3">
                            <button
                                onClick={handleFinalizeSale}
                                disabled={isSaving || !buyerNome.trim() || !buyerEmail.trim() || !buyerTelefone.trim()}
                                className="flex w-full items-center justify-center gap-2 h-[56px] bg-emerald-500 text-white font-black rounded-2xl text-[16px] shadow-xl shadow-emerald-500/20 active:scale-[0.98] disabled:opacity-50 transition-all uppercase tracking-widest"
                            >
                                {isSaving ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
                                Finalizar Venda
                            </button>
                            <button
                                onClick={() => setStep("PAYMENT")}
                                className="w-full h-[48px] text-slate-400 hover:text-slate-600 font-bold rounded-2xl hover:bg-slate-50 transition-colors text-sm uppercase tracking-widest"
                            >
                                Voltar ao QR Code
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ==================== HEADER ==================== */}
            <header className="sticky top-0 z-30 flex items-center justify-between bg-white/80 px-4 py-4 backdrop-blur-md border-b border-slate-200 shadow-sm">
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => router.back()}
                        className="cursor-pointer p-2 rounded-full hover:bg-slate-100/50 text-slate-500 transition-colors"
                        title="Voltar"
                    >
                        <ArrowLeft className="size-5" />
                    </button>
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary border border-primary/20 shadow-inner">
                        <Ticket className="size-5" />
                    </div>
                    <div>
                        <h1 className="text-base font-black leading-tight tracking-tight text-slate-900 truncate max-w-[180px]">
                            {rifa.titulo}
                        </h1>
                        <p className="text-[9px] font-black text-primary/80 uppercase tracking-[0.2em]">PDV · Venda Presencial</p>
                    </div>
                </div>
                <div className="text-right">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Disponíveis</p>
                    <p className="text-sm font-black text-slate-900">{numDisponiveis}/{rifa.quantidadeNumeros}</p>
                </div>
            </header>

            {/* ==================== CONTENT ==================== */}
            <main className="p-4 space-y-4 animate-in fade-in duration-500">
                {rifa.imagemUrl && (
                    <div className="relative rounded-[1.5rem] overflow-hidden h-36 bg-slate-100 shadow-sm border border-slate-100">
                        <img src={rifa.imagemUrl} alt={rifa.titulo} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 to-transparent" />
                        <div className="absolute bottom-4 left-4">
                            <p className="text-white font-black text-lg leading-tight">{rifa.titulo}</p>
                            <p className="text-white/70 text-xs font-medium">
                                R$ {rifa.precoPorNumero.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} por número
                            </p>
                        </div>
                    </div>
                )}

                <div className="flex items-center justify-between py-1">
                    <h2 className="text-lg font-black tracking-tight text-slate-900">Selecionar Números</h2>
                    {selectedNumbers.length > 0 && (
                        <button
                            onClick={() => setSelectedNumbers([])}
                            className="text-xs font-black text-red-500 hover:text-red-600 transition-colors uppercase tracking-widest"
                        >
                            Limpar
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    <div className="flex items-center gap-1.5"><div className="size-3 rounded bg-slate-200" /> Indisponível</div>
                    <div className="flex items-center gap-1.5"><div className="size-3 rounded bg-white border border-slate-300" /> Livre</div>
                    <div className="flex items-center gap-1.5"><div className="size-3 rounded bg-primary" /> Selecionado</div>
                </div>

                <div className="grid grid-cols-5 gap-2">
                    {rifa.numeros.map(num => {
                        const isAvailable = num.status === "DISPONIVEL";
                        const isSelected = selectedNumbers.includes(num.numero);
                        return (
                            <button
                                key={num.id}
                                disabled={!isAvailable}
                                onClick={() => toggleNumber(num.numero)}
                                className={`
                                    w-full aspect-square rounded-xl flex items-center justify-center text-xs font-black transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-primary/20
                                    ${!isAvailable ? "bg-slate-100 text-slate-300 border border-slate-200 cursor-not-allowed" : ""}
                                    ${isAvailable && !isSelected ? "bg-white text-slate-600 border border-slate-200 hover:border-primary/50 hover:text-primary cursor-pointer active:scale-95" : ""}
                                    ${isSelected ? "bg-primary text-white border-primary shadow-md shadow-primary/30 scale-105 z-10" : ""}
                                `}
                            >
                                {String(num.numero).padStart(3, "0")}
                            </button>
                        );
                    })}
                </div>
            </main>

            {/* ==================== FOOTER ==================== */}
            <footer className="fixed bottom-0 left-0 right-0 z-40 mx-auto max-w-md border-t border-slate-200 bg-white/95 backdrop-blur-md p-4 pt-3 pb-6 shadow-[0_-10px_40px_rgba(0,0,0,0.06)] rounded-t-[1.5rem]">
                <div className="mb-3 flex items-center justify-between px-2">
                    <span className="text-slate-500 font-bold text-sm tracking-wide block">
                        {selectedNumbers.length > 0
                            ? `${selectedNumbers.length} número${selectedNumbers.length > 1 ? "s" : ""} selecionado${selectedNumbers.length > 1 ? "s" : ""}`
                            : "Nenhum número selecionado"}
                    </span>
                    <span className="text-2xl font-black text-slate-900 tracking-tight">
                        R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                    </span>
                </div>
                <button
                    onClick={handleGoToPayment}
                    disabled={selectedNumbers.length === 0}
                    className={`flex w-full items-center justify-center gap-3 rounded-[1.2rem] h-[56px] text-[17px] font-black text-white shadow-xl transition-all duration-300 active:scale-[0.98] tracking-widest uppercase ${selectedNumbers.length > 0 ? "bg-primary shadow-primary/30 hover:bg-primary/95" : "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none"}`}
                >
                    <ShoppingCart className="size-5" />
                    Ir para Pagamento
                </button>
            </footer>
        </div>
    );
}
