ALTER TABLE events
 ADD COLUMN source_country_code text,
 ADD COLUMN source_country_name text,
 ADD COLUMN source_asn bigint,
 ADD COLUMN source_asn_org text,
 ADD COLUMN geo_source text,
 ADD COLUMN geo_version text;

CREATE INDEX events_geo_source_time_idx ON events(source_country_code,occurred_at DESC,id) WHERE source_country_code IS NOT NULL;
