# ADR 0009 — Acesso institucional e bootstrap administrativo

- Status: ACCEPTED
- Data: 2026-08-30

## Contexto e problema

O Portal, incluindo a Rede Social Germinare e as demais funcionalidades autenticadas, deve atender a comunidade institucional sem cadastro administrativo individual para cada consumidor. Ao mesmo tempo, possuir um e-mail institucional não pode conceder privilégios operacionais do PDV ou administração. Como a plataforma é greenfield, também é necessário definir de forma explícita e segura quem recebe a primeira função administrativa.

## Decisão

Qualquer pessoa que comprove controle de um endereço no domínio exato `@institutojef.org.br` pode criar uma conta de consumidor no Portal. O código de uso único é usado para verificar o e-mail durante o cadastro; depois da confirmação, o usuário conclui nome, senha, username único e, opcionalmente, foto. O e-mail confirmado é fixo nessa etapa. Domínios externos, subdomínios, grafias semelhantes, código expirado e reutilização são rejeitados. Solicitação e validação recebem rate limit e respostas que não facilitam enumeração.

Portal e PDV usam e-mail ou username com senha como autenticação cotidiana. O login nunca cria conta implicitamente e devolve resposta genérica para identificador inexistente, senha incorreta, conta incompleta ou inativa. Contas operacionais do PDV são provisionadas por administrador; o vendedor não percorre verificação por código para entrar no PDV.

O código também é aceito em “Esqueci minha senha”. Cada ciclo de recuperação permite no máximo dois envios persistidos; a terceira solicitação e as seguintes ficam bloqueadas até um administrador reiniciar o ciclo com motivo e auditoria. A ação administrativa autoriza um novo ciclo de recuperação, mas não revela, escolhe nem transmite a senha do usuário.

Na primeira autenticação válida, a identidade recebe somente o papel base `CONSUMIDOR`. A mesma conta pode acumular papéis, mas o domínio institucional não concede `VENDEDOR`, `ADMIN` ou qualquer outra função privilegiada. O acesso ao PDV exige ativação explícita e auditada de `VENDEDOR` e da permissão aplicável por um administrador. Inativação ou remoção desse acesso deve produzir efeito no servidor mesmo em sessão já aberta.

O primeiro administrador é `theo.martins@institutojef.org.br`. O bootstrap é uma operação única: exige que o endereço esteja verificado, concede `ADMIN` de forma idempotente, registra ator/processo e correlação na auditoria e se torna indisponível após sucesso. Nenhuma senha, código de verificação, token ou segredo é versionado ou registrado em documentação. Novos administradores são concedidos apenas pelo fluxo normal de permissões após o bootstrap.

## Consequências positivas

- cadastro institucional verificável sem tornar OTP o login cotidiano;
- uma identidade única para Portal e PDV;
- múltiplas funções sem duplicar contas;
- separação explícita entre elegibilidade institucional e autorização operacional;
- primeiro administrador definido sem senha padrão ou promoção ampla por domínio.

## Consequências negativas

- dependência da entrega e reputação do e-mail institucional no cadastro e na recuperação;
- necessidade de segredo server-side governado para resolver username sem expor e-mail pela Data API;
- necessidade de rate limit, expiração, replay protection e observabilidade do fluxo;
- necessidade de processo de recuperação caso o primeiro endereço administrativo fique indisponível antes do bootstrap.

## Critérios de segurança e aceite

- aceitar somente o domínio canônico `institutojef.org.br` após normalização e verificação do e-mail;
- nunca usar apenas validação visual no frontend ou comparação insegura por sufixo;
- exigir conclusão de nome, senha e username único antes de liberar a conta; foto permanece opcional;
- autenticar Portal e PDV por e-mail ou username + senha, sem criação implícita;
- limitar recuperação a dois envios e exigir desbloqueio administrativo auditado antes de novo ciclo;
- impedir que administradores leiam ou definam a senha do usuário durante o desbloqueio;
- conceder automaticamente somente `CONSUMIDOR`;
- negar o PDV antes da ativação administrativa de `VENDEDOR`, inclusive por acesso direto à URL/API;
- registrar concessão e remoção de papéis em audit log;
- garantir que repetir o bootstrap não duplique nem amplie permissões;
- manter credenciais, códigos e segredos fora do Git, logs e respostas.

## Relação com outras decisões

Este ADR complementa o ADR 0001 (greenfield), o ADR 0003 (autoridade do servidor) e o modelo RBAC da especificação v2.2. Ele não altera a separação entre identidade operacional Germinatura e identidade financeira definida no ADR 0006.
