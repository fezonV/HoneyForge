package main

import (
	"embed"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

//go:embed archive.html dashboard.html
var pages embed.FS

type Event struct {
	Time   time.Time `json:"time"`
	IP     string    `json:"ip"`
	Method string    `json:"method"`
	Path   string    `json:"path"`
}

type eventLog struct {
	mu     sync.Mutex
	events []Event
}

func (l *eventLog) record(r *http.Request) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, Event{Time: time.Now().UTC(), IP: ip, Method: r.Method, Path: r.URL.Path})
	if len(l.events) > 100 {
		copy(l.events, l.events[len(l.events)-100:])
		l.events = l.events[:100]
	}
}

func (l *eventLog) snapshot() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	result := make([]Event, len(l.events))
	for i := range l.events {
		result[i] = l.events[len(l.events)-1-i]
	}
	return result
}

func newHandler() http.Handler {
	journal := &eventLog{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if err := json.NewEncoder(w).Encode(journal.snapshot()); err != nil {
			log.Printf("write events: %v", err)
		}
	})
	// Reserve management paths: they must never enter the decoy journal.
	mux.HandleFunc("/api/", http.NotFound)
	showDashboard := func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dashboard" && r.URL.Path != "/dashboard/" {
			http.NotFound(w, r)
			return
		}
		servePage(w, r, "dashboard.html")
	}
	mux.HandleFunc("/dashboard", showDashboard)
	mux.HandleFunc("/dashboard/", showDashboard)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		journal.record(r)
		servePage(w, r, "archive.html")
	})
	return mux
}

func servePage(w http.ResponseWriter, r *http.Request, name string) {
	page, err := pages.ReadFile(name)
	if err != nil {
		http.Error(w, "Page unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodHead {
		_, _ = w.Write(page)
	}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	flag.Parse()
	server := &http.Server{
		Addr: *addr, Handler: newHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("HoneyForge: http://%s/ | dashboard: http://%s/dashboard", *addr, *addr)
	log.Fatal(server.ListenAndServe())
}
