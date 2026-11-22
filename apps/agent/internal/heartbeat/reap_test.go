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
	e.procEntryState(pid, comm, "S", ppid, start, pssKB)
}

func (e *reapEnv) procEntryState(pid int, comm, state string, ppid int, start uint64, pssKB int) {
	e.t.Helper()
	dir := filepath.Join(e.proc, fmt.Sprint(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		e.t.Fatal(err)
	}
	// Fields after the command: state, ppid, 17 more up to field 21, then starttime (22).
	stat := fmt.Sprintf("%d (%s) %s %d%s %d 0 0\n", pid, comm, state, ppid, strings.Repeat(" 0", 17), start)
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
	e.pidFile(pid, id)
	e.c.registered[id] = h
	e.c.channels[id] = &channel{}
	return h
}

// pidFile is Claude Code's own record of a process: which session it runs.
func (e *reapEnv) pidFile(pid int, session string) {
	e.t.Helper()
	dir := filepath.Join(e.home, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		e.t.Fatal(err)
	}
	body := fmt.Sprintf(`{"pid":%d,"sessionId":%q,"procStart":"1","status":"idle"}`, pid, session)
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprint(pid)+".json"), []byte(body), 0o600); err != nil {
		e.t.Fatal(err)
	}
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
	want := `{"at":"2023-11-16T02:00:00Z","reason":"expired","pid":100,"pssBytes":3670016,"start":1000}` + "\n"
	if got := e.reapedFile(id); got != want {
		t.Errorf("reaped file = %q, want %q", got, want)
	}
	wantPayload := `{"session_id":"` + id + `","reaped":{"at":"2023-11-16T02:00:00Z","reason":"expired","pid":100,"pssBytes":3670016,"start":1000}}`
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
	// A signal that failed does not count as sent: the session is tried again.
	e.c.kill = func(pid int) error { e.killed = append(e.killed, pid); return nil }
	e.c.reapOnce(reapNow.Add(time.Minute))
	if fmt.Sprint(e.killed) != "[100 300 100]" || e.reapedFile(a) == "" {
		t.Errorf("a minute later signalled %v, a=%q: want 100 tried again and recorded", e.killed, e.reapedFile(a))
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
	want := `{"earlier":true}` + "\n" + `{"at":"2023-11-16T02:00:00Z","reason":"expired","pid":100,"pssBytes":1048576,"start":1000}` + "\n"
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

func ticksAgo(d time.Duration) uint64 { return uint64(reapNow.Add(-d).Unix()-bootTimeSec) * 100 }

func (e *reapEnv) logText() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return strings.Join(e.logs, "\n")
}

// registerChannel connects a channel to the concern's socket and registers a session
// the way `ccx-agent channel` does, then waits until serve has it.
func registerChannel(t *testing.T, e *reapEnv, id, pid string) {
	t.Helper()
	var conn net.Conn
	var err error
	for i := 0; i < 100; i++ {
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
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		e.c.mu.Lock()
		h := e.c.registered[id]
		e.c.mu.Unlock()
		if h != nil {
			// The registration is logged before the entry appears.
			return
		}
	}
	t.Fatalf("session %s never registered", id)
}

// A process that has just started has not been left alone for any time yet, so a
// resume of an old transcript is not reaped on the spot. The cache test counts
// from the process start as well.
func TestReapCountsIdleFromTheProcessStart(t *testing.T) {
	old := answered("1", reapNow.Add(-3*time.Hour))
	for name, tc := range map[string]struct {
		started time.Duration
		maxIdle time.Duration
		reaped  bool
	}{
		"started inside maxIdle":                  {started: time.Hour, maxIdle: 2 * time.Hour},
		"started outside maxIdle":                 {started: 2*time.Hour + 10*time.Minute, maxIdle: 2 * time.Hour, reaped: true},
		"started inside the cache TTL":            {started: 30 * time.Minute, maxIdle: 10 * time.Minute},
		"started outside the cache TTL":           {started: 70 * time.Minute, maxIdle: 10 * time.Minute, reaped: true},
		"started long before the last real use":   {started: 4 * time.Hour, maxIdle: 2 * time.Hour, reaped: true},
		"started after the last real use, in TTL": {started: 10 * time.Minute, maxIdle: time.Minute},
	} {
		t.Run(name, func(t *testing.T) {
			e := newReapEnv(t)
			start := ticksAgo(tc.started)
			h := e.session("00000000-0000-4000-8000-000000000001", 100, start, old)
			h.MaxIdle = tc.maxIdle
			e.procEntry(100, "claude", 1, start, 10)
			e.c.reapOnce(reapNow)
			if got := len(e.killed) == 1; got != tc.reaped {
				t.Errorf("process started %v ago, maxIdle %v: signalled %v, want stopped=%v", tc.started, tc.maxIdle, e.killed, tc.reaped)
			}
		})
	}
}

// After /clear the same claude runs another session id while its channel stays
// registered under the old one: the pid file decides, and anything but a match
// keeps the session. A mismatch is said once, not every tick.
func TestReapNeedsThePidFileToNameTheSession(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	for name, setup := range map[string]func(e *reapEnv){
		"another session": func(e *reapEnv) { e.pidFile(100, "00000000-0000-4000-8000-0000000000ff") },
		"no pid file":     func(e *reapEnv) { _ = os.Remove(filepath.Join(e.home, "sessions", "100.json")) },
		"unparsable":      func(e *reapEnv) { _ = os.WriteFile(filepath.Join(e.home, "sessions", "100.json"), []byte("{"), 0o600) },
		"no sessionId": func(e *reapEnv) {
			_ = os.WriteFile(filepath.Join(e.home, "sessions", "100.json"), []byte(`{"pid":100}`), 0o600)
		},
		"pid file for 100 is another's": func(e *reapEnv) { e.pidFile(100, "") },
	} {
		t.Run(name, func(t *testing.T) {
			e := newReapEnv(t)
			e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
			e.procEntry(100, "claude", 1, goodStart, 10)
			setup(e)
			e.c.reapOnce(reapNow)
			e.c.reapOnce(reapNow.Add(time.Minute))
			if len(e.killed) != 0 || e.reapedFile(id) != "" {
				t.Errorf("signalled %v, reaped %q: want the session kept", e.killed, e.reapedFile(id))
			}
			if n := strings.Count(e.logText(), "reap: keeping "+id); n != 1 {
				t.Errorf("said %d times why it was kept over two ticks, want once; log %q", n, e.logText())
			}
		})
	}
}

// A mismatch names the session the process runs now.
func TestReapSaysWhichSessionThePidRunsNow(t *testing.T) {
	e := newReapEnv(t)
	const id, other = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-0000000000ff"
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.pidFile(100, other)
	e.c.reapOnce(reapNow)
	want := fmt.Sprintf("reap: keeping %s: pid 100 now runs session %q", id, other)
	if !strings.Contains(e.logText(), want) {
		t.Errorf("log %q, want %q", e.logText(), want)
	}
}

// A serve restart or a channel reconnect makes a new Heartbeat; the reaped file
// is what remembers that this very process was already signalled. A different
// process under the same pid (another start time) is not covered by it.
func TestReapDoesNotSignalAProcessItsFileSaysWasSignalled(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	line := func(pid, start int) string {
		return fmt.Sprintf(`{"at":"2023-11-16T01:00:00Z","reason":"expired","pid":%d,"pssBytes":1,"start":%d}`+"\n", pid, start)
	}
	for name, tc := range map[string]struct {
		file   string
		reaped bool
	}{
		"same pid and start":              {file: line(100, 1000)},
		"among older lines":               {file: line(55, 5) + "not json\n" + line(100, 1000) + line(7, 7)},
		"same pid, another start":         {file: line(100, 999), reaped: true},
		"same start, another pid":         {file: line(101, 1000), reaped: true},
		"an older record without a start": {file: `{"at":"x","reason":"expired","pid":100,"pssBytes":1}` + "\n", reaped: true},
		"no file":                         {reaped: true},
	} {
		t.Run(name, func(t *testing.T) {
			e := newReapEnv(t)
			if tc.file != "" {
				_ = os.MkdirAll(filepath.Join(e.home, "sessions", id), 0o700)
				_ = os.WriteFile(filepath.Join(e.home, "sessions", id, "reaped"), []byte(tc.file), 0o600)
			}
			e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
			e.procEntry(100, "claude", 1, goodStart, 10)
			e.c.reapOnce(reapNow)
			if got := len(e.killed) == 1; got != tc.reaped {
				t.Errorf("signalled %v, want stopped=%v", e.killed, tc.reaped)
			}
		})
	}
}

// keepMin counts the sessions left running: one already signalled that is still
// registered (it takes a while to exit) is not one, whether it is known from this
// serve's own flag or from its reaped file.
func TestReapKeepMinDoesNotCountASessionAlreadySignalled(t *testing.T) {
	const a, b, c = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000c"
	for name, mark := range map[string]func(e *reapEnv, h *Heartbeat){
		"flag in memory": func(_ *reapEnv, h *Heartbeat) { h.signalled.Store(true) },
		"reaped file": func(e *reapEnv, h *Heartbeat) {
			_ = os.MkdirAll(filepath.Join(e.home, "sessions", h.SessionID), 0o700)
			_ = os.WriteFile(filepath.Join(e.home, "sessions", h.SessionID, "reaped"), []byte(`{"pid":300,"start":1000}`+"\n"), 0o600)
		},
	} {
		t.Run(name, func(t *testing.T) {
			e := newReapEnv(t)
			e.c.reap.KeepMin = 2
			e.session(a, 100, goodStart, answered("1", reapNow.Add(-5*time.Hour))) // expired
			e.procEntry(100, "claude", 1, goodStart, 10)
			hb := e.session(b, 300, goodStart, answered("2", reapNow.Add(-5*time.Hour))) // signalled, still registered
			e.procEntry(300, "claude", 1, goodStart, 10)
			e.session(c, 400, goodStart, answered("3", reapNow.Add(-time.Minute)))
			e.procEntry(400, "claude", 1, goodStart, 10)
			mark(e, hb)
			e.c.reapOnce(reapNow)
			if len(e.killed) != 0 {
				t.Errorf("signalled %v: only a and c are left running, so keepMin 2 forbids a stop", e.killed)
			}
			e.c.reap.KeepMin = 1
			e.c.reapOnce(reapNow)
			if fmt.Sprint(e.killed) != "[100]" {
				t.Errorf("with keepMin 1 signalled %v, want only 100 (b is already on its way out)", e.killed)
			}
		})
	}
}

// The count is taken again under the lock right before the signal: a session that
// went away between the first look and the signal can leave too few behind.
func TestReapRechecksKeepMinRightBeforeTheSignal(t *testing.T) {
	e := newReapEnv(t)
	const a, b = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"
	e.c.reap.KeepMin = 1
	e.session(a, 100, goodStart, answered("1", reapNow.Add(-5*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.session(b, 300, goodStart, answered("2", reapNow.Add(-time.Minute)))
	// b's channel closes while a's process tree is being measured (after the first
	// count, before the signal): the readdir of the fake /proc is the hook.
	e.c.kill = func(pid int) error { t.Errorf("signalled %d with nobody else left running", pid); return nil }
	e.c.beforeSignal = func() {
		e.c.mu.Lock()
		delete(e.c.registered, b)
		delete(e.c.channels, b)
		e.c.mu.Unlock()
	}
	e.c.reapOnce(reapNow)
	if e.reapedFile(a) != "" {
		t.Errorf("a was recorded as reaped: %q", e.reapedFile(a))
	}
}

// A zombie keeps its command name; it is not a running claude, at registration or
// right before a signal.
func TestReapIgnoresAZombieClaude(t *testing.T) {
	for _, state := range []string{"Z", "X"} {
		e := newReapEnv(t)
		const a, b = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"
		e.session(a, 100, goodStart, answered("1", reapNow.Add(-5*time.Hour)))
		e.session(b, 300, goodStart, answered("2", reapNow.Add(-3*time.Hour)))
		e.procEntryState(100, "claude", state, 1, goodStart, 10)
		e.procEntry(300, "claude", 1, goodStart, 10)
		e.c.reapOnce(reapNow)
		if fmt.Sprint(e.killed) != "[300]" {
			t.Errorf("state %s: signalled %v, want only 300", state, e.killed)
		}
	}
	e := newReapEnv(t)
	e.procEntryState(100, "claude", "Z", 1, goodStart, 10)
	if _, ok := claudeProc(e.proc, 100); ok {
		t.Error("a zombie counted as a claude process")
	}
	e.procEntryState(101, "claude", "R", 1, goodStart, 10)
	if _, ok := claudeProc(e.proc, 101); !ok {
		t.Error("a running claude did not count")
	}
}

// The pid is verified after the slow tree walk, right before the signal: a process
// that stops being the claude during the walk is not signalled.
func TestReapVerifiesThePidAfterMeasuring(t *testing.T) {
	e := newReapEnv(t)
	const id = "00000000-0000-4000-8000-000000000001"
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.c.beforeSignal = func() { e.procEntry(100, "bash", 1, goodStart+5, 10) }
	e.c.reapOnce(reapNow)
	if len(e.killed) != 0 || e.reapedFile(id) != "" {
		t.Errorf("signalled %v, reaped %q: the pid was recycled during the walk", e.killed, e.reapedFile(id))
	}
}

// Reaping on: a registration with nothing to reap through says so once.
func TestRegistrationSaysWhyASessionWillNotBeReaped(t *testing.T) {
	e := newReapEnv(t)
	e.c.socketPath = testsock.Path(t, "ch.sock")
	e.c.reap.Interval = 24 * time.Hour
	e.procEntry(100, "claude", 1, 777, 10)
	e.procEntry(101, "bash", 1, 778, 10)
	e.procEntryState(102, "claude", "Z", 1, 779, 10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = e.c.Run(ctx) }()
	const a, b, c, d, z = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000c", "00000000-0000-4000-8000-00000000000d", "00000000-0000-4000-8000-00000000000e"
	registerChannel(t, e, a, "100")
	registerChannel(t, e, b, "101")
	registerChannel(t, e, c, "")
	registerChannel(t, e, d, "1")
	registerChannel(t, e, z, "102")
	log := e.logText()
	for _, want := range []string{
		"reap: session " + b + " registered pid 101, which is not a claude process; it will not be reaped",
		"reap: session " + c + ` registered no usable pid (""); it will not be reaped`,
		"reap: session " + d + ` registered no usable pid ("1"); it will not be reaped`,
		"reap: session " + z + " registered pid 102, which is not a claude process; it will not be reaped",
	} {
		if strings.Count(log, want) != 1 {
			t.Errorf("log %q: want %q once", log, want)
		}
	}
	if strings.Contains(log, a) {
		t.Errorf("log %q: said something about a session that will be reaped normally", log)
	}
}

// With reaping off a registration neither reads /proc nor says anything about
// reaping: a real claude process is on offer and still no pid is kept.
func TestRegistrationReadsNoPidWhenReapingIsOff(t *testing.T) {
	e := newReapEnv(t)
	e.c.reap.Enabled = false
	e.c.socketPath = testsock.Path(t, "ch.sock")
	e.procEntry(100, "claude", 1, 777, 10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = e.c.Run(ctx) }()
	const id = "00000000-0000-4000-8000-00000000000a"
	registerChannel(t, e, id, "100")
	registerChannel(t, e, "00000000-0000-4000-8000-00000000000b", "abc")
	e.c.mu.Lock()
	pid := e.c.registered[id].pid
	e.c.mu.Unlock()
	if pid != 0 || strings.Contains(e.logText(), "reap:") {
		t.Errorf("pid kept %d, log %q: want nothing read and nothing said with reaping off", pid, e.logText())
	}
}

// Run ticks the reaper every Interval when reaping is on, one stop per tick and
// none before the first Interval has passed, and never when it is off.
func TestRunTicksTheReaperEveryIntervalOnlyWhenEnabled(t *testing.T) {
	const interval = 150 * time.Millisecond
	for _, enabled := range []bool{true, false} {
		e := newReapEnv(t)
		e.c.reap = config.Reap{Enabled: enabled, Interval: interval}
		e.c.socketPath = testsock.Path(t, "ch.sock")
		type stop struct {
			pid int
			at  time.Time
		}
		stops := make(chan stop, 8)
		e.c.kill = func(pid int) error { stops <- stop{pid, time.Now()}; return nil }
		e.session("00000000-0000-4000-8000-000000000001", 100, goodStart, answered("1", time.Now().Add(-5*time.Hour)))
		e.session("00000000-0000-4000-8000-000000000002", 200, goodStart, answered("2", time.Now().Add(-4*time.Hour)))
		e.procEntry(100, "claude", 1, goodStart, 10)
		e.procEntry(200, "claude", 1, goodStart, 10)
		ctx, cancel := context.WithCancel(context.Background())
		began := time.Now()
		done := make(chan struct{})
		go func() { _ = e.c.Run(ctx); close(done) }()
		var got []stop
		for deadline := time.After(1500 * time.Millisecond); len(got) < 2; {
			select {
			case s := <-stops:
				got = append(got, s)
				continue
			case <-deadline:
			case <-time.After(600 * time.Millisecond):
			}
			break
		}
		cancel()
		<-done
		if !enabled {
			if len(got) != 0 {
				t.Errorf("reaping off: signalled %v", got)
			}
			continue
		}
		if len(got) != 2 || got[0].pid != 100 || got[1].pid != 200 {
			t.Fatalf("signalled %v, want 100 then 200, one per tick", got)
		}
		if got[0].at.Sub(began) < interval {
			t.Errorf("first stop after %v, want at least one interval (%v) first", got[0].at.Sub(began), interval)
		}
		if got[1].at.Sub(got[0].at) < interval {
			t.Errorf("second stop %v after the first, want at least one interval (%v) between", got[1].at.Sub(got[0].at), interval)
		}
	}
}

// Run does not return until the reaper's loop has: a stop still in flight is not
// left running against a directory its caller is about to remove.
func TestRunWaitsForTheReapLoop(t *testing.T) {
	e := newReapEnv(t)
	e.c.reap = config.Reap{Enabled: true, Interval: 20 * time.Millisecond}
	e.c.socketPath = testsock.Path(t, "ch.sock")
	entered, release := make(chan struct{}), make(chan struct{})
	e.c.kill = func(int) error {
		close(entered)
		<-release
		return nil
	}
	e.session("00000000-0000-4000-8000-000000000001", 100, goodStart, answered("1", time.Now().Add(-5*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = e.c.Run(ctx); close(done) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the reaper never reached the signal")
	}
	cancel()
	select {
	case <-done:
		t.Fatal("Run returned while the reap loop was still in a stop")
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after the loop finished")
	}
}

// A candidate whose channel closed during the walk is skipped; the next one goes.
func TestReapSkipsACandidateThatUnregisteredDuringTheWalk(t *testing.T) {
	e := newReapEnv(t)
	const a, b = "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"
	e.session(a, 100, goodStart, answered("1", reapNow.Add(-5*time.Hour)))
	e.session(b, 300, goodStart, answered("2", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.procEntry(300, "claude", 1, goodStart, 10)
	first := true
	e.c.beforeSignal = func() {
		if first {
			first = false
			e.c.mu.Lock()
			delete(e.c.registered, a)
			delete(e.c.channels, a)
			e.c.mu.Unlock()
		}
	}
	e.c.reapOnce(reapNow)
	if fmt.Sprint(e.killed) != "[300]" || e.reapedFile(a) != "" {
		t.Errorf("signalled %v, a=%q: want only 300", e.killed, e.reapedFile(a))
	}
}

// Where the reaped file cannot be written, the in-memory flag alone keeps a claude
// that ignored SIGTERM from being signalled on every tick.
func TestReapSignalsOnceEvenWhenTheRecordCannotBeWritten(t *testing.T) {
	e := newReapEnv(t)
	const id = "00000000-0000-4000-8000-000000000001"
	if err := os.MkdirAll(filepath.Join(e.home, "sessions", id, "reaped"), 0o700); err != nil { // a directory in the file's place
		t.Fatal(err)
	}
	e.session(id, 100, goodStart, answered("1", reapNow.Add(-3*time.Hour)))
	e.procEntry(100, "claude", 1, goodStart, 10)
	e.c.reapOnce(reapNow)
	e.c.reapOnce(reapNow.Add(time.Minute))
	if fmt.Sprint(e.killed) != "[100]" {
		t.Errorf("signalled %v over two ticks, want 100 once", e.killed)
	}
	if !strings.Contains(e.logText(), "reap: writing the record of "+id) {
		t.Errorf("log %q: want the failed write said", e.logText())
	}
}
