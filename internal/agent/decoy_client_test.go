package agent

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPDecoyAdapterApplyConfigurationRequiresMatchingAcknowledgement(t *testing.T) {
	want := ConfigResponse{TrapID: "11111111-1111-4111-8111-111111111111", ProfileID: "22222222-2222-4222-8222-222222222222", Revision: 7}
	tests := []struct {
		name, body string
		status     int
		wantErr    bool
	}{
		{name: "matching acknowledgement", body: fmt.Sprintf(`{"trap_id":%q,"profile_id":%q,"revision":7}`, want.TrapID, want.ProfileID), status: http.StatusOK},
		{name: "mismatched acknowledgement", body: fmt.Sprintf(`{"trap_id":%q,"profile_id":%q,"revision":6}`, want.TrapID, want.ProfileID), status: http.StatusOK, wantErr: true},
		{name: "server error", body: `conflict`, status: http.StatusConflict, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/internal/config" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test-token" {
					t.Fatalf("unexpected request %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
				}
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			adapter, err := NewHTTPDecoyAdapter(server.URL, "test-token")
			if err != nil {
				t.Fatal(err)
			}
			err = adapter.ApplyConfiguration(context.Background(), want)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ApplyConfiguration error=%v, wantErr=%v", err, tt.wantErr)
			}
		})
	}
}
