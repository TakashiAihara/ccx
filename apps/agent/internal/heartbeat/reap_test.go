package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testsock"
	"github.com/TakashiAihara/ccx/packages/core/config"
)

// reapNow is 2023-11-16T02:00:00Z. The fake host booted at 1700000000, so a
// process with start ticks N began at 1700000000 + N/100.
var reapNow = time.Unix(1700100000, 0).UTC()

const bootTimeSec = 1700000000

type reapEnv struct {
	t         *testing.T
	home      string
	proc      string
	c         *Concern
	mu        sync.Mutex
	killed    []int
	logs      []string
	records   []string
	recordErr error
}

func newReapEnv(t *testing.T) *reapEnv {
	t.Helper()
	e := &reapEnv{t: t, home: t.TempDir(), proc: t.TempDir()}
	if err := os.WriteFile(filepath.Join(e.proc, "stat"), []byte(fmt.Sprintf("cpu  1 2 3\nbtime %d\nprocesses 9\n", bootTimeSec)), 0o644); err != nil {
		t.Fatal(err)
	}
	e.c = &Concern{
		claudeHome: e.home, procRoot: e.proc,
		reap:       config.Reap{Enabled: true, Interval: time.Hour},
		log:        func(f string, a ...any) { e.mu.Lock(); e.logs = append(e.logs, fmt.Sprintf(f, a...)); e.mu.Unlock() },
		kill:       func(pid int) error { e.killed = append(e.killed, pid); return nil },
		registered: map[string]*Heartbeat{}, channels: map[string]*channel{},
	}
	e.c.Record = func(p []byte) error {
		e.records = append(e.records, string(p))
		return e.recordErr
	}
	return e
}

// procEntry writes one fake /proc/<pid>: stat with its command, parent and start
// ticks, and a smaps_rollup with pssKB (negative leaves it unreadable).
func (e *reapEnv) procEntry(pid int, comm string, ppid int, start uint64, pssKB int) {
	e.t.Helper()
	dir := filepath.Join(e.proc, fmt.Sprint(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		e.t.Fatal(err)
	}
	// Fields after the command: state, ppid, 17 more up to field 21, then starttime (22).
	stat := fmt.Sprintf("%d (%s) S %d%s %d 0 0\n", pid, comm, ppid, strings.Repeat(" 0", 17), start)
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o644); err != nil {
		e.t.Fatal(err)
	}
	if pssKB >= 0 {
		smaps := fmt.Sprintf("Rss:               99999 kB\nPss:  %14d kB\nPss_Anon:              7 kB\n", pssKB)
		if err := os.WriteFile(filepath.Join(dir, "smaps_rollup"), []byte(smaps), 0o644); err != nil {
			e.t.Fatal(err)
		}
	}
}

// session registers a session whose claude is pid (started at the given ticks)
// with the transcript, which "" leaves unwritten.
func (e *reapEnv) session(id string, pid int, start uint64, transcript string) *Heartbeat {
	e.t.Helper()
	if transcript != "" {
		dir := filepath.Join(e.home, "projects", "-cwd")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			e.t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(transcript), 0o644); err != nil {
			e.t.Fatal(err)
		}
	}
	h := &Heartbeat{SessionID: id, ClaudeHome: e.home, MaxIdle: 2 * time.Hour, Log: e.c.log, pid: pid, pidStart: start}
	e.c.registered[id] = h
	e.c.channels[id] = &channel{}
	return h
}

func (e *reapEnv) reapedFile(id string) string {
	b, err := os.ReadFile(filepath.Join(e.home, "sessions", id, "reaped"))
	if err != nil {
		return ""
	}
	return string(b)
}

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func tr(lines ...string) string { return strings.Join(lines, "\n") + "\n" }

func userAt(uuid string, at time.Time, content string) string {
	return fmt.Sprintf(`{"type":"user","uuid":%q,"timestamp":%q,"message":{"content":%s}}`, uuid, ts(at), content)
}

func assistantAt(uuid, parent string, at time.Time, blocks string) string {
	return fmt.Sprintf(`{"type":"assistant","uuid":%q,"parentUuid":%q,"timestamp":%q,"message":{"id":"m-%s","content":[%s]}}`, uuid, parent, ts(at), uuid, blocks)
}

// answered is a request at req that got its answer ten seconds later.
func answered(id string, req time.Time) string {
	return tr(userAt("u-"+id, req, `"hi"`), assistantAt("a-"+id, "u-"+id, req.Add(10*time.Second), ""))
}

const goodStart = 1000 // ticks: the process began ten seconds after boot, long before any activity here

// An expired session is stopped, and the stop is recorded in the log, in its own
// reaped file and in what the center is sent.
func TestReapStopsAnExpiredSession(t *testing.T) {
	e := newReapEnv(t)
	const id = "00000000-0000-4000-8000-000000000001"
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 2048)
	e.procEntry(101, "node", 100, 5000, 1024)
	e.procEntry(102, "bun", 101, 5000, 512)
	e.procEntry(103, "mcp", 100, 5000, -1) // unreadable: skipped
	e.procEntry(200, "claude", 1, 5000, 4096)

	e.c.reapOnce(reapNow)

	if fmt.Sprint(e.killed) != "[100]" {
		t.Fatalf("signalled %v, want only 100", e.killed)
	}
	want := `{"at":"2023-11-16T02:00:00Z","reason":"expired","pid":100,"pssBytes":3670016}` + "\n"
	if got := e.reapedFile(id); got != want {
		t.Errorf("reaped file = %q, want %q", got, want)
	}
	wantPayload := `{"session_id":"` + id + `","reaped":{"at":"2023-11-16T02:00:00Z","reason":"expired","pid":100,"pssBytes":3670016}}`
	if len(e.records) != 1 || e.records[0] != wantPayload {
		t.Errorf("sent to the center = %q, want [%s]", e.records, wantPayload)
	}
	wantLog := "reap: stopped " + id + " (expired, 3 MiB, idle 2h59m50s)"
	if len(e.logs) != 1 || e.logs[0] != wantLog {
		t.Errorf("log = %q, want [%s]", e.logs, wantLog)
	}
	dir, _ := os.Stat(filepath.Join(e.home, "sessions", id))
	file, _ := os.Stat(filepath.Join(e.home, "sessions", id, "reaped"))
	if dir.Mode().Perm() != 0o700 || file.Mode().Perm() != 0o600 {
		t.Errorf("modes dir %v file %v, want 0700 / 0600", dir.Mode().Perm(), file.Mode().Perm())
	}
}

// Each condition that makes a session worth keeping, flipped on its own against
// the same expired baseline; the paired cases are the side that lets it go.
func TestReapExpiryConditionsOneByOne(t *testing.T) {
	old := reapNow.Add(-3 * time.Hour)
	beatLine := func(at time.Time) string {
		return fmt.Sprintf(`{"type":"user","uuid":"b","isMeta":true,"timestamp":%q,"message":{"content":"<channel source=\"ccx\" kind=\"heartbeat\">heartbeat</channel>"}}`, ts(at))
	}
	bgStart := func(at time.Time) string {
		return fmt.Sprintf(`{"type":"user","uuid":"bg","timestamp":%q,"toolUseResult":{"backgroundTaskId":"bg1"},"message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}`, ts(at))
	}
	cases := []struct {
		name       string
		transcript string // "" writes none
		start      uint64
		tweak      func(h *Heartbeat, e *reapEnv, id string)
		reaped     bool
	}{
		{name: "baseline", transcript: answered("1", old), reaped: true},
		{name: "used within maxIdle", transcript: answered("1", reapNow.Add(-90*time.Minute))},
		{name: "no maxIdle cap", transcript: answered("1", old), tweak: func(h *Heartbeat, _ *reapEnv, _ string) { h.MaxIdle = 0 }},
		{name: "idle past maxIdle but request within the cache TTL", transcript: answered("1", reapNow.Add(-45*time.Minute)),
			tweak: func(h *Heartbeat, _ *reapEnv, _ string) { h.MaxIdle = 30 * time.Minute }},
		{name: "heartbeat landed within the cache TTL", transcript: answered("1", old) + beatLine(reapNow.Add(-30*time.Minute)) + "\n"},
		{name: "heartbeat older than the cache TTL", transcript: answered("1", old) + beatLine(reapNow.Add(-90*time.Minute)) + "\n", reaped: true},
		{name: "tool still running", transcript: tr(userAt("u-1", old, `"hi"`), assistantAt("a-1", "u-1", old.Add(10*time.Second), `{"type":"tool_use","id":"t1"}`))},
		{name: "tool result came back", reaped: true, transcript: tr(userAt("u-1", old, `"hi"`), assistantAt("a-1", "u-1", old.Add(10*time.Second), `{"type":"tool_use","id":"t1"}`),
			userAt("r-1", old.Add(20*time.Second), `[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]`))},
		{name: "input just arrived and has no answer yet", transcript: answered("1", old) + userAt("u-2", reapNow.Add(-2*time.Minute), `"more"`) + "\n",
			tweak: func(h *Heartbeat, _ *reapEnv, _ string) { h.MaxIdle = time.Minute }},
		{name: "input waited past turnStart", reaped: true, transcript: answered("1", old) + userAt("u-2", reapNow.Add(-10*time.Minute), `"more"`) + "\n",
			tweak: func(h *Heartbeat, _ *reapEnv, _ string) { h.MaxIdle = time.Minute }},
		{name: "background task from this process", start: goodStart,
			transcript: tr(userAt("u-1", old, `"hi"`), bgStart(old.Add(2*time.Second)), assistantAt("a-1", "u-1", old.Add(10*time.Second), ""))},
		{name: "background task from before the process started", reaped: true,
			start:      uint64(old.Add(time.Minute).Unix()-bootTimeSec) * 100,
			transcript: tr(userAt("u-1", old, `"hi"`), bgStart(old.Add(2*time.Second)), assistantAt("a-1", "u-1", old.Add(10*time.Second), ""))},
		{name: "pinned", transcript: answered("1", old), tweak: func(_ *Heartbeat, e *reapEnv, id string) {
			_ = os.MkdirAll(filepath.Join(e.home, "sessions", id), 0o700)
			_ = os.WriteFile(filepath.Join(e.home, "sessions", id, "pinned"), nil, 0o600)
		}},
		{name: "a directory named pinned is not the flag", reaped: true, transcript: answered("1", old), tweak: func(_ *Heartbeat, e *reapEnv, id string) {
			_ = os.MkdirAll(filepath.Join(e.home, "sessions", id, "pinned"), 0o700)
		}},
		{name: "transcript missing"},
		{name: "transcript without an answer", transcript: tr(userAt("u-1", old, `"hi"`))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newReapEnv(t)
			const id = "00000000-0000-4000-8000-000000000001"
			start := tc.start
			if start == 0 {
				start = goodStart
			}
			h := e.session(id, 100, start, tc.transcript)
			e.procEntry(100, "claude", 1, start, 100)
			if tc.tweak != nil {
				tc.tweak(h, e, id)
			}
			e.c.reapOnce(reapNow)
			if tc.reaped {
				if fmt.Sprint(e.killed) != "[100]" || e.reapedFile(id) == "" {
					t.Errorf("signalled %v, reaped file %q: want the session stopped", e.killed, e.reapedFile(id))
				}
				return
			}
			if len(e.killed) != 0 || e.reapedFile(id) != "" || len(e.records) != 0 {
				t.Errorf("signalled %v, reaped file %q, sent %q: want the session kept", e.killed, e.reapedFile(id), e.records)
			}
		})
	}
}

// A pid that is no longer the claude that registered, or never was, is not
// signalled; the next expired session still is.
func TestReapSkipsAPidThatIsNotTheRegisteredClaude(t *testing.T) {
	old := answered("1", reapNow.Add(-5*time.Hour)) // the oldest, so tried first
	younger := answered("2", reapNow.Add(-3*time.Hour))
	const a, b = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"
	for name, setup := range map[string]func(e *reapEnv){
		"start time changed (pid reused)": func(e *reapEnv) { e.procEntry(100, "claude", 1, goodStart+1, 10) },
		"command is not claude":           func(e *reapEnv) { e.procEntry(100, "bash", 1, goodStart, 10) },
		"process gone":                    func(e *reapEnv) {},
	} {
		t.Run(name, func(t *testing.T) {
			e := newReapEnv(t)
			e.session(a, 100, goodStart, old)
			e.session(b, 300, goodStart, younger)
			setup(e)
			e.procEntry(300, "claude", 1, goodStart, 10)
			e.c.reapOnce(reapNow)
			if fmt.Sprint(e.killed) != "[300]" || e.reapedFile(a) != "" || e.reapedFile(b) == "" {
				t.Errorf("signalled %v, reaped a=%q b=%q: want only 300", e.killed, e.reapedFile(a), e.reapedFile(b))
			}
		})
	}
}

// Without a readable process table (macOS) nothing is ever a candidate.
func TestReapNeverActsWithoutAProcessTable(t *testing.T) {
	e := newReapEnv(t)
	e.session("00000000-0000-4000-8000-000000000001", 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.c.procRoot = filepath.Join(e.proc, "missing")
	e.c.reapOnce(reapNow)
	if len(e.killed) != 0 {
		t.Errorf("signalled %v with no /proc", e.killed)
	}

	e.c.procRoot = e.proc
	if err := os.WriteFile(filepath.Join(e.proc, "stat"), []byte("cpu  1 2 3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.c.reapOnce(reapNow)
	if len(e.killed) != 0 {
		t.Errorf("signalled %v with no btime", e.killed)
	}
}

// A session whose registration carried no pid, or pid 1, is not a candidate.
func TestReapIgnoresSessionsWithoutAPid(t *testing.T) {
	e := newReapEnv(t)
	e.session("00000000-0000-4000-8000-000000000001", 0, 0, answered("1", reapNow.Add(-3*time.Hour)))
	e.session("00000000-0000-4000-8000-000000000002", 1, goodStart, answered("2", reapNow.Add(-3*time.Hour)))
	e.procEntry(1, "claude", 0, goodStart, 10)
	e.c.reapOnce(reapNow)
	if len(e.killed) != 0 {
		t.Errorf("signalled %v", e.killed)
	}
}

func TestReapKeepMin(t *testing.T) {
	for _, tc := range []struct {
		keepMin int
		reaped  bool
	}{{3, false}, {2, true}, {0, true}} {
		e := newReapEnv(t)
		e.c.reap.KeepMin = tc.keepMin
		// Three sessions with a channel, one of them expired.
		e.session("00000000-0000-4000-8000-000000000001", 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
		e.procEntry(100, "claude", 1, goodStart, 10)
		for i, id := range []string{"00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"} {
			e.session(id, 200+i, goodStart, answered(fmt.Sprint(i), reapNow.Add(-time.Minute)))
		}
		e.c.reapOnce(reapNow)
		if got := len(e.killed) == 1; got != tc.reaped {
			t.Errorf("keepMin %d with 3 sessions: signalled %v, want stopped=%v", tc.keepMin, e.killed, tc.reaped)
		}
	}
}

// The oldest expired session goes first, one per tick.
func TestReapOldestFirstOnePerTick(t *testing.T) {
	e := newReapEnv(t)
	ids := map[int]string{
		1: "00000000-0000-4000-8000-000000000001", // 7h
		2: "00000000-0000-4000-8000-000000000002", // 9h: the oldest, in the middle by id
		3: "00000000-0000-4000-8000-000000000003", // 5h
	}
	for pid, hours := range map[int]int{1: 7, 2: 9, 3: 5} {
		e.session(ids[pid], pid*100, goodStart, answered(fmt.Sprint(pid), reapNow.Add(-time.Duration(hours)*time.Hour)))
		e.procEntry(pid*100, "claude", 1, goodStart, 10)
	}
	e.c.reapOnce(reapNow)
	if fmt.Sprint(e.killed) != "[200]" {
		t.Fatalf("first tick signalled %v, want only the 9h one (200)", e.killed)
	}
	// The stopped session's channel closes in real life.
	delete(e.c.registered, ids[2])
	delete(e.c.channels, ids[2])
	e.c.reapOnce(reapNow)
	if fmt.Sprint(e.killed) != "[200 100]" {
		t.Errorf("after two ticks signalled %v, want 200 then 100 (the 7h one)", e.killed)
	}
}

func TestReapSignalFailureSkipsThatSession(t *testing.T) {
	e := newReapEnv(t)
	a, b := "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"
	e.session(a, 100, goodStart, answered("1", reapNow.Add(-5*time.Hour)))
	e.session(b, 300, goodStart, answered("2", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.procEntry(300, "claude", 1, goodStart, 10)
	e.c.kill = func(pid int) error {
		e.killed = append(e.killed, pid)
		if pid == 100 {
			return errors.New("operation not permitted")
		}
		return nil
	}
	e.c.reapOnce(reapNow)
	if fmt.Sprint(e.killed) != "[100 300]" || e.reapedFile(a) != "" || e.reapedFile(b) == "" {
		t.Errorf("signalled %v, a=%q b=%q: want 100 tried and not recorded, then 300 stopped", e.killed, e.reapedFile(a), e.reapedFile(b))
	}
	if !strings.Contains(strings.Join(e.logs, "\n"), "reap: signalling "+a+" (pid 100): operation not permitted") {
		t.Errorf("log = %q, want the failed signal", e.logs)
	}
}

// A failing send to the spool is logged and does not undo or prevent the local
// record; an existing reaped file is appended to.
func TestReapRecordFuncErrorDoesNotStopTheLocalWrite(t *testing.T) {
	e := newReapEnv(t)
	const id = "00000000-0000-4000-8000-000000000001"
	e.recordErr = errors.New("spool is full")
	dir := filepath.Join(e.home, "sessions", id)
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "reaped"), []byte(`{"earlier":true}`+"\n"), 0o600)
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 1024)
	e.c.reapOnce(reapNow)
	want := `{"earlier":true}` + "\n" + `{"at":"2023-11-16T02:00:00Z","reason":"expired","pid":100,"pssBytes":1048576}` + "\n"
	if got := e.reapedFile(id); got != want {
		t.Errorf("reaped file = %q, want %q", got, want)
	}
	if len(e.records) != 1 || !strings.Contains(strings.Join(e.logs, "\n"), "sending the record of "+id+" to the spool: spool is full") {
		t.Errorf("records %q, log %q: want the send attempted and its failure logged", e.records, e.logs)
	}
}

// With no record func (collect off) the stop is still done and recorded locally.
func TestReapWithoutARecordFunc(t *testing.T) {
	e := newReapEnv(t)
	e.c.Record = nil
	const id = "00000000-0000-4000-8000-000000000001"
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.c.reapOnce(reapNow)
	if fmt.Sprint(e.killed) != "[100]" || e.reapedFile(id) == "" {
		t.Errorf("signalled %v, file %q", e.killed, e.reapedFile(id))
	}
}

func TestReadProcStatHandlesAParenthesisInTheName(t *testing.T) {
	e := newReapEnv(t)
	e.procEntry(7, "a) b (c", 3, 424242, 1)
	st, ok := readProcStat(e.proc, 7)
	if !ok || st.comm != "a) b (c" || st.ppid != 3 || st.start != 424242 {
		t.Errorf("readProcStat = %+v, %v", st, ok)
	}
}

// Registration reads the pid the channel reports: a claude is recorded with its
// start time; anything else, or no pid, is not.
func TestRegistrationRecordsOnlyAClaudePid(t *testing.T) {
	e := newReapEnv(t)
	e.c.socketPath = testsock.Path(t, "ch.sock")
	e.c.reap.Interval = 24 * time.Hour // the loop never ticks; the test calls reapOnce itself
	e.procEntry(100, "claude", 1, 777, 10)
	e.procEntry(101, "bash", 1, 778, 10)
	e.procEntry(1, "claude", 0, 779, 10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = e.c.Run(ctx) }()

	register := func(id, pid string) {
		var conn net.Conn
		var err error
		for i := 0; i < 50; i++ {
			if conn, err = net.Dial("unix", e.c.socketPath); err == nil {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		_ = json.NewEncoder(conn).Encode(Register{Session: id, PID: pid})
	}
	const a, b, c, d = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000c", "00000000-0000-4000-8000-00000000000d"
	register(a, "100")
	register(b, "101")
	register(c, "")
	register(d, "1")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		e.c.mu.Lock()
		n := len(e.c.registered)
		e.c.mu.Unlock()
		if n == 4 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.c.mu.Lock()
	defer e.c.mu.Unlock()
	got := map[string][2]uint64{}
	for id, h := range e.c.registered {
		got[id] = [2]uint64{uint64(h.pid), h.pidStart}
	}
	want := map[string][2]uint64{a: {100, 777}, b: {0, 0}, c: {0, 0}, d: {0, 0}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("registered pids = %v, want %v", got, want)
	}
}

// With reaping off a registration reads nothing from /proc.
func TestRegistrationReadsNoPidWhenReapingIsOff(t *testing.T) {
	e := newReapEnv(t)
	e.c.reap.Enabled = false
	e.c.socketPath = testsock.Path(t, "ch.sock")
	e.procEntry(100, "claude", 1, 777, 10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = e.c.Run(ctx) }()
	var conn net.Conn
	var err error
	for i := 0; i < 50; i++ {
		if conn, err = net.Dial("unix", e.c.socketPath); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	const id = "00000000-0000-4000-8000-00000000000a"
	_ = json.NewEncoder(conn).Encode(Register{Session: id, PID: "100"})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		e.c.mu.Lock()
		h := e.c.registered[id]
		e.c.mu.Unlock()
		if h != nil {
			if h.pid != 0 {
				t.Errorf("pid = %d, want none with reaping off", h.pid)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("session never registered")
}

// Run ticks the reaper every Interval when reaping is on, and never when it is off.
func TestRunTicksTheReaperOnlyWhenEnabled(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		e := newReapEnv(t)
		e.c.reap = config.Reap{Enabled: enabled, Interval: 20 * time.Millisecond}
		e.c.socketPath = testsock.Path(t, "ch.sock")
		killed := make(chan int, 4)
		e.c.kill = func(pid int) error { killed <- pid; return nil }
		e.session("00000000-0000-4000-8000-000000000001", 100, goodStart, answered("1", time.Now().Add(-3*time.Hour)))
		e.procEntry(100, "claude", 1, goodStart, 10)
		ctx, cancel := context.WithCancel(context.Background())
		go func() { _ = e.c.Run(ctx) }()
		select {
		case pid := <-killed:
			if !enabled || pid != 100 {
				t.Errorf("enabled=%v: signalled %d", enabled, pid)
			}
		case <-time.After(500 * time.Millisecond):
			if enabled {
				t.Error("enabled: nothing was signalled within 500ms")
			}
		}
		cancel()
	}
}

// A claude that does not exit on SIGTERM keeps its channel registered; the next
// tick must not signal it again and write a second record.
func TestReapSignalsASessionOnce(t *testing.T) {
	e := newReapEnv(t)
	id := "00000000-0000-4000-8000-000000000001"
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-13*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.c.reapOnce(reapNow)
	e.c.reapOnce(reapNow.Add(time.Minute))
	if fmt.Sprint(e.killed) != "[100]" {
		t.Errorf("signalled %v over two ticks, want 100 once", e.killed)
	}
	if n := strings.Count(e.reapedFile(id), "\n"); n != 1 {
		t.Errorf("reaped file has %d lines, want 1", n)
	}
}
