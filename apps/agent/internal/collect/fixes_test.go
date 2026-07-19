package collect

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// An unexpected Accept error must be RETURNED (fatal to the concern), not
// swallowed into a dead-listener state. Fix for the review's High#1.
func TestAcceptLoop_ReturnsErrorOnUnexpectedFailure(t *testing.T) {
	spool, err := OpenSpool(t.TempDir(), &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	c := newCollect(t.TempDir()+"/s.sock", spool, nil, quietLog)

	ln, err := net.Listen("unix", c.socketPath)
	if err != nil {
		t.Fatal(err)
	}
	ln.Close() // closing WITHOUT cancelling ctx makes Accept fail unexpectedly

	// ctx is live (not cancelled), so the closed listener is an unexpected error.
	got := c.acceptLoop(context.Background(), ln)
	if got == nil {
		t.Error("acceptLoop must return the error for an unexpected Accept failure, not nil")
	}
}

// A second ccxd on the same spool is refused by the flock, not by a racy socket
// probe. Fix for the review's Medium#3.
func TestSingleInstanceLock_RefusesSecond(t *testing.T) {
	dir := t.TempDir()
	first, err := acquireLock(dir)
	if err != nil {
		t.Fatalf("first lock should succeed: %v", err)
	}

	if _, err := acquireLock(dir); err == nil {
		t.Error("a second ccxd on the same spool must be refused while the first holds the lock")
	}

	// After the first releases, a new one can acquire (crash recovery).
	first.release()
	second, err := acquireLock(dir)
	if err != nil {
		t.Errorf("lock should be re-acquirable after release: %v", err)
	}
	second.release()
}

// Stray temp files from a crash mid-write are reaped on open, not accumulated.
// Fix for the review's Low#7.
func TestOpenSpool_ReapsStrayTemps(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "incoming"), 0o700); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(dir, ".tmp-crash")
	strayIn := filepath.Join(dir, "incoming", ".tmp-crash")
	if err := os.WriteFile(stray, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(strayIn, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := OpenSpool(dir, &ccxv1.Origin{Machine: "m", User: "u"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Error("stray temp in spool dir should have been reaped")
	}
	if _, err := os.Stat(strayIn); !os.IsNotExist(err) {
		t.Error("stray temp in incoming dir should have been reaped")
	}
}

// The hook returns within its overall budget even if the socket path stalls (a
// ccxd that accepts but never acks), rather than hanging the session. Fix for
// the review's Medium#5 / Low#6.
func TestHook_ReturnsWithinBudget_WhenServerStalls(t *testing.T) {
	dir := t.TempDir()
	sock := dir + "/s.sock"
	// A listener that accepts connections but never reads or replies — a wedged
	// ccxd. The hook must not wait on it beyond its deadlines.
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		var held []net.Conn
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			held = append(held, conn) // hold open, never respond
			_ = held
		}
	}()

	start := time.Now()
	code := Hook(sock, dir+"/spool", strings.NewReader(`{"x":1}`))
	elapsed := time.Since(start)

	if code != 0 {
		t.Errorf("hook must exit 0, got %d", code)
	}
	if elapsed > hookOverallBudget+time.Second {
		t.Errorf("hook blocked %s on a stalled server — must be bounded", elapsed)
	}
	// It should have fallen back to the spool rather than losing the event.
	raw, _ := filepath.Glob(filepath.Join(dir, "spool", "incoming", "*.raw"))
	if len(raw) != 1 {
		t.Errorf("stalled socket should have driven a fallback write, got %d incoming files", len(raw))
	}
}

// countingForwarder records how many times Forward is called.
type countingForwarder struct {
	mu    sync.Mutex
	calls int
}

func (f *countingForwarder) Forward(context.Context, *ccxv1.Event) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return nil // center always accepts; the failure under test is the local delete
}

func (f *countingForwarder) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// When the center accepts but the local Ack (delete) keeps failing, the loop must
// back off, not spin re-forwarding the same event as fast as it can. Fix for the
// review's High#2.
func TestForwardLoop_AckFailure_BacksOffNotBusyLoop(t *testing.T) {
	dir := t.TempDir()
	spool, err := OpenSpool(dir, &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := spool.Append([]byte(`{"x":1}`)); err != nil {
		t.Fatal(err)
	}

	// Make os.Remove of the spool file fail: strip write permission on the dir so
	// the entry cannot be unlinked. Restore in cleanup so t.TempDir can clean up.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	fwd := &countingForwarder{}
	loop := newForwardLoop(spool, fwd, quietLog)
	ctx, cancel := context.WithCancel(context.Background())
	go loop.run(ctx)

	time.Sleep(300 * time.Millisecond)
	cancel()

	// With the fix (min backoff 100ms), ~3-4 attempts in 300ms. Without it, the
	// loop would re-forward thousands of times. A generous ceiling still catches
	// the busy loop.
	if n := fwd.count(); n > 25 {
		t.Errorf("forward called %d times in 300ms on persistent Ack failure — that is a busy loop, backoff is missing", n)
	}
}

// A center that accepts the connection but never responds must make Forward
// time out and RETURN an error (so the loop can back off and retry), not block
// for the life of ccxd. Fix for the CodeRabbit review's forward finding.
func TestConnectForwarder_TimesOutOnHungCenter(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-block // hang: never respond until the test unblocks it
	}))
	// Order matters: unblock the handler BEFORE Close waits on it (defers are
	// LIFO), or Close deadlocks on the still-hung request.
	defer srv.Close()
	defer close(block)

	f := &connectForwarder{
		client:  ccxv1connect.NewIngestServiceClient(http.DefaultClient, srv.URL),
		timeout: 200 * time.Millisecond,
	}

	start := time.Now()
	err := f.Forward(context.Background(), &ccxv1.Event{EventId: "x", Payload: []byte("y")})
	elapsed := time.Since(start)

	if err == nil {
		t.Error("Forward against a hung center must return an error, not block/succeed")
	}
	if elapsed > 2*time.Second {
		t.Errorf("Forward blocked %s on a hung center — the per-call timeout is missing", elapsed)
	}
}
