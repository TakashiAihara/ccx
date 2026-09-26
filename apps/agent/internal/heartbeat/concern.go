// Package heartbeat is the ccx-agent concern that keeps idle sessions' prompt
// caches warm (docs/design/heartbeat.md). Each session's `ccx-agent channel`
// registers on the channel socket; this concern decides from the session's own
// transcript when a heartbeat is due and sends it down that connection.
package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/TakashiAihara/ccx/packages/core/config"
)

// Register is the one line a channel sends after connecting.
type Register struct {
	Session string `json:"session"`
	// ClaudeHome is the session's CLAUDE_CONFIG_DIR, when it set one. serve runs
	// under systemd with its own environment and would look in ~/.claude.
	ClaudeHome string `json:"claudeHome,omitempty"`
}

// sessionID is the shape Claude Code gives a session. Anything else is refused:
// the id becomes a path and a glob.
var sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Event is one line serve sends a channel: push this into the session.
type Event struct {
	Content string            `json:"content"`
	Meta    map[string]string `json:"meta"`
}

// Beat is the heartbeat event. `kind` is what Marker matches in the transcript.
var Beat = Event{Content: "heartbeat", Meta: map[string]string{"kind": "heartbeat"}}

// Concern serves the channel socket.
type Concern struct {
	socketPath string
	claudeHome string
	cfg        config.Heartbeat
	log        func(string, ...any)

	mu         sync.Mutex
	registered map[string]*Heartbeat // session id -> its running heartbeat
}

// Status is one session's heartbeat as the agent sees it (kaneo ccx#34).
type Status struct {
	Wanted     bool
	Registered bool
	Stats
}

// Status answers for a session whether or not its channel is connected: an
// unconnected one still has a declaration, it just has no way to be beaten.
// home is the session's CLAUDE_CONFIG_DIR as the asker knows it; a connected
// session's own registration wins, as it does for the beats themselves.
func (c *Concern) Status(session, home string) Status {
	c.mu.Lock()
	h := c.registered[session]
	c.mu.Unlock()
	if h != nil {
		return Status{Wanted: h.wanted(), Registered: true, Stats: h.Stats()}
	}
	if home == "" || !filepath.IsAbs(home) {
		home = c.claudeHome
	}
	probe := &Heartbeat{SessionID: session, ClaudeHome: home, Default: c.cfg.Default}
	return Status{Wanted: probe.wanted()}
}

func New(cfg config.Config, log func(string, ...any)) *Concern {
	home := os.Getenv("CLAUDE_CONFIG_DIR")
	if home == "" {
		h, _ := os.UserHomeDir()
		home = filepath.Join(h, ".claude")
	}
	return &Concern{socketPath: cfg.ChannelSocketPath, claudeHome: home, cfg: cfg.Heartbeat, log: log}
}

func (c *Concern) Name() string { return "heartbeat" }

// maxUnixPath is the unix socket path limit (108 on Linux, 104 on the BSDs,
// with the terminator, so 103 usable there). At or over it, bind fails with a
// bare "invalid argument".
const maxUnixPath = 104

// Run never fails the process. The concern is on by default and inert for
// anyone without the channel, so a socket it cannot set up (a path too long, a
// second serve holding the lock) turns off the heartbeat alone, with the reason
// in the log; collect keeps running.
func (c *Concern) Run(ctx context.Context) error {
	if err := c.run(ctx); err != nil {
		c.log("heartbeat off: %v", err)
		<-ctx.Done()
	}
	return nil
}

func (c *Concern) run(ctx context.Context) error {
	if len(c.socketPath) >= maxUnixPath {
		return fmt.Errorf("channel socket path is %d bytes, over the %d-byte unix-socket limit: %s\nset CCX_CHANNEL_SOCKET to a shorter path",
			len(c.socketPath), maxUnixPath, c.socketPath)
	}
	if err := os.MkdirAll(filepath.Dir(c.socketPath), 0o700); err != nil {
		return err
	}
	// Held before the socket is touched: a second serve must not remove the
	// socket the running one is listening on (collect's lock does not cover
	// this; the concerns start at once, and collect may be off).
	lock, err := os.OpenFile(c.socketPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another ccx-agent serve holds %s.lock: %w", c.socketPath, err)
	}
	// Under the lock, a socket left here is from a serve that died.
	if err := os.Remove(c.socketPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	ln, err := net.Listen("unix", c.socketPath)
	if err != nil {
		return err
	}
	defer os.Remove(c.socketPath)
	if err := os.Chmod(c.socketPath, 0o600); err != nil {
		ln.Close()
		return err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	c.accept(ctx, ln, acceptRetry)
	return nil
}

// acceptRetry is the pause after a failed Accept. Giving up would leave the
// socket in place with nobody accepting, so every session that connects later
// (a new one, or one reconnecting after a restart) would be silently unserved;
// errors like EMFILE pass.
const acceptRetry = time.Second

func (c *Concern) accept(ctx context.Context, ln net.Listener, retry time.Duration) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log("heartbeat: accept: %v (retrying)", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(retry):
			}
			continue
		}
		go c.serve(ctx, conn)
	}
}

// serve runs one session's heartbeat for as long as its channel stays connected.
func (c *Concern) serve(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := r.ReadBytes('\n')
	var reg Register
	if err != nil || json.Unmarshal(line, &reg) != nil || !sessionID.MatchString(reg.Session) {
		c.log("heartbeat: a channel connected without registering a session id")
		return
	}
	home := c.claudeHome
	if reg.ClaudeHome != "" && filepath.IsAbs(reg.ClaudeHome) {
		home = reg.ClaudeHome
	}
	_ = conn.SetReadDeadline(time.Time{})

	// The channel never sends again; a read returning is the session going away.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _, _ = r.ReadByte(); cancel() }()

	out := json.NewEncoder(conn)
	h := &Heartbeat{
		SessionID: reg.Session, ClaudeHome: home,
		Interval: c.cfg.Interval, MaxIdle: c.cfg.MaxIdle, Default: c.cfg.Default,
		Push: func() error {
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			return out.Encode(Beat)
		},
		Log: c.log,
		Now: time.Now,
		Sleep: func(ctx context.Context, d time.Duration) {
			select {
			case <-ctx.Done():
			case <-time.After(d):
			}
		},
	}
	c.mu.Lock()
	if c.registered == nil {
		c.registered = map[string]*Heartbeat{}
	}
	c.registered[reg.Session] = h
	c.mu.Unlock()
	defer func() {
		// A reconnect can register the same session before this one winds down;
		// only remove the entry that is still ours.
		c.mu.Lock()
		if c.registered[reg.Session] == h {
			delete(c.registered, reg.Session)
		}
		c.mu.Unlock()
	}()
	h.Run(ctx)
}
