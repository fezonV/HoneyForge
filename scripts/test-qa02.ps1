$ErrorActionPreference = 'Stop'

if (-not $env:TEST_DATABASE_URL) {
    throw 'Set TEST_DATABASE_URL to a disposable PostgreSQL database before running QA-02.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    $env:HF_DECOY_PROCESS_TEST = '1'
    $pattern = '^(TestControlPostgresFoundation|TestQA02|TestBE02|TestBE03|TestTwoDecoyProcessesAcceptance|TestAgentProcessCrashRetainsAcknowledgedIPCEvents|TestHeartbeatAndIntakeContinueDuringStalledDelivery|Test(Low|Medium)|TestArchivePages|TestQueue|TestDiskFull|TestEventQueue|TestFlush|TestCommandResult|TestExpiredAndInterruptedCommands|TestExecuteCommand|TestHTTPDecoy|TestIPC)'
    go test -race -count=1 -run $pattern ./cmd/agent ./cmd/decoy ./internal/agent ./internal/control ./internal/decoy
    if ($LASTEXITCODE -ne 0) {
        throw "QA-02 failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
