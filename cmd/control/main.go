package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"
	"honeyforge/internal/control"
	"honeyforge/migrations"
)

func main() {
	createUser := flag.Bool("create-user", false, "create a new operator account and exit")
	flag.Parse()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatal("database configuration is invalid")
	}
	defer db.Close()
	if err = db.Ping(ctx); err != nil {
		log.Fatal("database unavailable")
	}
	if err = migrations.Apply(ctx, db); err != nil {
		log.Fatalf("database migrations: %v", err)
	}
	if *createUser {
		if err = provisionUser(ctx, db); err != nil {
			log.Fatal(err)
		}
		return
	}
	addr := env("LISTEN_ADDR", "127.0.0.1:8081")
	origin := strings.TrimRight(env("PUBLIC_ORIGIN", "http://127.0.0.1:8081"), "/")
	parsedOrigin, err := url.Parse(origin)
	if err != nil || (parsedOrigin.Scheme != "http" && parsedOrigin.Scheme != "https") || parsedOrigin.Host == "" || parsedOrigin.User != nil || parsedOrigin.Path != "" || parsedOrigin.RawQuery != "" || parsedOrigin.Fragment != "" {
		log.Fatal("PUBLIC_ORIGIN must be an http(s) origin without path, query, or credentials")
	}
	secure, err := strconv.ParseBool(env("COOKIE_SECURE", "true"))
	if err != nil {
		log.Fatal("COOKIE_SECURE must be true or false")
	}
	ipHost, _, _ := net.SplitHostPort(parsedOrigin.Host)
	if ipHost == "" {
		ipHost = parsedOrigin.Host
	}
	ip := net.ParseIP(ipHost)
	loopback := ip != nil && ip.IsLoopback() || strings.EqualFold(ipHost, "localhost")
	if !secure && (parsedOrigin.Scheme != "http" || !loopback) {
		log.Fatal("COOKIE_SECURE=false is allowed only for loopback PUBLIC_ORIGIN")
	}
	server := &http.Server{Addr: addr, Handler: control.New(db, control.Config{PublicOrigin: origin, CookieSecure: secure}).Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	stopCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-stopCtx.Done()
		shutdownCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("HoneyForge Control API listening on %s", addr)
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
func provisionUser(ctx context.Context, db *pgxpool.Pool) error {
	username := strings.TrimSpace(os.Getenv("HF_USERNAME"))
	role := os.Getenv("HF_ROLE")
	password := os.Getenv("HF_PASSWORD")
	reader := bufio.NewReader(os.Stdin)
	if username == "" {
		fmt.Print("Username: ")
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		username = strings.TrimSpace(line)
	}
	if role == "" {
		fmt.Print("Role (operator/viewer) [operator]: ")
		line, _ := reader.ReadString('\n')
		role = strings.TrimSpace(line)
		if role == "" {
			role = "operator"
		}
	}
	if role != "operator" && role != "viewer" {
		return errors.New("HF_ROLE must be operator or viewer")
	}
	if password == "" {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return errors.New("set HF_PASSWORD or run interactively to enter it securely")
		}
		fmt.Print("Password (min 12 characters): ")
		secret, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}
		password = string(secret)
	}
	if username == "" || len(username) > 120 {
		return errors.New("username must contain 1 to 120 characters")
	}
	if len(password) < 12 || len(password) > 72 {
		return errors.New("password must contain 12 to 72 bytes")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES(gen_random_uuid(),$1,$2,$3)`, username, string(hash), role)
	if err != nil {
		return fmt.Errorf("create user (existing usernames are not reset): %w", err)
	}
	fmt.Printf("Created %s user %q\n", role, username)
	return nil
}
func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
