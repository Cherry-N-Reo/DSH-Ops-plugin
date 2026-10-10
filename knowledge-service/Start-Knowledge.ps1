param([switch]$Check)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath '.env')) {
        throw 'Copy .env.example to .env and fill the database password, API token and SiliconFlow settings first.'
    }
    & uv sync --frozen
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge dependencies could not be installed.' }
    & uv run python -c 'from ops_knowledge.config import Settings; Settings(); print("Knowledge configuration validated")'
    if ($LASTEXITCODE -ne 0) { throw 'Invalid knowledge configuration.' }
    $standaloneCompose = Get-Command docker-compose -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($standaloneCompose) {
        & $standaloneCompose.Source config --quiet
    } else {
        & docker compose config --quiet
    }
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable or compose.yaml is invalid.' }
    if ($Check) { return }
    if ($standaloneCompose) {
        & $standaloneCompose.Source up -d --wait postgres
    } else {
        & docker compose up -d --wait postgres
    }
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge PostgreSQL did not become healthy.' }
    & uv run uvicorn ops_knowledge.api:create_app --factory --host 127.0.0.1 --port 8765
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge service stopped with an error.' }
} finally { Pop-Location }
