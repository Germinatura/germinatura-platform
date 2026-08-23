# Baseline de segurança da fundação v2.1

## Classificação de endpoints

A allowlist executável está em `apps/portal/lib/api-security.ts`. Qualquer API não classificada exige autenticação antes de chegar ao 404 do Next.js. Métodos fora da allowlist retornam `405`.

| Endpoint | Método | Classe | Regra |
| --- | --- | --- | --- |
| `/api/v1/health` | GET | pública | Resposta mínima, sem banco, versão ou configuração. |
| `/api/auth/login` | POST | pública | Body validado; mutação exige Origin confiável. |
| `/api/auth/logout` | POST | authenticated | Sessão validada no proxy e novamente no handler. |
| `/api/auth/me` | GET | authenticated | Retorna somente perfil da própria sessão. |
| `/api/auth/reset-password` | POST | authenticated | Atualiza apenas a própria identidade Supabase Auth. |
| `/api/v1/auth/session` | GET | authenticated | Retorna identidade, papel primário e papéis da própria sessão. |

Não há endpoints `seller-only` ou `admin-only` ativos nesta fundação. As classes existem no enforcement server-side e devem ser usadas quando novos domínios forem introduzidos; menu oculto nunca substitui RBAC.

O PDV expõe publicamente apenas seu próprio `/api/v1/health`. Demais chamadas `/api/*` são reescritas para o Portal e passam pela mesma classificação server-side.

## Sessão e CSRF

- Supabase Auth é a única identidade;
- requisições por cookie usam cookies gerenciados por `@supabase/ssr`;
- mutações por cookie exigem `Origin` do Portal ou PDV e rejeitam `Sec-Fetch-Site: cross-site`;
- requisições Bearer não dependem de cookie e precisam conter um token não vazio;
- respostas de Auth usam `Cache-Control: no-store` e preservam `x-request-id`;
- access token e refresh token não são incluídos nos payloads de sessão da aplicação.

## RLS e Storage

Todas as tabelas públicas da fundação têm RLS. Usuários autenticados podem ler apenas o próprio perfil e vínculos de papel; não existe policy de escrita direta em RBAC. Elevação de privilégio exige uma operação administrativa futura e auditada.

O bucket `product-images` limita tamanho e MIME. Escritas exigem `catalog.manage`, caminho sob o UUID do ator e nome UUID com extensão permitida. Não há uploader ativo na aplicação.

## Headers e logs

Portal e PDV enviam CSP, proteção contra framing e MIME sniffing, Referrer Policy, Permissions Policy, COOP e CORP. A CSP permite os requisitos atuais do Next.js/Supabase e deve ser revalidada quando OpenNext/Cloudflare for instalado. O servidor de desenvolvimento acrescenta `unsafe-eval` somente a `script-src`, pois o runtime de depuração do React/Next depende dessa diretiva; o build de produção não contém essa exceção.

O logger compartilhado elimina campos de senha, token, authorization, cookie, secret, API key, connection string e service role, inclusive em objetos aninhados. O scan de repositório nunca imprime o valor encontrado.

## Secrets e CI

`pnpm security:scan` verifica todos os arquivos rastreados e falha para arquivos de ambiente, `.dev.vars`, estado Wrangler, dumps/backups, chaves privadas, service role, tokens Cloudflare/GitHub, secrets de pagamento e URLs de banco com credenciais. Publishable keys não são bloqueadas por serem públicas, mas os exemplos continuam sem valores reais.
