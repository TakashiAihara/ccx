package collect

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/TakashiAihara/ccx/packages/core/config"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// Collect is ccxd's collect concern (ADR 0002): hooks → center. It owns the
// socket hooks write to, the spool events wait in, and the loop that drains them
// to the center. It is one module behind the Concern interface — the seam both
// for the config on/off toggle and for a future extraction to its own process.
//
// It satisfies the concern.Concern interface structurally (Name + Run); it does
// not import that package, to keep the dependency pointing one way (main wires
// concerns; concerns do not know about the runner).
type Collect struct {
	socketPath string
	spool      *Spool
	loop       *forwardLoop
	log        func(string, ...any)
}

// New builds the collect concern from resolved config. The center may be unset
// (HubURL == ""), in which case Collect still accepts and spools hook events; it
// just has nowhere to forward them yet. The local side never depends on the
// center (scope.md).
func New(cfg config.Config, log func(string, ...any)) (*Collect, error) {
	origin := &ccxv1.Origin{Machine: cfg.Machine, User: cfg.User}
	spool, err := OpenSpool(cfg.SpoolDir, origin)
	if err != nil {
		return nil, err
	}
	return newCollect(cfg.SocketPath, spool, NewForwarder(cfg.HubURL), log), nil
}

// newCollect is the lower-level constructor with the spool and forwarder
// injected, so tests can drive collect against a stub center and a temp spool.
func newCollect(socketPath string, spool *Spool, forwarder Forwarder, log func(string, ...any)) *Collect {
	c := &Collect{socketPath: socketPath, spool: spool, log: log}
	if forwarder != nil {
		c.loop = newForwardLoop(spool, forwarder, log)
	}
	return c
}

// Name identifies the concern in logs and config (ADR 0002).
func (s *Collect) Name() string { return "collect" }

// Run drains anything hooks left in incoming/ (from while ccxd was down), then
// serves the socket and runs the forward loop until ctx is cancelled. It blocks.
func (s *Collect) Run(ctx context.Context) error {
	// Startup drain: events hooks wrote to the fallback while ccxd was down get
	// enveloped into the main queue now, before we start forwarding, so they go
	// out in front of anything that arrives after startup.
	if n, err := s.spool.DrainIncoming(); err != nil {
		s.log("startup drain error: %v", err)
	} else if n > 0 {
		s.log("drained %d event(s) from the fallback spool on startup", n)
	}

	// One ccxd per spool. Held for the whole run; the kernel frees it on exit.
	lock, err := acquireLock(s.spool.Dir())
	if err != nil {
		return err
	}
	defer lock.release()

	ln, err := s.listen()
	if err != nil {
		return err
	}
	defer ln.Close()
	defer os.Remove(s.socketPath)

	// A fatal accept error must wind the whole concern down, not silently stop
	// accepting while the forward loop keeps the process alive — that would leave
	// a dead listener behind whose socket file still exists, so every hook would
	// connect, get no ack, and stall for the full deadline, forever, with nothing
	// surfaced. Cancelling on the error lets Run return it; concern.Run then
	// stops the process and systemd restarts it.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

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

	acceptErr := s.acceptLoop(ctx, ln)
	cancel() // stop the forward loop too — one process, one lifecycle
	wg.Wait()
	return acceptErr
}

// maxUnixPath is the practical limit on a unix socket path. The kernel's
// sockaddr_un.sun_path is 108 bytes on Linux (104 on the BSDs) including the
// null terminator; over that, bind fails with a cryptic "invalid argument".
const maxUnixPath = 104

// listen binds the unix socket, refusing to start if another ccxd already owns
// it and clearing a stale socket left by a crashed one.
func (s *Collect) listen() (net.Listener, error) {
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

	// We hold the single-instance lock by the time we get here, so any socket
	// file present is a stale leftover from a crashed ccxd — no live daemon can
	// own it. Safe to remove unconditionally; there is no live socket to clobber.
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

func (s *Collect) acceptLoop(ctx context.Context, ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			// ctx cancelled → the listener was closed on purpose; a clean stop.
			if ctx.Err() != nil {
				return nil
			}
			// An unexpected accept error is fatal to the concern — return it so
			// Run tears down and the process restarts, rather than looping into a
			// dead-listener state.
			return fmt.Errorf("accept: %w", err)
		}
		go s.handle(conn)
	}
}

// handle receives one framed payload, spools it, and acks. It does not inspect
// the payload — it envelopes and stores the bytes. The producer is set from the
// fact that this arrived on the hook socket, not from anything inside the bytes.
func (s *Collect) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(hookExchangeTimeout))

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
