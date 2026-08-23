import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Germinatura",
  description: "Fundação greenfield da plataforma Germinatura v2.1",
};

import { ToastProvider } from "@/components/ui/Toast";

import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="font-sans antialiased bg-background-light text-slate-900">
        <ToastProvider>
          <DashboardLayout>
            {children}
          </DashboardLayout>
        </ToastProvider>
      </body>
    </html>
  );
}
