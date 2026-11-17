package message

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"net/http"
	"net/http/httptest"

	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	// The files spell ESC as \e so that a diff of them stays readable text.
	return strings.ReplaceAll(string(b), `\e`, "\x1b")
}

// The fixtures are devin 3000.12.57's screen read through `herdr agent read
// --source visible --format ansi`, with the shell prompt and paths taken out
// and ESC written as \e.
func TestInputBoxOnDevinScreens(t *testing.T) {
	for _, tc := range []struct {
		file string
		want inputState
	}{
		// History lines above the box draw the same mark after a background colour.
		{"empty.ansi", inputEmpty},
		{"typed.ansi", inputTyped},
		// A permission prompt draws the mark styled and leaves no box.
		{"dialog.ansi", inputMissing},
		// An ask_user_question picker: its mark is indented and styled.
		{"question.ansi", inputMissing},
		// Devin mid-turn keeps its box, with another placeholder.
		{"working.ansi", inputEmpty},
	} {
		if got := inputBox(fixture(t, tc.file)); got != tc.want {
			t.Errorf("%s: inputBox = %v, want %v", tc.file, got, tc.want)
		}
	}
}

// box frames a box line between the two rules Devin draws around it.
func box(line string) string { return "history\n─────\n" + line + "\r\n─────\nfooter\n" }

func TestInputBoxReadsStylingNotWords(t *testing.T) {
	for _, tc := range []struct {
		name, screen string
		want         inputState
	}{
		{"bare mark", box("❭ "), inputEmpty},
		{"placeholder after reset", box("❭ \x1b[0m\x1b[38;2;9;9;9mAnything at all\x1b[0m"), inputEmpty},
		{"typed after a reset", box("❭ \x1b[0mhi"), inputTyped},
		{"typed after a bare reset", box("❭ \x1b[2m \x1b[mhi"), inputTyped},
		{"typed after the placeholder style ends", box("❭ \x1b[38;2;9;9;9m \x1b[0mhi"), inputTyped},
		{"typed before a styled tail", box("❭ hi\x1b[38;2;9;9;9m tail"), inputTyped},
		{"zero-padded reset", box("❭ \x1b[2m \x1b[00mhi"), inputTyped},
		{"reset spelled 0;0", box("❭ \x1b[2m \x1b[0;0mhi"), inputTyped},
		{"typed after default colour", box("❭ \x1b[38;2;9;9;9m \x1b[39mhi"), inputTyped},
		{"typed after normal intensity", box("❭ \x1b[1m \x1b[22;39mhi"), inputTyped},
		{"set then reset in one sequence", box("❭ \x1b[2m \x1b[31;0mhi"), inputTyped},
		{"reset then set in one sequence", box("❭ \x1b[0;31mplaceholder\x1b[0m"), inputEmpty},
		{"256-colour placeholder whose index looks like a reset", box("❭ \x1b[38;5;59mplaceholder\x1b[0m"), inputEmpty},
		{"truecolour placeholder whose blue looks like a reset", box("❭ \x1b[38;2;124;124;0mplaceholder\x1b[0m"), inputEmpty},
		{"only spaces typed", box("❭    "), inputTyped},
		{"spaces typed before a styled tail", box("❭   \x1b[2mtail\x1b[0m"), inputTyped},
		{"typed text on two lines, the second starting with the mark", box("❭ first line\r\n❭ "), inputTyped},
		{"a placeholder with a second line", box("❭ \x1b[2mplaceholder\x1b[0m\r\n  more"), inputTyped},
		// An unstyled "❭ " line in the output above the box does not decide anything.
		{"an unstyled mark in the output above", "❭ output line\n" + box("❭ \x1b[2mplaceholder"), inputEmpty},
		{"styled mark in the box", box("\x1b[1m❭ \x1b[0mAllow"), inputMissing},
		{"indented mark in the box", box("  \x1b[1m❭ \x1b[0mAllow"), inputMissing},
		{"no rules at all", "❭ \x1b[2mplaceholder\n", inputMissing},
		{"no rules and no mark", "plain screen\n", inputMissing},
		{"a dialog drawn below the box", box("❭ \x1b[2mplaceholder") + "\x1b[1m❭ \x1b[0mAllow", inputMissing},
		{"an indented dialog below the box", box("❭ \x1b[2mplaceholder") + "  \x1b[1m❭ \x1b[0mAllow", inputMissing},
		{"empty box", "─────\n─────\n", inputMissing},
		{"only one rule", "❭ \x1b[2mplaceholder\r\n─────\nfooter\n", inputMissing},
		{"placeholder colour with normal intensity", box("❭ \x1b[38;2;124;124;124;22mplaceholder\x1b[0m"), inputEmpty},
		{"placeholder colour then default background", box("❭ \x1b[38;2;124;124;124m\x1b[49mplaceholder\x1b[0m"), inputEmpty},
		{"bold stays after default colour", box("❭ \x1b[1;39mplaceholder\x1b[0m"), inputEmpty},
		{"typed after the colour is turned back", box("❭ \x1b[38;2;9;9;9m \x1b[39mhi"), inputTyped},
		{"an unknown code keeps styling until reset", box("❭ \x1b[73mplaceholder\x1b[0m"), inputEmpty},
		{"typed after the background is turned back", box("❭ \x1b[48;2;1;1;1m \x1b[49mhi"), inputTyped},
		{"256-colour index 0 is not a reset", box("❭ \x1b[38;5;0mplaceholder\x1b[0m"), inputEmpty},
	} {
		if got := inputBox(tc.screen); got != tc.want {
			t.Errorf("%s: inputBox = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// fakeHerdr plays a Devin pane. Each read of the visible screen and each status
// look takes the next entry of its script, and stays on the last one.
type fakeHerdr struct {
	panes   string
	screens []string
	// before is the history until the prompt goes in, history after it.
	before, history string
	status          []string
	calls           [][]string
	prompt          error
	typed           bool
	statusErr       error
	lines           []string
	// panesAfter, if set, is what pane list returns from its second call on.
	panesAfter string
	listed     int
	// hold keeps the prompt out of the history until a key is sent (a queue).
	hold bool
	keys []string
}

func (f *fakeHerdr) run(_ context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	next := func(s *[]string) string {
		v := (*s)[0]
		if len(*s) > 1 {
			*s = (*s)[1:]
		}
		return v
	}
	cmd := strings.Join(args[:2], " ")
	if cmd != "pane list" && args[2] != "w2:p1" {
		return nil, errors.New("herdr " + cmd + " on the wrong pane " + args[2])
	}
	switch cmd {
	case "pane list":
		f.listed++
		if f.panesAfter != "" && f.listed > 1 {
			return []byte(f.panesAfter), nil
		}
		return []byte(f.panes), nil
	case "pane get":
		if f.statusErr != nil {
			return nil, f.statusErr
		}
		return []byte(`{"result":{"pane":{"agent_status":"` + next(&f.status) + `"}}}`), nil
	case "agent read":
		if args[4] == "recent-unwrapped" {
			if strings.Join(args[3:7], " ") != "--source recent-unwrapped --format text" || len(args) != 9 || args[7] != "--lines" {
				return nil, errors.New("unexpected read " + strings.Join(args, " "))
			}
			f.lines = append(f.lines, args[8])
			if f.typed {
				return []byte(f.history), nil
			}
			return []byte(f.before), nil
		}
		if strings.Join(args[3:], " ") != "--source visible --format ansi" {
			return nil, errors.New("unexpected read " + strings.Join(args, " "))
		}
		return []byte(next(&f.screens)), nil
	case "agent prompt":
		f.typed = f.prompt == nil && !f.hold
		return nil, f.prompt
	case "pane send-keys":
		f.keys = append(f.keys, args[3:]...)
		f.typed = true
		return nil, nil
	}
	return nil, errors.New("unexpected herdr " + strings.Join(args, " "))
}

func (f *fakeHerdr) prompted() []string {
	for _, c := range f.calls {
		if c[0] == "agent" && c[1] == "prompt" {
			return c
		}
	}
	return nil
}

const (
	devinPanes = `{"result":{"panes":[
		{"pane_id":"w1:p1","agent":"claude","agent_status":"idle","agent_session":{"value":"claude-one"}},
		{"pane_id":"w2:p1","agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}},
		{"pane_id":"w3:p1","agent":"devin","agent_status":"idle","agent_session":null}]}}`
	emptyBox = "history\n\x1b[0m\x1b[38;2;68;68;68m──────\x1b[0m\r\n❭ \x1b[0m\x1b[38;2;124;124;124mAsk Devin\x1b[0m\r\n\x1b[0m\x1b[38;2;68;68;68m──────\x1b[0m\r\nfooter\n"
	typedBox = "──────\n❭ half typed\r\n──────\n"
)

func newDevin(f *fakeHerdr) *Devin {
	return &Devin{Herdr: f.run, Poll: time.Millisecond, SentWait: 50 * time.Millisecond, StartWait: 50 * time.Millisecond}
}

func send(d *Devin, req Request) ([]*ccxv1.SendResponse, error) {
	var got []*ccxv1.SendResponse
	err := d.Send(context.Background(), req, func(e *ccxv1.SendResponse) error {
		got = append(got, e)
		return nil
	})
	return got, err
}

func req(mode ccxv1.DeliveryMode) Request {
	return Request{Target: "excited-giraffe", Sender: "claude-a1b2c3d4", Summary: "review 3", Body: "line 1\nline 2", Mode: mode}
}

func TestSendTypesHeaderAndBodyAndReportsSentThenWorking(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3\nline 1\n", status: []string{"idle", "working"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_UNSPECIFIED))
	if err != nil {
		t.Fatal(err)
	}
	p := f.prompted()
	if p == nil || p[2] != "w2:p1" || p[3] != "ccx: claude-a1b2c3d4: review 3\nline 1\nline 2" {
		t.Fatalf("prompt = %q", p)
	}
	if len(got) != 2 || got[0].State != ccxv1.SendResponse_STATE_SENT || got[0].Detail != "pane w2:p1" || got[1].State != ccxv1.SendResponse_STATE_WORKING || got[1].Detail != "agent_status working" {
		t.Fatalf("events = %v", got)
	}
}

func TestSendCountsDoneAsStarted(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"done"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_WORKING || got[1].Detail != "agent_status done" {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestSendReportsNotStartedWhenStatusStaysIdle(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_NOT_STARTED || !strings.Contains(got[1].Detail, "last look: idle") {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestSendWaitsUntilTheBoxClearsAndTheHeaderShows(t *testing.T) {
	// The box still holds the text twice before it submits.
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox, typedBox, typedBox, emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 {
		t.Fatalf("events = %v, err = %v", got, err)
	}
	reads := 0
	for _, c := range f.calls {
		if c[1] == "read" && c[4] == "visible" {
			reads++
		}
	}
	if reads != 5 {
		t.Fatalf("visible reads = %d, want 5 (the box before and after the history read)", reads)
	}
}

func TestSendFailsWhenThePromptNeverShowsAsSent(t *testing.T) {
	// The box cleared but the header is not in the history: not counted as sent.
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ something else", status: []string{"working"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if connect.CodeOf(err) != connect.CodeUnknown || !strings.Contains(err.Error(), "was not seen as sent") || len(got) != 0 || notTyped(err) {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestSendRefusesWithoutTyping(t *testing.T) {
	for _, tc := range []struct {
		name   string
		f      *fakeHerdr
		r      Request
		code   connect.Code
		reason string
	}{
		{"text in the box", &fakeHerdr{panes: devinPanes, screens: []string{typedBox}}, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT), connect.CodeFailedPrecondition, "has text in its input box"},
		{"a dialog is open", &fakeHerdr{panes: devinPanes, screens: []string{"\x1b[1m❭ \x1b[0mAllow"}}, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT), connect.CodeFailedPrecondition, "not at its input box"},
		{"after-turn while working", &fakeHerdr{panes: strings.Replace(devinPanes, `"agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}`, `"agent":"devin","agent_status":"working","agent_session":{"value":"excited-giraffe"}`, 1), screens: []string{emptyBox}}, req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN), connect.CodeFailedPrecondition, "after-turn is refused"},
		{"unknown target", &fakeHerdr{panes: devinPanes}, Request{Target: "nobody", Sender: "s", Summary: "x", Body: "b"}, connect.CodeNotFound, `no herdr pane has session "nobody"`},
		{"not a devin", &fakeHerdr{panes: devinPanes}, Request{Target: "claude-one", Sender: "s", Summary: "x", Body: "b"}, connect.CodeFailedPrecondition, "is a claude session"},
		{"two panes", &fakeHerdr{panes: strings.Replace(devinPanes, `"agent_session":null`, `"agent_session":{"value":"excited-giraffe"}`, 1)}, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT), connect.CodeFailedPrecondition, "2 herdr panes"},
		{"summary with a newline", &fakeHerdr{panes: devinPanes}, Request{Target: "excited-giraffe", Sender: "s", Summary: "a\nb", Body: "b"}, connect.CodeInvalidArgument, "one non-empty line"},
		{"empty sender", &fakeHerdr{panes: devinPanes}, Request{Target: "excited-giraffe", Summary: "x", Body: "b"}, connect.CodeInvalidArgument, "one non-empty line"},
		{"empty body", &fakeHerdr{panes: devinPanes}, Request{Target: "excited-giraffe", Sender: "s", Summary: "x"}, connect.CodeInvalidArgument, "body is empty"},
		{"empty target", &fakeHerdr{panes: devinPanes}, Request{Sender: "s", Summary: "x", Body: "b"}, connect.CodeInvalidArgument, "target is empty"},
	} {
		got, err := send(newDevin(tc.f), tc.r)
		if connect.CodeOf(err) != tc.code || !strings.Contains(err.Error(), tc.reason) {
			t.Errorf("%s: err = %v, want %v containing %q", tc.name, err, tc.code, tc.reason)
		}
		if p := tc.f.prompted(); p != nil || len(got) != 0 || !notTyped(err) {
			t.Errorf("%s: typed %q, events %v, marked not typed %v", tc.name, p, got, notTyped(err))
		}
	}
}

func TestSendPassesOnAFailedPrompt(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, prompt: errors.New("herdr agent: exit status 1: agent_blocked")}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if connect.CodeOf(err) != connect.CodeUnknown || !strings.Contains(err.Error(), "agent_blocked") || notTyped(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendCountsBlockedAsStarted(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle", "blocked"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_WORKING || got[1].Detail != "agent_status blocked" {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestUnspecifiedModeIsAfterTurn(t *testing.T) {
	working := strings.Replace(devinPanes, `"agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}`, `"agent":"devin","agent_status":"working","agent_session":{"value":"excited-giraffe"}`, 1)
	f := &fakeHerdr{panes: working, screens: []string{emptyBox}}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_UNSPECIFIED))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "after-turn is refused") || f.prompted() != nil {
		t.Fatalf("err = %v, typed %q", err, f.prompted())
	}
}

func TestSendRefusesUnknownModeAndOversizedBody(t *testing.T) {
	big := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	big.Body = strings.Repeat("x", 64<<10+1)
	for name, r := range map[string]Request{"unknown mode": req(ccxv1.DeliveryMode(99)), "oversized body": big} {
		f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
		_, err := send(newDevin(f), r)
		if connect.CodeOf(err) != connect.CodeInvalidArgument || f.prompted() != nil {
			t.Errorf("%s: err = %v, typed %v", name, err, f.prompted() != nil)
		}
	}
	ok := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	ok.Body = strings.Repeat("x", 64<<10)
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(f), ok); err != nil {
		t.Errorf("a body at the limit: %v", err)
	}
}

// A pane whose status before the send is st.
func panesWith(st string) string {
	return strings.Replace(devinPanes, `"agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}`, `"agent":"devin","agent_status":"`+st+`","agent_session":{"value":"excited-giraffe"}`, 1)
}

func TestSendDoesNotTakeADoneLeftFromThePreviousTurnAsStarted(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("done"), screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"done"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_NOT_STARTED {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestUrgentToAWorkingDevinSaysItWasAlreadyWorking(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_SENT || !strings.Contains(got[0].Detail, "was working, reads it at its next break") {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestSendDoesNotTakeAnEarlierSameHeaderAsSent(t *testing.T) {
	line := "❭ ccx: claude-a1b2c3d4: review 3\n"
	stale := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, before: line, history: line, status: []string{"working"}}
	if _, err := send(newDevin(stale), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err == nil || connect.CodeOf(err) != connect.CodeUnknown {
		t.Fatalf("stale header: err = %v", err)
	}
	again := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, before: line, history: line + line, status: []string{"working"}}
	if got, err := send(newDevin(again), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err != nil || len(got) != 2 {
		t.Fatalf("second header: events = %v, err = %v", got, err)
	}
}

func TestSendRefusesControlCharactersInTheBody(t *testing.T) {
	for _, body := range []string{"a\x1b[2Kb", "a\x07", "a\rb", "a\u009bb", "a\x9bb", "a\u2028b", "a\u202eb", "a\u200bb"} {
		r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
		r.Body = body
		f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}}
		if _, err := send(newDevin(f), r); connect.CodeOf(err) != connect.CodeInvalidArgument || f.prompted() != nil {
			t.Errorf("%q: err = %v", body, err)
		}
	}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.Body = "tab\there\nnext line 👨\u200d👩\u200d👧 क्\u200dष"
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(f), r); err != nil {
		t.Errorf("tab and newline: %v", err)
	}
}

func TestServiceLogsEachSend(t *testing.T) {
	var lines []string
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox}}
	s := &Service{Devin: newDevin(f), Log: func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	// later to a working pane is queued, not typed: only if the mode reaches
	// Devin.Send (unspecified would be an after-turn refusal). The wait is
	// TestServiceDeliverPassesTheWaitOn's.
	var got []*ccxv1.SendResponse
	err := s.Deliver(context.Background(), &ccxv1.SendRequest{Target: r.Target, Sender: r.Sender, Summary: r.Summary, Body: r.Body, Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER, WaitSeconds: 0}, func(a *ccxv1.SendResponse) error {
		got = append(got, a)
		return nil
	})
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_QUEUED || f.prompted() != nil {
		t.Fatalf("Deliver: acks %v err %v", got, err)
	}
	if len(lines) != 1 || !strings.Contains(lines[0], `to "excited-giraffe" from "claude-a1b2c3d4"`) || !strings.HasSuffix(lines[0], ": STATE_QUEUED") {
		t.Fatalf("log = %q", lines)
	}
}

// Two sends to one pane at once: the second may not look at the box before the
// first has typed, or both see it empty and type into it together.
func TestSendsAreOneAtATime(t *testing.T) {
	var mu sync.Mutex
	var order []string
	inner := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, status: []string{"working"}}
	d := newDevin(inner)
	d.Herdr = func(ctx context.Context, args ...string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, args[0]+" "+args[1])
		if args[1] == "prompt" {
			// The second send's history must grow past what it saw before.
			inner.history += "❭ ccx: claude-a1b2c3d4: review 3\n"
		}
		out, err := inner.run(ctx, args...)
		if args[1] == "list" {
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
		}
		return out, err
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
		}()
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("sends failed: %v", errs)
	}
	lists := 0
	for _, o := range order {
		if o == "agent prompt" {
			break
		}
		if o == "pane list" {
			lists++
		}
	}
	// Each send looks the pane up twice (found, then again before the last check).
	if lists != 2 {
		t.Fatalf("the second send looked before the first typed: %q", order)
	}
}

func TestNotStartedSaysWhyStatusCouldNotBeRead(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", statusErr: errors.New("herdr pane get: socket gone")}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_NOT_STARTED || !strings.Contains(got[1].Detail, "socket gone") {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func notTyped(err error) bool {
	ce := new(connect.Error)
	return errors.As(err, &ce) && ce.Meta().Get(NotTypedKey) == "1"
}

func TestSentNeedsTheExactHeaderLine(t *testing.T) {
	// "review 10" sent earlier is not "review 1"; Devin pads the line with spaces.
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, before: "❭ ccx: claude-a1b2c3d4: review 30   \n", history: "❭ ccx: claude-a1b2c3d4: review 30   \n❭ ccx: claude-a1b2c3d4: review 3      \n", status: []string{"working"}}
	if got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err != nil || len(got) != 2 {
		t.Fatalf("events = %v, err = %v", got, err)
	}
	g := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 30\n", status: []string{"working"}}
	if _, err := send(newDevin(g), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err == nil || connect.CodeOf(err) != connect.CodeUnknown {
		t.Fatalf("a longer summary counted as sent: %v", err)
	}
}

// With the box not in sight (a dialog, or unsent text too tall for the screen),
// the header in the history may be that unsent text: not counted as sent.
func TestABoxOutOfSightIsNotTakenAsSent(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox, "\x1b[1m❭ \x1b[0mAllow"}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"done"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err == nil || connect.CodeOf(err) != connect.CodeUnknown || notTyped(err) || len(got) != 0 {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestStoppingWhileWaitingIsCanceledAndMarkedTyped(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox, typedBox}, history: "", status: []string{"working"}}
	d := newDevin(f)
	d.SentWait = time.Minute
	ctx, cancel := context.WithCancel(context.Background())
	inner := d.Herdr
	d.Herdr = func(c context.Context, args ...string) ([]byte, error) {
		if args[1] == "prompt" {
			cancel()
		}
		return inner(c, args...)
	}
	err := d.Send(ctx, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT), func(*ccxv1.SendResponse) error { return nil })
	if connect.CodeOf(err) != connect.CodeCanceled || notTyped(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendRefusesLongOrBrokenLabels(t *testing.T) {
	for name, r := range map[string]Request{
		"long sender":    {Target: "excited-giraffe", Sender: strings.Repeat("s", 41), Summary: "x", Body: "b"},
		"long summary":   {Target: "excited-giraffe", Sender: "s", Summary: strings.Repeat("s", 81), Body: "b"},
		"broken sender":  {Target: "excited-giraffe", Sender: "a\xffb", Summary: "x", Body: "b"},
		"broken summary": {Target: "excited-giraffe", Sender: "s", Summary: "a\xffb", Body: "b"},
		"trailing space": {Target: "excited-giraffe", Sender: "s", Summary: "review 3 ", Body: "b"},
		"leading space":  {Target: "excited-giraffe", Sender: " s", Summary: "x", Body: "b"},
		"bidi override":  {Target: "excited-giraffe", Sender: "claude\u202e", Summary: "x", Body: "b"},
	} {
		f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}}
		if _, err := send(newDevin(f), r); connect.CodeOf(err) != connect.CodeInvalidArgument || f.prompted() != nil {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.Sender, r.Summary = strings.Repeat("f", 40), strings.Repeat("s", 80)
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: " + r.Sender + ": " + r.Summary, status: []string{"working"}}
	if _, err := send(newDevin(f), r); err != nil {
		t.Errorf("labels at the limit: %v", err)
	}
}

func TestALongBodyGetsLongerToShowAsSent(t *testing.T) {
	// With no base wait, only the time given for the body's size lets the
	// box clear after a few looks.
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox, typedBox, typedBox, typedBox, emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	d := newDevin(f)
	d.SentWait = 0
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.Body = strings.Repeat("x", 16<<10)
	if got, err := send(d, r); err != nil || len(got) != 2 {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestStartedStatusesLeftFromBeforeDoNotCount(t *testing.T) {
	// blocked before the prompt, still blocked after: not this message.
	f := &fakeHerdr{panes: panesWith("blocked"), screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"blocked"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_NOT_STARTED {
		t.Fatalf("blocked: events = %v, err = %v", got, err)
	}
	// done before, then idle, then done: the second done is this message's turn.
	g := &fakeHerdr{panes: panesWith("done"), screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"done", "idle", "done"}}
	got, err = send(newDevin(g), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("done after idle: events = %v, err = %v", got, err)
	}
}

// A herdr read that hangs is cut off by the wait, not by herdr's own timeout.
func TestTheWaitBoundsAHangingHerdrCall(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, status: []string{"working"}}
	d := newDevin(f)
	inner := d.Herdr
	typed := false
	d.Herdr = func(ctx context.Context, args ...string) ([]byte, error) {
		if args[1] == "prompt" {
			typed = true
		}
		if typed && args[1] == "read" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return inner(ctx, args...)
	}
	start := time.Now()
	_, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err == nil || connect.CodeOf(err) != connect.CodeUnknown || time.Since(start) > 3*time.Second {
		t.Fatalf("err = %v after %s", err, time.Since(start))
	}
}

// Through the real handler: acks reach the client and the last one is logged.
func TestServiceStreamsAcksAndLogsTheLast(t *testing.T) {
	var lines []string
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle", "working"}}
	s := &Service{Devin: newDevin(f), Log: func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }}
	path, h := ccxv1connect.NewMessageServiceHandler(s)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	stream, err := ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL).Send(context.Background(), connect.NewRequest(&ccxv1.SendRequest{Target: r.Target, Sender: r.Sender, Summary: r.Summary, Body: r.Body, Mode: r.Mode}))
	if err != nil {
		t.Fatal(err)
	}
	var states []ccxv1.SendResponse_State
	for stream.Receive() {
		states = append(states, stream.Msg().State)
	}
	if stream.Err() != nil || len(states) != 2 || states[1] != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("states %v err %v", states, stream.Err())
	}
	if len(lines) != 1 || !strings.HasSuffix(lines[0], ": STATE_WORKING") {
		t.Fatalf("log = %q", lines)
	}
}

// herdr says idle while Devin is still writing; the screen says otherwise.
func TestAfterTurnRefusedWhileTheScreenShowsATurn(t *testing.T) {
	working := fixture(t, "working.ansi")
	f := &fakeHerdr{panes: devinPanes, screens: []string{working}}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "after-turn is refused") || f.prompted() != nil {
		t.Fatalf("err = %v, typed %v", err, f.prompted() != nil)
	}
	// urgent still goes in.
	g := &fakeHerdr{panes: devinPanes, screens: []string{working, emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(g), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err != nil {
		t.Fatalf("urgent: %v", err)
	}
}

// The not-typed mark reaches a Connect client over the wire, on a streaming error.
func TestNotTypedMarkCrossesTheWire(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{typedBox}}
	path, h := ccxv1connect.NewMessageServiceHandler(&Service{Devin: newDevin(f)})
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	stream, err := ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL).Send(context.Background(), connect.NewRequest(&ccxv1.SendRequest{Target: r.Target, Sender: r.Sender, Summary: r.Summary, Body: r.Body, Mode: r.Mode}))
	if err == nil {
		for stream.Receive() {
		}
		err = stream.Err()
	}
	if !notTyped(err) || !strings.Contains(err.Error(), "has text in its input box") {
		t.Fatalf("err = %v, marked %v", err, notTyped(err))
	}
}

func TestMidTurnReadsOnlyTheStatusLineAboveTheBox(t *testing.T) {
	if !midTurn(fixture(t, "working.ansi")) {
		t.Error("working.ansi: not mid-turn")
	}
	for _, name := range []string{"empty.ansi", "typed.ansi", "dialog.ansi", "question.ansi"} {
		if midTurn(fixture(t, name)) {
			t.Errorf("%s: mid-turn", name)
		}
	}
	// The words in the history, not on the status line.
	if midTurn("Typing · 3s (esc twice to interrupt)\nanswer line\n" + box("❭ \x1b[2mplaceholder")) {
		t.Error("history text read as the status line")
	}
}

// herdr says idle while Devin writes; an urgent send then ends at sent like one
// to a working Devin, since its status cannot show this message being picked up.
func TestUrgentToADevinMidTurnOnScreenEndsAtSent(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{fixture(t, "working.ansi"), emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_SENT || !strings.Contains(got[0].Detail, "was working") {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}

func TestBodyRefusesFormatCharactersButKeepsJoiners(t *testing.T) {
	for _, r := range []rune{'\x1b', '\u00ad', '\u202e', '\u2066', '\ufeff', '\U000E0001', '\U00013430', '\u2028'} {
		if !refusedInBody(r) {
			t.Errorf("%U not refused", r)
		}
	}
	for _, r := range []rune{'\n', '\t', '\u200c', '\u200d', 'a', 'क'} {
		if refusedInBody(r) {
			t.Errorf("%U refused", r)
		}
	}
}

// The box must still be empty after the history read: text that went back into
// the box (or never left it) is not sent.
func TestSentNeedsTheBoxEmptyAfterTheHistoryToo(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox, emptyBox, typedBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err == nil || connect.CodeOf(err) != connect.CodeUnknown {
		t.Fatalf("err = %v", err)
	}
}

// The box is looked at right before typing: nothing runs between the screen read
// and the prompt.
func TestTheBoxIsReadRightBeforeTyping(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); err != nil {
		t.Fatal(err)
	}
	for i, c := range f.calls {
		if c[1] == "prompt" {
			if prev := f.calls[i-1]; prev[1] != "read" || prev[4] != "visible" {
				t.Fatalf("the call before the prompt was %q", prev)
			}
			return
		}
	}
	t.Fatal("no prompt")
}

func TestASessionThatLeftThePaneIsNotTypedInto(t *testing.T) {
	moved := strings.Replace(devinPanes, `{"pane_id":"w2:p1","agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}}`, `{"pane_id":"w9:p1","agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}}`, 1)
	f := &fakeHerdr{panes: devinPanes, panesAfter: moved, screens: []string{emptyBox}}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "moved from pane w2:p1 to w9:p1") || f.prompted() != nil || !notTyped(err) {
		t.Fatalf("err = %v, typed %v", err, f.prompted() != nil)
	}
	gone := &fakeHerdr{panes: devinPanes, panesAfter: `{"result":{"panes":[]}}`, screens: []string{emptyBox}}
	if _, err := send(newDevin(gone), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)); connect.CodeOf(err) != connect.CodeNotFound || gone.prompted() != nil {
		t.Fatalf("gone: err = %v", err)
	}
}

func TestHistoryIsReadDeepEnoughForTheBody(t *testing.T) {
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.Body = strings.Repeat("line\n", 500)
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(f), r); err != nil {
		t.Fatal(err)
	}
	// 200 + 500 newlines + 2500 bytes / 40
	want := "762"
	for _, n := range f.lines {
		if n != want {
			t.Fatalf("history read with --lines %q, want %s for both reads (%q)", n, want, f.lines)
		}
	}
	if len(f.lines) < 2 {
		t.Fatalf("history reads = %q", f.lines)
	}
}

// The status from the second lookup is the one used: idle when found, working
// right before typing, refuses after-turn.
func TestTheStatusFromTheSecondLookupIsUsed(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, panesAfter: panesWith("working"), screens: []string{emptyBox}}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "after-turn is refused") || f.prompted() != nil {
		t.Fatalf("err = %v", err)
	}
}

func TestParseKeymap(t *testing.T) {
	for _, tc := range []struct {
		name, config string
		want         Keymap
	}{
		{"default", `{"theme_mode":"dark"}`, Keymap{Send: "enter"}},
		{"enter queues, ctrl+enter sends", `{"keymap":{"editor":{"accept_line":"ctrl-enter"},"readbox_input":{"queue_message":"enter"}}}`, Keymap{Queues: true, Send: "ctrl+enter"}},
		{"queue on another key", `{"keymap":{"readbox_input":{"queue_message":"tab"}}}`, Keymap{Send: "enter"}},
	} {
		got, err := parseKeymap([]byte(tc.config))
		if err != nil || got != tc.want {
			t.Errorf("%s: got %+v, %v", tc.name, got, err)
		}
	}
	if _, err := parseKeymap([]byte(`{"keymap":`)); err == nil {
		t.Error("broken config: no error")
	}
}

const queuedHeader = "ccx: claude-a1b2c3d4: review 3"

func queuedScreen(t *testing.T) string {
	return strings.Replace(fixture(t, "queued.ansi"), "ccx: tester: queued sample", queuedHeader, 1)
}

func TestQueuedScreenReadsAsMidTurnWithAnEmptyBox(t *testing.T) {
	s := fixture(t, "queued.ansi")
	if !midTurn(s) || inputBox(s) != inputEmpty || queuedLines(s, "ccx: tester: queued sample") != 1 || queuedLines(s, "ccx: tester: queued") != 0 {
		t.Fatalf("midTurn %v, inputBox %v, queued %d", midTurn(s), inputBox(s), queuedLines(s, "ccx: tester: queued sample"))
	}
	// Indented lines alone, with no queued rule above them, are not a queue.
	if midTurn(strings.Replace(s, "1 queued", "1 thing", 1)) {
		t.Fatal("midTurn without the queued rule")
	}
	// A queued rule in the history, above lines that are not queued, is not the queue.
	if midTurn("old (esc twice to interrupt)\n── 1 queued ──\nhistory line\n─────\n❭ box\n─────\n") {
		t.Fatal("midTurn from a queued rule in the history")
	}
}

var enterQueues = func() (Keymap, error) { return Keymap{Queues: true, Send: "ctrl+enter"}, nil }

func TestUrgentToAQueueingDevinSendsTheQueueOn(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox, queuedScreen(t)}, history: "❭ " + queuedHeader, status: []string{"working"}, hold: true}
	d := newDevin(f)
	d.Keymap = enterQueues
	got, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_SENT || !strings.Contains(got[0].Detail, "reads it at its next break") || strings.Join(f.keys, " ") != "ctrl+enter" {
		t.Fatalf("events = %v, err = %v, keys = %v", got, err, f.keys)
	}
}

func TestAfterTurnToAQueueingDevinLeavesItQueued(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox, queuedScreen(t)}, status: []string{"working"}, hold: true}
	d := newDevin(f)
	d.Keymap = enterQueues
	got, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_SENT || !strings.Contains(got[0].Detail, "queued until its turn ends") || len(f.keys) != 0 {
		t.Fatalf("events = %v, err = %v, keys = %v", got, err, f.keys)
	}
}

func TestAQueueingDevinWhoseTurnEndedTakesItAsIdle(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox}, history: "❭ " + queuedHeader, status: []string{"idle", "working"}}
	d := newDevin(f)
	d.Keymap = enterQueues
	got, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_WORKING || len(f.keys) != 0 {
		t.Fatalf("events = %v, err = %v, keys = %v", got, err, f.keys)
	}
}

func TestQueuedButNeverShownIsMayHaveBeenSent(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox}, status: []string{"working"}, hold: true}
	d := newDevin(f)
	d.Keymap = enterQueues
	_, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeUnknown || !strings.Contains(err.Error(), "not seen as queued or sent") || len(f.keys) != 0 {
		t.Fatalf("err = %v, keys = %v", err, f.keys)
	}
}

func TestUrgentRefusedWhenEnterBothQueuesAndSends(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working"), screens: []string{emptyBox}}
	d := newDevin(f)
	d.Keymap = func() (Keymap, error) { return Keymap{Queues: true, Send: "enter"}, nil }
	_, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || f.prompted() != nil {
		t.Fatalf("err = %v", err)
	}
}

func TestABrokenKeymapSendsNothing(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}}
	d := newDevin(f)
	d.Keymap = func() (Keymap, error) { return Keymap{}, errors.New("devin config: broken") }
	_, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || f.prompted() != nil {
		t.Fatalf("err = %v", err)
	}
}

// herdr reported done while messages sat queued (#86): the queue on screen still
// says mid-turn, so after-turn is refused under the default keymap.
func TestAQueueOnScreenIsMidTurnWhateverHerdrSays(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("done"), screens: []string{queuedScreen(t)}}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "after-turn is refused") || f.prompted() != nil {
		t.Fatalf("err = %v", err)
	}
}

// The keymap only matters mid-turn: an idle Devin takes Enter as a send.
func TestUrgentToAnIdleDevinIgnoresTheQueueKeymap(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ " + queuedHeader, status: []string{"idle", "working"}}
	d := newDevin(f)
	d.Keymap = func() (Keymap, error) { return Keymap{Queues: true, Send: "enter"}, nil }
	got, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("events = %v, err = %v", got, err)
	}
}
