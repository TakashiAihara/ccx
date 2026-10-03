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

func (f *fakeCenter) Append(ctx context.Context, session string, offset uint64, data []byte) (uint64, error) {
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
	if calls[0].session != sid || calls[0].offset != 0 {
		t.Fatalf("first call = %+v, want session %s offset 0", calls[0], sid)
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
	if _, calls := c.snapshot(); len(calls) > 4 {
		t.Fatalf("%d appends for one burst of 50 hooks; reads were not coalesced", len(calls))
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

func TestOrdinaryHookDoesNotScheduleALateRead(t *testing.T) {
	c := &fakeCenter{}
	s := start(t, c, fast)
	p := transcript(t, "a\n")

	s.Notify(hook("PostToolUse", sid, p))
	eventually(t, "the first line stored", storedIs(c, "a\n"))
	appendFile(t, p, "b\n")
	time.Sleep(4 * fast.SettleDelay)
	if st, _ := c.snapshot(); string(st) != "a\n" {
		t.Fatalf("stored %q: a non-terminal hook read again without a trigger", st)
	}
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

func (p *perSession) Append(ctx context.Context, session string, offset uint64, data []byte) (uint64, error) {
	p.mu.Lock()
	c := p.m[session]
	if c == nil {
		c = &fakeCenter{}
		p.m[session] = c
	}
	p.mu.Unlock()
	return c.Append(ctx, session, offset, data)
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
	if _, calls := c.snapshot(); len(calls) != 0 {
		t.Fatalf("Append was called through a symlink: %+v", calls)
	}
}
