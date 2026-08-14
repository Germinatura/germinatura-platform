"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle, Loader2 } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = useCallback((message: string, type: ToastType = "info") => {
        const id = Math.random().toString(36).substring(2, 9);
        setToasts((prev: any) => [...prev, { id, message, type }]);

        // Auto-dismiss after 4 seconds
        setTimeout(() => {
            setToasts((prev: any) => prev.filter((t: any) => t.id !== id));
        }, 4000);
    }, []);

    const removeToast = (id: string) => {
        setToasts((prev: any) => prev.filter((t: any) => t.id !== id));
    };

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 pointer-events-none">
                {toasts.map((toast: any) => (
                    <ToastComponent
                        key={toast.id}
                        toast={toast}
                        onClose={() => removeToast(toast.id)}
                    />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

function ToastComponent({ toast, onClose }: { toast: Toast; onClose: () => void }) {
    const icons = {
        success: <CheckCircle2 className="size-5 text-emerald-500" />,
        error: <AlertCircle className="size-5 text-red-500" />,
        warning: <AlertTriangle className="size-5 text-amber-500" />,
        info: <Info className="size-5 text-blue-500" />,
    };

    const styles = {
        success: "border-emerald-100 bg-emerald-50 shadow-emerald-100/50",
        error: "border-red-100 bg-red-50 shadow-red-100/50",
        warning: "border-amber-100 bg-amber-50 shadow-amber-100/50",
        info: "border-blue-100 bg-blue-50 shadow-blue-100/50",
    };

    return (
        <div
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 min-w-[300px] border rounded-2xl shadow-xl animate-in slide-in-from-right-full fade-in duration-300 ${styles[toast.type]}`}
        >
            <div className="shrink-0">
                {icons[toast.type]}
            </div>
            <p className="flex-1 text-sm font-semibold text-slate-900">{toast.message}</p>
            <button
                onClick={onClose}
                className="shrink-0 p-1 rounded-lg hover:bg-black/5 transition-colors text-slate-400 hover:text-slate-600"
            >
                <X className="size-4" />
            </button>
        </div>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
}
