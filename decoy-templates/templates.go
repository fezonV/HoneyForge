package decoytemplates

import (
	"embed"
	"html/template"
	"io"
)

//go:embed archive.html archive.css
var assets embed.FS

var page = template.Must(template.ParseFS(assets, "archive.html"))

type Document struct {
	Path, URL string
	Size      int
}

type View struct {
	Title, Service, Banner, Prompt, Message string
	State, Path, Body, Output, DownloadURL  string
	SignedIn                                bool
	Documents                               []Document
}

func Render(w io.Writer, view View) error { return page.Execute(w, view) }

func Stylesheet() []byte {
	data, _ := assets.ReadFile("archive.css")
	return data
}
