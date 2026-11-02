package collect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
)

// scriptedForwarder answers each payload from a script: the errors listed for it
// are returned in turn, then the event is accepted.
type scriptedForwarder struct {
	mu       sync.Mutex
	script   map[string][]error
	calls    map[string]int
	received []string
	at       map[string]time.Time
}

func newScripted(script map[string][]error) *scriptedForwarder {
	return &scriptedForwarder{script: script, calls: map[string]int{}, at: map[string]time.Time{}}
}

func (f *scriptedForwarder) Forward(_ context.Context, ev *ccxv1.Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := string(ev.GetPayload())
	f.at[p] = time.Now()
	n := f.calls[p]
	f.calls[p]++
	if errs := f.script[p]; n < len(errs) {
		return errs[n]
	}
	f.received = append(f.received, p)
	return nil
}

func (f *scriptedForwarder) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.received...)
}

func (f *scriptedForwarder) callsFor(p string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[p]
}

func (f *scriptedForwarder) lastCall(p string) time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.at[p]
}

func repeat(err error, n int) []error {
	out := make([]error, n)
	for i := range out {
		out[i] = err
	}
	return out
}

func openDeadSpool(t *testing.T, origin *ccxv1.Origin) (*Spool, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := OpenSpool(dir, origin)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func appendAll(t *testing.T, s *Spool, payloads ...string) {
	t.Helper()
	for _, p := range payloads {
		if _, err := s.Append([]byte(p)); err != nil {
			t.Fatal(err)
		}
	}
}

func runLoop(t *testing.T, loop *forwardLoop) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { loop.run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return cancel
}

// deadPayloads reads back what dead/ holds, in name order.
func deadPayloads(t *testing.T, spoolDir string) []string {
	t.Helper()
	ents, err := os.ReadDir(deadPath(spoolDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	var out []string
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(deadPath(spoolDir), n))
		if err != nil {
			t.Fatal(err)
		}
		var ev ccxv1.Event
		if err := proto.Unmarshal(b, &ev); err != nil {
			t.Fatalf("dead/%s is not an event: %v", n, err)
		}
		out = append(out, string(ev.GetPayload()))
	}
	return out
}

// An event the center refuses for its content is set aside in dead/ and the
// events behind it are delivered (#126). Before, it was retried forever and the
// machine's spool never drained again.
func TestForwardLoop_RefusedEventIsSetAsideAndTheQueueMovesOn(t *testing.T) {
	for _, code := range []connect.Code{connect.CodeInvalidArgument, connect.CodeFailedPrecondition} {
		t.Run(code.String(), func(t *testing.T) {
			spool, dir := openDeadSpool(t, &ccxv1.Origin{Machine: "m", User: "u"})
			appendAll(t, spool, "first", "refused", "last")
			fwd := newScripted(map[string][]error{"refused": {connect.NewError(code, errors.New("no"))}})
			loop := newForwardLoop(spool, fwd, quietLog)
			// The next event goes out at once, without a backoff: a sleep here
			// would outlast the test.
			loop.minBackoff = time.Hour
			runLoop(t, loop)

			waitFor(t, 2*time.Second, func() bool { return len(fwd.got()) == 2 })
			if got := fwd.got(); got[0] != "first" || got[1] != "last" {
				t.Fatalf("delivered %v, want [first last]", got)
			}
			if n, err := spool.Pending(); err != nil || n != 0 {
				t.Fatalf("pending = %d (%v), want 0", n, err)
			}
			if got := deadPayloads(t, dir); len(got) != 1 || got[0] != "refused" {
				t.Fatalf("dead/ holds %v, want [refused]", got)
			}
			if n := fwd.callsFor("refused"); n != 1 {
				t.Errorf("refused event was sent %d times, want 1", n)
			}
			if r := loop.reach(); r.LastError == "" || r.LastErrorAt.IsZero() {
				t.Errorf("a refusal must show as the last error, got %+v", r)
			}
		})
	}
}

// Errors that can clear without the event changing keep the event at the front
// and are retried: nothing moves to dead/ and nothing behind it overtakes it.
func TestForwardLoop_RetryableErrorsKeepTheEvent(t *testing.T) {
	retryable := map[string]error{
		"unavailable":     connect.NewError(connect.CodeUnavailable, errors.New("down")),
		"unauthenticated": connect.NewError(connect.CodeUnauthenticated, errors.New("token")),
		"deadline":        connect.NewError(connect.CodeDeadlineExceeded, errors.New("slow")),
		"internal":        connect.NewError(connect.CodeInternal, errors.New("bug")),
		"plain":           errors.New("dial tcp: connection refused"),
	}
	for name, ferr := range retryable {
		t.Run(name, func(t *testing.T) {
			spool, dir := openDeadSpool(t, &ccxv1.Origin{Machine: "m", User: "u"})
			appendAll(t, spool, "head", "behind")
			fwd := newScripted(map[string][]error{"head": {ferr, ferr}})
			loop := newForwardLoop(spool, fwd, quietLog)
			loop.minBackoff = time.Millisecond
			runLoop(t, loop)

			waitFor(t, 2*time.Second, func() bool { return len(fwd.got()) == 2 })
			if got := fwd.got(); got[0] != "head" || got[1] != "behind" {
				t.Fatalf("delivered %v, want [head behind]: the failing event must be retried, not skipped", got)
			}
			if n := fwd.callsFor("head"); n != 3 {
				t.Errorf("head sent %d times, want 3 (two failures, then accepted)", n)
			}
			if got := deadPayloads(t, dir); len(got) != 0 {
				t.Fatalf("dead/ holds %v, want nothing", got)
			}
		})
	}
}

// Through the real Connect client and server: the center's InvalidArgument for a
// missing origin reaches the loop with its code, so the event is set aside.
func TestForwardLoop_RealCenterRefusalIsSetAside(t *testing.T) {
	c, url := testcenter.Start()
	defer c.Close()
	c.RequireOrigin()

	spool, dir := openDeadSpool(t, &ccxv1.Origin{Machine: "", User: "u"})
	appendAll(t, spool, `{"n":1}`, `{"n":2}`)
	runLoop(t, newForwardLoop(spool, NewForwarder(url, ""), quietLog))

	waitFor(t, 2*time.Second, func() bool { return len(deadPayloads(t, dir)) == 2 })
	if n, err := spool.Pending(); err != nil || n != 0 {
		t.Fatalf("pending = %d (%v), want 0", n, err)
	}
	if got := c.Payloads(); len(got) != 0 {
		t.Fatalf("the center stored %v, want nothing", got)
	}
}

// If the event cannot be moved aside, it stays at the front of the queue and the
// loop backs off instead of re-sending it as fast as it can.
func TestForwardLoop_MoveToDeadFailure_KeepsTheEventAndBacksOff(t *testing.T) {
	spool, dir := openDeadSpool(t, &ccxv1.Origin{Machine: "m", User: "u"})
	appendAll(t, spool, "refused", "behind")
	// A file where dead/ should be makes MkdirAll fail.
	if err := os.WriteFile(deadPath(dir), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	refuse := connect.NewError(connect.CodeInvalidArgument, errors.New("no"))
	fwd := newScripted(map[string][]error{"refused": repeat(refuse, 100)})
	cancel := runLoop(t, newForwardLoop(spool, fwd, quietLog))

	time.Sleep(300 * time.Millisecond)
	cancel()

	if n := fwd.callsFor("refused"); n < 1 || n > 10 {
		t.Errorf("refused event sent %d times in 300ms, want 1..10 (backing off from 100ms)", n)
	}
	if got := fwd.got(); len(got) != 0 {
		t.Fatalf("delivered %v while the refused event is still at the front", got)
	}
	if n, err := spool.Pending(); err != nil || n != 2 {
		t.Fatalf("pending = %d (%v), want 2: the refused event must not be lost", n, err)
	}
}

// After setting an event aside the loop starts again from the shortest backoff,
// so an outage before the refusal does not slow the retries of the next event.
func TestForwardLoop_RefusalResetsTheBackoff(t *testing.T) {
	spool, _ := openDeadSpool(t, &ccxv1.Origin{Machine: "m", User: "u"})
	appendAll(t, spool, "refused", "next")
	down := connect.NewError(connect.CodeUnavailable, errors.New("down"))
	refusedScript := append(repeat(down, 10), connect.NewError(connect.CodeInvalidArgument, errors.New("no")))
	fwd := newScripted(map[string][]error{"refused": refusedScript, "next": {down}})
	loop := newForwardLoop(spool, fwd, quietLog)
	loop.minBackoff = time.Millisecond
	runLoop(t, loop)

	waitFor(t, 5*time.Second, func() bool { return len(fwd.got()) == 1 })
	// Ten outages leave the backoff at 1024ms. Reset, the one retry of "next"
	// waits 1ms; kept, it waits more than a second.
	if d := fwd.lastCall("next").Sub(fwd.lastCall("refused")); d > 500*time.Millisecond {
		t.Errorf("next event was delivered %s after the refusal, want well under 500ms", d)
	}
}

// A move that fails is reported, so the loop keeps the event and retries.
func TestMoveToDead_ReportsAFailedRename(t *testing.T) {
	spool, dir := openDeadSpool(t, &ccxv1.Origin{Machine: "m", User: "u"})
	gone := &Entry{Path: filepath.Join(dir, "00000000000000000042.pb"), Event: &ccxv1.Event{Seq: 42}}
	if got, err := spool.MoveToDead(gone); err == nil {
		t.Fatalf("moving a missing file succeeded as %q, want an error", got)
	}
}

// Two refused events that carry the same seq (seq resumes from the queue alone
// after a restart) are both kept in dead/.
func TestMoveToDead_KeepsBothEventsOfOneSeq(t *testing.T) {
	origin := &ccxv1.Origin{Machine: "m", User: "u"}
	spool, dir := openDeadSpool(t, origin)
	appendAll(t, spool, "one")
	e, err := spool.Oldest()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := spool.MoveToDead(e); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenSpool(dir, origin)
	if err != nil {
		t.Fatal(err)
	}
	appendAll(t, reopened, "two")
	e2, err := reopened.Oldest()
	if err != nil {
		t.Fatal(err)
	}
	if e2.Event.GetSeq() != e.Event.GetSeq() {
		t.Fatalf("precondition: want the same seq again after reopening, got %d then %d", e.Event.GetSeq(), e2.Event.GetSeq())
	}
	if _, err := reopened.MoveToDead(e2); err != nil {
		t.Fatal(err)
	}

	got := deadPayloads(t, dir)
	sort.Strings(got)
	if len(got) != 2 || got[0] != "one" || got[1] != "two" {
		t.Fatalf("dead/ holds %v, want both [one two]", got)
	}
}
