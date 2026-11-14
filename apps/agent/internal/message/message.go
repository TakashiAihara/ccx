// Package message delivers a message to a running session (MessageService, #301 /
// #302). The sender says how it should be read (mode); this package picks how to
// get it there. Only Devin in a herdr pane is built: the text goes in through
// `herdr agent prompt`, which submits multi-line text as one input, where
// send-text followed by Enter loses the Enter to the paste (docs/design/transport.md).
//
// The design and the measurements behind each check are in issue #302.
package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// Herdr runs `herdr <args...>` and returns its stdout. On a failed run the error
// carries what herdr said (it prints a JSON error on stdout and exits 1).
type Herdr func(ctx context.Context, args ...string) ([]byte, error)

// CommandHerdr runs the herdr on PATH (the systemd unit puts ~/.local/bin there).
func CommandHerdr(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "herdr", args...)
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		var exit *exec.ExitError
		if errors.As(err, &exit) && len(exit.Stderr) > 0 {
			msg = strings.TrimSpace(msg + " " + string(exit.Stderr))
		}
		return out, fmt.Errorf("herdr %s: %v: %s", args[0], err, msg)
	}
	return out, nil
}

// Request is one message to send.
type Request struct {
	Target, Sender, Summary, Body string
	Mode                          ccxv1.DeliveryMode
}

// Devin delivers to Devin sessions running in herdr panes.
type Devin struct {
	Herdr Herdr
	// Poll is the interval of the checks after the prompt; SentWait bounds the
	// wait for the prompt to show up as sent, StartWait the wait for working.
	Poll, SentWait, StartWait time.Duration

	mu sync.Mutex
}

// NewDevin uses the herdr on PATH and the waits measured on #302: working showed
// within 3 seconds of the prompt.
func NewDevin() *Devin {
	return &Devin{Herdr: CommandHerdr, Poll: 250 * time.Millisecond, SentWait: 3 * time.Second, StartWait: 5 * time.Second}
}

// MaxBody keeps the text herdr gets as one argument well under Linux's 128 KiB
// limit on a single argument (MAX_ARG_STRLEN), past which exec fails with E2BIG.
const MaxBody = 64 << 10

// headerLine is the line the receiver sees first (#301): who sent it and what it is.
func headerLine(sender, summary string) string { return "ccx: " + sender + ": " + summary }

var (
	oneLine     = regexp.MustCompile(`^[^\r\n\p{Cc}\x{2028}\x{2029}]+$`)
	controlChar = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f-\x9f]`)
)

// Send delivers req and hands each ack to emit as it happens. A refusal before
// typing is INVALID_ARGUMENT / NOT_FOUND / FAILED_PRECONDITION and nothing went
// into the pane. Any other error may come after the text was typed.
func (d *Devin) Send(ctx context.Context, req Request, emit func(*ccxv1.SendResponse) error) error {
	if req.Target == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("target is empty"))
	}
	if !oneLine.MatchString(req.Sender) || !oneLine.MatchString(req.Summary) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("sender and summary must each be one non-empty line"))
	}
	if req.Body == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("body is empty"))
	}
	if !utf8.ValidString(req.Body) || controlChar.MatchString(req.Body) {
		// An ESC reaching the pane can cancel or clear Devin's input.
		return connect.NewError(connect.CodeInvalidArgument, errors.New("body is not UTF-8 text without control characters (newline and tab are fine)"))
	}
	mode := req.Mode
	if mode == ccxv1.DeliveryMode_DELIVERY_MODE_UNSPECIFIED {
		mode = ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN
	}
	switch mode {
	case ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN, ccxv1.DeliveryMode_DELIVERY_MODE_URGENT:
	case ccxv1.DeliveryMode_DELIVERY_MODE_LATER:
		// Getting it in without waking Devin (UserPromptSubmit's additionalContext)
		// is not measured yet.
		return connect.NewError(connect.CodeInvalidArgument, errors.New("devin does not take mode later; it takes after-turn, urgent"))
	default:
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown mode %d", mode))
	}
	if len(req.Body) > MaxBody {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("body is %d bytes, over the %d-byte limit", len(req.Body), MaxBody))
	}

	// One send at a time: two that both saw an empty box would type into it
	// together and be submitted joined.
	d.mu.Lock()
	defer d.mu.Unlock()

	p, err := d.find(ctx, req.Target)
	if err != nil {
		return err
	}
	if mode == ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN && p.Status == "working" {
		// This catches only what herdr reports as working. herdr also reports idle
		// while Devin is still writing its answer (#302), and a send then goes in
		// mid-turn; telling the end of the turn needs Devin's Stop hook.
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s is working; waiting for its turn to end is not built yet, so after-turn is refused (send --mode urgent to have it read at its next break)", req.Target))
	}

	screen, err := d.Herdr(ctx, "agent", "read", p.ID, "--source", "visible", "--format", "ansi")
	if err != nil {
		return connect.NewError(connect.CodeUnavailable, err)
	}
	switch inputBox(string(screen)) {
	case inputMissing:
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s is not at its input box (a dialog such as a question or a permission prompt may be open); nothing was sent", req.Target))
	case inputTyped:
		// Text typed after a half-written line is submitted joined to it (#302).
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s has text in its input box; nothing was sent", req.Target))
	}

	header := headerLine(req.Sender, req.Summary)
	// A header sent before is already in the history; only a new one counts.
	before, err := d.Herdr(ctx, "agent", "read", p.ID, "--source", "recent-unwrapped")
	if err != nil {
		return connect.NewError(connect.CodeUnavailable, err)
	}
	seen := strings.Count(string(before), "❭ "+header)
	if _, err := d.Herdr(ctx, "agent", "prompt", p.ID, header+"\n"+req.Body); err != nil {
		return connect.NewError(connect.CodeUnavailable, err)
	}

	if err := d.waitSent(ctx, p.ID, header, seen); err != nil {
		return err
	}
	if err := emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "pane " + p.ID}); err != nil {
		return err
	}

	if p.Status == "working" {
		// An urgent send to a working Devin: its status cannot show the new
		// message being picked up.
		return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_WORKING, Detail: "was already working; reads it at its next break"})
	}
	state, detail := d.waitStarted(ctx, p.ID, p.Status)
	return emit(&ccxv1.SendResponse{State: state, Detail: detail})
}

type pane struct{ ID, Agent, Status string }

func (d *Devin) find(ctx context.Context, target string) (pane, error) {
	out, err := d.Herdr(ctx, "pane", "list")
	if err != nil {
		return pane{}, connect.NewError(connect.CodeUnavailable, err)
	}
	var list struct {
		Result struct {
			Panes []paneJSON `json:"panes"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return pane{}, connect.NewError(connect.CodeInternal, fmt.Errorf("herdr pane list: %w", err))
	}
	var hits []pane
	for _, p := range list.Result.Panes {
		if p.Session != nil && p.Session.Value == target {
			hits = append(hits, pane{ID: p.ID, Agent: p.Agent, Status: p.Status})
		}
	}
	switch {
	case len(hits) == 0:
		// A Devin started outside `herdr agent start` has no session name in herdr
		// (#302); it is not guessed from anything else.
		return pane{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("no herdr pane has session %q (a Devin started outside `herdr agent start` / `spawn-task --agent devin` carries no session name)", target))
	case len(hits) > 1:
		return pane{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%d herdr panes have session %q", len(hits), target))
	case hits[0].Agent != "devin":
		return pane{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%q is a %s session; only devin is delivered to yet (#301)", target, hits[0].Agent))
	}
	return hits[0], nil
}

type paneJSON struct {
	ID      string `json:"pane_id"`
	Agent   string `json:"agent"`
	Status  string `json:"agent_status"`
	Session *struct {
		Value string `json:"value"`
	} `json:"agent_session"`
}

func (d *Devin) status(ctx context.Context, id string) (string, error) {
	out, err := d.Herdr(ctx, "pane", "get", id)
	if err != nil {
		return "", err
	}
	var got struct {
		Result struct {
			Pane paneJSON `json:"pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		return "", fmt.Errorf("herdr pane get: %w", err)
	}
	return got.Result.Pane.Status, nil
}

// waitSent waits for the input box to be empty again with the header in the
// history above it. herdr accepting the prompt is not that: the text can sit in
// the box unsent (docs/design/transport.md).
func (d *Devin) waitSent(ctx context.Context, id, header string, seen int) error {
	deadline := time.Now().Add(d.SentWait)
	for {
		screen, err := d.Herdr(ctx, "agent", "read", id, "--source", "visible", "--format", "ansi")
		if err == nil && inputBox(string(screen)) == inputEmpty {
			hist, err := d.Herdr(ctx, "agent", "read", id, "--source", "recent-unwrapped")
			if err == nil && strings.Count(string(hist), "❭ "+header) > seen {
				return nil
			}
		}
		if !time.Now().Before(deadline) || sleep(ctx, d.Poll) != nil {
			return connect.NewError(connect.CodeUnknown, fmt.Errorf("herdr took the prompt but it was not seen as sent in pane %s; look at the pane before sending again", id))
		}
	}
}

// waitStarted watches herdr's agent_status. done also means the turn started
// (a short answer can finish between two looks, and a permission prompt shows as
// done, measured on devin 3000.12.57), but only when it was not done before the
// prompt: a done left from the previous turn says nothing about this one.
func (d *Devin) waitStarted(ctx context.Context, id, before string) (ccxv1.SendResponse_State, string) {
	deadline := time.Now().Add(d.StartWait)
	last := ""
	for {
		st, err := d.status(ctx, id)
		if err != nil {
			last = err.Error()
		} else {
			last = st
			if st == "working" || st == "blocked" || (st == "done" && before != "done") {
				return ccxv1.SendResponse_STATE_WORKING, "agent_status " + st
			}
		}
		if !time.Now().Before(deadline) || sleep(ctx, d.Poll) != nil {
			return ccxv1.SendResponse_STATE_NOT_STARTED, fmt.Sprintf("not seen working within %s (last look: %s)", d.StartWait, last)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type inputState int

const (
	inputMissing inputState = iota
	inputEmpty
	inputTyped
)

// inputBox reads Devin's input box off an ANSI snapshot of the visible screen.
// The box is the last line that starts with "❭ " with no styling before it;
// history lines and dialogs (a question, a permission prompt) draw the same mark
// after a background colour. The box is empty when every visible character after
// the mark is styled (the grey placeholder) and the box's rule is right below it;
// typed text is drawn unstyled. Anything else reads as no box, so nothing is
// typed. Measured on devin 3000.12.57.
func inputBox(screen string) inputState {
	state := inputMissing
	lines := strings.Split(screen, "\n")
	for i, line := range lines {
		if rest, ok := strings.CutPrefix(line, "❭ "); ok {
			switch {
			case typed(rest):
				state = inputTyped
			case i+1 < len(lines) && strings.HasPrefix(strings.TrimSpace(sgr.ReplaceAllString(lines[i+1], "")), "─"):
				// The box's rule right under it: a placeholder line anywhere else is
				// not taken for the box.
				state = inputEmpty
			default:
				state = inputMissing
			}
		} else if strings.HasPrefix(sgr.ReplaceAllString(line, ""), "❭ ") {
			// A styled mark below the box is a dialog drawn over it.
			state = inputMissing
		}
	}
	return state
}

var sgr = regexp.MustCompile(`\x1b\[([0-9;]*)m`)

// typed says whether s prints a visible character with no styling in effect.
func typed(s string) bool {
	styled, at := false, 0
	for _, m := range sgr.FindAllStringSubmatchIndex(s, -1) {
		if !styled && strings.TrimSpace(s[at:m[0]]) != "" {
			return true
		}
		styled = !isReset(s[m[2]:m[3]])
		at = m[1]
	}
	return !styled && strings.TrimSpace(s[at:]) != ""
}

// Service answers MessageService. The api concern mounts it on the unix socket
// only (message.proto says why). Each send is logged, so "who typed this into my
// Devin" has an answer.
type Service struct {
	Devin *Devin
	Log   func(string, ...any)
}

func (s *Service) Send(ctx context.Context, req *connect.Request[ccxv1.SendRequest], stream *connect.ServerStream[ccxv1.SendResponse]) error {
	m := req.Msg
	var last ccxv1.SendResponse_State
	err := s.Devin.Send(ctx, Request{Target: m.GetTarget(), Sender: m.GetSender(), Summary: m.GetSummary(), Body: m.GetBody(), Mode: m.GetMode()}, func(r *ccxv1.SendResponse) error {
		last = r.GetState()
		return stream.Send(r)
	})
	if s.Log != nil {
		outcome := last.String()
		if err != nil {
			outcome = fmt.Sprintf("%s, error: %v", outcome, err)
		}
		s.Log("message: to %q from %q (%q, %s): %s", m.GetTarget(), m.GetSender(), m.GetSummary(), m.GetMode(), outcome)
	}
	return err
}

// isReset says whether SGR parameters only reset: "", "0", "00", "0;0", ";".
func isReset(params string) bool {
	for _, p := range strings.Split(params, ";") {
		if strings.Trim(p, "0") != "" {
			return false
		}
	}
	return true
}
