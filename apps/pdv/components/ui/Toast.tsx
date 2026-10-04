"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";

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
        setToasts((previous) => [...previous, { id, message, type }]);

        // Auto-dismiss after 4 seconds
        setTimeout(() => {
            setToasts((previous) => previous.filter((toast) => toast.id !== id));
        }, 4000);
    }, []);

    const removeToast = (id: string) => {
        setToasts((previous) => previous.filter((toast) => toast.id !== id));
    };

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[9999] flex flex-col items-end gap-3 sm:inset-x-auto sm:right-6 sm:bottom-6">
                {toasts.map((toast) => (
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
        success: <CheckCircle2 className="size-5 text-[var(--g-status-success)]" />,
        error: <AlertCircle className="size-5 text-[var(--g-status-danger)]" />,
        warning: <AlertTriangle className="size-5 text-[var(--g-status-warning)]" />,
        info: <Info className="size-5 text-[var(--g-focus-ring)]" />,
    };

    const styles = {
        success: "border-[var(--g-status-success)]/40",
        error: "border-[var(--g-status-danger)]/50",
        warning: "border-[var(--g-status-warning)]/50",
        info: "border-[var(--g-focus-ring)]/50",
    };

    return (
        <div
            className={`pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-[var(--g-radius-card)] border bg-[var(--g-surface-raised)] px-4 py-3 text-[var(--g-text-primary)] shadow-[var(--g-shadow-raised)] ${styles[toast.type]}`}
        >
            <div className="shrink-0">
                {icons[toast.type]}
            </div>
            <p className="flex-1 text-sm font-semibold">{toast.message}</p>
            <button
                onClick={onClose}
                type="button"
                aria-label="Fechar aviso"
                className="min-h-11 min-w-11 shrink-0 rounded-lg text-[var(--g-text-muted)] transition-colors hover:bg-[var(--g-surface-hover)] hover:text-[var(--g-text-primary)]"
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
