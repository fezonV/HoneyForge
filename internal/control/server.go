commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/internal/control/server.go b/internal/control/server.go
index 6dd3a47..6e4f921 100644
--- a/internal/control/server.go
+++ b/internal/control/server.go
@@ -27,18 +27,24 @@ import (
 )
 
 type Config struct {
-	PublicOrigin string
-	CookieSecure bool
-	GeoResolver  GeoResolver
+	PublicOrigin           string
+	CookieSecure           bool
+	GeoResolver            GeoResolver
+	AgentOrigin            string
+	BundleSourceRepository string
+	BundleSourceRevision   string
 }
 type Server struct {
-	db     *pgxpool.Pool
-	origin string
-	secure bool
-	geo    GeoResolver
-	ws     *wsHub
-	mu     sync.Mutex
-	logins map[string][]time.Time
+	db             *pgxpool.Pool
+	origin         string
+	agentOrigin    string
+	bundleSource   string
+	bundleRevision string
+	secure         bool
+	geo            GeoResolver
+	ws             *wsHub
+	mu             sync.Mutex
+	logins         map[string][]time.Time
 }
 type ctxKey string
 
@@ -63,7 +69,7 @@ type apiFailure struct {
 }
 
 func New(db *pgxpool.Pool, cfg Config) *Server {
-	return &Server{db: db, origin: strings.TrimRight(cfg.PublicOrigin, "/"), secure: cfg.CookieSecure, geo: cfg.GeoResolver, ws: newWSHub(), logins: map[string][]time.Time{}}
+	return &Server{db: db, origin: strings.TrimRight(cfg.PublicOrigin, "/"), agentOrigin: strings.TrimRight(cfg.AgentOrigin, "/"), bundleSource: cfg.BundleSourceRepository, bundleRevision: cfg.BundleSourceRevision, secure: cfg.CookieSecure, geo: cfg.GeoResolver, ws: newWSHub(), logins: map[string][]time.Time{}}
 }
 func (s *Server) Handler() http.Handler {
 	m := http.NewServeMux()
@@ -96,6 +102,7 @@ func (s *Server) Handler() http.Handler {
 	m.Handle("DELETE /api/v1/traps/{id}/profile", s.auth(true, "operator", http.HandlerFunc(s.detachProfile)))
 	m.Handle("DELETE /api/v1/traps/{id}", s.auth(true, "operator", http.HandlerFunc(s.deleteTrap)))
 	m.Handle("POST /api/v1/traps/{id}/enrollment-token", s.auth(true, "operator", http.HandlerFunc(s.createEnrollment)))
+	m.Handle("GET /api/v1/traps/{id}/bundle", s.auth(false, "operator", http.HandlerFunc(s.downloadTrapBundle)))
 	m.Handle("POST /api/v1/traps/{id}/commands", s.auth(true, "operator", http.HandlerFunc(s.queueCommand)))
 	m.Handle("GET /api/v1/traps/{id}/commands", s.auth(false, "", http.HandlerFunc(s.listCommands)))
 	m.Handle("GET /api/v1/events", s.auth(false, "", http.HandlerFunc(s.listEvents)))
