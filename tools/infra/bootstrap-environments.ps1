param(
  [switch]$DeployStaging,
  [switch]$PrepareProductionOnly = $true
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = "C:\Germinatura"
$Repo = "Germinatura/germinatura-platform"

$CloudflareAccountId = "ac1e415bccca201b80f8313dd5ffeec8"
$WorkersSubdomain = "germinatura.workers.dev"

$StagingSupabaseRef = "ttupvkygtkfspkgfihbl"
$StagingSupabaseUrl = "https://ttupvkygtkfspkgfihbl.supabase.co"

$ProductionSupabaseRef = "emfmofwbazvvvasetoqu"
$ProductionSupabaseUrl = "https://emfmofwbazvvvasetoqu.supabase.co"

$PortalStagingUrl = "https://germinatura-portal-staging.$WorkersSubdomain"
$PdvStagingUrl = "https://germinatura-pdv-staging.$WorkersSubdomain"
$PortalProductionUrl = "https://germinatura-portal-production.$WorkersSubdomain"
$PdvProductionUrl = "https://germinatura-pdv-production.$WorkersSubdomain"

function Step($m) {
  Write-Host "`n=== $m ===" -ForegroundColor Cyan
}

function Need($cmd) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Comando '$cmd' não encontrado."
  }
}

function Read-SecretText($prompt) {
  $s = Read-Host $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Write-Utf8NoBom($path, $content) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($path, $content, $enc)
}

function Get-KvId($name) {
  Push-Location "$RepoRoot\apps\portal"
  try {
    $raw = pnpm exec wrangler kv namespace list 2>&1 | Out-String
    $jsonStart = $raw.IndexOf("[")
    $jsonEnd = $raw.LastIndexOf("]")
    if ($jsonStart -lt 0 -or $jsonEnd -le $jsonStart) { return $null }
    $items = $raw.Substring($jsonStart, $jsonEnd-$jsonStart+1) | ConvertFrom-Json
    foreach ($x in @($items)) {
      $n = if ($x.PSObject.Properties.Name -contains "title") { $x.title } else { $x.name }
      if ($n -eq $name) { return [string]$x.id }
    }
    return $null
  } finally { Pop-Location }
}

function Ensure-Kv($name) {
  $id = Get-KvId $name
  if ($id) {
    Write-Host "[OK] KV já existe: $name -> $id" -ForegroundColor Green
    return $id
  }

  Push-Location "$RepoRoot\apps\portal"
  try {
    $raw = pnpm exec wrangler kv namespace create $name 2>&1 | Out-String
    Write-Host $raw
    $m = [regex]::Matches($raw,'(?i)[0-9a-f]{32}')
    if ($m.Count -eq 0) { throw "Não consegui extrair ID do KV $name" }
    return $m[$m.Count-1].Value
  } finally { Pop-Location }
}

function Set-GhVar($envName,$name,$value) {
  gh variable set $name --env $envName --repo $Repo --body $value
  if ($LASTEXITCODE -ne 0) { throw "Falha ao definir variable $name em $envName" }
}

function Set-GhSecret($envName,$name,$value) {
  $value | gh secret set $name --env $envName --repo $Repo
  if ($LASTEXITCODE -ne 0) { throw "Falha ao definir secret $name em $envName" }
}

function Ensure-Environment($name) {
  gh api --method PUT "repos/$Repo/environments/$name" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Falha ao criar GitHub Environment $name" }
}

function Ensure-Develop {
  $exists = git ls-remote --heads origin develop
  if ([string]::IsNullOrWhiteSpace($exists)) {
    $mainSha = (gh api "repos/$Repo/git/ref/heads/main" --jq ".object.sha").Trim()
    gh api --method POST "repos/$Repo/git/refs" -f ref="refs/heads/develop" -f sha="$mainSha" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar develop" }
    Write-Host "[OK] develop criada" -ForegroundColor Green
  } else {
    Write-Host "[OK] develop já existe" -ForegroundColor Green
  }
}

function Ensure-Vinext($app, $port) {
  $dir = "$RepoRoot\apps\$app"
  Push-Location $dir
  try {
    if (-not (Test-Path ".\wrangler.jsonc")) {
      pnpm dlx vinext@1.0.0-beta.8 check
      if ($LASTEXITCODE -ne 0) { throw "vinext check falhou em $app" }

      pnpm dlx vinext@1.0.0-beta.8 init --platform=cloudflare
      if ($LASTEXITCODE -ne 0) { throw "vinext init falhou em $app" }
    }

    $pkg = Get-Content .\package.json -Raw | ConvertFrom-Json
    foreach ($p in @(
      @{n="dev:vinext";v="vinext dev --port $port"},
      @{n="build:vinext";v="vinext build"},
      @{n="start:vinext";v="wrangler dev --config dist/server/wrangler.json"},
      @{n="deploy:vinext";v="vinext-cloudflare deploy --config dist/server/wrangler.json"}
    )) {
      if ($pkg.scripts.PSObject.Properties.Name -contains $p.n) {
        $pkg.scripts.($p.n) = $p.v
      } else {
        $pkg.scripts | Add-Member -NotePropertyName $p.n -NotePropertyValue $p.v
      }
    }
    Write-Utf8NoBom ".\package.json" ($pkg | ConvertTo-Json -Depth 50)
  } finally { Pop-Location }
}

Step "0/9 Pre-flight"
Set-Location $RepoRoot
Need git
Need pnpm
Need gh
gh auth status
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI não autenticado" }

Push-Location "$RepoRoot\apps\portal"
pnpm exec wrangler whoami
if ($LASTEXITCODE -ne 0) { throw "Wrangler não autenticado" }
Pop-Location

Step "1/9 Branches"
Ensure-Develop

Step "2/9 Vinext Portal + PDV"
Ensure-Vinext "portal" 3000
Ensure-Vinext "pdv" 3001
pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install falhou" }

Step "3/9 Cloudflare KV"
$portalStagingKv = Ensure-Kv "germinatura-portal-staging-vinext-cache"
$portalProductionKv = Ensure-Kv "germinatura-portal-production-vinext-cache"
$pdvStagingKv = Ensure-Kv "germinatura-pdv-staging-vinext-cache"
$pdvProductionKv = Ensure-Kv "germinatura-pdv-production-vinext-cache"

Step "4/9 Wrangler configs"
$portalWrangler = @"
{
  "`$schema": "node_modules/wrangler/config-schema.json",
  "name": "germinatura-portal",
  "account_id": "$CloudflareAccountId",
  "compatibility_date": "2026-08-29",
  "compatibility_flags": ["nodejs_compat"],
  "main": "vinext/server/fetch-handler",
  "assets": {
    "directory": "dist/client",
    "not_found_handling": "none",
    "binding": "ASSETS"
  },
  "cache": { "enabled": true },
  "env": {
    "staging": {
      "name": "germinatura-portal-staging",
      "workers_dev": true,
      "images": { "binding": "IMAGES" },
      "kv_namespaces": [
        { "binding": "VINEXT_KV_CACHE", "id": "$portalStagingKv" }
      ]
    },
    "production": {
      "name": "germinatura-portal-production",
      "workers_dev": true,
      "images": { "binding": "IMAGES" },
      "kv_namespaces": [
        { "binding": "VINEXT_KV_CACHE", "id": "$portalProductionKv" }
      ]
    }
  }
}
"@

$pdvWrangler = @"
{
  "`$schema": "node_modules/wrangler/config-schema.json",
  "name": "germinatura-pdv",
  "account_id": "$CloudflareAccountId",
  "compatibility_date": "2026-08-29",
  "compatibility_flags": ["nodejs_compat"],
  "main": "vinext/server/fetch-handler",
  "assets": {
    "directory": "dist/client",
    "not_found_handling": "none",
    "binding": "ASSETS"
  },
  "cache": { "enabled": true },
  "env": {
    "staging": {
      "name": "germinatura-pdv-staging",
      "workers_dev": true,
      "images": { "binding": "IMAGES" },
      "kv_namespaces": [
        { "binding": "VINEXT_KV_CACHE", "id": "$pdvStagingKv" }
      ]
    },
    "production": {
      "name": "germinatura-pdv-production",
      "workers_dev": true,
      "images": { "binding": "IMAGES" },
      "kv_namespaces": [
        { "binding": "VINEXT_KV_CACHE", "id": "$pdvProductionKv" }
      ]
    }
  }
}
"@

Write-Utf8NoBom "$RepoRoot\apps\portal\wrangler.jsonc" $portalWrangler
Write-Utf8NoBom "$RepoRoot\apps\pdv\wrangler.jsonc" $pdvWrangler

Step "5/9 .env.example completo"
$envExample = @"
# ============================================================
# GERMINATURA - EXEMPLO DE CONFIGURAÇÃO
# Copie para .env.local somente no ambiente local.
# NÃO coloque segredos reais neste arquivo.
# ============================================================

# Aplicação
APP_ENV=local

# URLs públicas dos apps
NEXT_PUBLIC_PORTAL_URL=http://127.0.0.1:3000
NEXT_PUBLIC_PDV_URL=http://127.0.0.1:3001

# Supabase público
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=replace-with-local-publishable-key

# Identificadores de infraestrutura
# Públicos/não secretos; usados por CI e documentação
SUPABASE_PROJECT_ID=
CLOUDFLARE_ACCOUNT_ID=

# CI/CD - SOMENTE SECRET STORE / GITHUB ENVIRONMENT
# Nunca preencher estes valores no Git.
SUPABASE_ACCESS_TOKEN=
SUPABASE_DB_PASSWORD=
CLOUDFLARE_API_TOKEN=

# Futuro - NÃO habilitar até implementação oficial
# PIC_PAY_CLIENT_ID=
# PIC_PAY_CLIENT_SECRET=
# PIC_PAY_WEBHOOK_SECRET=
# SENTRY_DSN=
"@

Write-Utf8NoBom "$RepoRoot\.env.example" $envExample
Write-Utf8NoBom "$RepoRoot\apps\portal\.env.example" $envExample
Write-Utf8NoBom "$RepoRoot\apps\pdv\.env.example" $envExample

Step "6/9 GitHub Environments + variables/secrets"
Ensure-Environment "staging"
Ensure-Environment "production"

$SupabasePat = Read-SecretText "SUPABASE_ACCESS_TOKEN (PAT)"
$StagingDbPassword = Read-SecretText "Senha do banco Supabase STAGING"
$ProductionDbPassword = Read-SecretText "Senha do banco Supabase PRODUCTION"
$CloudflareApiToken = Read-SecretText "CLOUDFLARE_API_TOKEN"

$StagingPublishableKey = Read-Host "Publishable Key Supabase STAGING (sb_publishable_...)"
$ProductionPublishableKey = Read-Host "Publishable Key Supabase PRODUCTION (sb_publishable_...)"

# staging vars
Set-GhVar staging SUPABASE_PROJECT_ID $StagingSupabaseRef
Set-GhVar staging CLOUDFLARE_ACCOUNT_ID $CloudflareAccountId
Set-GhVar staging NEXT_PUBLIC_SUPABASE_URL $StagingSupabaseUrl
Set-GhVar staging NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY $StagingPublishableKey
Set-GhVar staging NEXT_PUBLIC_PORTAL_URL $PortalStagingUrl
Set-GhVar staging NEXT_PUBLIC_PDV_URL $PdvStagingUrl

# staging secrets
Set-GhSecret staging SUPABASE_ACCESS_TOKEN $SupabasePat
Set-GhSecret staging SUPABASE_DB_PASSWORD $StagingDbPassword
Set-GhSecret staging CLOUDFLARE_API_TOKEN $CloudflareApiToken

# production vars
Set-GhVar production SUPABASE_PROJECT_ID $ProductionSupabaseRef
Set-GhVar production CLOUDFLARE_ACCOUNT_ID $CloudflareAccountId
Set-GhVar production NEXT_PUBLIC_SUPABASE_URL $ProductionSupabaseUrl
Set-GhVar production NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY $ProductionPublishableKey
Set-GhVar production NEXT_PUBLIC_PORTAL_URL $PortalProductionUrl
Set-GhVar production NEXT_PUBLIC_PDV_URL $PdvProductionUrl

# production secrets
Set-GhSecret production SUPABASE_ACCESS_TOKEN $SupabasePat
Set-GhSecret production SUPABASE_DB_PASSWORD $ProductionDbPassword
Set-GhSecret production CLOUDFLARE_API_TOKEN $CloudflareApiToken

Step "7/9 Workflows"
$wfDir = "$RepoRoot\.github\workflows"
New-Item -ItemType Directory -Path $wfDir -Force | Out-Null

$deployStagingWorkflowContent = @'
name: Deploy Staging

on:
  push:
    branches: [develop]
  workflow_dispatch:

concurrency:
  group: germinatura-staging
  cancel-in-progress: true

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    environment:
      name: staging
      url: ${{ vars.NEXT_PUBLIC_PORTAL_URL }}
    env:
      CLOUDFLARE_ENV: staging
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
      SUPABASE_PROJECT_ID: ${{ vars.SUPABASE_PROJECT_ID }}
      NEXT_PUBLIC_SUPABASE_URL: ${{ vars.NEXT_PUBLIC_SUPABASE_URL }}
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ vars.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}
      NEXT_PUBLIC_PORTAL_URL: ${{ vars.NEXT_PUBLIC_PORTAL_URL }}
      NEXT_PUBLIC_PDV_URL: ${{ vars.NEXT_PUBLIC_PDV_URL }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
      - run: npm i -g pnpm@11.19.0
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm exec supabase link --project-ref "$SUPABASE_PROJECT_ID"
      - run: pnpm exec supabase db push --dry-run
      - run: pnpm exec supabase db push
      - working-directory: apps/portal
        run: pnpm run deploy:vinext -- --env staging
      - working-directory: apps/pdv
        run: pnpm run deploy:vinext -- --env staging
      - run: curl --fail --silent --show-error "${NEXT_PUBLIC_PORTAL_URL}/api/v1/health"
      - run: curl --fail --silent --show-error "${NEXT_PUBLIC_PDV_URL}/api/v1/health"
'@

$deployProductionWorkflowContent = @'
name: Deploy Production

on:
  workflow_dispatch:
    inputs:
      confirm:
        description: Digite PRODUCAO
        required: true
        type: string

concurrency:
  group: germinatura-production
  cancel-in-progress: false

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    if: github.ref == 'refs/heads/main' && inputs.confirm == 'PRODUCAO'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    environment:
      name: production
      url: ${{ vars.NEXT_PUBLIC_PORTAL_URL }}
    env:
      CLOUDFLARE_ENV: production
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
      SUPABASE_PROJECT_ID: ${{ vars.SUPABASE_PROJECT_ID }}
      NEXT_PUBLIC_SUPABASE_URL: ${{ vars.NEXT_PUBLIC_SUPABASE_URL }}
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ vars.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}
      NEXT_PUBLIC_PORTAL_URL: ${{ vars.NEXT_PUBLIC_PORTAL_URL }}
      NEXT_PUBLIC_PDV_URL: ${{ vars.NEXT_PUBLIC_PDV_URL }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
      - run: npm i -g pnpm@11.19.0
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm exec supabase link --project-ref "$SUPABASE_PROJECT_ID"
      - run: pnpm exec supabase db push --dry-run
      - run: pnpm exec supabase db push
      - working-directory: apps/portal
        run: pnpm run deploy:vinext -- --env production
      - working-directory: apps/pdv
        run: pnpm run deploy:vinext -- --env production
      - run: curl --fail --silent --show-error "${NEXT_PUBLIC_PORTAL_URL}/api/v1/health"
      - run: curl --fail --silent --show-error "${NEXT_PUBLIC_PDV_URL}/api/v1/health"
'@

Write-Utf8NoBom "$wfDir\deploy-staging.yml" $deployStagingWorkflowContent
Write-Utf8NoBom "$wfDir\deploy-production.yml" $deployProductionWorkflowContent

Step "8/9 Validar staging e production por dry-run"
$env:CLOUDFLARE_ACCOUNT_ID = $CloudflareAccountId

foreach ($cfg in @(
  @{env="staging"; url=$StagingSupabaseUrl; key=$StagingPublishableKey; portal=$PortalStagingUrl; pdv=$PdvStagingUrl},
  @{env="production"; url=$ProductionSupabaseUrl; key=$ProductionPublishableKey; portal=$PortalProductionUrl; pdv=$PdvProductionUrl}
)) {
  $env:CLOUDFLARE_ENV = $cfg.env
  $env:NEXT_PUBLIC_SUPABASE_URL = $cfg.url
  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $cfg.key
  $env:NEXT_PUBLIC_PORTAL_URL = $cfg.portal
  $env:NEXT_PUBLIC_PDV_URL = $cfg.pdv

  foreach ($app in @("portal","pdv")) {
    Push-Location "$RepoRoot\apps\$app"
    try {
      Write-Host "Dry-run $app / $($cfg.env)" -ForegroundColor Cyan
      pnpm run deploy:vinext -- --env $cfg.env --dry-run
      if ($LASTEXITCODE -ne 0) { throw "Dry-run falhou: $app / $($cfg.env)" }
    } finally { Pop-Location }
  }
}

Step "9/9 Deploy staging opcional"
if ($DeployStaging) {
  $env:CLOUDFLARE_ENV = "staging"
  $env:NEXT_PUBLIC_SUPABASE_URL = $StagingSupabaseUrl
  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $StagingPublishableKey
  $env:NEXT_PUBLIC_PORTAL_URL = $PortalStagingUrl
  $env:NEXT_PUBLIC_PDV_URL = $PdvStagingUrl

  $env:SUPABASE_ACCESS_TOKEN = $SupabasePat
  $env:SUPABASE_DB_PASSWORD = $StagingDbPassword

  pnpm exec supabase link --project-ref $StagingSupabaseRef
  pnpm exec supabase db push --dry-run

  $confirm = Read-Host "Digite DEPLOY-STAGING para aplicar migrations e publicar staging"
  if ($confirm -eq "DEPLOY-STAGING") {
    pnpm exec supabase db push
    Push-Location "$RepoRoot\apps\portal"
    pnpm run deploy:vinext -- --env staging
    Pop-Location
    Push-Location "$RepoRoot\apps\pdv"
    pnpm run deploy:vinext -- --env staging
    Pop-Location

    Invoke-RestMethod "$PortalStagingUrl/api/v1/health"
    Invoke-RestMethod "$PdvStagingUrl/api/v1/health"
  }
}

Remove-Item Env:CLOUDFLARE_ENV -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_SUPABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_PORTAL_URL -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_PDV_URL -ErrorAction SilentlyContinue
Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "CONFIGURAÇÃO CONCLUÍDA." -ForegroundColor Green
Write-Host "Production ficou pronta, mas NÃO foi publicada." -ForegroundColor Yellow
Write-Host ""
Write-Host "Próximo commit recomendado:"
Write-Host 'git switch -c chore/deployment-environments'
Write-Host 'git add .'
Write-Host 'git commit -m "chore(deploy): configure staging and production"'
Write-Host 'git push -u origin chore/deployment-environments'
Write-Host 'gh pr create --base develop --fill'
