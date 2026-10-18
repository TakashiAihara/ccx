// Package resume is ccx-agent's side of reopening a stopped session (#261): it
// reports which of this user's sessions are running on this machine, and opens
// the ones the center asks for.
//
// Neither decision is made here. Which sessions are running is a fact only this
// machine knows, so the whole list is sent — when it changes, and again once
// the interval is up, because a list that stops arriving is how the center
// reads this agent as gone. Whether to reopen a stopped one is the center's
// call; what is left for this concern is to run `ccx session resume`, the same
// command a person would, and to hand back what the CLI said.
package resume

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/TakashiAihara/ccx/apps/agent/internal/hubauth"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// Center is the two services this concern speaks to: the running list goes to
// IngestService, the resume requests to ResumeService. The methods are the
// Connect clients' own, so one of them can be handed in as it is.
type Center interface {
	Ingest(context.Context, *connect.Request[ccxv1.IngestRequest]) (*connect.Response[ccxv1.IngestResponse], error)
	ClaimResume(context.Context, *connect.Request[ccxv1.ClaimResumeRequest]) (*connect.Response[ccxv1.ClaimResumeResponse], error)
	FinishResume(context.Context, *connect.Request[ccxv1.FinishResumeRequest]) (*connect.Response[ccxv1.FinishResumeResponse], error)
}

// callTimeout bounds one call to the center. Without it a center that accepts
// the connection and never answers holds a tick forever: no list is reported and
// no request is claimed until the agent restarts (collect's forward loop bounds
// its calls the same way).
const callTimeout = 30 * time.Second

type connectCenter struct {
	ingest ccxv1connect.IngestServiceClient
	resume ccxv1connect.ResumeServiceClient
}

// NewCenter points the concern at the center that holds both the fleet view and
// the resume requests.
func NewCenter(hubURL, token string) Center {
	return &connectCenter{
		ingest: ccxv1connect.NewIngestServiceClient(http.DefaultClient, hubURL, hubauth.Options(token)...),
		resume: ccxv1connect.NewResumeServiceClient(http.DefaultClient, hubURL, hubauth.Options(token)...),
	}
}

func (c *connectCenter) Ingest(ctx context.Context, r *connect.Request[ccxv1.IngestRequest]) (*connect.Response[ccxv1.IngestResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return c.ingest.Ingest(ctx, r)
}

func (c *connectCenter) ClaimResume(ctx context.Context, r *connect.Request[ccxv1.ClaimResumeRequest]) (*connect.Response[ccxv1.ClaimResumeResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return c.resume.ClaimResume(ctx, r)
}

func (c *connectCenter) FinishResume(ctx context.Context, r *connect.Request[ccxv1.FinishResumeRequest]) (*connect.Response[ccxv1.FinishResumeResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return c.resume.FinishResume(ctx, r)
}

// RunFunc opens one session and says how it went. It is the one thing this
// concern does not do itself, so a test can stand in for the command.
type RunFunc func(ctx context.Context, sessionID string, force bool) (exitCode int, output string)

// Options builds the concern. Machine and User are this agent's origin: the
// center keys both the list and the requests by them.
type Options struct {
	Machine    string
	User       string
	ClaudeHome string
	Center     Center
	Run        RunFunc
	// Interval is how often the unchanged list is sent again.
	Interval time.Duration
	// Poll is how often the center is asked whether anything is to be opened.
	Poll time.Duration
	Now  func() time.Time
	Log  func(string, ...any)
}

const (
	defaultInterval = time.Minute
	defaultPoll     = 5 * time.Second
)

// New builds the concern. A zero Interval, Poll or Now takes the default, so a
// caller that cares about one of them need not spell out the rest.
func New(o Options) *Resume {
	if o.Interval == 0 {
		o.Interval = defaultInterval
	}
	if o.Poll == 0 {
		o.Poll = defaultPoll
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Resume{opts: o}
}

// Resume is the concern. One goroutine touches it (Run), so its state needs no
// lock.
type Resume struct {
	opts Options

	// sent is the list the center last took and sentAt when it took it. The
	// interval runs from that send, so a failed one leaves the list unsent and
	// the next tick sends it again — the center needs the list again after an
	// outage, not just after a change. sentAt starts at the zero time, so the
	// first tick always sends, an empty list included.
	sent   []string
	sentAt time.Time
}

// Name identifies the concern in logs and config (ADR 0002).
func (r *Resume) Name() string { return "resume" }

// Run polls until ctx is cancelled. None of what a tick does can be fatal — the
// center calls and the command fail on their own and are picked up again by the
// next tick — so the concern stops only with the process.
func (r *Resume) Run(ctx context.Context) error {
	t := time.NewTicker(r.opts.Poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			r.Tick(ctx)
		}
	}
}

// Tick is one pass: report what is running here, then open a session if the
// center has one to open.
func (r *Resume) Tick(ctx context.Context) {
	r.report(ctx)
	r.claim(ctx)
}

// runningList is the running list's JSON. The array is never null: an empty
// list says nothing is running here, which is not the same as the key missing.
type runningList struct {
	SessionIDs []string `json:"session_ids"`
}

func (r *Resume) report(ctx context.Context) {
	ids, err := RunningIDs(r.opts.ClaudeHome)
	if err != nil {
		r.log("resume: could not read which sessions are running: %v", err)
		return
	}
	now := r.opts.Now()
	if slices.Equal(ids, r.sent) && now.Sub(r.sentAt) < r.opts.Interval {
		return
	}

	id, err := uuid.NewV7()
	if err != nil {
		// Only a broken system RNG, and nothing is sent, so the next tick tries
		// again with a fresh id.
		r.log("resume: could not mint an event id: %v", err)
		return
	}
	payload, err := json.Marshal(runningList{SessionIDs: ids})
	if err != nil {
		r.log("resume: could not encode the running sessions: %v", err)
		return
	}

	// Seq is left at zero: this list is not a hook event and never goes through
	// the spool, so there is no local order to give it.
	ev := &ccxv1.Event{
		Origin:     &ccxv1.Origin{Machine: r.opts.Machine, User: r.opts.User},
		EventId:    id.String(),
		ReceivedAt: timestamppb.New(now),
		Producer:   ccxv1.Producer_PRODUCER_CCX_AGENT_RUNNING,
		Payload:    payload,
	}
	if _, err := r.opts.Center.Ingest(ctx, connect.NewRequest(&ccxv1.IngestRequest{Events: []*ccxv1.Event{ev}})); err != nil {
		r.log("resume: reporting the running sessions failed, sending them again: %v", err)
		return
	}
	r.sent, r.sentAt = ids, now
}

// sessionID is the shape Claude Code gives a session — the shape the transcript's
// file name uses too. The claimed id becomes an argument on a command line, so
// anything else is refused rather than quoted.
var sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// claim opens the oldest request addressed to this machine and user, if there is
// one. An answer without a request means there was nothing to take.
func (r *Resume) claim(ctx context.Context) {
	res, err := r.opts.Center.ClaimResume(ctx, connect.NewRequest(&ccxv1.ClaimResumeRequest{
		Machine: r.opts.Machine,
		User:    r.opts.User,
	}))
	if err != nil {
		r.log("resume: claiming a request failed: %v", err)
		return
	}
	req := res.Msg.GetRequest()
	if req == nil {
		return
	}

	id := req.GetKey().GetSessionId()
	if !sessionID.MatchString(id) {
		// Nothing is run for an id that cannot name a session: the CLI would
		// answer about its own arguments instead of about a session.
		r.finish(ctx, req.GetId(), ccxv1.ResumeOutcome_RESUME_OUTCOME_FAILED,
			fmt.Sprintf("%q is not a session id, so there is nothing to open", id), 1)
		return
	}

	code, out := r.opts.Run(ctx, id, req.GetForce())
	outcome := ccxv1.ResumeOutcome_RESUME_OUTCOME_OPENED
	if code != 0 {
		outcome = ccxv1.ResumeOutcome_RESUME_OUTCOME_FAILED
	}
	r.finish(ctx, req.GetId(), outcome, detailOf(out), int32(code))
}

func (r *Resume) finish(ctx context.Context, id string, outcome ccxv1.ResumeOutcome, detail string, exitCode int32) {
	_, err := r.opts.Center.FinishResume(ctx, connect.NewRequest(&ccxv1.FinishResumeRequest{
		Id:       id,
		Outcome:  outcome,
		Detail:   detail,
		ExitCode: exitCode,
	}))
	if err != nil {
		// The request stays claimed and the center offers it again after its
		// own deadline, so the loss is a repeat of the work, not a silent end.
		r.log("resume: finishing %s failed: %v", id, err)
	}
}

func (r *Resume) log(format string, a ...any) { r.opts.Log(format, a...) }

// detailCap is how much of a resume's output the center keeps. What says why a
// resume failed is at the end of it, so a longer output is cut from the front.
const detailCap = 4096

func detailOf(out string) string {
	d := strings.TrimSpace(out)
	if len(d) > detailCap {
		return d[len(d)-detailCap:]
	}
	return d
}

// runTimeout bounds one resume. The CLI answers once the pane is up; past this
// the request is finished as failed, so the center stops waiting on it and the
// detail says the command was still running.
const runTimeout = 2 * time.Minute

// CommandRunner resumes through the ccx CLI and passes its answer on as it is:
// the CLI's exit code is the outcome, its output the detail. The agent decides
// nothing about how a session is opened.
func CommandRunner(ccxPath string) RunFunc {
	return func(ctx context.Context, sessionID string, force bool) (int, string) {
		ctx, cancel := context.WithTimeout(ctx, runTimeout)
		defer cancel()

		args := []string{"session", "resume", sessionID}
		if force {
			args = append(args, "--force")
		}
		out, err := exec.CommandContext(ctx, ccxPath, args...).CombinedOutput()
		switch {
		case err == nil:
			return 0, string(out)
		case ctx.Err() != nil:
			// What a killed process reports is the signal, which says nothing
			// about the resume; the deadline is the reason.
			return 1, fmt.Sprintf("%s\nccx session resume did not finish in %s", strings.TrimSpace(string(out)), runTimeout)
		default:
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				return 1, fmt.Sprintf("could not run %s: %v", ccxPath, err)
			}
			if code := exit.ExitCode(); code >= 0 {
				return code, string(out)
			}
			// Killed by something else: there is no exit code to pass on.
			return 1, strings.TrimSpace(string(out) + "\n" + exit.Error())
		}
	}
}

// FindCCX is the ccx to resume with: the one beside this binary, since an
// install puts them together, or the one on PATH. "" when there is neither —
// the concern then has nothing to run and stays off.
func FindCCX() string {
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		beside := filepath.Join(filepath.Dir(exe), "ccx")
		if info, err := os.Stat(beside); err == nil && !info.IsDir() {
			return beside
		}
	}
	if path, err := exec.LookPath("ccx"); err == nil {
		return path
	}
	return ""
}

// sessionFile is how Claude Code names what it writes per running session.
var sessionFile = regexp.MustCompile(`^[0-9]+\.json$`)

// RunningIDs are the sessions running under this Claude home, sorted.
//
// Claude Code writes sessions/<pid>.json per running session, but the file alone
// is not the answer: a session that was killed leaves one behind, and the kernel
// reuses pid numbers. The judgement made here is the CLI's runningSessionIds, so
// the two agree on what "running" means.
func RunningIDs(claudeHome string) ([]string, error) {
	ids := []string{}
	dir := filepath.Join(claudeHome, "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return ids, nil
		}
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !sessionFile.MatchString(e.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		// Gone or unreadable: nothing to say about it.
		if err != nil {
			continue
		}
		var f struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
			ProcStart string `json:"procStart"`
		}
		if json.Unmarshal(b, &f) != nil || f.PID == 0 || f.SessionID == "" {
			continue
		}
		if pidAlive(f.PID, f.ProcStart) && !slices.Contains(ids, f.SessionID) {
			ids = append(ids, f.SessionID)
		}
	}
	slices.Sort(ids)
	return ids, nil
}

// pidAlive says whether pid is still that session's process. kill(pid, 0) only
// says some process has the number, and the kernel reuses numbers, so the start
// time Claude Code recorded settles it: a match means the session, anything else
// means a process that took the number after it. EPERM says it exists (not this
// user's); only ESRCH says it is gone.
func pidAlive(pid int, procStart string) bool {
	if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return false
	}
	if procStart == "" {
		return true
	}
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	// No /proc to ask: the kill answer is all there is.
	if err != nil {
		return true
	}
	// comm can hold spaces, so the fields are counted from the closing paren:
	// starttime is the 20th after it.
	i := strings.LastIndexByte(string(stat), ')')
	if i < 0 {
		return true
	}
	fields := strings.Fields(string(stat)[i+2:])
	return len(fields) > 19 && fields[19] == procStart
}
