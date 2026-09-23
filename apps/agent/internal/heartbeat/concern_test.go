package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/packages/core/config"
)

// A registered channel whose session is due gets the heartbeat down its own
// connection; a channel for a session that is not due gets nothing.
func TestConcernSendsTheBeatToTheRegisteredSession(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "projects", "-cwd")
	_ = os.MkdirAll(dir, 0o755)
	stamp := func(ago time.Duration) string { return time.Now().UTC().Add(-ago).Format(time.RFC3339Nano) }
	write := func(id string, ago time.Duration) {
		tr := `{"type":"user","timestamp":"` + stamp(ago+5*time.Second) + `","message":{"content":"hi"}}` + "\n" +
			`{"type":"assistant","timestamp":"` + stamp(ago) + `","message":{"content":[]}}` + "\n"
		_ = os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(tr), 0o644)
	}
	const due, fresh = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	write(due, 51*time.Minute)
	write(fresh, time.Minute)

	sock := filepath.Join(t.TempDir(), "ch.sock")
	c := &Concern{socketPath: sock, claudeHome: home, log: t.Logf,
		cfg: config.Heartbeat{Default: true, Interval: 50 * time.Minute, MaxIdle: 12 * time.Hour}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Run(ctx) }()

	dial := func(id string) *bufio.Reader {
		var conn net.Conn
		var err error
		for i := 0; i < 50; i++ {
			if conn, err = net.Dial("unix", sock); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		_ = json.NewEncoder(conn).Encode(Register{Session: id})
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		return bufio.NewReader(conn)
	}

	line, err := dial(due).ReadBytes('\n')
	if err != nil {
		t.Fatalf("due session got nothing: %v", err)
	}
	var ev Event
	if json.Unmarshal(line, &ev) != nil || ev.Meta["kind"] != "heartbeat" || ev.Content == "" {
		t.Errorf("event = %s", line)
	}

	// Still connected, and nothing came: a read that times out, not one that ends.
	line, err = dial(fresh).ReadBytes('\n')
	if ne, ok := err.(net.Error); !ok || !ne.Timeout() {
		t.Errorf("fresh session: got %q, err %v; want a timeout on a live connection", line, err)
	}

	// An id that is not a session id is dropped: it becomes a path and a glob.
	if _, err := dial("../../etc").ReadBytes('\n'); err == nil || isTimeout(err) {
		t.Errorf("bad id: err %v, want the connection closed", err)
	}
}

func isTimeout(err error) bool { ne, ok := err.(net.Error); return ok && ne.Timeout() }

func TestConcernRefusesASecondServe(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "ch.sock")
	first := &Concern{socketPath: sock, log: t.Logf}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = first.Run(ctx) }()
	for i := 0; i < 50; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	second := &Concern{socketPath: sock, log: t.Logf}
	if err := second.Run(context.Background()); err == nil {
		t.Fatal("a second serve started")
	}
	if _, err := os.Stat(sock); err != nil {
		t.Errorf("the running serve's socket is gone: %v", err)
	}
}

func TestConcernRefusesATooLongSocketPath(t *testing.T) {
	c := &Concern{socketPath: "/" + strings.Repeat("x", 120) + ".sock", log: t.Logf}
	if err := c.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "CCX_CHANNEL_SOCKET") {
		t.Errorf("err = %v, want one that says what to set", err)
	}
}
