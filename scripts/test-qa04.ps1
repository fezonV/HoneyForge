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
    & bash ./scripts/test-qa.sh
    if ($LASTEXITCODE -ne 0) { throw 'Backend acceptance failed.' }

    Push-Location web
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'QA-04 command failed.' }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'QA-04 command failed.' }
        npm run lint
        if ($LASTEXITCODE -ne 0) { throw 'QA-04 command failed.' }
        npm run lint:api
        if ($LASTEXITCODE -ne 0) { throw 'OpenAPI validation failed.' }
        npx playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw 'QA-04 command failed.' }
        npm run test:e2e -- e2e/api-contract.spec.mjs e2e/trap-realtime.spec.mjs e2e/trap-control.spec.mjs e2e/profile-preview.spec.mjs --reporter=line
        if ($LASTEXITCODE -ne 0) { throw 'QA-04 command failed.' }
        npm run test:e2e -- e2e/trap-park.spec.mjs --reporter=line
        if ($LASTEXITCODE -ne 0) { throw 'QA-04 command failed.' }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}
