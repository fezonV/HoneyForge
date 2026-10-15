package api

import (
	_ "embed"
	"strings"
	"testing"
)

// Keep the public contract under test without requiring a running control
// service. The API tests in internal/control exercise the corresponding
// handlers; this guard catches accidental route/schema drift in review.
//
//go:embed openapi.yaml
var openAPI []byte

func TestOpenAPIContractDeclaresRequiredQA01Surface(t *testing.T) {
	doc := string(openAPI)
	for _, marker := range []string{
		"openapi: 3.1.0",
		"/api/v1/auth/login:",
		"/api/v1/auth/logout:",
		"/api/v1/auth/me:",
		"/api/v1/templates:",
		"/api/v1/profiles:",
		"/api/v1/profiles/{id}:",
		"/api/v1/profiles/{id}/revisions:",
		"/api/v1/profiles/{id}/revisions/{revision}:",
		"/api/v1/profiles/{id}/revisions/{revision}/sensitive:",
		"/api/v1/traps:",
		"/api/v1/traps/{id}/profile:",
		"/api/v1/traps/{id}/enrollment-token:",
		"/agent/v1/enroll:",
		"ProfileConfig:",
		"SyntheticCredential:",
		"DeploymentBinding:",
		"ApiError:",
	} {
		if !strings.Contains(doc, marker) {
			t.Errorf("OpenAPI contract is missing %q", marker)
		}
	}

	// These fields are security boundaries: removing them from the schema can
	// make a client accidentally display or persist credentials.
	for _, marker := range []string{
		"sensitive_redacted",
		"agent_token",
		"csrf_token",
		"tls_required",
	} {
		if !strings.Contains(doc, marker) {
			t.Errorf("OpenAPI contract is missing security marker %q", marker)
		}
	}
}
