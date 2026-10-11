package collect

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testsock"
	"github.com/TakashiAihara/ccx/packages/core/config"
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
	c := newCollect(testsock.Path(t, "s.sock"), spool, nil, quietLog)

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

// A second ccx-agent on the same spool is refused by the flock, not by a racy socket
// probe. Fix for the review's Medium#3.
func TestSingleInstanceLock_RefusesSecond(t *testing.T) {
	dir := t.TempDir()
	first, err := acquireLock(dir)
	if err != nil {
		t.Fatalf("first lock should succeed: %v", err)
	}

	if _, err := acquireLock(dir); err == nil {
		t.Error("a second ccx-agent on the same spool must be refused while the first holds the lock")
	}

	// After the first releases, a new one can acquire (crash recovery).
	first.release()
	second, err := acquireLock(dir)
	if err != nil {
		t.Errorf("lock should be re-acquirable after release: %v", err)
	}
	second.release()
}

// Stray temp files from a crash mid-write are reaped, not accumulated: the spool's
// on open, incoming/'s once the lock is held (#218). Fix for the review's Low#7.
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
	// In incoming/ only a settled temp file is looked at (#218).
	old := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(strayIn, old, old); err != nil {
		t.Fatal(err)
	}

	s, err := OpenSpool(dir, &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Error("stray temp in spool dir should have been reaped")
	}
	if _, err := os.Stat(strayIn); err != nil {
		t.Errorf("incoming/ must not be touched before the lock: %v", err)
	}
	if _, d, _ := s.recoverTemps(time.Now()); d != 1 {
		t.Errorf("dropped %d, want the partial temp", d)
	}
	if _, err := os.Stat(strayIn); !os.IsNotExist(err) {
		t.Error("stray temp in incoming dir should have been reaped")
	}
}

// The hook returns within its overall budget even if the socket path stalls (a
// ccx-agent that accepts but never acks), rather than hanging the session. Fix for
// the review's Medium#5 / Low#6.
func TestHook_ReturnsWithinBudget_WhenServerStalls(t *testing.T) {
	dir := t.TempDir()
	sock := testsock.Path(t, "s.sock")
	// A listener that accepts connections but never reads or replies — a wedged
	// ccx-agent. The hook must not wait on it beyond its deadlines.
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
// for the life of ccx-agent. Fix for the CodeRabbit review's forward finding.
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

// The single-instance lock must be acquired BEFORE the spool is touched, so two
// ccx-agent starting at once cannot both drain incoming/ and race the seq counter
// (CodeRabbit Critical). If another instance holds the lock, Run must fail
// without draining — proven here by the incoming file being left untouched.
func TestRun_LockPrecedesDrain(t *testing.T) {
	dir := t.TempDir()
	spool, err := OpenSpool(dir, &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	// A hook dropped a fallback event while ccx-agent was down.
	if err := writeIncoming(spool.IncomingDir(), newUUIDv7(), []byte(`{"pending":1}`)); err != nil {
		t.Fatal(err)
	}

	// ...and a settled temp it could not rename (#218): recovering it is a change to
	// incoming/ too, so it must also wait for the lock.
	settled := filepath.Join(spool.IncomingDir(), ".tmp-01a050e6-8722-7c8a-9041-f38193f5a473.raw-1")
	if err := os.WriteFile(settled, []byte(`{"pending":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * tempAge)
	if err := os.Chtimes(settled, old, old); err != nil {
		t.Fatal(err)
	}

	// Another ccx-agent already holds the spool lock.
	held, err := acquireLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer held.release()

	// This instance's Run must fail on the lock — before DrainIncoming runs.
	c := newCollect(testsock.Path(t, "s.sock"), spool, nil, quietLog)
	if err := c.Run(context.Background()); err == nil {
		t.Fatal("Run should fail while another ccx-agent holds the lock")
	}

	// The incoming event must be untouched: the drain never ran.
	raw, _ := filepath.Glob(filepath.Join(spool.IncomingDir(), "*.raw"))
	if len(raw) != 1 {
		t.Errorf("incoming/ should be untouched when Run fails on the lock, found %d files", len(raw))
	}
	pending, _ := spool.Pending()
	if pending != 0 {
		t.Errorf("nothing should have been drained into the main spool, found %d", pending)
	}
	if _, err := os.Stat(settled); err != nil {
		t.Errorf("the settled temp should be untouched when Run fails on the lock: %v", err)
	}
}

// A temp too young to judge at startup (the agent came back seconds after the hook
// was cut off) is looked at again once it has settled, not left forever (#218).
func TestRun_TakesInATempThatWasYoungAtStartup(t *testing.T) {
	dir := t.TempDir()
	spool, err := OpenSpool(dir, &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	const id = "01a050e6-8722-7c8a-9041-f38193f5a472"
	tmp := filepath.Join(spool.IncomingDir(), ".tmp-"+id+".raw-1")
	if err := os.WriteFile(tmp, []byte(`{"late":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	fwd := &stubForwarder{}
	var logMu sync.Mutex
	var logs []string
	c := newCollect(testsock.Path(t, "s.sock"), spool, fwd, func(f string, a ...any) {
		logMu.Lock()
		defer logMu.Unlock()
		logs = append(logs, fmt.Sprintf(f, a...))
	})
	// what the later look takes in must wake the idle loop, not wait for its poll
	c.loop.idlePoll = time.Hour
	// the startup look and the next see the temp as new (a clock stepped back); the
	// third, as settled
	var looks atomic.Int32
	c.clock = func() time.Time {
		if looks.Add(1) <= 2 {
			return time.Now()
		}
		return time.Now().Add(2 * tempAge)
	}
	c.resweepAfter = 10 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if p := fwd.payloads(); len(p) == 1 && p[0] == `{"late":true}` {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatalf("the young temp was not taken in after it settled (looks: %d)", looks.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	logMu.Lock()
	joined := strings.Join(logs, "\n")
	logMu.Unlock()
	if !strings.Contains(joined, "1 temp(s) still too new to judge") {
		t.Errorf("a look that still finds a young temp must say so; logs:\n%s", joined)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("the temp is still in incoming/: %v", err)
	}
}

// An event without machine or user is rejected by the center and would be retried
// forever, holding back the rest (#126): collect does not start without both.
func TestNew_RequiresMachineAndUser(t *testing.T) {
	base := config.Config{Machine: "m", User: "u", SpoolDir: filepath.Join(t.TempDir(), "spool")}
	if _, err := New(base, quietLog); err != nil {
		t.Fatalf("with both: %v", err)
	}
	for _, c := range []struct {
		name string
		cfg  config.Config
		want string
	}{
		{"machine", config.Config{User: "u", SpoolDir: base.SpoolDir}, "CCX_MACHINE"},
		{"user", config.Config{Machine: "m", SpoolDir: base.SpoolDir}, "no user name"},
	} {
		if _, err := New(c.cfg, quietLog); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("without %s: err = %v, want one naming %q", c.name, err, c.want)
		}
	}
}
