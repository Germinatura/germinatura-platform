# Spike de isolamento por turma — evidências

> Execução local de 08/10/2026 (`node tools/spikes/cohort-isolation/run.mjs`), sobre `develop` c0b6e34 + `spike.sql`. Dados sintéticos.

## ✅ Diff de schema (pg_dump antes × depois do spike)

- tables: +8 −7 | + "cohort_data"."categories", "cohort_data"."finance_manual_entries", "cohort_data"."portal_highlights", "cohort_data"."product_images", "cohort_data"."product_prices", "cohort_data"."product_stock_alerts", "cohort_data"."products", "private"."spike_admin_masters" | − "public"."categories", "public"."finance_manual_entries", "public"."portal_highlights", "public"."product_images", "public"."product_prices", "public"."product_stock_alerts", "public"."products"
- views: +7 −0 | + "public"."categories", "public"."finance_manual_entries", "public"."portal_highlights", "public"."product_images", "public"."product_prices", "public"."product_stock_alerts", "public"."products"
- policies: +7 −0 | + "categories_cohort_scope", "finance_manual_entries_cohort_scope", "portal_highlights_cohort_scope", "product_images_cohort_scope", "product_prices_cohort_scope", "product_stock_alerts_cohort_scope", "products_cohort_scope"
- triggers: +17 −10 | + "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."categories", "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."finance_manual_entries", "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."portal_highlights", "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."product_images", "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."product_prices", "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."product_stock_alerts", "a_cohort_guard" BEFORE INSERT OR DELETE OR UPDATE ON "cohort_data"."products", "categories_prevent_hard_delete" BEFORE DELETE ON "cohort_data"."categories", "categories_set_updated_at" BEFORE UPDATE ON "cohort_data"."categories", "finance_manual_entries_immutable" BEFORE DELETE OR UPDATE ON "cohort_data"."finance_manual_entries", "portal_highlights_immutable" BEFORE DELETE OR UPDATE ON "cohort_data"."portal_highlights", "product_prices_prevent_hard_delete" BEFORE DELETE ON "cohort_data"."product_prices", … | − "categories_prevent_hard_delete" BEFORE DELETE ON "public"."categories", "categories_set_updated_at" BEFORE UPDATE ON "public"."categories", "finance_manual_entries_immutable" BEFORE DELETE OR UPDATE ON "public"."finance_manual_entries", "portal_highlights_immutable" BEFORE DELETE OR UPDATE ON "public"."portal_highlights", "product_prices_prevent_hard_delete" BEFORE DELETE ON "public"."product_prices", "product_prices_prevent_update" BEFORE UPDATE ON "public"."product_prices", "products_broadcast_published" AFTER INSERT OR UPDATE OF "active", "published" ON "public"."products", "products_prevent_hard_delete" BEFORE DELETE ON "public"."products", "products_prevent_sku_update" BEFORE UPDATE ON "public"."products", "products_set_updated_at" BEFORE UPDATE ON "public"."products"

## ✅ Teste de isolamento do spike (banco limpo): 49/49


## ℹ️ Suíte pgTAP existente sobre o banco convertido (90 arquivos, 2419 testes)

- Arquivos com falha: catalog_core_test.sql: 6 de 32; catalog_product_images_test.sql: 1 de 25; cohort_foundation_test.sql: 5 de 27; finance_manual_entries_test.sql: 1 de 22
- falha: categories table exists
- falha: products table exists
- falha: product prices table exists
- falha: SKU is unique
- falha: price validity lookup is indexed
- falha: all catalog tables have RLS enabled
- falha: product image metadata table exists
- falha: until the authorization context exists, new rows default to Turma 2026 (same behavior as today)
- falha: every cohort foreign key is validated
- falha: the integrity report is clean
- falha: cross-cohort references are checked for every foreign key between scoped tables
- falha: still clean after the write
- falha: manual entries exist

## ✅ Conversão sobre banco populado: todas as linhas, valores e tuplas preservados

- tabelas movidas (agora em cohort_data): categories, products, product_prices, product_images, product_stock_alerts, finance_manual_entries, portal_highlights; linhas: categories=16, products=159, product_prices=158, product_images=118, product_stock_alerts=0, finance_manual_entries=0, portal_highlights=0

## ✅ Teste de isolamento do spike (banco populado): 49/49


## ✅ Data API (HTTP, PostgREST real)

- ✔ anon não vê produto publicado de outra turma — HTTP 200
- ✔ embedding por FK através das views (products → categories, product_prices) — HTTP 200
- ✔ admin da Turma 2026 não lê a categoria da 2027 — HTTP 200
- ✔ nem pedindo a 2027 pelo header — HTTP 200
- ✔ admin da 2027 lê a própria categoria — HTTP 200
- ✔ o schema das tabelas base não é exposto pela Data API — HTTP 406
- ✔ escrita direta na view é negada (grants da tabela base) — HTTP 403
- ✔ RPC SECURITY DEFINER via Data API não alcança registro de outra turma — HTTP 500 CATEGORY_NOT_FOUND
- ✔ escrita em contexto sem turma concreta é recusada — HTTP 400 COHORT_REQUIRED
- ✔ RPC da 2027 grava na 2027 — HTTP 200, cohort c0000000-0000-4000-8000-000000002027

## ✅ Realtime (postgres_changes ponta a ponta)

- ✔ a view não pode ser publicada — ERROR:  cannot add relation "categories" to publication
- assinaturas registradas: anon:anon, authenticated:1c000000-0000-4000-8000-0000000000bb, authenticated:10000000-0000-4000-8000-000000000001
- ✔ assinante da 2026 (admin) recebeu: [spike-rt-a] (esperado spike-rt-a)
- ✔ assinante da 2027 (admin) recebeu: [spike-rt-b] (esperado spike-rt-b)
- ✔ assinante anônimo (controle: só a turma padrão) recebeu: [spike-rt-a] (esperado spike-rt-a)

## ✅ Backup (supabase db dump) e restauração pelo procedimento do runbook (linhas da aplicação antes da carga: 0)


## ✅ Teste de isolamento do spike no banco restaurado: 49/49

