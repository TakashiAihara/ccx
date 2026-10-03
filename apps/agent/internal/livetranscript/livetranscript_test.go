package livetranscript

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const sid = "0d5ad3c1-5b6e-4c1f-9a3e-1f2b3c4d5e6f"

// fakeCenter is the center's side of Append: offset must equal the stored size.
type fakeCenter struct {
	mu      sync.Mutex
	stored  []byte
	calls   []call
	failN   int           // the next failN calls fail with a transport error
	block   chan struct{} // when non-nil, Append waits on it
	maxSeen int
}

type call struct {
	session string
	offset  uint64
	data    []byte
}

func (f *fakeCenter) Append(ctx context.Context, session string, offset uint64, data, tail []byte) (uint64, error) {
	f.mu.Lock()
	block := f.block
	f.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call{session, offset, append([]byte(nil), data...)})
	if len(data) > f.maxSeen {
		f.maxSeen = len(data)
	}
	if f.failN > 0 {
		f.failN--
		return 0, errors.New("unavailable")
	}
	if offset != uint64(len(f.stored)) {
		return 0, &Mismatch{Size: uint64(len(f.stored))}
	}
	if len(tail) > len(f.stored) || string(f.stored[len(f.stored)-len(tail):]) != string(tail) {
		return 0, &Permanent{Err: errors.New("diverged")}
	}
	f.stored = append(f.stored, data...)
	return uint64(len(f.stored)), nil
}

func (f *fakeCenter) snapshot() ([]byte, []call) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.stored...), append([]call(nil), f.calls...)
}

// fast keeps the tests quick; the real values are constants in the package.
var fast = Options{MinInterval: 10 * time.Millisecond, SettleDelay: 40 * time.Millisecond, RetryDelay: 20 * time.Millisecond, MaxChunk: 1 << 20}

func start(t *testing.T, c Appender, opts Options) *Sync {
	t.Helper()
	s := New(c, opts, func(string, ...any) {})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("Run did not return after cancel")
		}
	})
	return s
}

// transcript makes <dir>/.claude/projects/<cwd>/<sid>.jsonl and returns its path.
func transcript(t *testing.T, content string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), ".claude", "projects", "-root-repo")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, sid+".jsonl")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func appendFile(t *testing.T, p, s string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func hook(event, session, path string) []byte {
	b, _ := json.Marshal(map[string]any{"hook_event_name": event, "session_id": session, "transcript_path": path, "cwd": "/root/repo"})
	return b
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func storedIs(c *fakeCenter, want string) func() bool {
	return func() bool { s, _ := c.snapshot(); return string(s) == want }
}

func TestSendsCompleteLinesFromTheStart(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "{\"a\":1}\n{\"b\":2}\n")

	s.Notify(hook("UserPromptSubmit", sid, p))

	eventually(t, "the whole file stored", storedIs(c, "{\"a\":1}\n{\"b\":2}\n"))
	_, calls := c.snapshot()
	if len(calls) < 2 || calls[0].offset != 0 || len(calls[0].data) != 0 {
		t.Fatalf("calls = %+v, want an empty size probe at offset 0 first", calls)
	}
	if calls[1].session != sid || calls[1].offset != 0 {
		t.Fatalf("first data call = %+v, want session %s offset 0", calls[1], sid)
	}
}

func TestALineLongerThanMaxLineStopsEvenUnderTheChunkCap(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.MaxChunk = 1024
	opts.MaxLine = 64
	s := start(t, c, opts)
	p := transcript(t, "ok\n"+strings.Repeat("x", 200))

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the session stopped with a reason", func() bool { return s.Stopped()[sid] != "" })
	if st, _ := c.snapshot(); string(st) != "ok\n" {
		t.Fatalf("stored %q, want only the complete line before the over-long one", st)
	}
}

func TestHoldsBackALineStillBeingWritten(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "{\"a\":1}\n{\"b\":")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the complete line stored", storedIs(c, "{\"a\":1}\n"))
	time.Sleep(3 * fast.SettleDelay)
	if st, _ := c.snapshot(); string(st) != "{\"a\":1}\n" {
		t.Fatalf("stored %q: a partial line was sent", st)
	}

	appendFile(t, p, "2}\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the finished line appended", storedIs(c, "{\"a\":1}\n{\"b\":2}\n"))
	for _, cl := range func() []call { _, cs := c.snapshot(); return cs }() {
		if len(cl.data) > 0 && cl.data[len(cl.data)-1] != '\n' {
			t.Fatalf("call %+v does not end with a newline", cl)
		}
	}
}

func TestEachReadSendsOnlyTheNewBytes(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	big := strings.Repeat("{\"x\":\""+strings.Repeat("y", 1000)+"\"}\n", 200)
	p := transcript(t, big)
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the big file stored", storedIs(c, big))
	_, before := c.snapshot()

	appendFile(t, p, "{\"new\":1}\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the new line stored", storedIs(c, big+"{\"new\":1}\n"))

	_, after := c.snapshot()
	for _, cl := range after[len(before):] {
		if len(cl.data) > 0 && string(cl.data) != "{\"new\":1}\n" {
			t.Fatalf("a later read sent %d bytes, want only the new line", len(cl.data))
		}
	}
}

func TestIgnoresPayloadsThatDoNotNameATranscript(t *testing.T) {
	good := transcript(t, "x\n")
	dir := filepath.Dir(good)
	other := filepath.Join(t.TempDir(), sid+".jsonl")
	if err := os.WriteFile(other, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	notProjects := filepath.Join(t.TempDir(), "elsewhere", sid+".jsonl")
	_ = os.MkdirAll(filepath.Dir(notProjects), 0o700)
	_ = os.WriteFile(notProjects, []byte("secret\n"), 0o600)
	wrongName := filepath.Join(dir, "1d5ad3c1-5b6e-4c1f-9a3e-1f2b3c4d5e6f.jsonl")
	_ = os.WriteFile(wrongName, []byte("secret\n"), 0o600)

	cases := map[string][]byte{
		"not json":                       []byte("{not json"),
		"no transcript_path":             []byte(`{"session_id":"` + sid + `"}`),
		"no session_id":                  []byte(`{"transcript_path":"` + good + `"}`),
		"session id not a uuid":          hook("Stop", "../../x", good),
		"file name is another session":   hook("Stop", sid, wrongName),
		"not under a projects directory": hook("Stop", sid, notProjects),
		"relative path":                  hook("Stop", sid, filepath.Join("projects", "-r", sid+".jsonl")),
		"dot-dot out of projects":        hook("Stop", sid, filepath.Join(dir, "..", "..", "..", filepath.Base(filepath.Dir(other)), sid+".jsonl")),
		"unclean path with dot-dot":      hook("Stop", sid, dir+"/../-root-repo/"+sid+".jsonl"),
		"unclean path with a double /":   hook("Stop", sid, dir+"//"+sid+".jsonl"),
		"directory traversal to other":   hook("Stop", sid, filepath.Join(dir, "..", "..", "projects", "..", "..", strings.TrimPrefix(other, "/"))),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			c := &fakeCenter{}
			s := start(t, c, fast)
			s.Notify(payload)
			time.Sleep(4 * fast.SettleDelay)
			if _, calls := c.snapshot(); len(calls) != 0 {
				t.Fatalf("Append was called %d time(s): %+v", len(calls), calls)
			}
		})
	}
}

func TestContinuesFromTheCentersSizeAfterARestart(t *testing.T) {
	// The center already holds the first line: an agent that restarted sends from
	// 0, is refused with the size, and continues from there without duplicating.
	c := &fakeCenter{stored: []byte("one\n")}
	s := start(t, c, fast)
	p := transcript(t, "one\ntwo\nthree\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the rest appended once", storedIs(c, "one\ntwo\nthree\n"))
}

func TestSplitsLargeReadsAtLineBoundaries(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.MaxChunk = 64
	s := start(t, c, opts)
	var b strings.Builder
	for i := 0; i < 20; i++ {
		fmt.Fprintf(&b, "{\"line\":%d,\"pad\":\"%s\"}\n", i, strings.Repeat("p", i))
	}
	long := "{\"long\":\"" + strings.Repeat("L", 200) + "\"}\n"
	b.WriteString(long)
	b.WriteString("{\"after\":1}\n")
	p := transcript(t, b.String())

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "everything stored", storedIs(c, b.String()))

	_, calls := c.snapshot()
	for _, cl := range calls {
		if len(cl.data) == 0 {
			continue
		}
		if cl.data[len(cl.data)-1] != '\n' {
			t.Fatalf("chunk %q does not end at a line boundary", cl.data)
		}
		if len(cl.data) > opts.MaxChunk && string(cl.data) != long {
			t.Fatalf("chunk of %d bytes over the %d cap, and it is not a single long line", len(cl.data), opts.MaxChunk)
		}
	}
	if len(calls) < 3 {
		t.Fatalf("%d calls: the cap did not split the read", len(calls))
	}
}

func TestCoalescesABurstOfHooks(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.MinInterval = 100 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "")

	for i := 0; i < 50; i++ {
		appendFile(t, p, fmt.Sprintf("{\"i\":%d}\n", i))
		s.Notify(hook("PostToolUse", sid, p))
	}
	want, _ := os.ReadFile(p)
	eventually(t, "the burst stored", storedIs(c, string(want)))
	if _, calls := c.snapshot(); nonEmpty(calls) > 4 {
		t.Fatalf("%d appends for one burst of 50 hooks; reads were not coalesced", nonEmpty(calls))
	}
}

func TestStopReadsAgainForLinesWrittenAfterTheHook(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "{\"prompt\":1}\n")

	s.Notify(hook("Stop", sid, p))
	eventually(t, "the first line stored", storedIs(c, "{\"prompt\":1}\n"))

	// Claude Code writes the turn's last record after the Stop hook fired, and
	// no other hook follows.
	appendFile(t, p, "{\"answer\":1}\n")
	eventually(t, "the late line picked up without another hook", storedIs(c, "{\"prompt\":1}\n{\"answer\":1}\n"))
}

func TestAnyHookReadsOnceMoreAfterItQuietsDown(t *testing.T) {
	// Which hook fired is not read (the agent reads two fields of the payload):
	// every trigger asks for one more read SettleDelay after the last one.
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "a\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the first line stored", storedIs(c, "a\n"))
	appendFile(t, p, "b\n")
	eventually(t, "the line written after the hook picked up by the settled read", storedIs(c, "a\nb\n"))
}

func TestDoesNotReadWhichHookFired(t *testing.T) {
	// A payload without hook_event_name is as good a trigger as any.
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "a\n")
	b, _ := json.Marshal(map[string]any{"session_id": sid, "transcript_path": p})
	s.Notify(b)
	eventually(t, "stored", storedIs(c, "a\n"))
}

func TestStopsASessionWhoseFileShrank(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "one\ntwo\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored", storedIs(c, "one\ntwo\n"))
	_, before := c.snapshot()

	if err := os.WriteFile(p, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(4 * fast.SettleDelay)
	appendFile(t, p, "y\nz\nmore-than-before\n")
	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(4 * fast.SettleDelay)

	st, after := c.snapshot()
	if string(st) != "one\ntwo\n" || len(after) != len(before) {
		t.Fatalf("after the shrink: stored %q, %d new call(s); want nothing written", st, len(after)-len(before))
	}
	if got := s.Stopped(); got[sid] == "" {
		t.Fatalf("Stopped() = %v, want a reason for %s", got, sid)
	}
}

func TestRetriesWhenTheCenterIsDown(t *testing.T) {
	c := &fakeCenter{failN: 3}
	s := start(t, c, fast)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored once the center answers, with no further hook", storedIs(c, "one\n"))
}

func TestNotifyNeverWaitsForTheCenter(t *testing.T) {
	c := &fakeCenter{block: make(chan struct{})}
	defer close(c.block)
	s := start(t, c, fast)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(2 * fast.SettleDelay) // the read is now stuck in Append

	t0 := time.Now()
	for i := 0; i < 100; i++ {
		s.Notify(hook("PostToolUse", sid, p))
	}
	if d := time.Since(t0); d > 50*time.Millisecond {
		t.Fatalf("100 Notify calls took %v while Append was blocked", d)
	}
}

func TestKeepsSessionsApart(t *testing.T) {
	c1 := &perSession{m: map[string]*fakeCenter{}}
	s := start(t, c1, fast)
	other := "1d5ad3c1-5b6e-4c1f-9a3e-1f2b3c4d5e6f"
	p1 := transcript(t, "s1\n")
	p2 := filepath.Join(filepath.Dir(p1), other+".jsonl")
	if err := os.WriteFile(p2, []byte("s2-a\ns2-b\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	s.Notify(hook("PostToolUse", sid, p1))
	s.Notify(hook("PostToolUse", other, p2))
	eventually(t, "both sessions stored separately", func() bool {
		return c1.stored(sid) == "s1\n" && c1.stored(other) == "s2-a\ns2-b\n"
	})
}

// perSession is a center holding one object per session.
type perSession struct {
	mu sync.Mutex
	m  map[string]*fakeCenter
}

func (p *perSession) Append(ctx context.Context, session string, offset uint64, data, tail []byte) (uint64, error) {
	p.mu.Lock()
	c := p.m[session]
	if c == nil {
		c = &fakeCenter{}
		p.m[session] = c
	}
	p.mu.Unlock()
	return c.Append(ctx, session, offset, data, tail)
}

func (p *perSession) stored(session string) string {
	p.mu.Lock()
	c := p.m[session]
	p.mu.Unlock()
	if c == nil {
		return ""
	}
	s, _ := c.snapshot()
	return string(s)
}

func TestTheLateReadAfterStopHappensOnce(t *testing.T) {
	// The settled read is one read. After it, the session waits for a trigger like
	// any other: a file that grows with no hook is not read (a loop that keeps
	// re-reading would pick it up, and spin on the file while doing so).
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "{\"prompt\":1}\n")

	s.Notify(hook("Stop", sid, p))
	time.Sleep(3 * fast.SettleDelay)
	eventually(t, "the first line stored", storedIs(c, "{\"prompt\":1}\n"))

	appendFile(t, p, "{\"later\":1}\n")
	time.Sleep(4 * fast.SettleDelay)
	if st, _ := c.snapshot(); string(st) != "{\"prompt\":1}\n" {
		t.Fatalf("stored %q: the session kept reading after its settled read", st)
	}
}

func TestStopsASessionWhoseLineNeverEnds(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.MaxChunk = 16
	opts.MaxLine = 64
	s := start(t, c, opts)
	p := transcript(t, "ok\n"+strings.Repeat("x", 200))

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the session stopped with a reason", func() bool { return s.Stopped()[sid] != "" })
	if st, _ := c.snapshot(); string(st) != "ok\n" {
		t.Fatalf("stored %q, want only the complete line before the over-long one", st)
	}
}

func TestALineManyTimesTheChunkCapArrivesIntact(t *testing.T) {
	// The over-long line is read a step at a time; each step must keep what the
	// previous ones read. One step's worth of growth past the cap is not enough to
	// show it, so the line spans several.
	c := &fakeCenter{}
	opts := fast
	opts.MaxChunk = 64
	s := start(t, c, opts)
	var long strings.Builder
	long.WriteString("{\"long\":\"")
	for i := 0; long.Len() < 300<<10; i++ {
		fmt.Fprintf(&long, "%08d", i)
	}
	long.WriteString("\"}\n")
	content := "ok\n" + long.String() + "{\"after\":1}\n"
	p := transcript(t, content)

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the long line stored byte for byte", storedIs(c, content))
}

func TestDoesNotFollowASymlinkNamedLikeTheTranscript(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	real := transcript(t, "x\n")
	if err := os.Remove(real); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("not a transcript\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, real); err != nil {
		t.Fatal(err)
	}

	s.Notify(hook("PostToolUse", sid, real))
	time.Sleep(4 * fast.SettleDelay)
	if _, calls := c.snapshot(); nonEmpty(calls) != 0 {
		t.Fatalf("bytes were sent through a symlink: %+v", calls)
	}
}

func nonEmpty(calls []call) int {
	n := 0
	for _, c := range calls {
		if len(c.data) > 0 {
			n++
		}
	}
	return n
}

func TestAsksTheCenterForItsSizeBeforeSending(t *testing.T) {
	// An agent that restarted (or never saw this session) must not upload bytes the
	// center already holds just to learn its size.
	c := &fakeCenter{stored: []byte("one\ntwo\n")}
	s := start(t, c, fast)
	p := transcript(t, "one\ntwo\nthree\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the missing line appended", storedIs(c, "one\ntwo\nthree\n"))
	_, calls := c.snapshot()
	sent := 0
	for _, cl := range calls {
		sent += len(cl.data)
	}
	if sent != len("three\n") {
		t.Fatalf("sent %d bytes in %d calls, want only the %d new ones", sent, len(calls), len("three\n"))
	}
}

// hangingCenter never answers its first n calls (until ctx is done), then behaves.
type hangingCenter struct {
	fakeCenter
	hang int
}

func (h *hangingCenter) Append(ctx context.Context, session string, offset uint64, data, tail []byte) (uint64, error) {
	h.mu.Lock()
	hang := h.hang > 0
	if hang {
		h.hang--
	}
	h.mu.Unlock()
	if hang {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	return h.fakeCenter.Append(ctx, session, offset, data, tail)
}

func TestAnAppendThatNeverAnswersTimesOutAndIsRetried(t *testing.T) {
	c := &hangingCenter{hang: 1}
	opts := fast
	opts.AppendTimeout = 50 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored after the hung call timed out", storedIs(&c.fakeCenter, "one\n"))
}

// refusing answers every call with err.
type refusing struct {
	mu    sync.Mutex
	err   error
	calls int
}

func (r *refusing) Append(context.Context, string, uint64, []byte, []byte) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return 0, r.err
}

func (r *refusing) n() int { r.mu.Lock(); defer r.mu.Unlock(); return r.calls }

func TestAPermanentRefusalStopsTheSessionInsteadOfRetrying(t *testing.T) {
	c := &refusing{err: &Permanent{Err: errors.New("bad key")}}
	s := start(t, c, fast)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the session stopped", func() bool { return s.Stopped()[sid] != "" })
	n := c.n()
	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(10 * fast.RetryDelay)
	if c.n() != n {
		t.Fatalf("%d more calls after a permanent refusal", c.n()-n)
	}
}

func TestAGlobalRefusalStopsEverySession(t *testing.T) {
	c := &refusing{err: &Permanent{Err: errors.New("unimplemented"), Global: true}}
	s := start(t, c, fast)
	p := transcript(t, "one\n")
	other := "1d5ad3c1-5b6e-4c1f-9a3e-1f2b3c4d5e6f"
	p2 := filepath.Join(filepath.Dir(p), other+".jsonl")
	if err := os.WriteFile(p2, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "halted", func() bool { return s.Halted() != "" })
	n := c.n()
	s.Notify(hook("PostToolUse", other, p2))
	time.Sleep(10 * fast.RetryDelay)
	if c.n() != n {
		t.Fatalf("another session called the center %d time(s) after a global refusal", c.n()-n)
	}
}

func TestTransientFailuresBackOff(t *testing.T) {
	c := &refusing{err: errors.New("down")}
	opts := fast
	opts.RetryDelay = 10 * time.Millisecond
	opts.MaxRetryDelay = time.Second
	s := start(t, c, opts)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(400 * time.Millisecond)
	// without backoff: 400ms / 10ms = 40 calls; doubling from 10ms: about 6
	if n := c.n(); n > 10 || n < 2 {
		t.Fatalf("%d calls in 400ms with a 10ms first retry", n)
	}
}

func TestARefusalAtTheSameSizeDoesNotSpin(t *testing.T) {
	c := &refusing{err: &Mismatch{Size: 0}}
	opts := fast
	opts.RetryDelay = 20 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(200 * time.Millisecond)
	if n := c.n(); n > 20 {
		t.Fatalf("%d calls in 200ms: a refusal at the offset sent from loops without delay", n)
	}
}

func TestFollowsTheSessionToANewPath(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "one\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored", storedIs(c, "one\n"))

	// resumed elsewhere: the same session's file under another project directory
	moved := filepath.Join(filepath.Dir(filepath.Dir(p)), "-root-elsewhere", sid+".jsonl")
	if err := os.MkdirAll(filepath.Dir(moved), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p, moved); err != nil {
		t.Fatal(err)
	}
	appendFile(t, moved, "two\n")
	s.Notify(hook("PostToolUse", sid, moved))
	eventually(t, "the new path read", storedIs(c, "one\ntwo\n"))
}

func TestForgetsAnIdleSessionAndPicksItUpAgain(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.IdleDrop = 100 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored", storedIs(c, "one\n"))

	eventually(t, "the idle session forgotten", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.sessions) == 0
	})
	appendFile(t, p, "two\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "picked up again from the center's size", storedIs(c, "one\ntwo\n"))
}

func TestASettledReadWaitsForALineStillBeingWritten(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "one\n{\"half\":")

	s.Notify(hook("Stop", sid, p))
	eventually(t, "the complete line stored", storedIs(c, "one\n"))
	time.Sleep(2 * fast.SettleDelay)
	// the rest of the line lands later, with no hook after it
	appendFile(t, p, "1}\n")
	eventually(t, "the finished line stored by a re-armed settled read", storedIs(c, "one\n{\"half\":1}\n"))
}

func TestAFIFOInTheTranscriptsPlaceDoesNotHang(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "")
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(p, 0o600); err != nil {
		t.Skip("mkfifo:", err)
	}
	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(4 * fast.SettleDelay)
	// The loop must still be serving: replace the FIFO with a file and it is read.
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored once the FIFO is a file again", storedIs(c, "one\n"))
}

func TestStopsInsteadOfSplicingADifferentCopy(t *testing.T) {
	// The center holds as many bytes as the local file's first line, but not the
	// same bytes (another machine's copy was pulled over this one). Appending the
	// rest would join two copies into one that exists nowhere.
	c := &fakeCenter{stored: []byte("XXX\n")}
	s := start(t, c, fast)
	p := transcript(t, "one\ntwo\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the session stopped", func() bool { return s.Stopped()[sid] != "" })
	st, calls := c.snapshot()
	if string(st) != "XXX\n" {
		t.Fatalf("stored %q: a different copy was appended to", st)
	}
	// found by the empty append that checks the tail, before any chunk was shipped
	if n := nonEmpty(calls); n != 0 {
		t.Fatalf("%d chunk(s) shipped before the divergence was found", n)
	}
}

func TestNoticesAnObjectAPushPutBackWithNoNewLines(t *testing.T) {
	// The agent has caught up; then a push replaces the object with an older
	// snapshot. The file does not grow, but the next hook's settled read checks
	// the center and sends what the push dropped.
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "one\ntwo\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "caught up", storedIs(c, "one\ntwo\n"))
	time.Sleep(3 * fast.SettleDelay)

	c.mu.Lock()
	c.stored = []byte("one\n")
	c.mu.Unlock()
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the dropped line sent again", storedIs(c, "one\ntwo\n"))
}

func TestForgetsLongStoppedSessionsWhenTheMapGrows(t *testing.T) {
	c := &refusing{err: &Permanent{Err: errors.New("diverged")}}
	opts := fast
	opts.IdleDrop = 50 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stopped", func() bool { return s.Stopped()[sid] != "" })
	time.Sleep(2 * opts.IdleDrop)

	other := "1d5ad3c1-5b6e-4c1f-9a3e-1f2b3c4d5e6f"
	p2 := filepath.Join(filepath.Dir(p), other+".jsonl")
	if err := os.WriteFile(p2, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Notify(hook("PostToolUse", other, p2))
	s.mu.Lock()
	_, kept := s.sessions[sid]
	s.mu.Unlock()
	if kept {
		t.Fatal("a session stopped longer ago than IdleDrop is still in the map")
	}
}

func TestSendsTheBytesBeforeTheOffsetAsTheExpectedTail(t *testing.T) {
	c := &tailRecorder{}
	opts := fast
	s := start(t, c, opts)
	big := strings.Repeat("y", 5000) + "\n"
	p := transcript(t, big)
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored", storedIs(&c.fakeCenter, big))
	appendFile(t, p, "next\n")
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored", storedIs(&c.fakeCenter, big+"next\n"))

	c.mu.Lock()
	defer c.mu.Unlock()
	last := c.tails[len(c.tails)-1]
	if len(last) != 4096 || string(last) != big[len(big)-4096:] {
		t.Fatalf("last tail is %d bytes, want the 4096 bytes before offset %d", len(last), len(big))
	}
	if len(c.tails[0]) != 0 {
		t.Fatalf("the first data append at offset 0 carried a %d-byte tail", len(c.tails[0]))
	}
}

type tailRecorder struct {
	fakeCenter
	tails [][]byte
}

func (r *tailRecorder) Append(ctx context.Context, session string, offset uint64, data, tail []byte) (uint64, error) {
	if len(data) > 0 {
		r.mu.Lock()
		r.tails = append(r.tails, append([]byte(nil), tail...))
		r.mu.Unlock()
	}
	return r.fakeCenter.Append(ctx, session, offset, data, tail)
}

func TestAfterARecoveredFailureTheSessionWaitsForATrigger(t *testing.T) {
	// The read that serves a retry clears it. Left set, a retry time in the past
	// stays due, and the loop re-reads the file without pause (it would pick up a
	// line written with no hook after it).
	c := &fakeCenter{failN: 1}
	s := start(t, c, fast)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stored after the retry", storedIs(c, "one\n"))
	time.Sleep(4 * fast.SettleDelay)
	appendFile(t, p, "two\n")
	time.Sleep(4 * fast.SettleDelay)
	if st, _ := c.snapshot(); string(st) != "one\n" {
		t.Fatalf("stored %q: the session kept reading after it recovered", st)
	}
}

func TestSettledReadsStopAfterMaxSettles(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.SettleDelay = 20 * time.Millisecond
	opts.MaxSettles = 2
	s := start(t, c, opts)
	p := transcript(t, "one\n{\"half\":")

	s.Notify(hook("Stop", sid, p))
	eventually(t, "the complete line stored", storedIs(c, "one\n"))
	time.Sleep(200 * time.Millisecond) // well past 2 re-armed reads
	appendFile(t, p, "1}\n")
	time.Sleep(200 * time.Millisecond)
	if st, _ := c.snapshot(); string(st) != "one\n" {
		t.Fatalf("stored %q: settled reads went on past MaxSettles", st)
	}
}

func TestANewHookGivesTheSettledReadsANewBudget(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.SettleDelay = 30 * time.Millisecond
	opts.MaxSettles = 1
	s := start(t, c, opts)
	p := transcript(t, "one\n{\"half\":")

	s.Notify(hook("Stop", sid, p))
	eventually(t, "the complete line stored", storedIs(c, "one\n"))
	time.Sleep(200 * time.Millisecond) // the first hook's budget is spent

	s.Notify(hook("Stop", sid, p))
	time.Sleep(45 * time.Millisecond) // after this hook's settled read, before its re-arm
	appendFile(t, p, "1}\n")
	eventually(t, "the re-armed read of the new hook picks the line up", storedIs(c, "one\n{\"half\":1}\n"))
}

func TestAContinuousStreamOfHooksDoesNotPostponeTheRead(t *testing.T) {
	c := &fakeCenter{}
	opts := fast
	opts.MinInterval = 30 * time.Millisecond
	opts.SettleDelay = 30 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 60; i++ {
			s.Notify(hook("PostToolUse", sid, p))
			time.Sleep(5 * time.Millisecond)
		}
	}()
	eventually(t, "stored while the hooks keep coming", storedIs(c, "one\n"))
	select {
	case <-done:
		t.Fatal("the read only happened after the stream of hooks ended")
	default:
	}
	<-done
}

func TestDuringAnOutageHooksDoNotRetryFasterThanTheBackoff(t *testing.T) {
	c := &refusing{err: errors.New("down")}
	opts := fast
	opts.MinInterval = 5 * time.Millisecond
	opts.SettleDelay = 5 * time.Millisecond
	opts.RetryDelay = 300 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")

	for i := 0; i < 40; i++ {
		s.Notify(hook("PostToolUse", sid, p))
		time.Sleep(5 * time.Millisecond)
	}
	if n := c.n(); n > 2 || n < 1 {
		t.Fatalf("%d calls in 200ms of hooks with a 300ms backoff (want 1 or 2)", n)
	}
}

func TestAStoppedSessionStartsOverAfterIdleDrop(t *testing.T) {
	c := &onceRefusing{fakeCenter: fakeCenter{}, err: &Permanent{Err: errors.New("diverged")}}
	opts := fast
	opts.IdleDrop = 100 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "one\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "stopped", func() bool { return s.Stopped()[sid] != "" })
	s.Notify(hook("PostToolUse", sid, p))
	time.Sleep(4 * fast.SettleDelay)
	if st, _ := c.snapshot(); len(st) != 0 {
		t.Fatalf("stored %q right after the stop", st)
	}

	time.Sleep(opts.IdleDrop)
	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the session started over", storedIs(&c.fakeCenter, "one\n"))
}

// onceRefusing answers its first call with err, then behaves.
type onceRefusing struct {
	fakeCenter
	err  error
	used bool
}

func (o *onceRefusing) Append(ctx context.Context, session string, offset uint64, data, tail []byte) (uint64, error) {
	o.mu.Lock()
	first := !o.used
	o.used = true
	o.mu.Unlock()
	if first {
		return 0, o.err
	}
	return o.fakeCenter.Append(ctx, session, offset, data, tail)
}

func TestWithTheDefaultOrderARecordAfterTheSettledReadIsStillRead(t *testing.T) {
	// Production order: the settled read (SettleDelay) comes before the
	// hook-triggered one (MinInterval). A record written between them, with no hook
	// after it, must still be read.
	c := &fakeCenter{}
	opts := fast
	opts.SettleDelay = 20 * time.Millisecond
	opts.MinInterval = 120 * time.Millisecond
	s := start(t, c, opts)
	p := transcript(t, "{\"prompt\":1}\n")

	s.Notify(hook("Stop", sid, p))
	eventually(t, "the settled read", storedIs(c, "{\"prompt\":1}\n"))
	time.Sleep(30 * time.Millisecond) // after the settled read, before MinInterval
	appendFile(t, p, "{\"answer\":1}\n")
	eventually(t, "the record written after the settled read", storedIs(c, "{\"prompt\":1}\n{\"answer\":1}\n"))
}
