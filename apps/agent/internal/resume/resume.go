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
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

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

// RunRequest is one resume to run.
type RunRequest struct {
	SessionID string
	Force     bool
	// WaitSeconds is what the request asked the CLI to wait for; 0 means the
	// CLI's own default.
	WaitSeconds uint32
	// Home is the Claude home the session's transcript is under, when it is not
	// this process's own; "" leaves the CLI on its default.
	Home string
}

// RunFunc opens one session and says how it went. It is the one thing this
// concern does not do itself, so a test can stand in for the command.
type RunFunc func(ctx context.Context, req RunRequest) (exitCode int, output string)

// Options builds the concern. Machine and User are this agent's origin: the
// center keys both the list and the requests by them.
type Options struct {
	Machine string
	User    string
	// DefaultHome is this process's own ~/.claude. Sessions can run under
	// another one (CLAUDE_CONFIG_DIR per account); Notice learns those from the
	// hook payloads, and both are read.
	DefaultHome string
	// HomesFile keeps the learned homes across restarts (one per line). An idle
	// session under another home fires no hook after a restart, so without it
	// the session would read as stopped until it did. "" keeps them in memory.
	HomesFile string
	Center    Center
	Run       RunFunc
	// APIURL is where the center reaches this agent's API to wake it. It goes in
	// the running list, so the center only wakes an agent that said it can be
	// reached; "" leaves the list without it.
	APIURL string
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
	if o.Log == nil {
		o.Log = func(string, ...any) {}
	}
	r := &Resume{opts: o, wake: make(chan struct{}, 1)}
	r.loadHomes()
	return r
}

// maxLearnedHomes bounds what Notice keeps. Each home is read on every report,
// and the payloads come from this user's own hooks, so a few accounts is the
// expected size; past this a new home is not kept.
const maxLearnedHomes = 16

// loadHomes reads the homes an earlier run learned. A missing file is a first
// run; anything else unreadable is logged and the concern starts with none.
func (r *Resume) loadHomes() {
	if r.opts.HomesFile == "" {
		return
	}
	fi, err := os.Stat(r.opts.HomesFile)
	if err != nil {
		if !os.IsNotExist(err) {
			r.log("resume: could not read the learned Claude homes from %s: %v", r.opts.HomesFile, err)
		}
		return
	}
	// A home read from here becomes a CLAUDE_CONFIG_DIR a resume runs under, so the
	// file has to be this user's own and writable by no one else (as saveHomes
	// writes it).
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Getuid() || fi.Mode().Perm()&0o022 != 0 {
		r.log("resume: ignoring %s: it must be owned by this user and writable only by them", r.opts.HomesFile)
		return
	}
	b, err := os.ReadFile(r.opts.HomesFile)
	if err != nil {
		r.log("resume: could not read the learned Claude homes from %s: %v", r.opts.HomesFile, err)
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		home := strings.TrimSpace(line)
		if home == "" || home != filepath.Clean(home) || !filepath.IsAbs(home) || home == "/" ||
			home == r.opts.DefaultHome || slices.Contains(r.learned, home) || len(r.learned) >= maxLearnedHomes {
			continue
		}
		r.learned = append(r.learned, home)
	}
}

// saveHomes writes the learned homes next to the old file and renames it into
// place, so a crash mid-write leaves the previous list. Called with r.mu held.
func (r *Resume) saveHomes() {
	if r.opts.HomesFile == "" {
		return
	}
	// A temp name of its own: two agents of one user must not write the same temp file.
	f, err := os.CreateTemp(filepath.Dir(r.opts.HomesFile), filepath.Base(r.opts.HomesFile)+".*.tmp")
	if err != nil {
		r.log("resume: could not save the learned Claude homes: %v", err)
		return
	}
	_, werr := f.WriteString(strings.Join(r.learned, "\n") + "\n")
	cerr := f.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(f.Name())
		r.log("resume: could not save the learned Claude homes: %v", err)
		return
	}
	if err := os.Rename(f.Name(), r.opts.HomesFile); err != nil {
		_ = os.Remove(f.Name())
		r.log("resume: could not save the learned Claude homes: %v", err)
	}
}

// Resume is the concern. Report and Claim run in their own goroutines; only the
// homes Notice learned need a lock.
type Resume struct {
	opts Options

	// mu guards learned: a hook payload arrives on its own goroutine (Notice)
	// while a report may be reading the same list.
	mu sync.Mutex
	// learned are the Claude homes hook payloads have shown, in the order they
	// arrived. A home named again is kept once.
	learned []string

	// sent is the list the center last took and sentAt when it took it. The
	// interval runs from that send, so a failed one leaves the list unsent and
	// the next tick sends it again — the center needs the list again after an
	// outage, not just after a change. sentAt starts at the zero time, so the
	// first tick always sends, an empty list included.
	sent   []string
	sentAt time.Time

	// running counts the resumes Run has started and not finished.
	running atomic.Int32

	// wake holds at most one pending wake, so Wake never blocks and several
	// wakes before the claim loop runs make one claim.
	wake chan struct{}
}

// maxRunning bounds the resumes running at once. Each is a CLI, a workspace and
// a Claude Code session; past this the requests wait on the center.
const maxRunning = 4

// Name identifies the concern in logs and config (ADR 0002).
func (r *Resume) Name() string { return "resume" }

// Run polls until ctx is cancelled. None of what a tick does can be fatal — the
// center calls and the command fail on their own and are picked up again by the
// next tick — so the concern stops only with the process.
//
// Reporting and claiming are separate loops on purpose: a resume that runs for
// longer than a poll must not keep the running list from going out, since a
// list that stops arriving is how the center reads this agent as gone.
//
// Each claimed request runs in its own goroutine, so one resume that waits long
// for its agent does not leave the others to expire unclaimed. The center hands
// a request to one claim at a time, so two goroutines never run the same one.
func (r *Resume) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	// every runs tick on each poll and on each signal from wake. A nil wake
	// never fires.
	every := func(wake <-chan struct{}, tick func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			t := time.NewTicker(r.opts.Poll)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				case <-wake:
				}
				tick()
			}
		}()
	}
	every(nil, func() { r.Report(ctx) })
	every(r.wake, func() {
		// Full: leave the requests on the center, where another tick (or another
		// agent) takes them, rather than start more than maxRunning at once.
		if r.running.Load() >= maxRunning {
			return
		}
		if req := r.claim(ctx); req != nil {
			r.running.Add(1)
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer r.running.Add(-1)
				r.open(ctx, req)
			}()
		}
	})
	wg.Wait()
	return nil
}

// Tick is one pass: report what is running here, then open a session if the
// center has one to open.
func (r *Resume) Tick(ctx context.Context) {
	r.Report(ctx)
	r.Claim(ctx)
}

// Wake makes the claim loop look at the center now rather than at the next
// poll. It never blocks, and a wake already pending covers this one.
func (r *Resume) Wake() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// runningList is the running list's JSON. The array is never null: an empty
// list says nothing is running here, which is not the same as the key missing.
type runningList struct {
	SessionIDs []string `json:"session_ids"`
	// APIURL is left out when unset, so an agent without one reads as not wakeable.
	APIURL string `json:"api_url,omitempty"`
}

// Report sends what is running under every Claude home this agent knows.
//
// This process's own home has to be readable: without it the list would call
// every session there stopped. A learned home that cannot be read is skipped
// with a line in the log, so one bad home does not silence the whole list.
func (r *Resume) Report(ctx context.Context) {
	homes := r.homes()
	ids, err := RunningIDs(homes[0])
	if err != nil {
		r.log("resume: could not read which sessions are running: %v", err)
		return
	}
	for _, h := range homes[1:] {
		more, err := RunningIDs(h)
		if err != nil {
			r.log("resume: skipping the Claude home %s: %v", h, err)
			continue
		}
		ids = append(ids, more...)
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
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
	payload, err := json.Marshal(runningList{SessionIDs: ids, APIURL: r.opts.APIURL})
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

// Notice is what collect calls for every spooled payload. A session can run under
// a Claude home other than this process's own (CLAUDE_CONFIG_DIR per account), and
// the hook payload is where that home is named, so a path that can only be one
// session's transcript teaches the concern a home to read too. A payload that
// names no such path is not an error: most hooks carry none.
func (r *Resume) Notice(payload []byte) {
	var p struct {
		SessionID      string `json:"session_id"`
		TranscriptPath string `json:"transcript_path"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return
	}
	home, ok := homeOf(p.TranscriptPath, p.SessionID)
	if !ok {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if home == r.opts.DefaultHome || slices.Contains(r.learned, home) {
		return
	}
	if len(r.learned) >= maxLearnedHomes {
		r.log("resume: already reading %d learned Claude homes; not adding %s", maxLearnedHomes, home)
		return
	}
	r.learned = append(r.learned, home)
	r.saveHomes()
}

// homeOf is the Claude home a transcript path belongs to, and whether the path
// can only be that session's transcript: absolute and already clean, exactly
// <session_id>.jsonl, and in a directory under one named projects. That is the
// shape the live transcript opens too, and it is the same payload.
func homeOf(path, id string) (string, bool) {
	if !sessionID.MatchString(id) || path == "" || !filepath.IsAbs(path) || path != filepath.Clean(path) {
		return "", false
	}
	if filepath.Base(path) != id+".jsonl" {
		return "", false
	}
	projects := filepath.Dir(filepath.Dir(path))
	if filepath.Base(projects) != "projects" {
		return "", false
	}
	return filepath.Dir(projects), true
}

// homes are the Claude homes to read: this process's own first, then the ones
// hooks have shown, in the order they arrived.
func (r *Resume) homes() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.learned)+1)
	out = append(out, r.opts.DefaultHome)
	for _, h := range r.learned {
		if !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	return out
}

// Claim opens the oldest request addressed to this machine and user, if there is
// one, and waits for it. An answer without a request means there was nothing to take.
func (r *Resume) Claim(ctx context.Context) {
	if req := r.claim(ctx); req != nil {
		r.open(ctx, req)
	}
}

func (r *Resume) claim(ctx context.Context) *ccxv1.ResumeRequest {
	res, err := r.opts.Center.ClaimResume(ctx, connect.NewRequest(&ccxv1.ClaimResumeRequest{
		Machine: r.opts.Machine,
		User:    r.opts.User,
	}))
	if err != nil {
		r.log("resume: claiming a request failed: %v", err)
		return nil
	}
	return res.Msg.GetRequest()
}

// homeWith is the Claude home whose projects hold this session's transcript,
// looked for in the same order as the running list. "" when none does: the CLI
// then says there is no transcript, which is the answer.
func (r *Resume) homeWith(id string) string {
	// Not filepath.Glob: a learned home is a path from a payload, and a '[' or
	// '*' in it would be read as a pattern.
	for _, h := range r.homes() {
		dirs, err := os.ReadDir(filepath.Join(h, "projects"))
		if err != nil {
			continue
		}
		for _, d := range dirs {
			if fi, err := os.Stat(filepath.Join(h, "projects", d.Name(), id+".jsonl")); err == nil && fi.Mode().IsRegular() {
				return h
			}
		}
	}
	return ""
}

func (r *Resume) open(ctx context.Context, req *ccxv1.ResumeRequest) {
	// Taken while the agent was stopping: run nothing and answer nothing. The
	// center offers it again once its run limit is over (or lets it expire).
	if ctx.Err() != nil {
		return
	}
	id := req.GetKey().GetSessionId()
	if !sessionID.MatchString(id) {
		// Nothing is run for an id that cannot name a session: the CLI would
		// answer about its own arguments instead of about a session.
		r.finish(ctx, req.GetId(), req.GetClaimToken(), ccxv1.ResumeOutcome_RESUME_OUTCOME_FAILED,
			fmt.Sprintf("%q is not a session id, so there is nothing to open", id), 1)
		return
	}

	run := RunRequest{SessionID: id, Force: req.GetForce(), WaitSeconds: req.GetWaitSeconds()}
	if h := r.homeWith(id); h != "" && h != r.opts.DefaultHome {
		run.Home = h
	}
	code, out := r.opts.Run(ctx, run)
	outcome := ccxv1.ResumeOutcome_RESUME_OUTCOME_OPENED
	if code != 0 {
		outcome = ccxv1.ResumeOutcome_RESUME_OUTCOME_FAILED
	}
	r.finish(ctx, req.GetId(), req.GetClaimToken(), outcome, detailOf(out), int32(code))
}

// finish returns the result under the token the claim handed out, so a result
// that arrives after the center offered the request again is refused.
//
// It is sent even when the agent is shutting down: the session may be open by
// now, and a lost result is a request the center offers again.
func (r *Resume) finish(ctx context.Context, id, claimToken string, outcome ccxv1.ResumeOutcome, detail string, exitCode int32) {
	_, err := r.opts.Center.FinishResume(context.WithoutCancel(ctx), connect.NewRequest(&ccxv1.FinishResumeRequest{
		Id:         id,
		Outcome:    outcome,
		Detail:     detail,
		ExitCode:   exitCode,
		ClaimToken: claimToken,
	}))
	for try := 1; err != nil && try < finishTries; try++ {
		// A refusal (the request was claimed again, or is not ours) does not
		// change on a retry; only a center that did not answer is tried again.
		if code := connect.CodeOf(err); code == connect.CodeFailedPrecondition || code == connect.CodeNotFound || code == connect.CodeInvalidArgument {
			break
		}
		time.Sleep(finishRetryDelay)
		_, err = r.opts.Center.FinishResume(context.WithoutCancel(ctx), connect.NewRequest(&ccxv1.FinishResumeRequest{
			Id: id, Outcome: outcome, Detail: detail, ExitCode: exitCode, ClaimToken: claimToken,
		}))
	}
	if err != nil {
		// The request stays claimed and the center offers it again once its run
		// limit is over (while it is still within its expiry). A second run of a
		// session this one already opened is refused as running.
		r.log("resume: finishing %s failed: %v", id, err)
	}
}

// finishTries and finishRetryDelay bound how long a result is kept trying to
// reach the center: well inside the center's run limit (wait + 180 s).
const (
	finishTries      = 3
	finishRetryDelay = 2 * time.Second
)

func (r *Resume) log(format string, a ...any) { r.opts.Log(format, a...) }

// detailCap is how much of a resume's output the center keeps. What says why a
// resume failed is at the end of it, so a longer output is cut from the front.
const detailCap = 4096

func detailOf(out string) string {
	// The output is whatever the command and the pane printed, not checked to be
	// UTF-8; a proto string that is not would fail to marshal.
	d := strings.TrimSpace(strings.ToValidUTF8(out, "�"))
	if len(d) <= detailCap {
		return d
	}
	d = d[len(d)-detailCap:]
	// The cut can land inside a character. The detail is a proto string, so what
	// the center shows must not start with half of one.
	for len(d) > 0 && !utf8.RuneStart(d[0]) {
		d = d[1:]
	}
	return d
}

const (
	// defaultWait is how long the CLI waits for the agent when the request names
	// no wait of its own.
	defaultWait = 40 * time.Second
	// runTimeoutMargin is what the run is allowed on top of the CLI's own wait:
	// making the workspace, and getting the answer back to the center.
	runTimeoutMargin = time.Minute
)

// DefaultRunTimeout bounds one resume. It follows the wait the request asked
// for, so a caller who asked the CLI to wait longer does not have their request
// failed while the CLI is still working on it.
func DefaultRunTimeout(waitSeconds uint32) time.Duration {
	wait := defaultWait
	if waitSeconds > 0 {
		wait = time.Duration(waitSeconds) * time.Second
	}
	return wait + runTimeoutMargin
}

// CommandRunner resumes through the ccx CLI and passes its answer on as it is:
// the CLI's exit code is the outcome, its output the detail. The agent decides
// nothing about how a session is opened. A nil timeoutFor takes DefaultRunTimeout.
func CommandRunner(ccxPath string, timeoutFor func(uint32) time.Duration) RunFunc {
	if timeoutFor == nil {
		timeoutFor = DefaultRunTimeout
	}
	return func(parent context.Context, req RunRequest) (int, string) {
		runTimeout := timeoutFor(req.WaitSeconds)
		ctx, cancel := context.WithTimeout(parent, runTimeout)
		defer cancel()

		args := []string{"session", "resume", req.SessionID}
		if req.Force {
			args = append(args, "--force")
		}
		// The request's wait is the caller's, passed on as it is; 0 leaves the
		// CLI on its own default.
		if req.WaitSeconds > 0 {
			args = append(args, "--wait", strconv.FormatUint(uint64(req.WaitSeconds), 10))
		}
		cmd := exec.CommandContext(ctx, ccxPath, args...)
		// The CLI reads the transcript and the running sessions under its own
		// CLAUDE_CONFIG_DIR, and passes it on to the pane it opens.
		if req.Home != "" {
			cmd.Env = append(os.Environ(), "CLAUDE_CONFIG_DIR="+req.Home)
		}
		// Without it a child that keeps the output pipe open (herdr starting a
		// server, say) holds CombinedOutput past the kill.
		cmd.WaitDelay = 5 * time.Second
		out, err := cmd.CombinedOutput()
		switch {
		case err == nil:
			return 0, string(out)
		case parent.Err() != nil:
			// The agent is stopping. The CLI was killed partway, so a workspace may
			// be open: the CLI's exit 4, with the reason that is true.
			return 4, fmt.Sprintf("%s\nccx-agent was stopped while ccx session resume ran; a workspace may be left open", strings.TrimSpace(string(out)))
		case ctx.Err() != nil:
			// What a killed process reports is the signal, which says nothing
			// about the resume; the deadline is the reason. It may have opened a
			// workspace before it was stopped, so this is the CLI's exit 4.
			return 4, fmt.Sprintf("%s\nccx session resume did not finish in %s; a workspace may be left open", strings.TrimSpace(string(out)), runTimeout)
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

// RunningIDs are the sessions running under these Claude homes, sorted.
//
// Claude Code writes sessions/<pid>.json per running session, but the file alone
// is not the answer: a session that was killed leaves one behind, and the kernel
// reuses pid numbers. The judgement made here is the CLI's runningSessionIds, so
// the two agree on what "running" means.
//
// Ids are lowercased and de-duplicated across homes: a session under two homes is
// one session, and Claude Code's id is lowercase anyway.
func RunningIDs(homes ...string) ([]string, error) {
	ids := []string{}
	seen := make(map[string]bool)
	for _, claudeHome := range homes {
		dir := filepath.Join(claudeHome, "sessions")
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
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
			if json.Unmarshal(b, &f) != nil || f.SessionID == "" {
				continue
			}
			if !pidAlive(f.PID, f.ProcStart) {
				continue
			}
			id := strings.ToLower(f.SessionID)
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
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
	// kill(-1, 0) and kill(0, 0) both answer about more than one process, so a
	// pid that names no process would read as alive.
	if pid <= 0 {
		return false
	}
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
	if i < 0 || i+2 > len(stat) {
		return true
	}
	fields := strings.Fields(string(stat)[i+2:])
	return len(fields) > 19 && fields[19] == procStart
}
