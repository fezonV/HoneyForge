$ErrorActionPreference = 'Stop'

if (-not $env:TEST_DATABASE_URL) {
    throw 'Set TEST_DATABASE_URL to a disposable PostgreSQL database before running QA-01.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    go test -race -count=1 -run 'TestOpenAPIContract|TestQA01|TestControlPostgresFoundation' ./api ./internal/control
    if ($LASTEXITCODE -ne 0) {
        throw "QA-01 failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
