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
}

func newConcern(t *testing.T, home string, c *fakeCenter, clock *time.Time, run RunFunc) *Resume {
	t.Helper()
	return New(Options{
		Machine:    "m1",
		User:       "dev",
		ClaudeHome: home,
		Center:     c,
		Run:        run,
		Interval:   60 * time.Second,
		Poll:       5 * time.Second,
		Now:        func() time.Time { return *clock },
		Log:        t.Logf,
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
	r := newConcern(t, home, c, &clock, func(context.Context, string, bool) (int, string) { return 0, "" })

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
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool) (int, string) { return 0, "" })
	r.Tick(context.Background())
	if len(c.ingested) != 1 || len(runningPayload(t, c.ingested[0])) != 0 {
		t.Fatalf("want one event with session_ids = [], got %d events", len(c.ingested))
	}
}

func TestTickResendsOnlyOnChangeOrAfterTheInterval(t *testing.T) {
	home := t.TempDir()
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, home, c, &clock, func(context.Context, string, bool) (int, string) { return 0, "" })

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
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool) (int, string) { return 0, "" })

	r.Tick(context.Background())
	c.ingestErr = nil
	clock = clock.Add(5 * time.Second)
	r.Tick(context.Background())

	if len(c.ingested) != 1 {
		t.Fatalf("after a failed send the next tick must send again: %d events, want 1", len(c.ingested))
	}
}

func TestTickRunsAClaimedRequestAndFinishesIt(t *testing.T) {
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-1", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}, Force: true}}}
	clock := time.Unix(1_800_000_000, 0)
	var calls []runCall
	r := newConcern(t, t.TempDir(), c, &clock, func(_ context.Context, id string, force bool) (int, string) {
		calls = append(calls, runCall{id, force})
		return 0, "opened wRK pane=wRK:p1 x (/w)\n"
	})

	r.Tick(context.Background())

	if len(c.claims) != 1 || c.claims[0].Machine != "m1" || c.claims[0].User != "dev" {
		t.Fatalf("claims %v, want one for m1/dev", c.claims)
	}
	if len(calls) != 1 || calls[0] != (runCall{idA, true}) {
		t.Fatalf("run calls %v", calls)
	}
	if len(c.finished) != 1 {
		t.Fatalf("finished %d, want 1", len(c.finished))
	}
	f := c.finished[0]
	if f.Id != "req-1" || f.Outcome != ccxv1.ResumeOutcome_RESUME_OUTCOME_OPENED || f.ExitCode != 0 || f.Detail != "opened wRK pane=wRK:p1 x (/w)" {
		t.Fatalf("finish %v", f)
	}
}

func TestTickReportsAFailedResumeWithItsExitCode(t *testing.T) {
	c := &fakeCenter{queue: []*ccxv1.ResumeRequest{{Id: "req-2", Key: &ccxv1.SessionKey{Machine: "m1", User: "dev", SessionId: idA}}}}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool) (int, string) {
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
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool) (int, string) { ran++; return 0, "" })
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
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool) (int, string) { ran++; return 0, "" })

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
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, string, bool) (int, string) { return 1, long })

	r.Tick(context.Background())

	d := c.finished[0].Detail
	if len(d) != 4096 || !strings.HasSuffix(d, "END") {
		t.Fatalf("detail is %d bytes (suffix %q), want the last 4096", len(d), d[len(d)-3:])
	}
}
