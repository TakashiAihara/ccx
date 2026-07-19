package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Server is the resident ccxd: it owns the socket hooks write to, the spool
// events wait in, and the loop that drains them to the center.
type Server struct {
	socketPath string
	spool      *Spool
	loop       *forwardLoop
	log        func(string, ...any)
}

// NewServer wires a server from a resolved spool and forwarder. A nil forwarder
// means "no center configured" — the server still accepts and spools; it just
// does not run the drain loop.
func NewServer(socketPath string, spool *Spool, forwarder Forwarder, log func(string, ...any)) *Server {
	s := &Server{socketPath: socketPath, spool: spool, log: log}
	if forwarder != nil {
		s.loop = newForwardLoop(spool, forwarder, log)
	}
	return s
}

// Run drains anything hooks left in incoming/ (from while ccxd was down), then
// serves the socket and runs the forward loop until ctx is cancelled. It blocks.
func (s *Server) Run(ctx context.Context) error {
	// Startup drain: events hooks wrote to the fallback while ccxd was down get
	// enveloped into the main queue now, before we start forwarding, so they go
	// out in front of anything that arrives after startup.
	if n, err := s.spool.DrainIncoming(); err != nil {
		s.log("startup drain error: %v", err)
	} else if n > 0 {
		s.log("drained %d event(s) from the fallback spool on startup", n)
	}

	ln, err := s.listen()
	if err != nil {
		return err
	}
	defer ln.Close()
	defer os.Remove(s.socketPath)

	var wg sync.WaitGroup

	if s.loop != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.loop.run(ctx)
		}()
	} else {
		s.log("no center configured — spooling only, not forwarding")
	}

	// Close the listener when ctx is cancelled so Accept returns.
	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	s.acceptLoop(ctx, ln)
	wg.Wait()
	return nil
}

// maxUnixPath is the practical limit on a unix socket path. The kernel's
// sockaddr_un.sun_path is 108 bytes on Linux (104 on the BSDs) including the
// null terminator; over that, bind fails with a cryptic "invalid argument".
const maxUnixPath = 104

// listen binds the unix socket, refusing to start if another ccxd already owns
// it and clearing a stale socket left by a crashed one.
func (s *Server) listen() (net.Listener, error) {
	// Fail early with a message that says what to do, instead of letting the
	// kernel return "bind: invalid argument" for a path that is merely too long
	// (a deep $HOME or $XDG_RUNTIME_DIR reaches this).
	if len(s.socketPath) > maxUnixPath {
		return nil, fmt.Errorf(
			"socket path is %d bytes, over the %d-byte unix-socket limit: %s\nset CCX_SOCKET to a shorter path",
			len(s.socketPath), maxUnixPath, s.socketPath)
	}

	if err := os.MkdirAll(filepath.Dir(s.socketPath), 0o700); err != nil {
		return nil, err
	}

	// If something is already listening, do not clobber it — that would be a
	// second ccxd, and two daemons racing on one spool is not a state to enter
	// silently.
	if conn, err := net.DialTimeout("unix", s.socketPath, 200*time.Millisecond); err == nil {
		conn.Close()
		return nil, errors.New("another ccxd is already listening on " + s.socketPath)
	}
	// Nothing answered — a leftover socket file from a crash is safe to remove.
	if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
		return nil, err
	}

	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return nil, err
	}
	// user-only: the socket lives in the user's runtime dir and only the user's
	// own hooks talk to it (#90 runs as the user).
	if err := os.Chmod(s.socketPath, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func (s *Server) acceptLoop(ctx context.Context, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			// ctx cancelled → the listener was closed on purpose.
			if ctx.Err() != nil {
				return
			}
			s.log("accept error: %v", err)
			return
		}
		go s.handle(conn)
	}
}

// handle receives one framed payload, spools it, and acks. It does not inspect
// the payload — it envelopes and stores the bytes. The producer is set from the
// fact that this arrived on the hook socket, not from anything inside the bytes.
func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(hookDialTimeout))

	payload, err := readFrame(conn)
	if err != nil {
		if err != io.EOF {
			s.log("read frame error: %v", err)
		}
		return
	}

	if _, err := s.spool.Append(payload); err != nil {
		// Could not durably store it. Do NOT ack — the hook will fall back to
		// incoming/, so the event is still not lost.
		s.log("spool append error: %v", err)
		return
	}

	// Durably spooled. Ack so the hook knows, and nudge the drain loop.
	if _, err := conn.Write([]byte{ackOK}); err != nil {
		s.log("ack write error: %v", err)
	}
	if s.loop != nil {
		s.loop.wake()
	}
}
