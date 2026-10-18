package resume

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

const (
	idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	idC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

// fakeCenter records what the concern sends and answers ClaimResume from a queue.
type fakeCenter struct {
	mu        sync.Mutex
	ingested  []*ccxv1.Event
	ingestErr error
	claims    []*ccxv1.ClaimResumeRequest
	queue     []*ccxv1.ResumeRequest
	finished  []*ccxv1.FinishResumeRequest
}

func (f *fakeCenter) Ingest(_ context.Context, r *connect.Request[ccxv1.IngestRequest]) (*connect.Response[ccxv1.IngestResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ingestErr != nil {
		return nil, f.ingestErr
	}
	f.ingested = append(f.ingested, r.Msg.Events...)
	return connect.NewResponse(&ccxv1.IngestResponse{Accepted: uint32(len(r.Msg.Events))}), nil
}

func (f *fakeCenter) ClaimResume(_ context.Context, r *connect.Request[ccxv1.ClaimResumeRequest]) (*connect.Response[ccxv1.ClaimResumeResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claims = append(f.claims, r.Msg)
	res := &ccxv1.ClaimResumeResponse{}
	if len(f.queue) > 0 {
		res.Request, f.queue = f.queue[0], f.queue[1:]
	}
	return connect.NewResponse(res), nil
}

func (f *fakeCenter) FinishResume(_ context.Context, r *connect.Request[ccxv1.FinishResumeRequest]) (*connect.Response[ccxv1.FinishResumeResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finished = append(f.finished, r.Msg)
	return connect.NewResponse(&ccxv1.FinishResumeResponse{}), nil
}

type runCall struct {
	id    string
	force bool
	wait  uint32
}

func newConcern(t *testing.T, home string, c *fakeCenter, clock *time.Time, run RunFunc) *Resume {
	t.Helper()
	return New(Options{
		Machine:     "m1",
		User:        "dev",
		DefaultHome: home,
		Center:      c,
		Run:         run,
		Interval:    60 * time.Second,
		Poll:        5 * time.Second,
		Now:         func() time.Time { return *clock },
		Log:         t.Logf,
	})
}

func writeSession(t *testing.T, home string, pid int, body string) {
	t.Helper()
	dir := filepath.Join(home, "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, strconv.Itoa(pid)+".json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// selfStart is /proc/self/stat field 22 (starttime), the value Claude Code writes as procStart.
func selfStart(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		t.Skip("no /proc")
	}
	s := string(b)
	return strings.Fields(s[strings.LastIndex(s, ")")+2:])[19]
}

// deadPID is the pid of a child that has already been reaped.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func TestRunningIDsKeepsOnlyLiveProcesses(t *testing.T) {
	home := t.TempDir()
	me := os.Getpid()
	writeSession(t, home, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idB+`","procStart":"`+selfStart(t)+`"}`)
	writeSession(t, home, me+1_000_000, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idA+`"}`)
	dead := deadPID(t)
	writeSession(t, home, dead, `{"pid":`+strconv.Itoa(dead)+`,"sessionId":"`+idC+`"}`)
	writeSession(t, home, 7, `{not json`)

	got, err := RunningIDs(home)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != idA+","+idB {
		t.Fatalf("got %v, want [%s %s] (sorted; the dead pid and the broken file left out)", got, idA, idB)
	}
}

// A pid that has been reused by another process is not the session: procStart has to match.
func TestRunningIDsRejectsAReusedPID(t *testing.T) {
	selfStart(t)
	home := t.TempDir()
	me := os.Getpid()
	writeSession(t, home, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idA+`","procStart":"1"}`)

	got, err := RunningIDs(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("got %v, want none (procStart does not match this process)", got)
	}
}

func TestRunningIDsWithNoSessionsDirIsEmpty(t *testing.T) {
	got, err := RunningIDs(t.TempDir())
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v; want empty, nil", got, err)
	}
}

func runningPayload(t *testing.T, e *ccxv1.Event) []string {
	t.Helper()
	var p struct {
		SessionIDs []string `json:"session_ids"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		t.Fatalf("payload %q: %v", e.Payload, err)
	}
	if p.SessionIDs == nil {
		t.Fatalf("payload %q has no session_ids array", e.Payload)
	}
	return p.SessionIDs
}

func TestTickReportsTheRunningList(t *testing.T) {
	home := t.TempDir()
	me := os.Getpid()
	writeSession(t, home, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idA+`"}`)
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, home, c, &clock, func(context.Context, string, bool, uint32) (int, string) { return 0, "" })

	r.Tick(context.Background())

	if len(c.ingested) != 1 {
		t.Fatalf("ingested %d events, want 1", len(c.ingested))
	}
	e := c.ingested[0]
	if e.Producer != ccxv1.Producer_PRODUCER_CCX_AGENT_RUNNING {
		t.Fatalf("producer %v", e.Producer)
	}
	if e.Origin.GetMachine() != "m1" || e.Origin.GetUser() != "dev" {
		t.Fatalf("origin %v", e.Origin)
	}
	if u, err := uuid.Parse(e.EventId); err != nil || u.Version() != 7 || u.String() != e.EventId {
		t.Fatalf("event id %q is not a lowercase UUIDv7", e.EventId)
	}
	if e.ReceivedAt.AsTime().Unix() != 1_800_000_000 {
		t.Fatalf("received_at %v, want the concern's clock", e.ReceivedAt.AsTime())
	}
	if got := runningPayload(t, e); len(got) != 1 || got[0] != idA {
		t.Fatalf("session_ids %v", got)
	}
}

func TestTickSendsAnEmptyListAsAnArray(t *testing.T) {
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) { return 0, "" })
	r.Tick(context.Background())
	if len(c.ingested) != 1 || len(runningPayload(t, c.ingested[0])) != 0 {
		t.Fatalf("want one event with session_ids = [], got %d events", len(c.ingested))
	}
}

func TestTickResendsOnlyOnChangeOrAfterTheInterval(t *testing.T) {
	home := t.TempDir()
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, home, c, &clock, func(context.Context, string, bool, uint32) (int, string) { return 0, "" })

	r.Tick(context.Background())
	clock = clock.Add(59 * time.Second)
	r.Tick(context.Background())
	if len(c.ingested) != 1 {
		t.Fatalf("same list within the interval: %d events, want 1", len(c.ingested))
	}

	clock = clock.Add(1 * time.Second)
	r.Tick(context.Background())
	if len(c.ingested) != 2 {
		t.Fatalf("interval elapsed: %d events, want 2", len(c.ingested))
	}

	clock = clock.Add(5 * time.Second)
	me := os.Getpid()
	writeSession(t, home, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idA+`"}`)
	r.Tick(context.Background())
	if len(c.ingested) != 3 {
		t.Fatalf("list changed: %d events, want 3", len(c.ingested))
	}
}

func TestTickRetriesAFailedReportOnTheNextTick(t *testing.T) {
	c := &fakeCenter{ingestErr: errors.New("center down")}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) { return 0, "" })

	r.Tick(context.Background())
	c.ingestErr = nil
	clock = clock.Add(5 * time.Second)
	r.Tick(context.Background())

	if len(c.ingested) != 1 {
		t.Fatalf("after a failed send the next tick must send again: %d events, want 1", len(c.ingested))
	}
}

func TestTickRunsAClaimedRequestAndFinishesIt(t *testing.T) {
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-1", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}, Force: true, ClaimToken: "tok-1", WaitSeconds: 90}}}
	clock := time.Unix(1_800_000_000, 0)
	var calls []runCall
	r := newConcern(t, t.TempDir(), c, &clock, func(_ context.Context, id string, force bool, wait uint32) (int, string) {
		calls = append(calls, runCall{id, force, wait})
		return 0, "opened wRK pane=wRK:p1 x (/w)\n"
	})

	r.Tick(context.Background())

	if len(c.claims) != 1 || c.claims[0].Machine != "m1" || c.claims[0].User != "dev" {
		t.Fatalf("claims %v, want one for m1/dev", c.claims)
	}
	if len(calls) != 1 || calls[0] != (runCall{idA, true, 90}) {
		t.Fatalf("run calls %v", calls)
	}
	if len(c.finished) != 1 {
		t.Fatalf("finished %d, want 1", len(c.finished))
	}
	f := c.finished[0]
	if f.Id != "req-1" || f.ClaimToken != "tok-1" || f.Outcome != ccxv1.ResumeOutcome_RESUME_OUTCOME_OPENED || f.ExitCode != 0 || f.Detail != "opened wRK pane=wRK:p1 x (/w)" {
		t.Fatalf("finish %v", f)
	}
}

func TestTickReportsAFailedResumeWithItsExitCode(t *testing.T) {
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-2", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}}}}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) {
		return 3, "workspace wRK was created ..."
	})

	r.Tick(context.Background())

	f := c.finished[0]
	if f.Outcome != ccxv1.ResumeOutcome_RESUME_OUTCOME_FAILED || f.ExitCode != 3 || f.Detail != "workspace wRK was created ..." {
		t.Fatalf("finish %v", f)
	}
}

func TestTickWithNothingClaimedRunsNothing(t *testing.T) {
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	ran := 0
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) { ran++; return 0, "" })
	r.Tick(context.Background())
	if ran != 0 || len(c.finished) != 0 || len(c.claims) != 1 {
		t.Fatalf("ran %d, finished %d, claims %d; want 0, 0, 1", ran, len(c.finished), len(c.claims))
	}
}

// A request whose id is not a session id is never handed to the command line.
func TestTickRefusesARequestThatIsNotASessionID(t *testing.T) {
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-3", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: "--help"}}}}
	clock := time.Unix(1_800_000_000, 0)
	ran := 0
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) { ran++; return 0, "" })

	r.Tick(context.Background())

	if ran != 0 {
		t.Fatalf("ran the command for %q", "--help")
	}
	if len(c.finished) != 1 || c.finished[0].Outcome != ccxv1.ResumeOutcome_RESUME_OUTCOME_FAILED {
		t.Fatalf("want one FAILED finish, got %v", c.finished)
	}
}

func TestDetailKeepsTheLast4KiB(t *testing.T) {
	long := strings.Repeat("a", 5000) + "END"
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-4", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}}}}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) { return 1, long })

	r.Tick(context.Background())

	d := c.finished[0].Detail
	if len(d) != 4096 || !strings.HasSuffix(d, "END") {
		t.Fatalf("detail is %d bytes (suffix %q), want the last 4096", len(d), d[len(d)-3:])
	}
}

// Sessions run under more than one Claude home (CLAUDE_CONFIG_DIR per account):
// the running list is the union, and a session id is lowercased.
func TestRunningIDsReadsEveryHome(t *testing.T) {
	h1, h2 := t.TempDir(), t.TempDir()
	me := os.Getpid()
	writeSession(t, h1, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idB+`"}`)
	writeSession(t, h2, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+strings.ToUpper(idA)+`"}`)
	writeSession(t, h2, me+1, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idB+`"}`)

	got, err := RunningIDs(h1, h2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != idA+","+idB {
		t.Fatalf("got %v, want [%s %s]", got, idA, idB)
	}
}

// kill(-1, 0) succeeds (it addresses every process), so a pid of 0 or below must
// never read as alive.
func TestRunningIDsRejectsNonPositivePIDs(t *testing.T) {
	home := t.TempDir()
	writeSession(t, home, 1, `{"pid":-1,"sessionId":"`+idA+`"}`)
	writeSession(t, home, 2, `{"pid":0,"sessionId":"`+idB+`"}`)
	got, err := RunningIDs(home)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v; want none", got, err)
	}
}

// The homes the concern reads are the ones hooks have shown it, plus the default.
func TestNoticeLearnsTheHomeFromATranscriptPath(t *testing.T) {
	def, other := t.TempDir(), t.TempDir()
	me := os.Getpid()
	writeSession(t, other, me, `{"pid":`+strconv.Itoa(me)+`,"sessionId":"`+idA+`"}`)
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := New(Options{Machine: "m1", User: "dev", DefaultHome: def, Center: c, Interval: time.Minute, Poll: time.Second,
		Now: func() time.Time { return clock }, Log: t.Logf, Run: func(context.Context, string, bool, uint32) (int, string) { return 0, "" }})

	r.Notice([]byte(`{"session_id":"` + idA + `","transcript_path":"` + filepath.Join(other, "projects", "-w", idA+".jsonl") + `"}`))
	r.Notice([]byte(`{"session_id":"` + idA + `","transcript_path":"/etc/passwd"}`))
	r.Notice([]byte(`{"session_id":"` + idA + `","transcript_path":"` + filepath.Join(t.TempDir(), "notprojects", "-w", idA+".jsonl") + `"}`))
	r.Notice([]byte(`not json`))
	r.Report(context.Background())

	if got := runningPayload(t, c.ingested[0]); len(got) != 1 || got[0] != idA {
		t.Fatalf("session_ids %v, want [%s] from the learned home", got, idA)
	}
	if hs := r.homes(); len(hs) != 2 || hs[0] != def || hs[1] != other {
		t.Fatalf("homes %v, want [%s %s] (the bad path ignored)", hs, def, other)
	}
}

// A resume that blocks must not stop the running list: the center reads a
// silent agent as gone after five minutes.
func TestRunKeepsReportingWhileAResumeRuns(t *testing.T) {
	release := make(chan struct{})
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-9", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}, ClaimToken: "t"}}}
	r := New(Options{Machine: "m1", User: "dev", DefaultHome: t.TempDir(), Center: c, Interval: 20 * time.Millisecond, Poll: 5 * time.Millisecond, Log: t.Logf,
		Run: func(context.Context, string, bool, uint32) (int, string) { <-release; return 0, "" }})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.Run(ctx); close(done) }()

	deadline := time.Now().Add(2 * time.Second)
	for {
		c.mu.Lock()
		n := len(c.ingested)
		c.mu.Unlock()
		if n >= 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d running lists sent while a resume was running", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	cancel()
	<-done
}

func TestDetailNeverSplitsAMultiByteCharacter(t *testing.T) {
	long := strings.Repeat("あ", 2000) + "END"
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-5", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}}}}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool, uint32) (int, string) { return 4, long })

	r.Tick(context.Background())

	d := c.finished[0].Detail
	if !utf8.ValidString(d) || len(d) > 4096 || len(d) < 4090 || !strings.HasSuffix(d, "END") {
		t.Fatalf("detail is %d bytes, valid UTF-8 %v; want the valid tail of at most 4096 bytes", len(d), utf8.ValidString(d))
	}
}

func TestNewDefaultsTheLog(t *testing.T) {
	r := New(Options{Machine: "m1", User: "dev", DefaultHome: t.TempDir(), Center: &fakeCenter{ingestErr: errors.New("down")},
		Run: func(context.Context, string, bool, uint32) (int, string) { return 0, "" }})
	r.Tick(context.Background())
}

func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCommandRunnerPassesTheArgumentsAndTheExitCode(t *testing.T) {
	dir := t.TempDir()
	ccx := writeScript(t, dir, "ccx", `echo "args: $*"; exit 4`)
	code, out := CommandRunner(ccx, nil)(context.Background(), idA, true, 90)
	if code != 4 || strings.TrimSpace(out) != "args: session resume "+idA+" --force --wait 90" {
		t.Fatalf("code %d out %q", code, out)
	}
	code, out = CommandRunner(ccx, nil)(context.Background(), idA, false, 0)
	if code != 4 || strings.TrimSpace(out) != "args: session resume "+idA {
		t.Fatalf("without force and wait: code %d out %q", code, out)
	}
}

func TestCommandRunnerStopsAtItsTimeout(t *testing.T) {
	ccx := writeScript(t, t.TempDir(), "ccx", `echo started; exec sleep 5`)
	start := time.Now()
	code, out := CommandRunner(ccx, func(uint32) time.Duration { return 200 * time.Millisecond })(context.Background(), idA, false, 0)
	if code != 1 || !strings.Contains(out, "did not finish") || time.Since(start) > 3*time.Second {
		t.Fatalf("code %d out %q after %v", code, out, time.Since(start))
	}
}

func TestCommandRunnerSaysWhenItCannotStart(t *testing.T) {
	code, out := CommandRunner(filepath.Join(t.TempDir(), "no-ccx"), nil)(context.Background(), idA, false, 0)
	if code != 1 || !strings.Contains(out, "could not run") {
		t.Fatalf("code %d out %q", code, out)
	}
}

// The run's limit leaves the CLI's own wait (40 s by default) a minute on top.
func TestDefaultRunTimeoutFollowsTheWait(t *testing.T) {
	if got := DefaultRunTimeout(0); got != 100*time.Second {
		t.Fatalf("wait 0: %v, want 100s", got)
	}
	if got := DefaultRunTimeout(300); got != 360*time.Second {
		t.Fatalf("wait 300: %v, want 360s", got)
	}
}

func TestFindCCXFallsBackToPATHAndSaysNothingWhenThereIsNone(t *testing.T) {
	dir := t.TempDir()
	writeScript(t, dir, "ccx", "true")
	t.Setenv("PATH", dir)
	if got := FindCCX(); got != filepath.Join(dir, "ccx") {
		t.Fatalf("FindCCX() = %q, want the one on PATH", got)
	}
	t.Setenv("PATH", t.TempDir())
	if got := FindCCX(); got != "" {
		t.Fatalf("FindCCX() = %q, want empty", got)
	}
}
