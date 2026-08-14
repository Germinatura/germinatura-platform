"use client";

import { useEffect, useState, use } from "react";
import { Loader2, ArrowLeft, Ticket, AlertCircle, ShoppingCart, Trophy, X, Check } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
    dataSorteio?: string;
    numeroSorteado?: number | null;
    numeros: NumeroRifa[];
    ganhadorNome?: string | null;
}

export default function RifaSelectionPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const [rifa, setRifa] = useState<Rifa | null>(null);
    const [loading, setLoading] = useState(true);
    const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
    
    // Checkout States
    const [isCheckingOut, setIsCheckingOut] = useState(false);
    const [checkoutData, setCheckoutData] = useState<{ pedidoId: string, qrCode: string, qrCodeUrl: string } | null>(null);
    const [paymentStatus, setPaymentStatus] = useState<string>("PENDENTE");
    
    // Customer Info Requirements
    const [missingInfo, setMissingInfo] = useState(false);
    const [cpfInput, setCpfInput] = useState("");
    const [telefoneInput, setTelefoneInput] = useState("");
    
    const { showToast } = useToast();
    const router = useRouter();

    const fetchRifa = async () => {
        try {
            const res = await fetch(`/api/consumer/rifas/${id}`);
            const data = await res.json();
            if (res.ok) {
                setRifa(data);
            } else {
                showToast(data.error || "Erro ao carregar rifa.", "error");
                router.push("/rifas");
            }
        } catch (error) {
            showToast("Erro de conexão.", "error");
            router.push("/rifas");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchRifa();
    }, [id]);

    useEffect(() => {
        if (!checkoutData || paymentStatus !== "PENDENTE") return;

        const interval = setInterval(async () => {
            try {
                const res = await fetch(`/api/consumer/pedidos/${checkoutData.pedidoId}/status`);
                const data = await res.json();
                
                if (data.status === "PAGO") {
                    setPaymentStatus("PAGO");
                    showToast("Sucesso! O pagamento foi compensado pelo AbacatePay.", "success");
                    clearInterval(interval);
                    fetchRifa(); 
                } else if (data.status === "CANCELADO") {
                    setPaymentStatus("CANCELADO");
                    showToast("Pagamento Cancelado / Expirado.", "error");
                    clearInterval(interval);
                }
            } catch (error) {
                console.error("Erro no polling", error);
            }
        }, 5000);

        return () => clearInterval(interval);
    }, [checkoutData, paymentStatus]);

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!rifa) return null;

    const toggleNumber = (numero: number) => {
        setSelectedNumbers(prev => 
            prev.includes(numero) 
                ? prev.filter(n => n !== numero)
                : [...prev, numero]
        );
    };

    const handleCheckout = async (additionalData?: { cpf: string, telefone: string }) => {
        if (selectedNumbers.length === 0) {
            showToast("Selecione pelo menos um número para comprar.", "warning");
            return;
        }
        
        setIsCheckingOut(true);
        try {
            const bodyData: any = { rifaId: id, selectedNumbers };
            if (additionalData) {
                bodyData.cpf = additionalData.cpf;
                bodyData.telefone = additionalData.telefone;
            }

            const res = await fetch("/api/consumer/rifas/checkout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(bodyData)
            });

            const data = await res.json();
            
            if (res.status === 400 && data.error === "MISSING_CUSTOMER_INFO") {
                setMissingInfo(true);
                return;
            }

            if (res.ok) {
                setMissingInfo(false);
                setCheckoutData(data);
                setPaymentStatus("PENDENTE");
            } else {
                showToast(data.error || "Falha ao gerar o Pix.", "error");
            }
        } catch (error) {
            showToast("Erro na comunicação com o checkout.", "error");
        } finally {
            setIsCheckingOut(false);
        }
    };

    const isFinished = rifa.status === 'FINALIZADA';
    const numDisponiveis = rifa.numeros?.filter(n => n.status === "DISPONIVEL").length || 0;
    const valorBase = selectedNumbers.length * rifa.precoPorNumero;
    const taxaAbacate = 0.80;
    const totalCompra = valorBase + taxaAbacate;

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden relative">
            {/* Header Area */}
            <div className="bg-white border-b border-slate-200 p-4 md:p-6 shrink-0 z-30 shadow-sm relative">
                <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <button onClick={() => router.back()} className="p-2 lg:p-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-500 hover:text-primary transition-colors">
                            <ArrowLeft className="size-5" />
                        </button>
                        <div>
                            <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-slate-900 hidden md:block">Detalhes da Rifa</h1>
                            <div className="md:hidden">
                                <h1 className="text-lg font-black tracking-tight text-slate-900 truncate max-w-[200px]">{rifa.titulo}</h1>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar">
                <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
                    {/* Winner Banner */}
                    {isFinished && rifa.numeroSorteado && (
                        <div className="mb-8 bg-gradient-to-br from-amber-400 to-amber-500 rounded-[2rem] p-8 shadow-xl text-white text-center relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-8 opacity-10">
                                <Trophy className="size-32" />
                            </div>
                            <div className="relative z-10">
                                <div className="inline-flex items-center justify-center p-4 bg-white/20 rounded-2xl mb-4">
                                    <Trophy className="size-8" />
                                </div>
                                <h3 className="text-3xl md:text-4xl font-black mb-2 uppercase tracking-tighter">Tenemos un Ganhador!</h3>
                                <p className="text-amber-100 font-medium mb-6">O sorteio foi realizado e o número premiado é:</p>
                                
                                <div className="inline-block bg-white text-amber-600 px-10 py-4 rounded-3xl text-6xl font-black shadow-2xl mb-6 tracking-widest tabular-nums">
                                    {String(rifa.numeroSorteado).padStart(3, '0')}
                                </div>
                                
                                {rifa.ganhadorNome && (
                                    <div className="mt-2">
                                        <p className="text-sm font-bold uppercase tracking-widest opacity-80 mb-1">Ganhador(a)</p>
                                        <p className="text-xl font-black">{rifa.ganhadorNome}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="flex flex-col xl:flex-row gap-6 lg:gap-8 pb-32 xl:pb-8">
                        {/* Detalhes da Rifa (Left) */}
                        <div className="w-full xl:w-1/3 flex flex-col gap-6">
                            <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                                <div className="h-48 sm:h-64 bg-slate-100 flex items-center justify-center relative">
                                    {rifa.imagemUrl ? (
                                        <img src={rifa.imagemUrl} alt={rifa.titulo} className="w-full h-full object-cover" />
                                    ) : (
                                        <Ticket className="size-16 text-slate-300" />
                                    )}
                                    <div className="absolute top-4 left-4">
                                        <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-sm backdrop-blur-md ${
                                            rifa.status === 'ATIVA' ? 'bg-emerald-500/90 text-white' : 'bg-amber-500/90 text-white'
                                        }`}>
                                            {rifa.status}
                                        </span>
                                    </div>
                                </div>
                                
                                <div className="p-6 md:p-8 flex flex-col flex-1">
                                    <h2 className="text-2xl font-black text-slate-900 mb-4">{rifa.titulo}</h2>
                                    <p className="text-sm text-slate-500 font-medium whitespace-pre-wrap flex-1 mb-8">{rifa.descricao}</p>
                                    
                                    <div className="grid grid-cols-2 gap-4 border-t border-slate-100 pt-6">
                                        <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 text-center">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Preço (cada)</p>
                                            <p className="text-lg font-black text-emerald-600">
                                                {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(rifa.precoPorNumero)}
                                            </p>
                                        </div>
                                        <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 text-center">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Disponíveis</p>
                                            <p className="text-lg font-black text-slate-900">{numDisponiveis} / {rifa.quantidadeNumeros}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {!isFinished && (
                                <div className="bg-primary/5 rounded-[2rem] p-6 border border-primary/10">
                                    <div className="flex items-center gap-3 mb-4">
                                        <AlertCircle className="size-5 text-primary" />
                                        <h4 className="font-black text-slate-900 uppercase tracking-widest text-[10px]">Informações Importantes</h4>
                                    </div>
                                    <ul className="space-y-3">
                                        <li className="flex items-start gap-2 text-xs font-medium text-slate-600">
                                            <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                                            O sorteio será realizado assim que todos os números forem vendidos.
                                        </li>
                                        <li className="flex items-start gap-2 text-xs font-medium text-slate-600">
                                            <div className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                                            O pagamento via Pix é compensado automaticamente em poucos segundos.
                                        </li>
                                    </ul>
                                </div>
                            )}
                        </div>

                        {/* Malha de Números (Right) */}
                        <div className="w-full xl:w-2/3 flex flex-col">
                            <div className="bg-white p-6 md:p-8 rounded-[2rem] border border-slate-200 shadow-sm flex flex-col h-full">
                                <div className="mb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                                    <div>
                                        <h3 className="text-xl font-black text-slate-900">Escolha seus Números</h3>
                                        <p className="text-xs text-slate-500 font-medium mt-1">Clique nos números disponíveis para adicioná-los ao carrinho.</p>
                                    </div>
                                    
                                    <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                        <div className="flex items-center gap-1.5"><div className="size-3 rounded-full bg-slate-100 border border-slate-200"></div> Indisponível</div>
                                        <div className="flex items-center gap-1.5"><div className="size-3 rounded-full bg-white border border-slate-300"></div> Livre</div>
                                        <div className="flex items-center gap-1.5"><div className="size-3 rounded-full bg-primary border border-primary"></div> Selecionado</div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 xl:grid-cols-10 gap-2 md:gap-3">
                                    {rifa.numeros?.map((num) => {
                                        const isDisposable = num.status === "DISPONIVEL";
                                        const isSelected = selectedNumbers.includes(num.numero);
                                        const isWinner = isFinished && rifa.numeroSorteado === num.numero;
                                        
                                        return (
                                            <button
                                                key={num.id}
                                                disabled={!isDisposable || isFinished}
                                                onClick={() => toggleNumber(num.numero)}
                                                className={`
                                                    relative w-full aspect-square rounded-xl flex items-center justify-center text-xs sm:text-sm font-black transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-primary/20
                                                    ${!isDisposable ? 'bg-slate-100/70 text-slate-300 border border-slate-200 cursor-not-allowed' : ''}
                                                    ${isDisposable && !isSelected ? 'bg-white text-slate-600 border border-slate-200 hover:border-primary/50 hover:text-primary hover:shadow-sm cursor-pointer' : ''}
                                                    ${isSelected ? 'bg-primary text-white border-primary shadow-md shadow-primary/30 transform scale-105 z-10' : ''}
                                                    ${isWinner ? 'bg-amber-400 text-white border-amber-500 ring-4 ring-amber-400/30 ring-offset-2' : ''}
                                                `}
                                            >
                                                {String(num.numero).padStart(3, '0')}
                                                {isWinner && <Trophy className="absolute -top-1.5 -right-1.5 size-3 text-amber-600 fill-amber-400" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Modals */}
            {missingInfo && !checkoutData && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
                    <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md overflow-hidden relative border border-slate-200 p-6">
                        <div className="text-center mb-6">
                            <h3 className="text-xl font-black text-slate-900">Complete seu Perfil</h3>
                            <p className="text-sm text-slate-500 font-medium mt-1">
                                Para gerar o Pix via AbacatePay, precisamos do seu CPF e Telefone.
                            </p>
                        </div>
                        
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase tracking-widest mb-1">CPF</label>
                                <input value={cpfInput} onChange={e => setCpfInput(e.target.value)} placeholder="000.000.000-00" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase tracking-widest mb-1">Telefone / WhatsApp</label>
                                <input value={telefoneInput} onChange={e => setTelefoneInput(e.target.value)} placeholder="(11) 99999-9999" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium text-slate-700 outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <button onClick={() => setMissingInfo(false)} className="flex-1 px-4 py-3 rounded-xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-50 transition-colors">
                                Cancelar
                            </button>
                            <button 
                                onClick={() => handleCheckout({ cpf: cpfInput, telefone: telefoneInput })} 
                                disabled={isCheckingOut || !cpfInput || !telefoneInput}
                                className="flex-1 px-4 py-3 rounded-xl bg-primary text-white font-black hover:bg-primary/90 transition-colors disabled:opacity-50 flex justify-center items-center uppercase tracking-widest text-xs"
                            >
                                {isCheckingOut ? <Loader2 className="size-4 animate-spin" /> : "Prosseguir"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {checkoutData && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
                    <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-md overflow-hidden relative border border-slate-200">
                        <div className="p-6 text-center border-b border-slate-100 bg-slate-50/50">
                            <h3 className="text-xl font-black text-slate-900">Finalizar Compra</h3>
                            <p className="text-sm text-slate-500 font-medium mt-1">
                                {paymentStatus === "PAGO" ? "Sua compra foi aprovada!" : "Pague via Pix usando o código abaixo."}
                            </p>
                        </div>
                        
                        <div className="p-6 flex flex-col items-center">
                            {paymentStatus === "PAGO" ? (
                                <div className="flex flex-col items-center animate-in zoom-in duration-500 w-full text-center">
                                    <div className="size-24 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-6 shadow-inner border border-emerald-200">
                                        <Check className="size-12" />
                                    </div>
                                    <h4 className="text-2xl font-black text-slate-900">Pagamento Aprovado!</h4>
                                    <p className="text-sm text-slate-500 mt-2 text-center mb-8">
                                        O AbacatePay processou o seu pagamento. Seus números estão oficialmente garantidos na rifa!
                                    </p>
                                    <Link href="/rifas/minhas" className="w-full bg-slate-900 text-white font-black py-4 rounded-xl hover:bg-slate-800 transition-colors uppercase tracking-widest text-xs flex items-center justify-center">
                                        Ver Meus Bilhetes
                                    </Link>
                                </div>
                            ) : (
                                <>
                                    <div className="bg-white p-4 rounded-3xl border-2 border-slate-100 shadow-sm mb-6 flex items-center justify-center w-56 h-56 relative group">
                                        {checkoutData.qrCodeUrl ? (
                                            <img src={checkoutData.qrCodeUrl} alt="QR Code PIX" className="w-full h-full object-contain rounded-xl group-hover:scale-105 transition-transform" />
                                        ) : (
                                            <div className="text-center w-full flex flex-col items-center opacity-50">
                                                <AlertCircle className="size-10 text-amber-500 mb-2" />
                                                <p className="text-xs font-black text-slate-400 uppercase">Sem Imagem</p>
                                            </div>
                                        )}
                                    </div>
                                    
                                    <div className="w-full mb-6 relative">
                                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 flex justify-between items-end">
                                            <div className="flex flex-col gap-0.5">
                                                <span>Pix Copia e Cola</span>
                                                <span className="text-primary normal-case font-medium">Inclui taxa de processamento: R$ {taxaAbacate.toFixed(2)}</span>
                                            </div>
                                            <span className="text-sm text-emerald-600">R$ {totalCompra.toFixed(2)}</span>
                                        </div>
                                        <div className="flex items-center gap-2 relative">
                                            <input 
                                                readOnly 
                                                value={checkoutData.qrCode} 
                                                className="flex-1 bg-slate-50 border border-slate-200 rounded-xl pl-4 pr-12 py-3.5 text-xs font-semibold text-slate-500 truncate outline-none shadow-sm cursor-text" 
                                            />
                                            <button 
                                                onClick={() => { navigator.clipboard.writeText(checkoutData.qrCode); showToast("Pix copiado!", "success"); }} 
                                                className="absolute right-1.5 p-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-all shadow-md active:scale-95"
                                            >
                                                Copiar
                                            </button>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-center gap-3 w-full p-4 bg-indigo-50 rounded-xl border border-indigo-100 mt-1 shadow-inner">
                                        <Loader2 className="size-5 animate-spin text-indigo-500 shrink-0" />
                                        <p className="text-xs font-bold text-indigo-700 min-w-0 truncate">Aguardando pagamento no app do seu banco...</p>
                                    </div>
                                </>
                            )}
                        </div>
                        {paymentStatus !== "PAGO" && (
                            <button onClick={() => { setCheckoutData(null); setSelectedNumbers([]); }} className="absolute top-4 right-4 p-2 bg-slate-100/50 hover:bg-slate-200 text-slate-400 hover:text-slate-700 rounded-full transition-colors backdrop-blur-sm">
                                <X className="size-5" />
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Bottom Checkout Bar (Sticky) */}
            {selectedNumbers.length > 0 && !isFinished && !checkoutData && !missingInfo && (
                <div className="fixed bottom-0 left-0 right-0 md:left-64 xl:left-64 z-40 p-4 md:p-6 animate-in slide-in-from-bottom-5 duration-300 pointer-events-none">
                    <div className="max-w-5xl mx-auto pointer-events-auto">
                        <div className="bg-white rounded-[2rem] shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)] p-4 md:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 border border-slate-200">
                            
                            <div className="flex items-center gap-4 w-full sm:w-auto overflow-hidden">
                                <div className="p-3 bg-primary/10 rounded-2xl shrink-0 hidden sm:block">
                                    <ShoppingCart className="size-6 text-primary" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Resumo da Compra</p>
                                    <p className="text-sm md:text-base font-medium text-slate-700 truncate w-full">
                                        <span className="font-black text-primary mr-1">{selectedNumbers.length}</span> 
                                        {selectedNumbers.length === 1 ? 'número selecionado' : 'números selecionados'}
                                    </p>
                                </div>
                            </div>
                            
                            <div className="flex items-center gap-4 md:gap-8 w-full sm:w-auto">
                                <div className="text-right hidden sm:block">
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Total</p>
                                    <p className="text-xl md:text-2xl font-black text-emerald-600">
                                        {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalCompra)}
                                    </p>
                                    <p className="text-[9px] font-bold text-primary uppercase tracking-tighter">Taxa fixa de R$ {taxaAbacate.toFixed(2)} inclusa</p>
                                </div>
                                
                                <button
                                    onClick={() => handleCheckout()}
                                    disabled={isCheckingOut}
                                    className="flex-1 sm:flex-none bg-primary hover:bg-primary/90 text-white px-6 md:px-8 py-3.5 md:py-4 rounded-xl shadow-lg shadow-primary/20 transition-all font-black uppercase tracking-widest text-[10px] md:text-xs flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                                >
                                    {isCheckingOut ? <Loader2 className="size-4 animate-spin hidden sm:block" /> : null}
                                    {isCheckingOut ? "Gerando Pix..." : "Ir para Pagamento"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
