# Runbook — acesso institucional e bootstrap

## Deploy

1. O workflow configura `site_url`, URLs permitidas e o template de OTP pelo Management API do Supabase antes do `db push`.
2. O deploy deve falhar se o provedor hospedado recusar ou não persistir o template com `{{ .Token }}`.
3. Confirmar que o SMTP do ambiente suporta a carga esperada; o provedor padrão do Supabase não deve ser tratado como capacidade institucional comprovada.
4. Executar smoke com endereço fictício autorizado: solicitar código, confirmar uma vez, rejeitar replay e confirmar papel único `CONSUMIDOR`.

## Tentativas de cadastro (A1)

- O pedido de código cria só a identidade técnica em `auth.users`, marcada pelo banco em `private.signup_attempts` (só o trigger de cadastro escreve essa marca). Perfil, vínculo e papel nascem com a sessão do código válido (`materialize_my_signup_identity`); a conclusão do perfil, com a mesma sessão, completa o que um verify interrompido deixou, sem novo código.
- O worker de jobs chama `worker_purge_unconfirmed_identities` a cada ciclo e remove SOMENTE tentativas marcadas deste fluxo, nunca confirmadas, sem login nem sessão, sem carimbo de provisionamento, paradas há 24 horas e sem nenhum histórico (auditoria, outbox, Storage ou qualquer chave estrangeira). A linha em confirmação é pulada (SKIP LOCKED). Cada remoção fica em `private.identity_purges`, sem e-mail.
- Identidades anteriores ao A1 (legado) nunca são removidas automaticamente. O ADMIN_MASTER lê o inventário com `select public.identity_inventory();` (somente leitura). Categorias: `SIGNUP_ATTEMPT`, `SIGNUP_ATTEMPT_WITH_HISTORY`, `CONFIRMED_NOT_MATERIALIZED`, `CONFIRMED_ONBOARDING_INCOMPLETE`, `ACTIVE_ACCOUNT`, `ADMIN_PROVISIONED`, `LEGACY_UNCONFIRMED_EMPTY` (oculta na Gestão), `LEGACY_UNCONFIRMED_NO_PROFILE`, `LEGACY_UNCONFIRMED_WITH_HISTORY`. Uma limpeza histórica é uma operação separada, explicitamente autorizada, auditada e precedida deste relatório.
- Código de cadastro bloqueado: Gestão de Usuários › "Código de cadastro bloqueado", com o e-mail e o motivo (ADMIN_MASTER ou ADMIN da turma padrão; até 30 liberações por hora por administrador; resposta uniforme).

## Primeiro administrador

1. `theo.martins@institutojef.org.br` solicita e confirma o OTP normalmente, sem compartilhar código, cookie ou token.
2. Na primeira sessão, a página apresenta **Ativar administração** somente para esse endereço sem papel `ADMIN`.
3. A ação chama o RPC idempotente, registra audit log/outbox e fecha o bootstrap permanentemente.
4. Recarregar a sessão e confirmar `ADMIN` + `CONSUMIDOR`. Repetição deve retornar `ALREADY_COMPLETED` sem nova concessão.

## Ativação e revogação de vendedor

- Administrações enviam o conjunto completo de papéis e o estado ativo; `CONSUMIDOR` é sempre preservado.
- Inativar o perfil corta permissões imediatamente no servidor, inclusive com sessão ainda aberta.
- Nunca remover ou inativar o último administrador ativo.
- Não registrar códigos, tokens, cookies ou senhas nas evidências operacionais.
