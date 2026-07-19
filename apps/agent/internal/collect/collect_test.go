package collect

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

func quietLog(string, ...any) {}

// stubForwarder is an in-memory center. It can be made to fail (center down)
// and records what it received, so tests assert ordering and no-loss without a
// real network.
type stubForwarder struct {
	mu       sync.Mutex
	down     bool
	received []*ccxv1.Event
}

func (s *stubForwarder) setDown(down bool) {
	s.mu.Lock()
	s.down = down
	s.mu.Unlock()
}

func (s *stubForwarder) Forward(_ context.Context, ev *ccxv1.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.down {
		return fmt.Errorf("center down")
	}
	s.received = append(s.received, ev)
	return nil
}

func (s *stubForwarder) payloads() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.received))
	for i, e := range s.received {
		out[i] = string(e.GetPayload())
	}
	return out
}

// startServer runs a Server on a temp socket/spool and returns it plus a cancel.
func startServer(t *testing.T, fwd Forwarder) (*Collect, string, string, context.CancelFunc) {
	t.Helper()
	dir := t.TempDir()
	sock := dir + "/ccxd.sock"
	spoolDir := dir + "/spool"

	spool, err := OpenSpool(spoolDir, &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCollect(sock, spool, fwd, quietLog)

	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.Run(ctx) }()

	// Wait for the socket to come up.
	waitFor(t, 2*time.Second, func() bool { return canDial(sock) })
	return srv, sock, spoolDir, cancel
}

func canDial(sock string) bool {
	c, err := net.DialTimeout("unix", sock, 200*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}

// End-to-end through the real socket: runHook delivers, the server spools, the
// forward loop drains to the stub — no keystroke, no network.
func TestHookToForward_EndToEnd(t *testing.T) {
	fwd := &stubForwarder{}
	_, sock, _, cancel := startServer(t, fwd)
	defer cancel()

	for _, p := range []string{`{"hook":"SessionStart"}`, `{"hook":"UserPromptSubmit"}`, `{"hook":"Stop"}`} {
		if code := Hook(sock, t.TempDir(), strings.NewReader(p)); code != 0 {
			t.Fatalf("hook should always exit 0, got %d", code)
		}
	}

	waitFor(t, 2*time.Second, func() bool { return len(fwd.payloads()) == 3 })
	got := fwd.payloads()
	want := []string{`{"hook":"SessionStart"}`, `{"hook":"UserPromptSubmit"}`, `{"hook":"Stop"}`}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("order[%d]: want %q got %q", i, want[i], got[i])
		}
	}
}

// Center down: hooks still return immediately, events spool, and on recovery
// they arrive IN ORDER. This is UC's "spooled events arrive in order".
func TestCenterDown_SpoolsThenDrainsInOrder(t *testing.T) {
	fwd := &stubForwarder{}
	fwd.setDown(true)
	srv, sock, _, cancel := startServer(t, fwd)
	defer cancel()

	start := time.Now()
	for i := 0; i < 5; i++ {
		if code := Hook(sock, t.TempDir(), strings.NewReader(fmt.Sprintf(`{"n":%d}`, i))); code != 0 {
			t.Fatalf("hook exit %d", code)
		}
	}
	// Hooks must not have blocked on the down center.
	if elapsed := time.Since(start); elapsed > 1*time.Second {
		t.Errorf("hooks blocked while center was down: %s", elapsed)
	}

	// Nothing delivered yet.
	if n := len(fwd.payloads()); n != 0 {
		t.Fatalf("center is down, expected 0 delivered, got %d", n)
	}
	pending, _ := srv.spool.Pending()
	if pending != 5 {
		t.Fatalf("expected 5 spooled, got %d", pending)
	}

	// Center recovers.
	fwd.setDown(false)
	srv.loop.wake()

	waitFor(t, 3*time.Second, func() bool { return len(fwd.payloads()) == 5 })
	for i, p := range fwd.payloads() {
		if want := fmt.Sprintf(`{"n":%d}`, i); p != want {
			t.Errorf("recovery order[%d]: want %q got %q", i, want, p)
		}
	}
}

// A hook that fires while ccxd is down writes to the fallback; when ccxd starts,
// it drains that fallback into the queue before serving.
func TestCcxdDown_HookFallsBack_ThenDrainedOnStart(t *testing.T) {
	dir := t.TempDir()
	sock := dir + "/ccxd.sock"
	spoolDir := dir + "/spool"

	// ccxd is NOT running. Hook fires: dial fails fast, falls back to incoming.
	if code := Hook(sock, spoolDir, strings.NewReader(`{"while":"down"}`)); code != 0 {
		t.Fatalf("hook exit %d", code)
	}

	// Now ccxd starts. It should drain the fallback and forward it.
	fwd := &stubForwarder{}
	spool, err := OpenSpool(spoolDir, &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCollect(sock, spool, fwd, quietLog)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Run(ctx) }()

	waitFor(t, 3*time.Second, func() bool { return len(fwd.payloads()) == 1 })
	if got := fwd.payloads()[0]; got != `{"while":"down"}` {
		t.Errorf("fallback event not drained correctly: %q", got)
	}
}

// A socket path over the unix limit fails with a clear, actionable error rather
// than the kernel's cryptic "bind: invalid argument". Surfaced by running the
// real binary under a deep scratchpad path.
func TestListen_TooLongSocketPath_ClearError(t *testing.T) {
	long := "/tmp/" + strings.Repeat("x", 120) + "/ccxd.sock"
	spool, err := OpenSpool(t.TempDir(), &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCollect(long, spool, nil, quietLog)
	_, err = srv.listen()
	if err == nil {
		t.Fatal("expected an error for an over-long socket path")
	}
	if !strings.Contains(err.Error(), "CCX_SOCKET") {
		t.Errorf("error should tell the user how to fix it, got: %v", err)
	}
}
