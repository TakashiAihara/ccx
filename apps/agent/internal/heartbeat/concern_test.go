package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	second := &Concern{socketPath: sock}
	if got := runOff(t, second); !strings.Contains(got, "another ccx-agent serve") {
		t.Errorf("second serve logged %q, want it to stand down", got)
	}
	if _, err := os.Stat(sock); err != nil {
		t.Errorf("the running serve's socket is gone: %v", err)
	}
}

// runOff runs a concern that cannot set up, and returns what it logged. Run
// must not return an error (that would stop collect too) and must stay up
// until the process stops.
func runOff(t *testing.T, c *Concern) string {
	t.Helper()
	var logged strings.Builder
	c.log = func(f string, a ...any) { fmt.Fprintf(&logged, f, a...) }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	select {
	case err := <-done:
		t.Fatalf("Run returned before the process stopped: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run returned %v; an error here stops collect", err)
	}
	return logged.String()
}

func TestConcernRefusesATooLongSocketPath(t *testing.T) {
	c := &Concern{socketPath: "/" + strings.Repeat("x", 120) + ".sock"}
	if got := runOff(t, c); !strings.Contains(got, "heartbeat off") || !strings.Contains(got, "CCX_CHANNEL_SOCKET") {
		t.Errorf("logged %q, want the heartbeat off and what to set", got)
	}
}

// flaky fails Accept a few times, then blocks until closed.
type flaky struct {
	net.Listener
	fails, calls int
	closed       chan struct{}
}

func (f *flaky) Accept() (net.Conn, error) {
	f.calls++
	if f.calls <= f.fails {
		return nil, errors.New("accept: too many open files")
	}
	<-f.closed
	return nil, net.ErrClosed
}

// A failed Accept (EMFILE and the like) is retried; the concern keeps serving
// sessions that connect later instead of leaving a socket nobody accepts on.
func TestConcernKeepsAcceptingAfterAnError(t *testing.T) {
	old := acceptRetry
	acceptRetry = time.Millisecond
	defer func() { acceptRetry = old }()

	f := &flaky{fails: 3, closed: make(chan struct{})}
	c := &Concern{log: t.Logf}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.accept(ctx, f); close(done) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	close(f.closed)
	<-done
	if f.calls != 4 {
		t.Errorf("Accept called %d times, want 3 failures then a 4th that waits", f.calls)
	}
}
