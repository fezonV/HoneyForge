package visitorproxy

import (
	"bufio"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestProxySourceValidation(t *testing.T) {
	for _, input := range []string{
		"GET / HTTP/1.1\r\n", "PROXY UNKNOWN\r\n",
		"PROXY TCP4 ::1 127.0.0.1 123 80\r\n",
		"PROXY TCP4 192.0.2.1 127.0.0.1 0 80\r\n",
		"PROXY TCP4 192.0.2.1 127.0.0.1 123 70000\r\n",
		strings.Repeat("x", 200) + "\r\n",
	} {
		if _, err := readSource(bufio.NewReaderSize(strings.NewReader(input), 128)); err == nil {
			t.Fatalf("accepted invalid header %q", input)
		}
	}
}

func TestPrivateListenerPreservesVisitorAddressAndBufferedPayload(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, _ = io.WriteString(client, "PROXY TCP4 198.51.100.23 192.0.2.1 12345 80\r\npayload")
	conn, err := (Listener{Listener: listener}).Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	data := make([]byte, 7)
	_, err = io.ReadFull(conn, data)
	if err != nil || string(data) != "payload" || conn.RemoteAddr().String() != "198.51.100.23:12345" {
		t.Fatalf("payload=%q source=%s err=%v", data, conn.RemoteAddr(), err)
	}
}

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
		wrapped := bufio.NewReader(conn)
		source, err := readSource(wrapped)
		if err != nil || source.String() == "" {
			return
		}
		request, _ := io.ReadAll(wrapped)
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
