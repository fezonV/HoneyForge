package visitorproxy

import (
	"bufio"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

// Listener requires PROXY v1 from the fixed visitor gateway. Enable it only on
// the private decoy listener; never trust visitor HTTP headers for source IPs.
type Listener struct{ net.Listener }

type forwardedConn struct {
	net.Conn
	reader *bufio.Reader
	source net.Addr
}

func (c *forwardedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
func (c *forwardedConn) RemoteAddr() net.Addr       { return c.source }

func (l Listener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		reader := bufio.NewReaderSize(conn, 128)
		source, err := readSource(reader)
		_ = conn.SetReadDeadline(time.Time{})
		if err != nil {
			_ = conn.Close()
			continue
		}
		return &forwardedConn{Conn: conn, reader: reader, source: source}, nil
	}
}

func readSource(reader *bufio.Reader) (net.Addr, error) {
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return nil, err
	}
	if len(line) > 108 || !strings.HasSuffix(string(line), "\r\n") {
		return nil, errors.New("invalid PROXY header")
	}
	fields := strings.Split(strings.TrimSuffix(string(line), "\r\n"), " ")
	if len(fields) != 6 || fields[0] != "PROXY" || (fields[1] != "TCP4" && fields[1] != "TCP6") {
		return nil, errors.New("invalid PROXY header")
	}
	for _, raw := range fields[2:4] {
		ip := net.ParseIP(raw)
		if ip == nil || (fields[1] == "TCP4") != (ip.To4() != nil) {
			return nil, errors.New("invalid PROXY address")
		}
	}
	for _, raw := range fields[4:6] {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid PROXY port")
		}
	}
	port, _ := strconv.Atoi(fields[4])
	return &net.TCPAddr{IP: net.ParseIP(fields[2]), Port: port}, nil
}
