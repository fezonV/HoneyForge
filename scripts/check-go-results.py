#!/usr/bin/env python3
"""Reject skips and missing acceptance sentinels in a full Linux race run."""
import json
import sys

required = {
    "TestOpenAPIContractDeclaresRequiredQA01Surface",
    "TestQA01ProfileAuthorizationValidationAndRevisionIsolation",
    "TestQA01RegistrationAndSecretBoundary",
    "TestQA02EventDeliveryRetainsIDsAcrossOutageAndLostACK",
    "TestQA02HTTPActionLoadToCommittedEvents",
    "TestQA03TLSValidityAndHostname",
    "TestQA03SensitiveDataAndManagementBoundary",
    "TestControlPostgresFoundation",
    "TestBE02SixtySecondOutageRestartAndLostCommitACK",
    "TestAgentProcessCrashRetainsAcknowledgedIPCEvents",
    "TestTwoDecoyProcessesAcceptance",
}
passed, failed = set(), []
with open(sys.argv[1], encoding="utf-8") as stream:
    for line in stream:
        row = json.loads(line)
        action = row.get("Action")
        # Go emits package-level skip for packages with no test files.
        if action == "fail" or action == "skip" and "Test" in row:
            failed.append((action, row.get("Package"), row.get("Test")))
        if action == "pass" and "Test" in row:
            passed.add(row["Test"])
if failed or required - passed:
    sys.exit(f"Acceptance incomplete: failures/skips={failed}, missing={sorted(required - passed)}")
print(f"PASS: {len(passed)} tests, no skips; all {len(required)} acceptance sentinels passed")
