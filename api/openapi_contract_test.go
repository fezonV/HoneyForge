package api

import (
	_ "embed"
	"gopkg.in/yaml.v3"
	"testing"
)

// Structural assertions complement the pinned Redocly syntax/reference lint.
//
//go:embed openapi.yaml
var openAPI []byte

func TestOpenAPIContractDeclaresRequiredQA01Surface(t *testing.T) {
	var doc struct {
		OpenAPI    string                    `yaml:"openapi"`
		Paths      map[string]map[string]any `yaml:"paths"`
		Components struct {
			Schemas map[string]struct {
				Properties map[string]any `yaml:"properties"`
			} `yaml:"schemas"`
			SecuritySchemes map[string]any `yaml:"securitySchemes"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(openAPI, &doc); err != nil {
		t.Fatal("invalid OpenAPI YAML:", err)
	}
	if doc.OpenAPI != "3.1.0" {
		t.Fatalf("OpenAPI version=%q", doc.OpenAPI)
	}
	for path, methods := range map[string][]string{
		"/api/v1/auth/login": {"post"}, "/api/v1/auth/logout": {"post"}, "/api/v1/auth/me": {"get"},
		"/api/v1/templates": {"get"}, "/api/v1/profiles": {"get", "post"},
		"/api/v1/profiles/{id}":                                {"get", "patch", "delete"},
		"/api/v1/profiles/{id}/revisions":                      {"get"},
		"/api/v1/profiles/{id}/revisions/{revision}":           {"get"},
		"/api/v1/profiles/{id}/revisions/{revision}/sensitive": {"get"},
		"/api/v1/traps":                                        {"get", "post"}, "/api/v1/traps/{id}/profile": {"put", "delete"},
		"/api/v1/traps/{id}/enrollment-token": {"post"}, "/agent/v1/enroll": {"post"},
	} {
		for _, method := range methods {
			if doc.Paths[path][method] == nil {
				t.Errorf("missing operation %s %s", method, path)
			}
		}
	}
	for schema, fields := range map[string][]string{
		"ProfileConfig":       {"level", "services", "visible_texts", "synthetic_credentials", "logging", "channel"},
		"SyntheticCredential": {"username", "password"}, "DeploymentBinding": {"service_id", "host_port"},
		"ApiError": {"error"},
	} {
		for _, field := range fields {
			if doc.Components.Schemas[schema].Properties[field] == nil {
				t.Errorf("missing schema property %s.%s", schema, field)
			}
		}
	}
	for _, name := range []string{"operatorSession", "agentBearer"} {
		if doc.Components.SecuritySchemes[name] == nil {
			t.Errorf("missing security scheme %s", name)
		}
	}
}
