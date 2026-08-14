import { LucideIcon } from "lucide-react";

interface KPICardProps {
    label: string;
    value: string;
    subtext?: string;
    trend?: {
        value: string;
        isUp: boolean;
    };
    icon: LucideIcon;
    variant?: "success" | "primary" | "danger" | "warning";
    className?: string;
}

export function KPICard({
    label,
    value,
    subtext,
    trend,
    icon: Icon,
    variant = "primary",
    className
}: KPICardProps) {

    const variants = {
        primary: "bg-primary/10 text-primary",
        success: "bg-green-500/10 text-green-600",
        danger: "bg-red-500/10 text-red-600",
        warning: "bg-amber-500/10 text-amber-600",
    };

    return (
        <div className={`bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between ${className || ''}`}>
            <div className="flex justify-between items-start mb-4">
                <span className="text-slate-500 text-sm font-medium">{label}</span>
                <div className={`size-10 rounded-lg flex items-center justify-center ${variants[variant]}`}>
                    <Icon className="size-6" />
                </div>
            </div>
            <div>
                <h3 className="text-3xl font-medium tracking-tight whitespace-nowrap">{value}</h3>
                {trend && (
                    <p className={`text-xs font-medium mt-2 flex items-center gap-1 ${trend.isUp ? "text-green-600" : "text-red-600"}`}>
                        <span className="text-sm font-bold">{trend.isUp ? "↑" : "↓"}</span>
                        {trend.value}
                    </p>
                )}
                {subtext && !trend && (
                    <p className="text-xs text-slate-500 mt-2">{subtext}</p>
                )}
            </div>
        </div>
    );
}
