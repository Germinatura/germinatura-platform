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
| `/api/v1/admin/inventory/distributions` | POST | inventory | Exige Admin ou Estoque no proxy e `inventory.manage` no handler/RPC; somente central ativa para vendedor ativo. |

As classes por domínio são verificadas no proxy e repetidas por permissão no handler e no banco. Menu oculto nunca substitui RBAC.

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

O bucket público `product-images` limita arquivos a 5 MB e aceita JPG, PNG e WebP. Uploads exigem `catalog.manage`, assinatura compatível com o MIME e caminho imutável `products/<produto>/<imagem>.<extensão>`; não há policy de listagem nem de sobrescrita. A API pública só enumera metadados ativos ligados a produto e categoria publicados. A remoção oculta o metadado antes de excluir o objeto pelo Storage API e preserva tombstone e auditoria para recuperação segura.

## Turmas: RBAC por turma e isolamento (ADR 0011)

Um único banco e domínio, com segregação lógica e de segurança por turma.

- **Contexto da requisição.**
  - O Portal envia `x-germinatura-cohort` com um uuid ou com `all`.
  - O banco valida o header (`private.cohort_scope()`) contra um vínculo ativo em `user_cohorts` ou contra ADMIN_MASTER.
    Header inválido ou de turma sem vínculo resulta em escopo vazio: nada é lido, nenhuma permissão é concedida e
    nada é escrito.
  - `all` vale só para ADMIN_MASTER e só para leitura e agregação. Toda escrita em tabela por turma exige uma turma
    concreta (`COHORT_REQUIRED`).
  - Sem header (PR 5), nada é defaultado: só quem tem exatamente uma turma ativa tem a turma resolvida pelo vínculo;
    ADMIN_MASTER nunca. Escrita por turma sem turma determinável falha (`COHORT_REQUIRED`), inclusive de sistema e de
    service role (worker sem contexto).
  - O jobs worker processa cada evento da outbox dentro da turma do evento (`private.enter_cohort_context`, exclusivo
    de sistema e service role).
- **RBAC.**
  - `has_permission(p)` concede a permissão se a pessoa é ADMIN_MASTER, ou se tem, na turma da requisição, um papel
    com `p` e um vínculo ativo. O mesmo usuário pode ser ADMIN numa turma e consumidor em outra.
  - ADMIN_MASTER (`admin_masters`, uma linha por pessoa, nunca um papel repetido por turma) tem todas as turmas e
    todas as permissões, inclusive `cohorts.manage`. Ele só é concedido por outro ADMIN_MASTER ou pelo bootstrap
    institucional. O último ativo não pode ser revogado. Continua autenticado, passa pelas mesmas funções e
    aparece na auditoria como ator normal.
- **Isolamento.**
  - Cada tabela por turma fica em `cohort_data`, que não é exposto. `public.<tabela>` é uma view `security_invoker`
    filtrada pelo escopo, e os RPCs (`SECURITY DEFINER`) só enxergam e gravam a turma da requisição.
  - A tabela base tem uma policy RLS restritiva com o mesmo escopo. Ela protege a Data API, o acesso direto e o
    Realtime.
  - O trigger `a_cohort_guard`:
    - preenche a turma a partir da linha pai;
    - recusa pai de outra turma, troca de turma, escrita em "Todas" e escrita em turma arquivada.
- **Global com visibilidade por turma.**
  - **Maquininhas:** a identidade é global (`private.payment_terminals`); a turma usa só as autorizadas em
    `cohort_payment_terminals`.
  - **Flags:**
    - as de infraestrutura e credenciamento são globais e alteradas só por ADMIN_MASTER;
    - as de módulo e meio de pagamento valem por turma.
  - **Evidência PicPay:** é global e única. A atribuição a uma venda ou lançamento herda a turma, e a mesma
    evidência nunca é atribuída a duas turmas.
- **Logs.** `audit_logs` e `outbox_events` levam a turma da operação. `NULL` marca uma operação realmente global, e
  essas linhas só são visíveis para ADMIN_MASTER e para o sistema.
- **Portal e PDV (PR 3).**
  - O proxy do Portal valida a seleção de turma (header `x-germinatura-cohort`, ou o cookie httpOnly
    `germinatura_cohort`) com `get_my_session` antes de qualquer rota. Seleção malformada → 400; seleção não aceita pelo
    banco → 403. Só a seleção validada chega à rota e ao banco, que valida de novo.
  - Escrita fora de uma turma concreta → 409 `COHORT_REQUIRED`, exceto as rotas `cohort: "global"` (perfil, sessões e
    notificações da própria pessoa, seleção de turma, bootstrap, turmas e ADMIN_MASTER).
  - A gestão de usuários lista pela sessão da própria pessoa (`list_cohort_users`); o service role só cria a identidade.
    Papéis, vínculo e desbloqueios de pessoa fora da turma da requisição → `USER_NOT_FOUND`.
  - O provisionamento só remove da turma padrão a identidade marcada por aquele provisionamento
    (`app_metadata.germinatura_provisioning`, que só o service role grava) e que nunca entrou.
  - O PDV opera numa turma concreta, revalidada em toda página; `all` nunca é contexto do PDV. A turma do handoff vem
    do código gravado no servidor, não da URL.
- **Visão consolidada (PR 4).**
  - Em "Todas as turmas", só leem as APIs marcadas `all: "read"`; as demais respondem 409, inclusive as públicas.
    Fora das telas consolidadas, o proxy manda para `/selecionar-turma`. É fail-closed para rotas e telas novas.
  - Agregados são calculados dentro de cada turma e mostrados lado a lado; a conta PicPay aparece como evidência
    global, sem saldo por turma.
  - Vínculos são geridos por ADMIN_MASTER na turma escolhida explicitamente. ADMIN comum não lista turmas nem vínculos
    e não alcança pessoas de outra turma.
  - Inativar um vínculo ou arquivar uma turma com operações em aberto é recusado. A revogação imediata de acesso
    continua sempre possível.
  - Os rótulos de turma da auditoria respeitam o escopo da requisição (`audit_log_cohorts`).
- **Contexto explícito (PR 5).**
  - **Visitante:** turma padrão ATIVA, ou turma ATIVA resolvida no servidor a partir de slug público ou de link `/d/`. `cohort_id` da URL nunca é aceito; turma arquivada ou slug inválido → nada.
  - **Turma padrão:** só ADMIN_MASTER muda; sempre exatamente uma ATIVA; trocas concorrentes são serializadas.
  - **Storage:** imagens de produto, capas e fotos de perda exigem a entidade na turma da requisição.
  - **Revogação imediata:** sempre possível, e informa as pendências. Outro ADMIN ou o FINANCEIRO as assume, com auditoria; nada é apagado.
- **Lacuna conhecida, para o PR 3:** a listagem de usuários do admin lê `profiles`/`user_roles` com o cliente de
  chave secreta, sem escopo de turma. Nenhuma segunda turma deve ser criada em produção antes de essa rota passar a
  usar um RPC escopado.

## Headers e logs

Portal e PDV enviam CSP, proteção contra framing e MIME sniffing, Referrer Policy, Permissions Policy, COOP e CORP. A CSP permite os requisitos atuais do Next.js/Supabase e deve ser revalidada quando OpenNext/Cloudflare for instalado. O servidor de desenvolvimento acrescenta `unsafe-eval` somente a `script-src`, pois o runtime de depuração do React/Next depende dessa diretiva; o build de produção não contém essa exceção.

O logger compartilhado elimina campos de senha, token, authorization, cookie, secret, API key, connection string e service role, inclusive em objetos aninhados. O scan de repositório nunca imprime o valor encontrado.

## Secrets e CI

`pnpm security:scan` verifica todos os arquivos rastreados e falha para arquivos de ambiente, `.dev.vars`, estado Wrangler, dumps/backups, chaves privadas, service role, tokens Cloudflare/GitHub, secrets de pagamento e URLs de banco com credenciais. Publishable keys não são bloqueadas por serem públicas, mas os exemplos continuam sem valores reais.
