// Package visitorproxy relays visitor TCP connections to a fixed decoy port.
// It has no access to management IPC or credentials and accepts no destination
// from visitors. The decoy itself remains on internal Docker networks.
package visitorproxy

import (
	"fmt"
	"io"
	"net"
	"time"
)

func Serve(listener net.Listener, target string) error {
	slots := make(chan struct{}, 128)
	for {
		incoming, err := listener.Accept()
		if err != nil {
			return err
		}
		select {
		case slots <- struct{}{}:
			go func() {
				defer func() { <-slots }()
				defer incoming.Close()
				upstream, err := net.DialTimeout("tcp", target, 5*time.Second)
				if err != nil {
					return
				}
				defer upstream.Close()
				// Bound connection lifetime independently of the visitor.
				deadline := time.Now().Add(5 * time.Minute)
				_ = incoming.SetDeadline(deadline)
				_ = upstream.SetDeadline(deadline)
				source := incoming.RemoteAddr().(*net.TCPAddr)
				destination := incoming.LocalAddr().(*net.TCPAddr)
				family := "TCP6"
				if source.IP.To4() != nil {
					family = "TCP4"
				}
				if _, err := fmt.Fprintf(upstream, "PROXY %s %s %s %d %d\r\n", family, source.IP, destination.IP, source.Port, destination.Port); err != nil {
					return
				}
				done := make(chan struct{})
				go func() {
					_, _ = io.Copy(upstream, incoming)
					if tcp, ok := upstream.(*net.TCPConn); ok {
						_ = tcp.CloseWrite()
					}
					close(done)
				}()
				_, _ = io.Copy(incoming, upstream)
				_ = incoming.Close()
				<-done
			}()
		default:
			_ = incoming.Close()
		}
	}
}
