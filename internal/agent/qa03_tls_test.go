package agent

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Exercise the real client verifier with trusted but expired/wrong-host certs.
func TestQA03TLSValidityAndHostname(t *testing.T) {
	for _, mode := range []string{"valid", "expired", "wrong-host"} {
		t.Run(mode, func(t *testing.T) {
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "lab"},
				NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
				IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
				ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
			if mode == "expired" {
				cert.NotBefore = time.Now().Add(-2 * time.Hour)
				cert.NotAfter = time.Now().Add(-time.Hour)
			}
			if mode == "wrong-host" {
				cert.IPAddresses = nil
				cert.DNSNames = []string{"wrong.example"}
			}
			der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
			server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
			server.StartTLS()
			defer server.Close()
			ca := filepath.Join(t.TempDir(), "ca.pem")
			if err = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
				t.Fatal(err)
			}
			client, err := NewClientWithCA(server.URL, ca)
			if err != nil {
				t.Fatal(err)
			}
			response, err := client.http.Get(server.URL)
			if response != nil {
				response.Body.Close()
			}
			if mode == "valid" && err != nil {
				t.Fatalf("valid TLS rejected: %v", err)
			}
			if mode != "valid" && err == nil {
				t.Fatalf("%s certificate accepted", mode)
			}
		})
	}
}
