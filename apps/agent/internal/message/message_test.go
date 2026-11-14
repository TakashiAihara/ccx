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
	} {
		if got := inputBox(fixture(t, tc.file)); got != tc.want {
			t.Errorf("%s: inputBox = %v, want %v", tc.file, got, tc.want)
		}
	}
}

func TestInputBoxReadsStylingNotWords(t *testing.T) {
	for _, tc := range []struct {
		name, screen string
		want         inputState
	}{
		{"bare mark", "❭ \r\n─", inputEmpty},
		{"placeholder after reset", "❭ \x1b[0m\x1b[38;2;9;9;9mAnything at all\x1b[0m\r\n─", inputEmpty},
		{"typed after a reset", "❭ \x1b[0mhi\r", inputTyped},
		{"typed after a bare reset", "❭ \x1b[2m \x1b[mhi\r", inputTyped},
		{"typed after the placeholder style ends", "❭ \x1b[38;2;9;9;9m \x1b[0mhi", inputTyped},
		{"typed before a styled tail", "❭ hi\x1b[38;2;9;9;9m tail", inputTyped},
		{"no mark", "plain screen\n", inputMissing},
		{"styled mark only", "\x1b[1m❭ \x1b[0mAllow", inputMissing},
		{"last box wins", "❭ old\n❭ \x1b[2mplaceholder\n─", inputEmpty},
		{"placeholder with no rule under it", "❭ \x1b[2mplaceholder\nsomething", inputMissing},
		{"a dialog drawn below the box", "❭ \x1b[2mplaceholder\n─\n\x1b[1m❭ \x1b[0mAllow", inputMissing},
		{"zero-padded reset", "❭ \x1b[2m \x1b[00mhi", inputTyped},
		{"reset spelled 0;0", "❭ \x1b[2m \x1b[0;0mhi", inputTyped},
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
		return []byte(f.panes), nil
	case "pane get":
		if f.statusErr != nil {
			return nil, f.statusErr
		}
		return []byte(`{"result":{"pane":{"agent_status":"` + next(&f.status) + `"}}}`), nil
	case "agent read":
		if args[4] == "recent-unwrapped" {
			if strings.Join(args[3:], " ") != "--source recent-unwrapped --format text" {
				return nil, errors.New("unexpected read " + strings.Join(args, " "))
			}
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
		f.typed = f.prompt == nil
		return nil, f.prompt
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
	emptyBox = "history\n❭ \x1b[0m\x1b[38;2;124;124;124mAsk Devin\x1b[0m\r\n\x1b[0m\x1b[38;2;68;68;68m──────\x1b[0m\r\nfooter\n"
	typedBox = "❭ half typed\r\n"
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
	if reads != 4 {
		t.Fatalf("visible reads = %d, want 4", reads)
	}
}

func TestSendFailsWhenThePromptNeverShowsAsSent(t *testing.T) {
	// The box cleared but the header is not in the history: not counted as sent.
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ something else", status: []string{"working"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if connect.CodeOf(err) != connect.CodeUnknown || !strings.Contains(err.Error(), "was not seen as sent") || len(got) != 0 || !typedMark(err) {
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
		{"later", &fakeHerdr{panes: devinPanes}, req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER), connect.CodeInvalidArgument, "it takes after-turn, urgent"},
		{"after-turn while working", &fakeHerdr{panes: strings.Replace(devinPanes, `"agent":"devin","agent_status":"idle","agent_session":{"value":"excited-giraffe"}`, `"agent":"devin","agent_status":"working","agent_session":{"value":"excited-giraffe"}`, 1)}, req(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN), connect.CodeFailedPrecondition, "after-turn is refused"},
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
		if p := tc.f.prompted(); p != nil || len(got) != 0 || typedMark(err) {
			t.Errorf("%s: typed %q, events %v, marked typed %v", tc.name, p, got, typedMark(err))
		}
	}
}

func TestSendPassesOnAFailedPrompt(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, prompt: errors.New("herdr agent: exit status 1: agent_blocked")}
	_, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if !strings.Contains(err.Error(), "agent_blocked") || !typedMark(err) {
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
	if err != nil || len(got) != 2 || got[1].State != ccxv1.SendResponse_STATE_WORKING || !strings.Contains(got[1].Detail, "was working when sent") {
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
	for _, body := range []string{"a\x1b[2Kb", "a\x07", "a\rb", "a\u009bb", "a\x9bb"} {
		r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
		r.Body = body
		f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}}
		if _, err := send(newDevin(f), r); connect.CodeOf(err) != connect.CodeInvalidArgument || f.prompted() != nil {
			t.Errorf("%q: err = %v", body, err)
		}
	}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.Body = "tab\there\nnext line"
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
	if _, err := send(newDevin(f), r); err != nil {
		t.Errorf("tab and newline: %v", err)
	}
}

func TestServiceLogsEachSend(t *testing.T) {
	var lines []string
	f := &fakeHerdr{panes: devinPanes, screens: []string{typedBox}}
	s := &Service{Devin: newDevin(f), Log: func(format string, a ...any) { lines = append(lines, fmt.Sprintf(format, a...)) }}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	err := s.Devin.Send(context.Background(), r, func(*ccxv1.SendResponse) error { return nil })
	if err == nil {
		t.Fatal("want a refusal")
	}
	// after-turn to a working pane: refused only if the mode reaches Devin.Send.
	f.panes = panesWith("working")
	serr := s.Send(context.Background(), connect.NewRequest(&ccxv1.SendRequest{Target: r.Target, Sender: r.Sender, Summary: r.Summary, Body: r.Body, Mode: ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN}), nil)
	if serr == nil || !strings.Contains(serr.Error(), "after-turn is refused") {
		t.Fatalf("Service.Send err = %v", serr)
	}
	if len(lines) != 1 || !strings.Contains(lines[0], `to "excited-giraffe" from "claude-a1b2c3d4"`) || !strings.Contains(lines[0], "after-turn is refused") {
		t.Fatalf("log = %q", lines)
	}
}

// Two sends to one pane at once: the second may not look at the box before the
// first has typed, or both see it empty and type into it together.
func TestSendsAreOneAtATime(t *testing.T) {
	var mu sync.Mutex
	var order []string
	inner := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"working"}}
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
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
		}()
	}
	wg.Wait()
	lists := 0
	for _, o := range order {
		if o == "agent prompt" {
			break
		}
		if o == "pane list" {
			lists++
		}
	}
	if lists != 1 {
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

func typedMark(err error) bool {
	ce := new(connect.Error)
	return errors.As(err, &ce) && ce.Meta().Get(TypedKey) == "1"
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

func TestSentWhenADialogReplacedTheBoxRightAway(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox, "\x1b[1m❭ \x1b[0mAllow"}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"done"}}
	got, err := send(newDevin(f), req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT))
	if err != nil || len(got) != 2 || got[0].State != ccxv1.SendResponse_STATE_SENT {
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
	if connect.CodeOf(err) != connect.CodeCanceled || !typedMark(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestSendRefusesLongOrBrokenLabels(t *testing.T) {
	long := strings.Repeat("s", MaxLabel+1)
	for name, r := range map[string]Request{
		"long sender":    {Target: "excited-giraffe", Sender: long, Summary: "x", Body: "b"},
		"long summary":   {Target: "excited-giraffe", Sender: "s", Summary: long, Body: "b"},
		"broken sender":  {Target: "excited-giraffe", Sender: "a\xffb", Summary: "x", Body: "b"},
		"broken summary": {Target: "excited-giraffe", Sender: "s", Summary: "a\xffb", Body: "b"},
	} {
		f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}}
		if _, err := send(newDevin(f), r); connect.CodeOf(err) != connect.CodeInvalidArgument || f.prompted() != nil {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.Summary = strings.Repeat("s", MaxLabel)
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: " + r.Summary, status: []string{"working"}}
	if _, err := send(newDevin(f), r); err != nil {
		t.Errorf("a summary at the limit: %v", err)
	}
}
