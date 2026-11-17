// Package message delivers a message to a running session (MessageService, #301 /
// #302). The sender says how it should be read (mode); this package picks how to
// get it there. Only Devin in a herdr pane is built: the text goes in through
// `herdr agent prompt`, which submits multi-line text as one input, where
// send-text followed by Enter loses the Enter to the paste (docs/design/transport.md).
//
// The design and the measurements behind each check are in issue #302.
package message

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
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
	// WaitSeconds keeps the send going after sent for the question / done acks.
	WaitSeconds uint32
}

// Devin delivers to Devin sessions running in herdr panes.
type Devin struct {
	Herdr Herdr
	// Poll is the interval of the checks after the prompt; SentWait bounds the
	// wait for the prompt to show up as sent, StartWait the wait for working.
	Poll, SentWait, StartWait time.Duration
	// Keymap reads what Enter does mid-turn from a Devin config file ("" is the
	// default file); nil is Devin's default keymap without reading anything.
	Keymap func(path string) (Keymap, error)

	mu        sync.Mutex
	hooksOnce sync.Once
	h         *hooks
}

// NewDevin uses the herdr on PATH. On #302 working showed within 3 seconds of
// the prompt; StartWait leaves room above that, SentWait is the time to see it in
// the history.
func NewDevin() *Devin {
	return &Devin{Herdr: CommandHerdr, Poll: 250 * time.Millisecond, SentWait: 3 * time.Second, StartWait: 5 * time.Second, Keymap: ReadKeymap}
}

// Keymap is the part of Devin's keymap a send depends on (#86). By default Enter
// in a running turn guides Devin ("Guide Devin while it works": read at its next
// break). A config can bind Enter to queue_message instead (held until the turn
// ends), and accept_line to another key, which then sends the queue at once.
type Keymap struct {
	// Queues: readbox_input.queue_message is "enter".
	Queues bool
	// Send is editor.accept_line as a herdr key name ("enter" when unset).
	Send string
}

// ReadKeymap reads path, the --config a Devin was started with, or with "" the
// default ~/.config/devin/config.json, whose absence is Devin's default keymap.
func ReadKeymap(path string) (Keymap, error) {
	named := path != ""
	if !named {
		home, err := os.UserHomeDir()
		if err != nil {
			return Keymap{}, err
		}
		path = filepath.Join(home, ".config", "devin", "config.json")
	}
	b, err := os.ReadFile(path)
	if !named && errors.Is(err, os.ErrNotExist) {
		return Keymap{Send: "enter"}, nil
	}
	if err != nil {
		return Keymap{}, err
	}
	return parseKeymap(b)
}

func parseKeymap(b []byte) (Keymap, error) {
	var c struct {
		Keymap struct {
			Editor struct {
				AcceptLine string `json:"accept_line"`
			} `json:"editor"`
			ReadboxInput struct {
				QueueMessage string `json:"queue_message"`
			} `json:"readbox_input"`
		} `json:"keymap"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return Keymap{}, fmt.Errorf("devin config: %w", err)
	}
	// Devin writes ctrl-enter, herdr takes ctrl+enter (both measured, devin
	// 3000.12.57 / herdr 0.9.5). shortcut: only ctrl+enter was tried; other chords
	// are passed the same way and fail at herdr if it names them otherwise.
	norm := func(k string) string { return strings.ToLower(strings.TrimSpace(k)) }
	return Keymap{
		Queues: norm(c.Keymap.ReadboxInput.QueueMessage) == "enter",
		Send:   strings.ReplaceAll(cmp.Or(norm(c.Keymap.Editor.AcceptLine), "enter"), "-", "+"),
	}, nil
}

// keymap reads the keymap of the Devin in pane, from the --config it was started
// with if any.
func (d *Devin) keymap(ctx context.Context, pane string) (Keymap, error) {
	if d.Keymap == nil {
		return Keymap{Send: "enter"}, nil
	}
	path, err := d.configPath(ctx, pane)
	if err != nil {
		return Keymap{}, err
	}
	return d.Keymap(path)
}

// configPath is the --config of the Devin running in pane as an absolute path; ""
// when it was started without one. herdr lists the pane's foreground
// processes with argv and cwd (herdr 0.9.5); the devin launcher and the binary it
// starts both carry the flag, the binary with it made absolute (measured, devin
// 3000.13.4). An absolute one is taken first, so a cwd that moved does not matter;
// otherwise the first relative one with a cwd, against that cwd. The client's flag is taken as the
// keymap's (the keymap is the client's input box); Devin refuses a client whose
// --config differs from its shared daemon's while that daemon has a busy session
// (devin 3000.13.4). No devin among them is an error, not "no --config": reading
// the default file then would be a guess. A Devin running a tool keeps the
// foreground; the tool runs in a shell of its own (measured, devin 3000.13.4).
func (d *Devin) configPath(ctx context.Context, pane string) (string, error) {
	out, err := d.Herdr(ctx, "pane", "process-info", "--pane", pane)
	if err != nil {
		return "", fmt.Errorf("herdr pane process-info: %w", err)
	}
	var got struct {
		Result struct {
			ProcessInfo struct {
				Foreground []struct {
					Argv []string `json:"argv"`
					Cwd  string   `json:"cwd"`
				} `json:"foreground_processes"`
			} `json:"process_info"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		return "", fmt.Errorf("herdr pane process-info: %w", err)
	}
	found := false
	var relative string
	var relErr error
	for _, p := range got.Result.ProcessInfo.Foreground {
		if len(p.Argv) == 0 || filepath.Base(p.Argv[0]) != "devin" {
			continue
		}
		found = true
		args := p.Argv[1:]
		for i, a := range args {
			// What follows -- is the first prompt, not flags.
			if a == "--" {
				break
			}
			v, ok := strings.CutPrefix(a, "--config=")
			if a == "--config" && i+1 < len(args) {
				v, ok = args[i+1], true
			}
			if !ok {
				continue
			}
			if filepath.IsAbs(v) {
				return v, nil
			}
			if relative != "" {
				continue
			}
			if p.Cwd == "" {
				relErr = fmt.Errorf("devin in pane %s has a relative --config %q and herdr gave no cwd to resolve it", pane, v)
			} else {
				relative = filepath.Join(p.Cwd, v)
			}
		}
	}
	if !found {
		return "", fmt.Errorf("herdr pane process-info lists no devin process in pane %s", pane)
	}
	if relative != "" {
		return relative, nil
	}
	return "", relErr
}

// MaxBody keeps the text herdr gets as one argument well under Linux's 128 KiB
// limit on a single argument (MAX_ARG_STRLEN), past which exec fails with E2BIG.
const MaxBody = 64 << 10

// MaxSender and MaxSummary keep the header line `ccx: <sender>: <summary>` under
// about 130 columns, so it does not wrap in a usual pane: a wrapped header is not
// recognised as sent. With MaxBody they keep the whole argument under the limit.
const (
	MaxSender  = 40
	MaxSummary = 80
)

// headerLine is the line the receiver sees first (#301): who sent it and what it is.
func headerLine(sender, summary string) string { return "ccx: " + sender + ": " + summary }

var (
	// Format characters (bidi overrides, zero-width) are refused too: they can
	// make the header show a different sender or summary than was sent.
	oneLine = regexp.MustCompile(`^[^\r\n\p{Cc}\p{Cf}\x{2028}\x{2029}]+$`)
)

// NotTypedKey is the error metadata key set on a failure that came before
// anything was handed to herdr. Only it says "not sent": an error without it
// (including one lost on the way) may come after the text went in, and a resend
// could type it twice.
const NotTypedKey = "Ccx-Not-Typed"

// Send delivers req and hands each ack to emit as it happens. An error carries
// NotTypedKey when nothing was typed.
func (d *Devin) Send(ctx context.Context, req Request, emit func(*ccxv1.SendResponse) error) error {
	typed := false
	err := d.send(ctx, req, emit, &typed)
	if err != nil && !typed {
		return markNotTyped(err)
	}
	return err
}

// Validate refuses a request whatever the receiver is: the target, the sender and
// summary lines, the body, and an unknown mode. A mode the receiver lacks is the
// receiver's call. The relay runs it before handing a message to the center, so a
// bad one is refused here as not sent.
func Validate(req Request) error {
	if req.Target == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("target is empty"))
	}
	for _, l := range []struct {
		name, s string
		max     int
	}{{"sender", req.Sender, MaxSender}, {"summary", req.Summary, MaxSummary}} {
		// Leading or trailing spaces would not survive the history line Devin pads.
		if !utf8.ValidString(l.s) || !oneLine.MatchString(l.s) || len(l.s) > l.max || strings.TrimSpace(l.s) != l.s {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s must be one non-empty line of at most %d bytes, without leading or trailing spaces", l.name, l.max))
		}
	}
	if req.Body == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("body is empty"))
	}
	if !utf8.ValidString(req.Body) || strings.ContainsFunc(req.Body, refusedInBody) {
		// An ESC reaching the pane can cancel or clear Devin's input.
		return connect.NewError(connect.CodeInvalidArgument, errors.New("body is not UTF-8 text without control or format characters (newline and tab are fine)"))
	}
	if _, ok := ccxv1.DeliveryMode_name[int32(req.Mode)]; !ok {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown mode %d", req.Mode))
	}
	if len(req.Body) > MaxBody {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("body is %d bytes, over the %d-byte limit", len(req.Body), MaxBody))
	}
	if time.Duration(req.WaitSeconds)*time.Second > MaxWait {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("wait is %d seconds, over the %d-second limit", req.WaitSeconds, int(MaxWait.Seconds())))
	}
	return nil
}

func (d *Devin) send(ctx context.Context, req Request, emit func(*ccxv1.SendResponse) error, typed *bool) error {
	if err := Validate(req); err != nil {
		return err
	}
	wait := waitOf(req)
	if req.Mode == ccxv1.DeliveryMode_DELIVERY_MODE_LATER {
		return d.sendLater(ctx, req, wait, emit, typed)
	}

	header := headerLine(req.Sender, req.Summary)
	var events <-chan hookEvent
	var ts *typedSend
	var drop func()
	beforeTyping := func() {}
	if wait > 0 {
		// Subscribe before typing, so the turn's UserPromptSubmit is not missed.
		var cancel func()
		events, cancel = d.hooks().subscribe(req.Target)
		defer cancel()
		beforeTyping = func() { ts, drop = d.hooks().expect(req.Target, header+"\n"+req.Body) }
	}
	err := d.typeIn(ctx, req, header, emit, typed, beforeTyping)
	if drop != nil {
		defer drop()
	}
	afterTyping(ctx)
	if err != nil {
		return err
	}
	if events == nil {
		return nil
	}
	// The turn that took it is the UserPromptSubmit Hook handed to this send: one
	// whose prompt is exactly what was typed (Devin hands the typed text over
	// unchanged, devin 3000.12.57); see typedSend for sends of the same text.
	mine := func(e hookEvent) bool { return e.Name == "UserPromptSubmit" && e.owner == ts }
	return watch(ctx, events, wait, mine, nil, emit)
}

// typeIn types the message into the receiver's pane and reports sent, then
// working or not-started.
// beforeTyping runs right before the text is typed, under the typing lock.
func (d *Devin) typeIn(ctx context.Context, req Request, header string, emit func(*ccxv1.SendResponse) error, typed *bool, beforeTyping func()) error {
	// One send at a time: two that both saw an empty box would type into it
	// together and be submitted joined. The waits for question / done come
	// after, outside the lock.
	d.mu.Lock()
	defer d.mu.Unlock()

	p, err := d.find(ctx, req.Target)
	if err != nil {
		return err
	}
	// A header sent before is already in the history; only a new one counts. Read
	// before the screen, so the box is looked at right before typing.
	lines := strconv.Itoa(historyLines(req.Body))
	before, err := d.Herdr(ctx, "agent", "read", p.ID, "--source", "recent-unwrapped", "--format", "text", "--lines", lines)
	if err != nil {
		return connect.NewError(connect.CodeUnavailable, err)
	}
	seen := headerLines(string(before), header)

	// The session may have left the pane since it was found (a pane hosts
	// whatever agent runs in it now): look it up again before the last check.
	if again, err := d.find(ctx, req.Target); err != nil {
		return err
	} else if again.ID != p.ID {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s moved from pane %s to %s while sending; nothing was sent", req.Target, p.ID, again.ID))
	} else {
		// Its status now, for the after-turn check and the start baseline.
		p = again
	}

	screen, err := d.Herdr(ctx, "agent", "read", p.ID, "--source", "visible", "--format", "ansi")
	if err != nil {
		return connect.NewError(connect.CodeUnavailable, err)
	}
	// herdr reports idle while Devin is still writing its answer (#302), so its
	// status alone would let after-turn go in mid-turn. Devin shows the turn on
	// screen ("Typing · 3s (esc twice to interrupt)", devin 3000.12.57) until its
	// Stop hook is wired to ccx-agent to tell the end of the turn properly.
	working := p.Status == "working" || midTurn(string(screen))
	// An idle Devin submits on Enter whatever accept_line is bound to (measured with
	// accept_line on ctrl-enter), so only a working one needs the keymap.
	var km Keymap
	if working {
		if km, err = d.keymap(ctx, p.ID); err != nil {
			return connect.NewError(connect.CodeFailedPrecondition, err)
		}
	}
	// With Enter bound to queue_message, Devin itself holds the message until the
	// turn ends: that is after-turn, and urgent sends the queue on with accept_line.
	queues := working && km.Queues
	if queues && req.Mode == ccxv1.DeliveryMode_DELIVERY_MODE_URGENT && km.Send == "enter" {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s is working and its keymap binds Enter to queue_message and leaves accept_line on Enter (or unset), so ccx has no key to send the queue on; nothing was sent", req.Target))
	}
	// With a same-header message already queued, its "○" line could stand for this
	// one, and the person sending the queue on meanwhile would move it to the
	// history as if this one went there.
	if queues && queuedLines(string(screen), header) > 0 {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s already has a message with this header queued; nothing was sent", req.Target))
	}
	if queues {
		// A same-header message the person sent on from the queue between the
		// history read above and this screen is in the history now: count again.
		hist, err := d.Herdr(ctx, "agent", "read", p.ID, "--source", "recent-unwrapped", "--format", "text", "--lines", lines)
		if err != nil {
			return connect.NewError(connect.CodeUnavailable, err)
		}
		// The read keeps the last lines only and moves forward, so a line that left
		// it does not come back to pass for this one: the recount stands as it is.
		seen = headerLines(string(hist), header)
	}
	if req.Mode != ccxv1.DeliveryMode_DELIVERY_MODE_URGENT && working && !queues {
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s is working; waiting for its turn to end is not built yet, so after-turn is refused (send --mode urgent to have it read at its next break)", req.Target))
	}
	if working {
		// The keymap (and the recount) asked herdr since the screen was read: read
		// it again, so the box check below is close to typing.
		if screen, err = d.Herdr(ctx, "agent", "read", p.ID, "--source", "visible", "--format", "ansi"); err != nil {
			return connect.NewError(connect.CodeUnavailable, err)
		}
	}
	switch inputBox(string(screen)) {
	case inputMissing:
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s is not at its input box (a dialog such as a question or a permission prompt may be open); nothing was sent", req.Target))
	case inputTyped:
		// Text typed after a half-written line is submitted joined to it (#302).
		return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s has text in its input box; nothing was sent", req.Target))
	}

	beforeTyping()
	*typed = true
	if _, err := d.Herdr(ctx, "agent", "prompt", p.ID, header+"\n"+req.Body); err != nil {
		// herdr may have written part of it before failing.
		return connect.NewError(connect.CodeUnknown, err)
	}

	// A long body takes longer to paste and render.
	wait := d.SentWait + time.Duration(len(req.Body)/(16<<10))*time.Second
	if queues {
		inQueue, err := d.waitQueued(ctx, p.ID, header, seen, lines, wait)
		if err != nil {
			return err
		}
		switch {
		case !inQueue:
			// The turn ended before Enter: it went in as to an idle Devin.
			working = false
		case req.Mode != ccxv1.DeliveryMode_DELIVERY_MODE_URGENT:
			return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "pane " + p.ID + "; was working, queued until its turn ends"})
		default:
			// accept_line sends everything queued, the person's own messages too.
			if _, err := d.Herdr(ctx, "pane", "send-keys", p.ID, km.Send); err != nil {
				return connect.NewError(connect.CodeUnknown, fmt.Errorf("the message is queued in pane %s but sending it on failed: %w", p.ID, err))
			}
			if err := d.waitSent(ctx, p.ID, header, seen, lines, wait); err != nil {
				return err
			}
			// Sent on at once, cutting into a running tool (devin 3000.12.57).
			return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "pane " + p.ID + "; was working, its queue was sent on now"})
		}
	} else if err := d.waitSent(ctx, p.ID, header, seen, lines, wait); err != nil {
		return err
	}
	if working {
		// An urgent send to a Devin that was already working: its status cannot
		// show this message being picked up, so sent is the last ack.
		return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "pane " + p.ID + "; was working, reads it at its next break"})
	}
	if err := emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "pane " + p.ID}); err != nil {
		return err
	}
	state, detail := d.waitStarted(ctx, p.ID, p.Status)
	return emit(&ccxv1.SendResponse{State: state, Detail: detail})
}

// headerLines counts the history lines that are exactly the header ("review 1"
// must not count "review 10"). Devin pads the line to the pane width.
func headerLines(hist, header string) int {
	n := 0
	for _, line := range strings.Split(hist, "\n") {
		if strings.TrimRight(line, " \r") == "❭ "+header {
			n++
		}
	}
	return n
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
//
// The box must be empty both before and after the history read: text still
// unsent in the box reads like a history line once the styling is gone, so an
// empty box on only one side does not rule it out. A box that is not seen (a
// dialog the message opened, or text too tall for the screen) is not taken as
// sent; that ends as "may have been sent".
func (d *Devin) waitSent(ctx context.Context, id, header string, seen int, lines string, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	// The wait bounds the herdr calls too, not only the looks between them: a
	// stuck read would otherwise hold every other send behind the mutex.
	wctx, cancel := context.WithDeadline(ctx, deadline.Add(time.Second))
	defer cancel()
	for {
		if d.boxEmpty(wctx, id) {
			hist, err := d.Herdr(wctx, "agent", "read", id, "--source", "recent-unwrapped", "--format", "text", "--lines", lines)
			if err == nil && headerLines(string(hist), header) > seen && d.boxEmpty(wctx, id) {
				return nil
			}
		}
		if time.Now().Before(deadline) && sleep(ctx, d.Poll) == nil {
			continue
		}
		if ctx.Err() != nil {
			return connect.NewError(connect.CodeCanceled, fmt.Errorf("stopped while waiting to see the message as sent in pane %s", id))
		}
		return connect.NewError(connect.CodeUnknown, fmt.Errorf("herdr took the prompt but it was not seen as sent in pane %s; look at the pane before sending again", id))
	}
}

// waitQueued waits for the message to show in Devin's queue with the box empty.
// inQueue is false when it showed in the history instead.
func (d *Devin) waitQueued(ctx context.Context, id, header string, seen int, lines string, wait time.Duration) (inQueue bool, err error) {
	deadline := time.Now().Add(wait)
	wctx, cancel := context.WithDeadline(ctx, deadline.Add(time.Second))
	defer cancel()
	for {
		screen, err := d.Herdr(wctx, "agent", "read", id, "--source", "visible", "--format", "ansi")
		if err == nil && inputBox(string(screen)) == inputEmpty {
			if queuedLines(string(screen), header) > 0 {
				return true, nil
			}
			hist, err := d.Herdr(wctx, "agent", "read", id, "--source", "recent-unwrapped", "--format", "text", "--lines", lines)
			if err == nil && headerLines(string(hist), header) > seen && d.boxEmpty(wctx, id) {
				return false, nil
			}
		}
		if time.Now().Before(deadline) && sleep(ctx, d.Poll) == nil {
			continue
		}
		if ctx.Err() != nil {
			return false, connect.NewError(connect.CodeCanceled, fmt.Errorf("stopped while waiting to see the message as queued in pane %s", id))
		}
		return false, connect.NewError(connect.CodeUnknown, fmt.Errorf("herdr took the prompt but it was not seen as queued or sent in pane %s; look at the pane before sending again", id))
	}
}

// queuedLines counts the queued messages whose first line is the header. Devin
// lists them above the box as "○ <first line>" (devin 3000.12.57, testdata).
func queuedLines(screen, header string) int {
	n := 0
	for _, l := range strings.Split(screen, "\n") {
		if strings.TrimRight(sgr.ReplaceAllString(l, ""), " \r") == "○ "+header {
			n++
		}
	}
	return n
}

// waitStarted watches herdr's agent_status. done also means the turn started
// (a short answer can finish between two looks, and a permission prompt shows as
// done, measured on devin 3000.12.57), but only when it was not done before the
// prompt: a done left from the previous turn says nothing about this one.
func (d *Devin) waitStarted(ctx context.Context, id, before string) (ccxv1.SendResponse_State, string) {
	deadline := time.Now().Add(d.StartWait)
	wctx, cancel := context.WithDeadline(ctx, deadline.Add(time.Second))
	defer cancel()
	last := ""
	for {
		st, err := d.status(wctx, id)
		if err != nil {
			last, _, _ = strings.Cut(err.Error(), "\n")
		} else {
			last = st
			if st == "idle" {
				before = st
			}
			// done and blocked left from before the prompt say nothing about it; once
			// idle has been seen after the prompt, a later one does.
			if st == "working" || (st == "blocked" && before != "blocked") || (st == "done" && before != "done") {
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
// The box is what lies between the last two rules (lines of ─), and it must start
// with "❭ " drawn unstyled: history lines above it and dialogs (a question, a
// permission prompt) draw the mark after a background colour or indented. The box
// is empty when it is that one line and every visible character after the mark is
// styled (the grey placeholder); typed text is drawn unstyled, and a second line
// in the box is typed text too. Anything else reads as no box, so nothing is
// typed. Measured on devin 3000.12.57 (testdata).
func inputBox(screen string) inputState {
	lines := strings.Split(screen, "\n")
	top, bottom := boxRules(lines)
	if bottom < 0 {
		return inputMissing
	}
	for _, l := range lines[bottom+1:] {
		// A mark below the box is a dialog drawn over it.
		if strings.HasPrefix(plainLine(l), "❭") {
			return inputMissing
		}
	}
	if top < 0 {
		return inputMissing
	}
	box := lines[top+1 : bottom]
	if len(box) == 0 {
		return inputMissing
	}
	rest, ok := strings.CutPrefix(box[0], "❭ ")
	if !ok {
		return inputMissing
	}
	if len(box) > 1 || typed(rest) {
		return inputTyped
	}
	return inputEmpty
}

var sgr = regexp.MustCompile(`\x1b\[([0-9;]*)m`)

// typed says whether s prints a visible character with no styling in effect.
// The styling is the SGR state carried across sequences (sgrState).
func typed(s string) bool {
	var st sgrState
	at := 0
	for _, m := range sgr.FindAllStringSubmatchIndex(s, -1) {
		// Spaces count: a box holding only typed spaces has lost its placeholder.
		if !st.styled() && strings.Trim(s[at:m[0]], "\r") != "" {
			return true
		}
		st.apply(s[m[2]:m[3]])
		at = m[1]
	}
	return !st.styled() && strings.Trim(s[at:], "\r") != ""
}

// Service answers MessageService. The api concern mounts it on the unix socket
// only (message.proto says why). Each send is logged, so "who typed this into my
// Devin" has an answer.
type Service struct {
	Devin *Devin
	// Claude delivers to Claude Code sessions (a target that is a session id)
	// through their ccx channel. nil when the heartbeat concern, which holds the
	// channel connections, is off.
	Claude *Claude
	// Machine and User are this agent's origin. A request naming another goes
	// through Relay (#138); without a Relay it is refused.
	Machine, User string
	Relay         *Relay
	Log           func(string, ...any)
}

func (s *Service) Send(ctx context.Context, req *connect.Request[ccxv1.SendRequest], stream *connect.ServerStream[ccxv1.SendResponse]) error {
	return s.route(ctx, req.Msg, stream.Send, s.Deliver)
}

// route hands m to local when it is for this agent, and to the relay otherwise.
func (s *Service) route(ctx context.Context, m *ccxv1.SendRequest, emit func(*ccxv1.SendResponse) error, local func(context.Context, *ccxv1.SendRequest, func(*ccxv1.SendResponse) error) error) error {
	if (m.GetMachine() == "" || m.GetMachine() == s.Machine) && (m.GetUser() == "" || m.GetUser() == s.User) {
		return local(ctx, m, emit)
	}

	// The other side fills what the sender left out with this agent's own.
	m.Machine, m.User = cmp.Or(m.GetMachine(), s.Machine), cmp.Or(m.GetUser(), s.User)
	if s.Relay == nil {
		return markNotTyped(connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s/%s is another machine or user, and this ccx-agent does not relay (it needs an http(s) center and its own machine and user names)", m.Machine, m.User)))
	}
	var last ccxv1.SendResponse_State
	err := s.Relay.Send(ctx, m, func(r *ccxv1.SendResponse) error {
		last = r.GetState()
		return emit(r)
	})
	s.logSend(m, "relayed to "+m.Machine+"/"+m.User+", ", last, err)
	return err
}

// Deliver sends m here, the same whether it came from the socket or was claimed
// from the center for this machine.
func (s *Service) Deliver(ctx context.Context, m *ccxv1.SendRequest, emit func(*ccxv1.SendResponse) error) error {
	var last ccxv1.SendResponse_State
	req := Request{Target: m.GetTarget(), Sender: m.GetSender(), Summary: m.GetSummary(), Body: m.GetBody(), Mode: m.GetMode(), WaitSeconds: m.GetWaitSeconds()}
	send := s.Devin.Send
	if IsClaudeSession(req.Target) {
		send = s.sendClaude
	}
	err := send(ctx, req, func(r *ccxv1.SendResponse) error {
		last = r.GetState()
		return emit(r)
	})
	s.logSend(m, "", last, err)
	return err
}

func (s *Service) logSend(m *ccxv1.SendRequest, via string, last ccxv1.SendResponse_State, err error) {
	if s.Log == nil {
		return
	}
	outcome := last.String()
	if err != nil {
		outcome = fmt.Sprintf("%s, error: %v", outcome, err)
	}
	s.Log("message: to %q from %q (%q, %s): %s%s", m.GetTarget(), m.GetSender(), m.GetSummary(), m.GetMode(), via, outcome)
}

// sgrState tracks which SGR attributes are away from the default. Each reset
// code turns back only its own attribute (22 intensity, 39 foreground, ...), so
// "bold; 39" stays styled and "38;..m then 39m" ends plain.
type sgrState map[string]bool

func (st *sgrState) styled() bool {
	for _, on := range *st {
		if on {
			return true
		}
	}
	return false
}

func (st *sgrState) apply(params string) {
	if *st == nil {
		*st = sgrState{}
	}
	set := func(attr string, on bool) { (*st)[attr] = on }
	ps := strings.Split(params, ";")
	for i := 0; i < len(ps); i++ {
		n, err := strconv.Atoi(ps[i])
		if ps[i] == "" {
			n, err = 0, nil
		}
		switch {
		case err != nil:
			set("other", true)
		case n == 0:
			*st = sgrState{}
		case n == 1 || n == 2:
			set("intensity", true)
		case n == 22:
			set("intensity", false)
		case n == 3:
			set("italic", true)
		case n == 23:
			set("italic", false)
		case n == 4 || n == 21:
			set("underline", true)
		case n == 24:
			set("underline", false)
		case n == 5 || n == 6:
			set("blink", true)
		case n == 25:
			set("blink", false)
		case n == 7:
			set("inverse", true)
		case n == 27:
			set("inverse", false)
		case n == 8:
			set("conceal", true)
		case n == 28:
			set("conceal", false)
		case n == 9:
			set("strike", true)
		case n == 29:
			set("strike", false)
		case n >= 30 && n <= 37 || n >= 90 && n <= 97:
			set("fg", true)
		case n == 39:
			set("fg", false)
		case n >= 40 && n <= 47 || n >= 100 && n <= 107:
			set("bg", true)
		case n == 49:
			set("bg", false)
		case n == 53:
			set("overline", true)
		case n == 55:
			set("overline", false)
		case n == 59:
			set("ulcolor", false)
		case n == 38 || n == 48 || n == 58:
			set(map[int]string{38: "fg", 48: "bg", 58: "ulcolor"}[n], true)
			// An extended colour: its arguments (5;n or 2;r;g;b) are not codes.
			if i+1 < len(ps) {
				switch ps[i+1] {
				case "5":
					i += 2
				case "2":
					i += 4
				}
			}
		default:
			set("other", true)
		}
	}
}

// midTurn says whether Devin's screen shows a turn in progress: the status line
// right above the box ends with "to interrupt)". Only that line is read, so the
// same words in the history above do not count. Queued messages sit between the
// two under a "── N queued ──" rule. Devin holds a queue only while a turn runs
// (it went at each turn's end, devin 3000.12.57), so the queue alone counts,
// whatever is above it; herdr reported done with it there (#86).
func midTurn(screen string) bool {
	lines := strings.Split(screen, "\n")
	top, _ := boxRules(lines)
	if queueRule(lines, top) >= 0 {
		return true
	}
	return top > 0 && strings.HasSuffix(plainLine(lines[top-1]), "to interrupt)")
}

var queuedRule = regexp.MustCompile(`^── \d+ queued ─`)

// queueRule finds the "── N queued ──" rule over the queue right above the box's
// top rule: the queue lines start with "○ ", are indented, or are blank (a blank
// line in a body). -1 when none, or when the queue is taller than the screen.
func queueRule(lines []string, top int) int {
	for i := top - 1; i >= 0; i-- {
		l := strings.TrimRight(sgr.ReplaceAllString(lines[i], ""), " \r")
		if queuedRule.MatchString(l) {
			return i
		}
		if l != "" && !strings.HasPrefix(l, "○ ") && !strings.HasPrefix(l, "  ") {
			return -1
		}
	}
	return -1
}

func plainLine(l string) string { return strings.TrimSpace(sgr.ReplaceAllString(l, "")) }

// boxRules finds the rules around Devin's input box: the last two lines of ─.
// Either is -1 when it is not on the screen.
func boxRules(lines []string) (top, bottom int) {
	top, bottom = -1, -1
	for i := len(lines) - 1; i >= 0; i-- {
		if !strings.HasPrefix(plainLine(lines[i]), "─") {
			continue
		}
		if bottom < 0 {
			bottom = i
			continue
		}
		top = i
		break
	}
	return top, bottom
}

// refusedInBody is a control or format character other than newline, tab and
// the zero-width joiners (U+200C, U+200D) that emoji sequences and some scripts
// need. An ESC can cancel or clear Devin's input; a bidi override can reorder
// what the receiver reads.
func refusedInBody(r rune) bool {
	switch r {
	case '\n', '\t', '\u200c', '\u200d':
		return false
	case '\u2028', '\u2029':
		return true
	}
	return unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r)
}

func (d *Devin) boxEmpty(ctx context.Context, id string) bool {
	screen, err := d.Herdr(ctx, "agent", "read", id, "--source", "visible", "--format", "ansi")
	return err == nil && inputBox(string(screen)) == inputEmpty
}

// historyLines is how many lines of history to read so the header stays inside
// them after the body is printed: herdr reads 80 by default, and a long body
// pushes the header above that. Each newline is a line, and a long line wraps
// about every 40 bytes; 200 more cover what Devin prints around it.
func historyLines(body string) int {
	return 200 + strings.Count(body, "\n") + len(body)/40
}

func (s *Service) sendClaude(ctx context.Context, req Request, emit func(*ccxv1.SendResponse) error) error {
	if s.Claude == nil {
		return markNotTyped(connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s is a Claude Code session, and this ccx-agent's heartbeat concern (which holds the ccx channels) is off", req.Target)))
	}
	return s.Claude.Send(ctx, req, emit)
}

// DevinHook takes one Devin hook event from `ccx-agent devin-hook`.
func (s *Service) DevinHook(ctx context.Context, req *connect.Request[ccxv1.DevinHookRequest]) (*connect.Response[ccxv1.DevinHookResponse], error) {
	out, err := s.Devin.Hook(ctx, req.Msg.GetPayload())
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&ccxv1.DevinHookResponse{Output: out}), nil
}
