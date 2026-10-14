package main

import (
	"log"
	"net"
	"os"
	"strconv"

	"honeyforge/internal/visitorproxy"
)

func main() {
	if len(os.Args) < 2 || len(os.Args) > 33 {
		log.Fatal("expected 1–32 visitor TCP ports")
	}
	listeners := make(map[string]net.Listener)
	for _, raw := range os.Args[1:] {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			log.Fatal("invalid visitor TCP port")
		}
		key := strconv.Itoa(port)
		if _, exists := listeners[key]; exists {
			log.Fatal("duplicate visitor TCP port")
		}
		listener, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", key))
		if err != nil {
			log.Fatal(err)
		}
		listeners[key] = listener
	}
	errors := make(chan error, len(listeners))
	for port, listener := range listeners {
		go func() { errors <- visitorproxy.Serve(listener, net.JoinHostPort("decoy", port)) }()
	}
	log.Fatal(<-errors)
}
