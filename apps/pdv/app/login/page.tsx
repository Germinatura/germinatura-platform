"use client";

import { useState } from "react";
import { Loader2, Lock, Mail, Eye, EyeOff } from "lucide-react";
import { apiFetch } from "@/lib/api";
import Link from "next/link";
import { useToast } from "@/components/ui/Toast";
import { getSupabaseBrowserClient } from "@/lib/supabase";

export default function LoginPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const { showToast } = useToast();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            const client = getSupabaseBrowserClient();
            const { error: signInError } = await client.auth.signInWithPassword({ email, password });
            if (signInError) throw new Error("Credenciais inválidas");

            const res = await apiFetch("/api/v1/auth/session");

            if (res.ok) {
                const data = await res.json();
                if (data.user.perfil === "CONSUMER") {
                    showToast("Seu perfil não possui acesso ao PDV", "error");
                    await client.auth.signOut();
                    return;
                }
                if (data.user.perfil === "ADMIN") {
                    const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000";
                    window.location.assign(portalUrl);
                } else {
                    window.location.assign("/");
                }
            } else {
                const data = await res.json();
                await client.auth.signOut();
                showToast(data.message || "Credenciais inválidas", "error");
                setError(data.message || "Credenciais inválidas");
            }
        } catch (loginError) {
            const message = loginError instanceof Error ? loginError.message : "Erro ao conectar com o servidor";
            showToast(message, "error");
            setError(message);
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
                        {/* <GraduationCap className="size-8" /> */}
                        <img src="https://i.imgur.com/EnMI9CP.png" alt="G" className="rounded-2xl" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900">Germinatura</h1>
                    <p className="text-slate-500 font-medium mt-2">Bem-vindo de volta!</p>
                </div>

                {/* Login Card */}
                <div className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden animate-in fade-in zoom-in duration-500">
                    <div className="p-8">
                        <form onSubmit={handleLogin} className="space-y-6">
                            {error && (
                                <div className="bg-rose-50 border border-rose-100 text-rose-600 px-4 py-3 rounded-xl text-sm font-semibold animate-in shake duration-300">
                                    {error}
                                </div>
                            )}

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
                                        type={showPassword ? "text" : "password"}
                                        value={password}
                                        onChange={(e: any) => setPassword(e.target.value)}
                                        placeholder="••••••••"
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
                                    <>
                                        Entrar na Plataforma
                                    </>
                                )}
                            </button>
                        </form>

                        <div className="pt-6 text-center">
                            <p className="text-sm font-medium text-slate-500">
                                Não possui conta?{" "}
                                <Link href={`${process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://127.0.0.1:3000"}/cadastro`} className="text-primary hover:text-primary/80 font-bold transition-colors">
                                    Cadastre-se
                                </Link>
                            </p>
                        </div>
                    </div>

                    <div className="p-6 bg-slate-50 border-t border-slate-100 text-center">
                        <p className="text-sm text-slate-500 font-medium">
                            Controle de Comissões e Vendas
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
