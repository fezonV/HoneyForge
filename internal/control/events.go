commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/internal/control/events.go b/internal/control/events.go
index 367a1d6..ffb3ae7 100644
--- a/internal/control/events.go
+++ b/internal/control/events.go
@@ -56,7 +56,7 @@ func parseEventFilters(q url.Values) (eventFilters, *apiFailure) {
 	if filters.sessionID != "" && !contracts.ValidID(filters.sessionID) {
 		return filters, &apiFailure{status: 400, code: "invalid_filter", message: "session_id must be a UUID", fields: map[string]string{"session_id": "invalid UUID"}}
 	}
-	if filters.eventType != "" && (len(filters.eventType) > 128 || !validAgentEventType(filters.eventType)) {
+	if filters.eventType != "" && (len(filters.eventType) > 128 || !validTelemetryEventType(filters.eventType)) {
 		return filters, &apiFailure{status: 400, code: "invalid_filter", message: "event_type is unsupported", fields: map[string]string{"event_type": "unsupported"}}
 	}
 	if q.Get("source_ip") != "" {
