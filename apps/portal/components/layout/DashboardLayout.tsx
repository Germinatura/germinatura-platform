"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Menu, X } from "lucide-react";

export function DashboardLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);

    if (
      pathname === "/login"
      || pathname.startsWith("/cadastro")
      || pathname === "/esqueci-senha"
      || pathname === "/recuperar-senha"
      || pathname.startsWith("/pdv")
      || pathname === "/trocar-senha"
    ) {
        return <>{children}</>;
    }

    return (
        <div className="flex min-h-screen">
            {/* Sidebar - Desktop */}
            <div className="hidden lg:flex w-64 sticky top-0 h-screen">
                <Sidebar />
            </div>

            {/* Sidebar - Mobile Overlay */}
            {isSidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm lg:hidden"
                    onClick={toggleSidebar}
                />
            )}

            {/* Sidebar - Mobile Drawer */}
            <div className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-white transform transition-transform duration-300 ease-in-out lg:hidden
        ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
                <div className="absolute top-4 right-4 lg:hidden">
                    <button onClick={toggleSidebar} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg">
                        <X className="size-6" />
                    </button>
                </div>
                <Sidebar />
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col h-screen min-w-0">
                {/* Mobile Header */}
                <header className="lg:hidden h-16 border-b border-slate-200 bg-white flex items-center justify-between px-4 shrink-0 z-30">
                    <div className="flex items-center gap-3">
                        <button onClick={toggleSidebar} className="p-2 text-slate-600 hover:bg-slate-50 rounded-lg">
                            <Menu className="size-6" />
                        </button>
                        <div className="flex items-center gap-2">
                            <div className="size-8 bg-primary/10 rounded-lg flex items-center justify-center text-primary">
                                {/* <GraduationCap className="size-5" /> */}
                                <img src="https://i.imgur.com/EnMI9CP.png" alt="G" className="rounded-lg" />
                            </div>
                            <h1 className="font-bold text-sm">Germinatura</h1>
                        </div>
                    </div>
                </header>

                <main className="flex-1 min-h-0 overflow-hidden">
                    {children}
                </main>
            </div>
        </div>
    );
}
