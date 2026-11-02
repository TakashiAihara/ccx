package channel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	"github.com/TakashiAihara/ccx/apps/agent/internal/testsock"
	"github.com/TakashiAihara/ccx/packages/core/config"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// Relay registers the session it was given and turns each event serve sends
// into a channel notification.
func TestRelayRegistersAndPushes(t *testing.T) {
	sock := testsock.Path(t, "ch.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	got := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, _ := bufio.NewReader(conn).ReadString('\n')
		got <- line
		_, _ = conn.Write([]byte(`{"content":"heartbeat","meta":{"kind":"heartbeat"}}` + "\n"))
		time.Sleep(time.Second)
	}()

	out := &syncBuf{}
	s := NewServer("ccx", "0", out)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { Relay(ctx, sock, "sid-1", "/custom/claude", s, t.Logf); close(done) }()
	// Wait for the relay to stop before the test ends: it logs through t.
	defer func() { cancel(); <-done }()

	select {
	case line := <-got:
		var reg map[string]string
		if json.Unmarshal([]byte(line), &reg) != nil || reg["session"] != "sid-1" || reg["claudeHome"] != "/custom/claude" {
			t.Errorf("registration = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay never registered")
	}

	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(out.String(), "notifications/claude/channel") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	var msg struct {
		Method string `json:"method"`
		Params struct {
			Content string            `json:"content"`
			Meta    map[string]string `json:"meta"`
		} `json:"params"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out.String())), &msg) != nil ||
		msg.Method != "notifications/claude/channel" || msg.Params.Meta["kind"] != "heartbeat" || msg.Params.Content != "heartbeat" {
		t.Errorf("pushed %q", out.String())
	}
}

// serve not there yet (not started, or restarted to apply config) is normal:
// the relay keeps trying and registers once it appears.
func TestRelayWaitsForServe(t *testing.T) {
	sock := testsock.Path(t, "ch.sock")
	s := NewServer("ccx", "0", &syncBuf{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { relay(ctx, sock, "sid-2", "", s, t.Logf, 50*time.Millisecond); close(done) }()
	defer func() { cancel(); <-done }()
	time.Sleep(200 * time.Millisecond)

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_ = ln.(*net.UnixListener).SetDeadline(time.Now().Add(2 * time.Second))
	conn, err := ln.Accept()
	if err != nil {
		t.Fatalf("relay never came back: %v", err)
	}
	defer conn.Close()
	line, _ := bufio.NewReader(conn).ReadString('\n')
	if !strings.Contains(line, `"sid-2"`) {
		t.Errorf("registration = %q", line)
	}
}

// A channel that was registered with one serve registers with the next one after
// a restart, through the real concern on both ends. The runtime dir is removed
// first, as in #196 (another unit with RuntimeDirectory=ccx stopped); the relay
// does not depend on it, and this test does not tell it apart from a plain restart.
func TestRelayRegistersAgainAfterServeRestarts(t *testing.T) {
	// heartbeat.New reads CLAUDE_CONFIG_DIR, else the real ~/.claude.
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	dir := filepath.Join(testsock.Dir(t), "ccx")
	sock := filepath.Join(dir, "ccx-channel.sock")
	cfg := config.Config{ChannelSocketPath: sock, Heartbeat: config.Heartbeat{Default: true, Interval: 50 * time.Minute}}
	const sid = "00000000-0000-4000-8000-000000000196"
	start := func() (*heartbeat.Concern, func()) {
		c := heartbeat.New(cfg, t.Logf)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { _ = c.Run(ctx); close(done) }()
		return c, func() { cancel(); <-done }
	}
	waitRegistered := func(c *heartbeat.Concern, what string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for !c.Status(sid, "").Registered {
			if time.Now().After(deadline) {
				t.Fatalf("%s: the channel never registered", what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	old, stopOld := start()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		relay(ctx, sock, sid, "", NewServer("ccx", "0", &syncBuf{}), t.Logf, 50*time.Millisecond)
		close(done)
	}()
	defer func() { cancel(); <-done }()
	waitRegistered(old, "first serve")

	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	stopOld()
	restarted, stopRestarted := start()
	defer stopRestarted()
	waitRegistered(restarted, "restarted serve")
}
