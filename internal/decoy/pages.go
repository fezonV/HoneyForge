package decoy

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"

	decoytemplates "honeyforge/decoy-templates"
)

func wantsHTML(r *http.Request) bool { return strings.Contains(r.Header.Get("Accept"), "text/html") }

func (s *Server) page(w http.ResponseWriter, r *http.Request, serviceID, state, message string, status int, signedIn bool, path, body, output string) {
	cfg := requestConfiguration(r)
	service := configuredService(cfg.Config.Services, serviceID)
	title := cfg.Config.VisibleTexts.Title
	if title == "" {
		title = service.Name
	}
	prompt := cfg.Config.VisibleTexts.LoginPrompt
	if prompt == "" {
		prompt = "Вход в архив"
	}
	view := decoytemplates.View{Title: title, Service: service.Name, Banner: service.Banner, Prompt: prompt,
		State: state, Message: message, SignedIn: signedIn,
		Path: path, Body: body, Output: output}
	if state == "file" {
		view.DownloadURL = "/files?" + url.Values{"path": {path}, "download": {"1"}}.Encode()
	}
	for _, file := range cfg.Config.FakeFS {
		query := url.Values{"path": {file.Path}, "view": {"1"}}
		view.Documents = append(view.Documents, decoytemplates.Document{Path: file.Path,
			URL: "/files?" + query.Encode(), Size: len(file.Content)})
	}
	var buf bytes.Buffer
	if err := decoytemplates.Render(&buf, view); err != nil {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) requireVisitor(w http.ResponseWriter, r *http.Request, serviceID string) (string, bool) {
	sid, ok, err := s.authenticated(r, serviceID)
	if err != nil {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	if !ok {
		if wantsHTML(r) && requestConfiguration(r).Config.Level == "medium" {
			message := "Для продолжения требуется вход в архив."
			if _, err := r.Cookie("archive_session"); err == nil {
				message = "Срок сессии истёк. Для продолжения требуется повторный вход."
			}
			s.page(w, r, serviceID, "login", message, http.StatusUnauthorized, false, "", "", "")
		} else {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
		return "", false
	}
	return sid, true
}
