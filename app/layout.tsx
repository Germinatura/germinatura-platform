import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Germinatura",
  description: "Plataforma completa para controle de vendas e fluxo de caixa",
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
      <body className={`${poppins.variable} font-sans antialiased bg-background-light text-slate-900`}>
        <ToastProvider>
          <DashboardLayout>
            {children}
          </DashboardLayout>
        </ToastProvider>
      </body>
    </html>
  );
}
