// Package visitorproxy relays visitor TCP connections to a fixed decoy port.
// It has no access to management IPC or credentials and accepts no destination
// from visitors. The decoy itself remains on internal Docker networks.
package visitorproxy

import (
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
				// Bound idle/abandoned connections independently of the visitor.
				deadline := time.Now().Add(5 * time.Minute)
				_ = incoming.SetDeadline(deadline)
				_ = upstream.SetDeadline(deadline)
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
