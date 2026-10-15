package decoy

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestArchivePagesUseServerSessionsAndAppliedContent(t *testing.T) {
	cfg := testConfig("medium")
	cfg.Config.VisibleTexts.Title = `<script>alert('title')</script>`
	cfg.Config.FakeFS[0].Content = "Отчёт — <script>alert('file')</script>"
	sink := &memorySink{}
	s, err := New(cfg, sink)
	if err != nil {
		t.Fatal(err)
	}
	s.SetRunning(true)
	request := func(path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		method := http.MethodGet
		if body != "" {
			method = http.MethodPost
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Accept", "text/html")
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		s.PublicHandler("web").ServeHTTP(w, r)
		return w
	}
	loginPage := request("/login", "", nil)
	if loginPage.Code != 200 || !strings.Contains(loginPage.Body.String(), `action="/login"`) || strings.Contains(loginPage.Body.String(), "<script>") || strings.Contains(loginPage.Body.String(), "disabled") {
		t.Fatalf("unsafe or inert login page: %s", loginPage.Body.String())
	}
	if w := request("/files", "", nil); w.Code != 401 || !strings.Contains(w.Body.String(), `action="/login"`) || strings.Contains(w.Body.String(), "reports/summary.txt") {
		t.Fatalf("anonymous files: %d %s", w.Code, w.Body.String())
	}
	if w := request("/login", "username=demo&password=wrong", nil); w.Code != 401 || !strings.Contains(w.Body.String(), "Denied") || !strings.Contains(w.Body.String(), `action="/login"`) {
		t.Fatalf("login error page: %d %s", w.Code, w.Body.String())
	}
	login := request("/login", "username=demo&password=synthetic-secret", nil)
	if login.Code != 303 {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	if w := request("/files", "", cookie); w.Code != 200 || !strings.Contains(w.Body.String(), "view=1") || !strings.Contains(w.Body.String(), `action="/logout"`) {
		t.Fatalf("catalog: %d %s", w.Code, w.Body.String())
	}
	if w := request("/files?path=reports%2Fsummary.txt&view=1", "", cookie); w.Code != 200 || !strings.Contains(w.Body.String(), "download=1") || strings.Contains(w.Body.String(), "<script>") || !strings.Contains(w.Body.String(), "&lt;script&gt;") {
		t.Fatalf("file view: %d %s", w.Code, w.Body.String())
	} else if !strings.Contains(w.Body.String(), fmt.Sprintf("TXT · %d Б", len(cfg.Config.FakeFS[0].Content))) {
		t.Fatal("file view size does not match the UTF-8 download bytes")
	}
	if w := request("/files?path=reports%2Fsummary.txt&download=1", "", cookie); w.Code != 200 || w.Body.String() != cfg.Config.FakeFS[0].Content || !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("download: %d %s", w.Code, w.Body.String())
	}
	if w := request("/console", "command=cat+reports%2Fsummary.txt", cookie); w.Code != 200 || strings.Contains(w.Body.String(), "<script>") || !strings.Contains(w.Body.String(), "&lt;script&gt;") {
		t.Fatalf("console: %d %s", w.Code, w.Body.String())
	}
	if w := request("/console", "command=cat+%2Fetc%2Fpasswd", cookie); w.Code != 200 || !strings.Contains(w.Body.String(), "file not found") {
		t.Fatalf("console traversal: %d %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/files?path=..%2F..%2Fetc%2Fpasswd&view=1", "/missing"} {
		if w := request(path, "", cookie); w.Code != 404 || !strings.Contains(w.Body.String(), "Документ не найден") {
			t.Fatalf("missing: %d %s", w.Code, w.Body.String())
		}
	}
	s.mu.Lock()
	item := s.sessions[cookie.Value]
	item.expires = time.Now().Add(-time.Second)
	s.sessions[cookie.Value] = item
	s.mu.Unlock()
	if w := request("/files", "", cookie); w.Code != 401 || !strings.Contains(w.Body.String(), "Срок сессии истёк") {
		t.Fatalf("expired: %d %s", w.Code, w.Body.String())
	}
	login = request("/login", "username=demo&password=synthetic-secret", nil)
	cookie = login.Result().Cookies()[0]
	if w := request("/logout", "submit=1", cookie); w.Code != 303 {
		t.Fatalf("logout: %d", w.Code)
	}
	if w := request("/files", "", cookie); w.Code != 401 {
		t.Fatalf("session survived logout: %d", w.Code)
	}
	s.SetRunning(false)
	if w := request("/", "", nil); w.Code != 503 || !strings.Contains(w.Body.String(), "Сервис временно недоступен") {
		t.Fatalf("stop: %d %s", w.Code, w.Body.String())
	}
}

func TestLowArchivePagesNeverServeSyntheticFileBodies(t *testing.T) {
	s, err := New(testConfig("low"), &memorySink{})
	if err != nil {
		t.Fatal(err)
	}
	s.SetRunning(true)
	for _, tc := range []struct {
		path, text string
		status     int
	}{{"/", "reports/summary.txt", 200}, {"/files?path=reports%2Fsummary.txt&view=1", "Материал недоступен", 403}, {"/assets/archive.css", ".archive-header", 200}} {
		r := httptest.NewRequest("GET", tc.path, nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		s.PublicHandler("web").ServeHTTP(w, r)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.text) || strings.Contains(w.Body.String(), "synthetic report") {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		if w.Header().Get("Content-Security-Policy") == "" {
			t.Fatal("missing CSP")
		}
	}
}
