package channel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
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
	sock := filepath.Join(t.TempDir(), "ch.sock")
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
	defer cancel()
	go Relay(ctx, sock, "sid-1", s, t.Logf)

	select {
	case line := <-got:
		var reg map[string]string
		if json.Unmarshal([]byte(line), &reg) != nil || reg["session"] != "sid-1" {
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
