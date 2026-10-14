package control

import (
	"net"
	"testing"
)

func TestOpenMaxMindGeoResolverCanBeDisabled(t *testing.T) {
	resolver, err := OpenMaxMindGeoResolver("", "", "", "")
	if err != nil || resolver != nil {
		t.Fatalf("disabled resolver=%v err=%v", resolver, err)
	}
}

func TestOpenMaxMindGeoResolverRequiresPinnedMetadata(t *testing.T) {
	if _, err := OpenMaxMindGeoResolver("city.mmdb", "", "", ""); err == nil {
		t.Fatal("configured local database without source/version metadata was accepted")
	}
}

func TestGeoIPSkipsPrivateAndNonRoutableAddresses(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "192.168.1.20", "169.254.1.1", "::1", "fd00::1", "fe80::1", "224.0.0.1"} {
		if isPublicGeoIP(net.ParseIP(address)) {
			t.Errorf("classified %s as public", address)
		}
	}
	for _, address := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !isPublicGeoIP(net.ParseIP(address)) {
			t.Errorf("classified %s as non-public", address)
		}
	}
}

func TestGeoResolverReturnsUnknownForPrivateAddress(t *testing.T) {
	resolver := &MaxMindGeoResolver{source: "test", version: "v1"}
	geo, err := resolver.Lookup(net.ParseIP("10.1.2.3"))
	if err != nil || geo.CountryCode != nil || geo.CountryName != nil || geo.ASN != nil || geo.ASNOrg != nil || geo.Source != nil || geo.Version != nil {
		t.Fatalf("private address enrichment=%+v err=%v", geo, err)
	}
}
