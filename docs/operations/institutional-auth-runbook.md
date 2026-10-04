# Runbook — acesso institucional e bootstrap

## Deploy

1. O workflow configura `site_url`, URLs permitidas e o template de OTP pelo Management API do Supabase antes do `db push`.
2. O deploy deve falhar se o provedor hospedado recusar ou não persistir o template com `{{ .Token }}`.
3. Confirmar que o SMTP do ambiente suporta a carga esperada; o provedor padrão do Supabase não deve ser tratado como capacidade institucional comprovada.
4. Executar smoke com endereço fictício autorizado: solicitar código, confirmar uma vez, rejeitar replay e confirmar papel único `CONSUMIDOR`.

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
