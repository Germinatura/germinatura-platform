# Germinatura - Gestão Financeira para Comissões de Formatura

Germinatura é uma plataforma robusta desenvolvida para simplificar a gestão financeira e administrativa de comissões de formatura. O sistema oferece visibilidade total sobre arrecadações, gastos e gestão de produtos para eventos, garantindo transparência e eficiência no processo.

## 🚀 Funcionalidades Principais

- **Dashboard Executivo**: Visão consolidada de KPIs essenciais, incluindo saldo atual, total arrecadado e total gasto.
- **Gestão de Cardápio/Produtos**: Controle completo de itens disponíveis para venda, com histórico de preços e alternância de status de disponibilidade.
- **PDV (Ponto de Venda)**: Interface otimizada para realização de vendas rápidas durante eventos.
- **Histórico de Vendas**: Registro detalhado e pesquisável de todas as transações realizadas no sistema.
- **Fluxo de Caixa**: Gestão de entradas e saídas financeiras com categorização e descrições detalhadas.
- **Gestão de Usuários**: Controle de acesso por perfis (ADMIN e VENDEDOR).

## 🛠️ Tecnologias Utilizadas

A plataforma é construída com um stack moderno e performante:

- **Frontend**: [Next.js](https://nextjs.org/) (App Router) com React.
- **Estilização**: Tailwind CSS para um design responsivo e premium.
- **Banco de Dados**: PostgreSQL gerenciado via [Prisma ORM](https://www.prisma.io/).
- **Autenticação**: Sistema seguro baseado em JWT (Jose) com cookies HTTP-only.
- **Ícones**: Lucide React.

## ⚙️ Configuração e Instalação

### Pré-requisitos
- Node.js (v18+)
- PostgreSQL

### Passos para Instalação

1. **Clonar o repositório**:
   ```bash
   git clone <url-do-repositorio>
   cd plataforma-web
   ```

2. **Instalar dependências**:
   ```bash
   npm install
   ```

3. **Configurar variáveis de ambiente**:
   Crie um arquivo `.env` na raiz do projeto com as seguintes chaves:
   ```env
   DATABASE_URL="postgresql://usuario:senha@localhost:5432/nome-do-banco"
   ```

4. **Rodar Migrações do Prisma**:
   ```bash
   npx prisma migrate dev
   ```

5. **Iniciar o servidor de desenvolvimento**:
   ```bash
   npm run dev
   ```

A plataforma estará disponível em `http://localhost:3000`.

## 📂 Estrutura do Projeto

- `app/`: Contém as rotas, páginas e lógica da API (Next.js App Router).
- `components/`: Componentes React reutilizáveis e UI (Sidebar, Modal, etc.).
- `lib/`: Utilitários, configurações do Prisma e lógica de autenticação.
- `prisma/`: Schema do banco de dados e migrações.
- `public/`: Assets estáticos.

## 📄 Licença

Este projeto é de uso restrito para a gestão financeira de comissões de formatura.

---
Desenvolvido com ❤️ para facilitar a realização de sonhos.
