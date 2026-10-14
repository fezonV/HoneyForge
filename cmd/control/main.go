commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/cmd/control/main.go b/cmd/control/main.go
index 3316e3b..9ac88bf 100644
--- a/cmd/control/main.go
+++ b/cmd/control/main.go
@@ -24,6 +24,8 @@ import (
 	"honeyforge/migrations"
 )
 
+var buildRevision = "unknown"
+
 func main() {
 	createUser := flag.Bool("create-user", false, "create a new operator account and exit")
 	flag.Parse()
@@ -77,7 +79,14 @@ func main() {
 	if !secure && (parsedOrigin.Scheme != "http" || !loopback) {
 		log.Fatal("COOKIE_SECURE=false is allowed only for loopback PUBLIC_ORIGIN")
 	}
-	server := &http.Server{Addr: addr, Handler: control.New(db, control.Config{PublicOrigin: origin, CookieSecure: secure, GeoResolver: geoResolver}).Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
+	server := &http.Server{Addr: addr, Handler: control.New(db, control.Config{
+		PublicOrigin:           origin,
+		CookieSecure:           secure,
+		GeoResolver:            geoResolver,
+		AgentOrigin:            env("AGENT_ORIGIN", ""),
+		BundleSourceRepository: env("HF_BUNDLE_SOURCE_REPOSITORY", "https://github.com/fezonV/HoneyForge.git"),
+		BundleSourceRevision:   env("HF_SOURCE_REVISION", buildRevision),
+	}).Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
 	stopCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
 	defer stop()
 	go func() {
