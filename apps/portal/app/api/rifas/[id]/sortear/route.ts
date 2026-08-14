import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import nodemailer from "nodemailer";

async function checkAdmin() {
    const session = await getSession();
    return session?.user?.perfil === "ADMIN";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!(await checkAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;

    try {
        const rifa = await prisma.rifa.findUnique({
            where: { id },
            include: {
                numeros: {
                    where: { status: "VENDIDO" },
                    include: { usuario: { select: { id: true, nome: true, email: true } } }
                }
            }
        });

        if (!rifa) return NextResponse.json({ error: "Rifa não encontrada." }, { status: 404 });
        if (rifa.status === "FINALIZADA") return NextResponse.json({ error: "Rifa já foi sorteada." }, { status: 400 });
        if (rifa.numeros.length === 0) return NextResponse.json({ error: "Nenhum número vendido para sortear." }, { status: 400 });

        // 🎰 Random pick
        const vencedor = rifa.numeros[Math.floor(Math.random() * rifa.numeros.length)];

        // Atualizar rifa com o ganhador e marcar como FINALIZADA
        await prisma.rifa.update({
            where: { id },
            data: {
                numeroSorteado: vencedor.numero,
                status: "FINALIZADA"
            }
        });

        // Enviar e-mail ao ganhador
        const emailSent = await sendWinnerEmail({
            nome: vencedor.usuario?.nome || "Participante",
            email: vencedor.usuario?.email || "",
            numero: vencedor.numero,
            rifaTitulo: rifa.titulo,
            dataSorteio: new Date().toLocaleDateString('pt-BR'),
        });

        return NextResponse.json({
            numeroSorteado: vencedor.numero,
            ganhador: { nome: vencedor.usuario?.nome, email: vencedor.usuario?.email },
            emailSent
        });

    } catch (error) {
        console.error("ERRO SORTEIO:", error);
        return NextResponse.json({ error: "Erro ao realizar sorteio." }, { status: 500 });
    }
}

async function sendWinnerEmail({ nome, email, numero, rifaTitulo, dataSorteio }: {
    nome: string;
    email: string;
    numero: number;
    rifaTitulo: string;
    dataSorteio: string;
}): Promise<boolean> {
    const user = process.env.EMAIL_USER;
    const pass = process.env.APP_PASSWORD;

    if (!user || !pass || !email) {
        console.warn("E-mail não enviado: EMAIL_USER ou APP_PASSWORD não configurado, ou e-mail do ganhador ausente.");
        return false;
    }

    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: user,
            pass: pass,
        },
    });

    const template = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width" name="viewport" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection" />
  </head>
  <body>
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">
      🎉 PARABÉNS! Você é o(a) grande ganhador(a) da rifa da Germinatura!
      <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
    </div>
    <table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center">
      <tbody>
        <tr>
          <td>
            <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:1.0769230769230769em;min-height:100%;line-height:155%">
              <tbody>
                <tr>
                  <td>
                    <table align="left" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="align:left;width:100%;padding-left:0px;padding-right:0px;line-height:155%;max-width:600px;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif">
                      <tbody>
                        <tr>
                          <td>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                              Olá, <strong>${nome}</strong>,
                            </p>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                              Temos uma notícia incrível para animar o seu dia!
                            </p>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                              O sorteio da rifa organizada através da plataforma <strong>Germinatura</strong> foi realizado, e o seu número foi o premiado!
                            </p>
                            <h3 style="margin:0;padding:0;font-size:1.4em;line-height:1.08em;padding-top:0.389em;font-weight:600">
                              🏆 Detalhes da sua premiação:
                            </h3>
                            <ul style="margin:0;padding:0;padding-left:1.1em;padding-bottom:1em">
                              <li style="margin:0;padding:0;margin-left:1em;margin-bottom:0.3em;margin-top:0.3em">
                                <p style="margin:0;padding:0"><strong>Prêmio:</strong> ${rifaTitulo}</p>
                              </li>
                              <li style="margin:0;padding:0;margin-left:1em;margin-bottom:0.3em;margin-top:0.3em">
                                <p style="margin:0;padding:0"><strong>Data do Sorteio:</strong> ${dataSorteio}</p>
                              </li>
                              <li style="margin:0;padding:0;margin-left:1em;margin-bottom:0.3em;margin-top:0.3em">
                                <p style="margin:0;padding:0"><strong>Número da Sorte:</strong> ${String(numero).padStart(3, '0')}</p>
                              </li>
                            </ul>
                            <hr style="width:100%;border:none;border-top:1px solid #eaeaea;padding-bottom:1em;border-width:2px" />
                            <h3 style="margin:0;padding:0;font-size:1.4em;line-height:1.08em;padding-top:0.389em;font-weight:600">
                              🚀 Como resgatar o seu prêmio?
                            </h3>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                              Para que possamos realizar a entrega, precisamos que você siga os passos abaixo:
                            </p>
                            <ol start="1" style="margin:0;padding:0;padding-left:1.1em;padding-bottom:1em">
                              <li style="margin:0;padding:0;margin-left:1em;margin-bottom:0.3em;margin-top:0.3em">
                                <p style="margin:0;padding:0"><strong>Responda a este e-mail</strong> confirmando o recebimento desta mensagem.</p>
                              </li>
                              <li style="margin:0;padding:0;margin-left:1em;margin-bottom:0.3em;margin-top:0.3em">
                                <p style="margin:0;padding:0"><strong>Envie uma foto do seu documento de identidade</strong> (ou apresente-o no ato da entrega).</p>
                              </li>
                              <li style="margin:0;padding:0;margin-left:1em;margin-bottom:0.3em;margin-top:0.3em">
                                <p style="margin:0;padding:0"><strong>Combine a entrega:</strong> Entre em contato diretamente com um dos responsáveis pela comissão.</p>
                              </li>
                            </ol>
                            <blockquote style="border-left:3px solid #acb3be;color:#7e8a9a;margin-left:0;padding-left:0.8em;font-size:1.1em;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif">
                              <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                                <strong>Atenção:</strong> De acordo com o nosso regulamento, você tem até <strong>7 dias</strong> para reivindicar o seu prêmio. Não perca o prazo!
                              </p>
                            </blockquote>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">
                              Agradecemos imensamente por ter contribuído com a nossa formatura. O seu apoio nos ajuda a realizar o sonho da nossa festa de graduação!
                            </p>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em">Com carinho,</p>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><strong>Comissão de Formatura</strong></p>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><em>Plataforma Germinatura</em></p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;

    try {
        await transporter.sendMail({
            from: `"Germinatura" <${user}>`,
            to: email,
            subject: `🎉 PARABÉNS! Você ganhou a rifa ${rifaTitulo}!`,
            html: template,
        });
        return true;
    } catch (error) {
        console.error("Erro ao enviar e-mail:", error);
        return false;
    }
}
