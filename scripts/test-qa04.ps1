$ErrorActionPreference = 'Stop'

if (-not $env:TEST_DATABASE_URL) {
    throw 'Set TEST_DATABASE_URL to a disposable PostgreSQL database before running QA-04.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    $goFiles = @(git ls-files '*.go')
    if ($goFiles.Count -gt 0) {
        $formatDiff = gofmt -d $goFiles
        if ($formatDiff) { throw "gofmt reported differences:`n$formatDiff" }
    }
    go test -race -short -count=1 ./...
    go vet ./...
    go build ./...
    npx --yes @redocly/cli@latest lint api/openapi.yaml
    Push-Location web
    try {
        npm ci
        npm run build
        npm run lint
        npx playwright install chromium
        npm run test:e2e -- e2e/trap-realtime.spec.mjs e2e/trap-control.spec.mjs e2e/profile-preview.spec.mjs --reporter=line
        npm run test:e2e -- e2e/trap-park.spec.mjs --reporter=line
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}
