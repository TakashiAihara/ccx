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

func (c *Concern) Run(ctx context.Context) error {
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

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("accept: %w", err)
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
	h.Run(ctx)
}
