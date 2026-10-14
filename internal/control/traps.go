commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/internal/control/traps.go b/internal/control/traps.go
index 0132155..6ba6cf7 100644
--- a/internal/control/traps.go
+++ b/internal/control/traps.go
@@ -717,6 +717,7 @@ func (s *Server) agentEvents(w http.ResponseWriter, r *http.Request) {
 		var sourceGeo SourceGeo
 		if s.geo != nil && event.SourceIP != "" {
 			sourceGeo, _ = s.geo.Lookup(net.ParseIP(event.SourceIP))
+		}
 		var inserted bool
 		err = tx.QueryRow(ctx, `INSERT INTO events(id,schema_version,trap_id,agent_id,service_id,session_id,profile_id,applied_revision,event_type,occurred_at,source_ip,source_port,destination_port,protocol,payload,source_country_code,source_country_name,source_asn,source_asn_org,geo_source,geo_version)
 			VALUES($1,$2,$3,$4,$5,NULLIF($6,'')::uuid,NULLIF($7,'')::uuid,$8,$9,$10,NULLIF($11,'')::inet,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
