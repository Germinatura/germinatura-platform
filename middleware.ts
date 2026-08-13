import { NextRequest, NextResponse } from "next/server";
import { decrypt } from "@/lib/auth";

const adminOnlyRoutes = ["/", "/vendas", "/produtos", "/fluxo-caixa", "/transacoes", "/configuracoes"];
const publicRoutes = ["/login", "/cadastro"];

export default async function middleware(req: NextRequest) {
    const path = req.nextUrl.pathname;
    const isPublicRoute = publicRoutes.includes(path);
    const isAdminOnlyRoute = adminOnlyRoutes.some(route =>
        route === "/" ? path === "/" : path.startsWith(route)
    );

    const cookie = req.cookies.get("session")?.value;
    let session = null;

    if (cookie) {
        try {
            session = await decrypt(cookie);
        } catch (e) {
            console.error("Erro ao descriptografar cookie de sessão");
        }
    }

    // 1. Se não estiver logado e não for rota pública, redireciona para login
    if (!session && !isPublicRoute) {
        return NextResponse.redirect(new URL("/login", req.nextUrl));
    }

    // 2. Se já estiver logado e tentar ir para rota pública, redireciona para a home apropriada
    if (isPublicRoute && session) {
        if (session.user.perfil === "ADMIN") {
            return NextResponse.redirect(new URL("/", req.nextUrl));
        }
        if (session.user.perfil === "CONSUMER") {
            return NextResponse.redirect(new URL("/reservas", req.nextUrl));
        }
        return NextResponse.redirect(new URL("/pdv", req.nextUrl));
    }

    // 3. Verificação de permissões por perfil e reset de senha obrigatório
    if (session) {
        const perfil = session.user.perfil;
        const needsReset = session.user.needsPasswordReset;

        if (needsReset) {
            // Permite acessar a tela de reset e as APIs necessárias (como logout e o próprio reset)
            const isAllowedDuringReset = path === "/trocar-senha" || path.startsWith("/api/auth/");
            if (!isAllowedDuringReset) {
                const redirectUrl = new URL("/trocar-senha", req.nextUrl);
                redirectUrl.searchParams.set("callbackUrl", path);
                return NextResponse.redirect(redirectUrl);
            }
            return NextResponse.next();
        } else if (path === "/trocar-senha") {
            // Se não precisa trocar, não pode acessar a tela de troca
            return NextResponse.redirect(new URL("/", req.nextUrl));
        }

        // Definição de rotas comuns
        const isHome = path === "/";
        const isReserva = path.startsWith("/reservas");
        const isRifa = path.startsWith("/rifas");
        const isPdv = path.startsWith("/pdv");

        if (perfil === "CONSUMER") {
            // CONSUMERS podem acessar: Dashboard (/), /reservas, /rifas (inc. /rifas/minhas)
            if (!isHome && !isReserva && !isRifa) {
                return NextResponse.redirect(new URL("/reservas", req.nextUrl));
            }
        } else if (perfil === "VENDEDOR") {
            // VENDEDORES podem acessar: Dashboard (/), /reservas, /rifas, /pdv
            if (!isHome && !isReserva && !isRifa && !isPdv) {
                return NextResponse.redirect(new URL("/", req.nextUrl));
            }
        }
        // Se for ADMIN, ele pode acessar todas as rotas sem exceção.
    }

    return NextResponse.next();
}

export const config = {
    matcher: ["/((?!api|_next/static|_next/image|favicon.ico|uploads).*)"],
};
