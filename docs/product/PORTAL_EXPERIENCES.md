# Experiências do Portal e perfil

A visão administrativa e a experiência do consumidor compartilham autenticação e contratos. `/inicio` é a entrada do consumidor; `/` preserva o dashboard para ADMIN. O seletor lateral altera apenas navegação, nunca papéis/permissões. Rotas compartilhadas como `/perfil` mantêm a última visão da aba; API/RLS continuam obrigatórias. Minhas reservas filtra o próprio cliente inclusive para ADMIN.

O shell ocupa a janela com rolagem independente no menu e no conteúdo. Perfil oferece nome, foto privada reduzida no navegador (até 512px), apresentação, turma/grupo e até oito preferências opcionais. Preferências residem em tabela privada por titular; RPC valida versão, propriedade da foto e idempotência. Auditoria não replica textos pessoais. Publicação social e recomendador permanecem pendentes. Fotos anteriores não são removidas automaticamente; uma futura rotina de retenção deve consultar referências antes de excluir, evitando apagar objetos ainda usados por sessões concorrentes.

O PDV oferece retorno ao Portal para administrador/vendedor e carrega fechamento sob demanda. Leituras iniciais são paralelas; pagamentos e estoque permanecem transacionais. Não há execução financeira sem confirmação.

A extração de `components/consumer/ConsumerHome` e de `lib/portal-experience.ts` facilita avaliar uma separação dos Workers operacional e consumidor. É apenas uma possibilidade: nenhum domínio, Worker, sessão ou service binding mudou. Uma decisão futura exige medir tráfego/bundle, delimitar contratos, autenticação entre origens, CSP/CSRF e rotas independentes.

A suíte CI inicia Storage para verificar envio e leitura real de foto privada. A imagem é reduzida e recodificada antes do envio; URLs assinadas duram 15 minutos, sem inclusão no cache offline do PDV.

## Evidência local desta revisão

Gates: 78 unitários, 789 pgTAP, cinco integrações concorrentes, lint (oito warnings históricos), typecheck, builds Next/Vinext e scan 290 passaram. As 23 jornadas E2E foram cobertas: 21 passaram na primeira suíte e quatro no reteste dirigido. Uma imagem PNG inválida da fixture e um reinício do servidor durante o teste de rifas foram corrigidos no ambiente/teste; nenhuma asserção foi removida. Capturas mobile de perfil, preferências e retorno PDV revisadas.

Smoke adicional com Next otimizado e Supabase exclusivamente local confirmou edição do nome, atualização da sessão e restauração da fixture, além da abertura do fechamento sob demanda. Em viewport 390×844, PDV pronto em 582/341/320 ms (primeira navegação e duas seguintes); não representa latência de rede móvel ou homologação de dispositivos.

Comparação dos artefatos Vinext locais antes/depois, somando entrypoint, página PDV e imports estáticos transitivos: 217.984 → 217.322 bytes gzip. Fechamento agora em chunk separado de 9.793 bytes (3.462 gzip), fora desse grafo inicial. É redução pequena, não promessa de aceleração geral. Os JSONs e capturas estão no QA local; CI e smoke de staging continuam obrigatórios antes de considerar a entrega integrada.
