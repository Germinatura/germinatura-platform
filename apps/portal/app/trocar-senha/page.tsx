"use client";

import { useState } from "react";
import { Loader2, Lock, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { Suspense } from "react";

function TrocarSenhaForm() {
    const [novaSenha, setNovaSenha] = useState("");
    const [confirmarSenha, setConfirmarSenha] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const router = useRouter();
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl");
    const { showToast } = useToast();

    const handleReset = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        if (novaSenha !== confirmarSenha) {
            setError("As senhas não coincidem");
            setLoading(false);
            return;
        }

        if (novaSenha.length < 8) {
            setError("A nova senha deve ter pelo menos 8 caracteres");
            setLoading(false);
            return;
        }

        try {
            const res = await fetch("/api/auth/reset-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ novaSenha }),
            });

            if (res.ok) {
                const data = await res.json();
                showToast("Senha alterada com sucesso!", "success");

                // Redireciona com base no perfil retornado ou manda pro root (middleware cuida do resto)
                if (callbackUrl) {
                    router.push(callbackUrl);
                } else if (data.perfil === "ADMIN") {
                    router.push("/");
                } else if (data.perfil === "CONSUMER") {
                    router.push("/reservas");
                } else {
                    router.push("/pdv");
                }
            } else {
                const data = await res.json();
                showToast(data.error || "Erro ao alterar senha", "error");
                setError(data.error || "Erro ao alterar senha");
            }
        } catch (err) {
            showToast("Erro ao conectar com o servidor", "error");
            setError("Erro ao conectar com o servidor");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 font-sans relative overflow-hidden">
            {/* Background design elements */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-rose-500/20 blur-[100px] rounded-full mix-blend-screen" />
            </div>

            <div className="w-full max-w-md relative z-10">
                {/* Header */}
                <div className="text-center mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-rose-500 shadow-lg shadow-rose-500/20 text-white mb-4">
                        <ShieldAlert className="size-8" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-white mb-2">Troca Obrigatória</h1>
                    <p className="text-slate-400 font-medium">Você está usando a senha padrão da plataforma. Para continuar, por favor, defina uma nova senha segura.</p>
                </div>

                {/* Reset Card */}
                <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden animate-in fade-in zoom-in duration-500">
                    <div className="p-8">
                        <form onSubmit={handleReset} className="space-y-6">
                            {error && (
                                <div className="bg-rose-50 border border-rose-100 text-rose-600 px-4 py-3 rounded-xl text-sm font-semibold animate-in shake duration-300">
                                    {error}
                                </div>
                            )}

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 ml-1">Nova Senha</label>
                                <div className="relative group">
                                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400 group-focus-within:text-primary transition-colors" />
                                    <input
                                        required
                                        minLength={8}
                                        type={showPassword ? "text" : "password"}
                                        value={novaSenha}
                                        onChange={(e: any) => setNovaSenha(e.target.value)}
                                        placeholder="Mínimo 6 caracteres"
                                        className="w-full pl-12 pr-12 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary outline-none transition-all placeholder:text-slate-400 font-medium"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 transition-colors"
                                    >
                                        {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 ml-1">Confirmar Nova Senha</label>
                                <div className="relative group">
                                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400 group-focus-within:text-primary transition-colors" />
                                    <input
                                        required
                                        minLength={8}
                                        type={showConfirmPassword ? "text" : "password"}
                                        value={confirmarSenha}
                                        onChange={(e: any) => setConfirmarSenha(e.target.value)}
                                        placeholder="Repita a nova senha"
                                        className="w-full pl-12 pr-12 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary outline-none transition-all placeholder:text-slate-400 font-medium"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 transition-colors"
                                    >
                                        {showConfirmPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
                                    </button>
                                </div>
                            </div>

                            <button
                                disabled={loading || !novaSenha || !confirmarSenha}
                                type="submit"
                                className="w-full py-4 bg-slate-900 text-white text-lg font-bold rounded-2xl shadow-lg hover:bg-slate-800 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:active:scale-100"
                            >
                                {loading ? (
                                    <Loader2 className="size-6 animate-spin" />
                                ) : (
                                    <>Salvar Nova Senha</>
                                )}
                            </button>
                        </form>
                    </div>

                    <div className="p-5 bg-slate-50 border-t border-slate-100 text-center">
                        <p className="text-xs text-slate-500 font-medium max-w-xs mx-auto">
                            Sua nova senha é criptografada e não pode ser acessada por administradores.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function TrocarSenhaPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
                <Loader2 className="size-8 animate-spin text-white" />
            </div>
        }>
            <TrocarSenhaForm />
        </Suspense>
    );
}
