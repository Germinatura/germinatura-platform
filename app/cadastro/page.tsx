"use client";

import { useState } from "react";
import { Loader2, Mail, Lock, User, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useToast } from "@/components/ui/Toast";

export default function CadastroPage() {
    const [nome, setNome] = useState("");
    const [email, setEmail] = useState("");
    const [senha, setSenha] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const router = useRouter();
    const { showToast } = useToast();

    const handleCadastro = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            const res = await fetch("/api/cadastro", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ nome, email, senha }),
            });

            if (res.ok) {
                showToast("Conta criada com sucesso! Faça login para continuar.", "success");
                router.push("/login");
            } else {
                const data = await res.json();
                showToast(data.error || "Erro ao criar conta", "error");
                setError(data.error || "Erro ao criar conta");
            }
        } catch (err) {
            showToast("Erro ao conectar com o servidor", "error");
            setError("Erro ao conectar com o servidor");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-background-light flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-md">
                {/* Logo and Greeting */}
                <div className="text-center mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl shadow-lg shadow-primary/20 text-white mb-4">
                        <img src="https://i.imgur.com/EnMI9CP.png" alt="G" className="rounded-2xl" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900">Criar Conta</h1>
                    <p className="text-slate-500 font-medium mt-2">Cadastre-se para reservar produtos</p>
                </div>

                {/* Registration Card */}
                <div className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden animate-in fade-in zoom-in duration-500">
                    <div className="p-8">
                        <form onSubmit={handleCadastro} className="space-y-6">
                            {error && (
                                <div className="bg-rose-50 border border-rose-100 text-rose-600 px-4 py-3 rounded-xl text-sm font-semibold animate-in shake duration-300">
                                    {error}
                                </div>
                            )}

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 ml-1">Nome Completo</label>
                                <div className="relative group">
                                    <User className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400 group-focus-within:text-primary transition-colors" />
                                    <input
                                        required
                                        type="text"
                                        value={nome}
                                        onChange={(e: any) => setNome(e.target.value)}
                                        placeholder="Seu nome completo"
                                        className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all placeholder:text-slate-400 font-medium"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 ml-1">Email</label>
                                <div className="relative group">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400 group-focus-within:text-primary transition-colors" />
                                    <input
                                        required
                                        type="email"
                                        value={email}
                                        onChange={(e: any) => setEmail(e.target.value)}
                                        placeholder="seu@email.com"
                                        className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all placeholder:text-slate-400 font-medium"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 ml-1">Senha</label>
                                <div className="relative group">
                                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400 group-focus-within:text-primary transition-colors" />
                                    <input
                                        required
                                        minLength={6}
                                        type={showPassword ? "text" : "password"}
                                        value={senha}
                                        onChange={(e: any) => setSenha(e.target.value)}
                                        placeholder="Mínimo 6 caracteres"
                                        className="w-full pl-12 pr-12 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-primary focus:border-primary outline-none transition-all placeholder:text-slate-400 font-medium"
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

                            <button
                                disabled={loading}
                                type="submit"
                                className="w-full py-4 bg-primary text-white text-lg font-bold rounded-2xl shadow-lg shadow-primary/30 hover:bg-primary/90 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-50"
                            >
                                {loading ? (
                                    <Loader2 className="size-6 animate-spin" />
                                ) : (
                                    <>Cadastrar</>
                                )}
                            </button>

                            <div className="pt-2 text-center">
                                <p className="text-sm font-medium text-slate-500">
                                    Já possui conta?{" "}
                                    <Link href="/login" className="text-primary hover:text-primary/80 font-bold transition-colors">
                                        Fazer Login
                                    </Link>
                                </p>
                            </div>
                        </form>
                    </div>

                    <div className="p-6 bg-slate-50 border-t border-slate-100 text-center">
                        <p className="text-sm text-slate-500 font-medium">
                            Sistema de Reservas Germinatura
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
