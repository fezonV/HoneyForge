package control

import (
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/oschwald/geoip2-golang"
)

type SourceGeo struct {
	CountryCode *string
	CountryName *string
	ASN         *int64
	ASNOrg      *string
	Source      *string
	Version     *string
}

type GeoResolver interface {
	Lookup(net.IP) (SourceGeo, error)
}

type MaxMindGeoResolver struct {
	city    *geoip2.Reader
	asn     *geoip2.Reader
	source  string
	version string
}

func OpenMaxMindGeoResolver(cityPath, asnPath, source, version string) (*MaxMindGeoResolver, error) {
	cityPath, asnPath = strings.TrimSpace(cityPath), strings.TrimSpace(asnPath)
	if cityPath == "" && asnPath == "" {
		return nil, nil
	}
	if source == "" || version == "" {
		return nil, errors.New("GEOIP_SOURCE and GEOIP_VERSION are required when a local GeoIP database is configured")
	}
	resolver := &MaxMindGeoResolver{source: source, version: version}
	if cityPath != "" {
		reader, err := geoip2.Open(cityPath)
		if err != nil {
			return nil, fmt.Errorf("open GeoIP city database: %w", err)
		}
		resolver.city = reader
	}
	if asnPath != "" {
		reader, err := geoip2.Open(asnPath)
		if err != nil {
			resolver.Close()
			return nil, fmt.Errorf("open GeoIP ASN database: %w", err)
		}
		resolver.asn = reader
	}
	return resolver, nil
}

func (g *MaxMindGeoResolver) Lookup(ip net.IP) (SourceGeo, error) {
	var result SourceGeo
	if g == nil || !isPublicGeoIP(ip) {
		return result, nil
	}
	source, version := g.source, g.version
	result.Source, result.Version = &source, &version
	var firstErr error
	if g.city != nil {
		record, err := g.city.City(ip)
		if err != nil {
			firstErr = err
		} else {
			if record.Country.IsoCode != "" {
				country := record.Country.IsoCode
				result.CountryCode = &country
			}
			if name := record.Country.Names["en"]; name != "" {
				result.CountryName = &name
			}
		}
	}
	if g.asn != nil {
		record, err := g.asn.ASN(ip)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
		} else {
			if record.AutonomousSystemNumber != 0 {
				asn := int64(record.AutonomousSystemNumber)
				result.ASN = &asn
			}
			if record.AutonomousSystemOrganization != "" {
				org := record.AutonomousSystemOrganization
				result.ASNOrg = &org
			}
		}
	}
	return result, firstErr
}

func (g *MaxMindGeoResolver) Close() {
	if g == nil {
		return
	}
	if g.city != nil {
		_ = g.city.Close()
	}
	if g.asn != nil {
		_ = g.asn.Close()
	}
}

func isPublicGeoIP(ip net.IP) bool {
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsUnspecified() && !ip.IsMulticast()
}
