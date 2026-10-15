$ErrorActionPreference = 'Stop'

if (-not $env:TEST_DATABASE_URL) {
    throw 'Set TEST_DATABASE_URL to a disposable PostgreSQL database before running QA-03.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    $pattern = '^(TestQA03|TestNewClient|TestEnrollAndFetchConfig|TestFetchConfig|TestSaveAndLoadState|TestLoadState|TestManagementRedirect|TestPublicResponses|TestAdminHandler|TestHandlerNever|TestFakeFile|TestQueueUsesPrivate|TestBundle|TestIPC|TestSafeCSV|TestEventMetadata|TestSensitiveEvent|TestAllowQuery|TestWebsocket)'
    go test -race -count=1 -run $pattern ./internal/agent ./internal/control ./internal/decoy ./internal/visitorproxy
    if ($LASTEXITCODE -ne 0) {
        throw "QA-03 failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
