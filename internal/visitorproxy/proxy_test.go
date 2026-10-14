package visitorproxy

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestRelaysBidirectionallyAndPreservesHalfClose(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		conn, err := upstream.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		request, _ := io.ReadAll(conn)
		_, _ = conn.Write(append([]byte("reply:"), request...))
	}()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- Serve(listener, upstream.Addr().String()) }()
	defer func() { listener.Close(); <-done }()
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = conn.Write([]byte("visitor payload"))
	_ = conn.(*net.TCPConn).CloseWrite()
	response, err := io.ReadAll(conn)
	if err != nil || string(response) != "reply:visitor payload" {
		t.Fatalf("response=%q err=%v", response, err)
	}
}
