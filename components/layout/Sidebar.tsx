"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
    LayoutDashboard,
    Package,
    ShoppingBag,
    History,
    Landmark,
    Users,
    ArrowRightLeft,
    LogOut,
    Loader2,
    ChevronDown,
    ChevronUp,
    Settings,
    DollarSign,
    CalendarClock,
    ShoppingBasket,
    ClipboardPlus,
    BadgePercent,
    Ticket,
    Archive,
} from "lucide-react";

interface User {
    id: string;
    nome: string;
    email: string;
    perfil: string;
}

interface MenuItem {
    name: string;
    href?: string;
    icon: any;
    roles: string[];
    children?: MenuItem[];
}

export function Sidebar() {
    const pathname = usePathname();
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [expandedFolders, setExpandedFolders] = useState<string[]>(["PRODUTOS", "FINANCEIRO", "CONFIGURAÇÕES"]);

    const menuItems: MenuItem[] = [
        { name: "Dashboard", href: "/", icon: LayoutDashboard, roles: ["ADMIN", "VENDEDOR", "CONSUMER"] },
        { name: "Minhas Reservas", href: "/reservas", icon: History, roles: ["ADMIN", "VENDEDOR", "CONSUMER"] },
        {
            name: "PRODUTOS",
            icon: Package,
            roles: ["ADMIN", "VENDEDOR"],
            children: [
                { name: "Vendas", href: "/vendas", icon: DollarSign, roles: ["ADMIN"] },
                { name: "Produtos", href: "/produtos", icon: ShoppingBasket, roles: ["ADMIN"] },
                { name: "Promoções", href: "/admin/produtos/promocoes", icon: BadgePercent, roles: ["ADMIN"] },
                { name: "Estoque", href: "/admin/estoque", icon: Package, roles: ["ADMIN"] },
                { name: "Reservas", href: "/admin/reservas", icon: CalendarClock, roles: ["ADMIN"] },
                { name: "Ponto de Venda", href: "/pdv", icon: ShoppingBag, roles: ["ADMIN", "VENDEDOR"] },
            ]
        },
        {
            name: "RIFAS",
            icon: Package,
            roles: ["ADMIN"],
            children: [
                { name: "Rifas", href: "/admin/rifas", icon: Ticket, roles: ["ADMIN"] },
            ]
        },
        {
            name: "FINANCEIRO",
            icon: Landmark,
            roles: ["ADMIN"],
            children: [
                { name: "Lançamentos", href: "/fluxo-caixa", icon: ClipboardPlus, roles: ["ADMIN"] },
                { name: "Transações", href: "/transacoes", icon: ArrowRightLeft, roles: ["ADMIN"] },
            ]
        },
        {
            name: "CONFIGURAÇÕES",
            icon: Settings,
            roles: ["ADMIN"],
            children: [
                { name: "Usuários", href: "/configuracoes/usuarios", icon: Users, roles: ["ADMIN"] },
            ]
        },
        { name: "Catálogo de Rifas", href: "/rifas", icon: Ticket, roles: ["CONSUMER"] },
        { name: "Meus Bilhetes", href: "/rifas/minhas", icon: Archive, roles: ["CONSUMER"] },
    ];

    const fetchUser = async () => {
        try {
            const res = await fetch("/api/auth/me");
            if (res.ok) {
                const data = await res.json();
                setUser(data.user);
            } else {
                setUser(null);
            }
        } catch (err) {
            console.error("Sidebar: Error fetching user:", err);
            setUser(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchUser();
    }, [pathname]);

    useEffect(() => {
        // Auto-expand folder if child is active
        const activeItem = findActiveItem(menuItems, pathname);
        if (activeItem && !expandedFolders.includes(activeItem.parentName)) {
            setExpandedFolders(prev => [...prev, activeItem.parentName]);
        }
    }, [pathname, loading]);

    const findActiveItem = (items: MenuItem[], path: string, parentName: string = ""): { parentName: string } | null => {
        for (const item of items) {
            if (item.href === path && parentName) return { parentName };
            if (item.children) {
                const found = findActiveItem(item.children, path, item.name);
                if (found) return found;
            }
        }
        return null;
    };

    const toggleFolder = (folderName: string) => {
        setExpandedFolders(prev =>
            prev.includes(folderName)
                ? prev.filter(f => f !== folderName)
                : [...prev, folderName]
        );
    };

    const handleLogout = async () => {
        try {
            await fetch("/api/auth/logout", { method: "POST" });
            setUser(null);
            router.push("/login");
        } catch (error) {
            console.error("Erro ao fazer logout:", error);
        }
    };

    if (pathname === "/login" || pathname === "/cadastro" || pathname === "/pdv") return null;

    if (loading) {
        return (
            <aside className="w-full h-full border-r border-slate-200 bg-white flex flex-col items-center justify-center">
                <Loader2 className="size-6 animate-spin text-primary" />
            </aside>
        );
    }

    const userProfile = user?.perfil || "";

    const filterMenuByRole = (items: MenuItem[]): MenuItem[] => {
        return items
            .filter(item => item.roles.includes(userProfile))
            .map(item => ({
                ...item,
                children: item.children ? filterMenuByRole(item.children) : undefined
            }))
            .filter(item => !item.children || item.children.length > 0 || item.href);
    };

    const filteredMenu = filterMenuByRole(menuItems);

    const renderMenuItem = (item: MenuItem, depth = 0) => {
        const hasChildren = item.children && item.children.length > 0;
        const isExpanded = expandedFolders.includes(item.name);
        const isActive = pathname === item.href;
        const isChildActive = item.children?.some(child => pathname === child.href);

        if (hasChildren) {
            return (
                <div key={item.name} className="pt-2 pb-0.5">
                    <button
                        onClick={() => toggleFolder(item.name)}
                        className="w-full flex items-center justify-between px-3 py-1 cursor-pointer group"
                    >
                        <span className="text-[11px] font-bold text-slate-500 tracking-wider group-hover:text-slate-700 transition-colors uppercase">
                            {item.name}
                        </span>
                        {isExpanded ? (
                            <ChevronUp className="size-3 text-slate-400 group-hover:text-slate-600" />
                        ) : (
                            <ChevronDown className="size-3 text-slate-400 group-hover:text-slate-600" />
                        )}
                    </button>
                    {isExpanded && (
                        <div className="space-y-0.5 mt-1">
                            {item.children?.map(child => renderMenuItem(child, depth + 1))}
                        </div>
                    )}
                </div>
            );
        }

        return (
            <Link
                key={item.href || item.name}
                href={item.href || "#"}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all font-semibold ${isActive
                    ? "bg-primary text-white shadow-md shadow-primary/20"
                    : "text-slate-600 hover:bg-slate-50 hover:text-primary"
                    }`}
            >
                <item.icon className="size-5" />
                <span className="text-sm">{item.name}</span>
            </Link>
        );
    };

    return (
        <aside className="w-full h-full border-r border-slate-200 bg-white flex flex-col">
            <div className="p-6 flex items-center gap-3">
                <div className="size-10 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
                    <img src="https://i.imgur.com/EnMI9CP.png" alt="G" className="rounded-lg" />
                </div>
                <div>
                    <h1 className="font-bold text-sm">Germinatura</h1>
                    <p className="text-xs text-slate-500">Gestão Escolar</p>
                </div>
            </div>

            <nav className="flex-1 px-4 py-4 space-y-0.5 overflow-y-auto">
                {filteredMenu.map(item => renderMenuItem(item))}
                {filteredMenu.length === 0 && (
                    <div className="px-3 py-4 text-xs text-slate-400 italic">
                        Nenhum item disponível para seu perfil: {userProfile}
                    </div>
                )}
            </nav>

            <div className="p-4 border-t border-slate-200">
                <div
                    onClick={handleLogout}
                    className="flex items-center gap-3 p-2 rounded-xl hover:bg-slate-50 cursor-pointer group transition-all"
                >
                    <div className="size-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold overflow-hidden border border-slate-200">
                        {user?.nome?.[0]?.toUpperCase() || "U"}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate text-slate-900">{user?.nome || "Admin Logado"}</p>
                        <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest">{user?.perfil || "Acesso"}</p>
                    </div>
                    <LogOut className="size-4 text-slate-400 group-hover:text-red-500 transition-colors" />
                </div>
            </div>
        </aside>
    );
}
