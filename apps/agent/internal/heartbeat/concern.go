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
	"time"

	"github.com/TakashiAihara/ccx/packages/core/config"
)

// Register is the one line a channel sends after connecting.
type Register struct {
	Session string `json:"session"`
}

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
// with the terminator). Over it, bind fails with a bare "invalid argument".
const maxUnixPath = 104

func (c *Concern) Run(ctx context.Context) error {
	if len(c.socketPath) > maxUnixPath {
		return fmt.Errorf("channel socket path is %d bytes, over the %d-byte unix-socket limit: %s\nset CCX_CHANNEL_SOCKET to a shorter path",
			len(c.socketPath), maxUnixPath, c.socketPath)
	}
	if err := os.MkdirAll(filepath.Dir(c.socketPath), 0o700); err != nil {
		return err
	}
	// ponytail: a leftover socket is removed without a lock. One serve per user
	// (systemd); take collect's lock if two ever race here.
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
	if err != nil || json.Unmarshal(line, &reg) != nil || reg.Session == "" {
		c.log("heartbeat: a channel connected without registering a session")
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	// The channel never sends again; a read returning is the session going away.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _, _ = r.ReadByte(); cancel() }()

	out := json.NewEncoder(conn)
	h := &Heartbeat{
		SessionID: reg.Session, ClaudeHome: c.claudeHome,
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
