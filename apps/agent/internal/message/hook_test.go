package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// Payload shapes as devin 3000.12.57 wrote them (#302).
func userPrompt(session, promptID, prompt string) []byte {
	b, _ := json.Marshal(map[string]any{"hook_event_name": "UserPromptSubmit", "session_id": session, "prompt_id": promptID, "prompt": prompt, "source": "user"})
	return b
}

func ask(session, promptID string) []byte {
	return []byte(fmt.Sprintf(`{"hook_event_name":"PreToolUse","tool_name":"ask_user_question","tool_input":{"questions":[{"header":"好きな果物","options":[{"description":"りんごを選ぶ","label":"りんご"},{"description":"みかんを選ぶ","label":"みかん"}],"question":"りんごとみかんのどちらが好きですか？"}]},"tool_use_id":"call_1","session_id":%q,"prompt_id":%q}`, session, promptID))
}

func stop(session, promptID, last string) []byte {
	b, _ := json.Marshal(map[string]any{"hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": last, "session_id": session, "prompt_id": promptID})
	return b
}

func hook(t *testing.T, d *Devin, payload []byte) string {
	t.Helper()
	out, err := d.Hook(payload)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// running is a send in the background: its acks arrive on acks, its end on done.
type running struct {
	acks chan *ccxv1.SendResponse
	done chan error
}

func start(d *Devin, r Request) *running {
	run := &running{acks: make(chan *ccxv1.SendResponse, 32), done: make(chan error, 1)}
	go func() {
		run.done <- d.Send(context.Background(), r, func(a *ccxv1.SendResponse) error {
			run.acks <- a
			return nil
		})
	}()
	return run
}

func (r *running) next(t *testing.T) *ccxv1.SendResponse {
	t.Helper()
	select {
	case a := <-r.acks:
		return a
	case err := <-r.done:
		// The send ends right after its last ack, so both can be ready and select
		// picks either. Every ack is sent before the end: take one if there is,
		// and keep the end for end().
		select {
		case a := <-r.acks:
			r.done <- err
			return a
		default:
		}
		t.Fatalf("send ended (%v) while an ack was expected", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no ack")
	}
	return nil
}

func (r *running) end(t *testing.T) []*ccxv1.SendResponse {
	t.Helper()
	select {
	case err := <-r.done:
		if err != nil {
			t.Fatalf("send: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("send did not end")
	}
	var rest []*ccxv1.SendResponse
	for {
		select {
		case a := <-r.acks:
			rest = append(rest, a)
		default:
			return rest
		}
	}
}

func TestWantedReadsOnlyTheEventsItUses(t *testing.T) {
	for _, tc := range []struct {
		payload string
		want    bool
	}{
		{string(userPrompt("s", "p", "hi")), true},
		{string(stop("s", "p", "ok")), true},
		{string(ask("s", "p")), true},
		{`{"hook_event_name":"PostToolUse","tool_name":"ask_user_question","session_id":"s"}`, false},
		{`{"hook_event_name":"PreToolUse","tool_name":"exec","session_id":"s"}`, false},
		{`{"hook_event_name":"SessionStart","session_id":"s"}`, false},
		{`not json`, false},
	} {
		if got := Wanted([]byte(tc.payload)); got != tc.want {
			t.Errorf("%s: Wanted = %v", tc.payload, got)
		}
	}
}

func TestHookRefusesWhatItCannotRead(t *testing.T) {
	d := newDevin(&fakeHerdr{})
	// A field of the wrong type leaves the rest filled in; it is still not read.
	for _, p := range []string{`nope`, `{"hook_event_name":"Stop"}`, `{"session_id":"s"}`, `{"hook_event_name":"Stop","session_id":"s","prompt":5}`} {
		if _, err := d.Hook([]byte(p)); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: err = %v", p, err)
		}
	}
}

func TestLaterIsQueuedAndTakenByTheNextTurnOnce(t *testing.T) {
	f := &fakeHerdr{panes: panesWith("working")}
	d := newDevin(f)
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	got, err := send(d, r)
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_QUEUED || f.prompted() != nil {
		t.Fatalf("acks %v err %v typed %v", got, err, f.prompted() != nil)
	}

	// Another session's turn does not take it.
	if out := hook(t, d, userPrompt("someone-else", "p0", "hi")); out != "" {
		t.Fatalf("another session took it: %q", out)
	}
	out := hook(t, d, userPrompt("excited-giraffe", "p1", "next question"))
	var parsed struct {
		Out struct {
			Name    string `json:"hookEventName"`
			Context string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil || parsed.Out.Name != "UserPromptSubmit" || parsed.Out.Context != "ccx: claude-a1b2c3d4: review 3\nline 1\nline 2" {
		t.Fatalf("hook output %q (%v)", out, err)
	}
	if out := hook(t, d, userPrompt("excited-giraffe", "p2", "again")); out != "" {
		t.Fatalf("taken twice: %q", out)
	}
}

func TestLaterMessagesGoInTogetherInOrder(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	for _, s := range []string{"first", "second"} {
		r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
		r.Summary = s
		if _, err := send(d, r); err != nil {
			t.Fatal(err)
		}
	}
	var parsed struct {
		Out struct {
			Context string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	out := hook(t, d, userPrompt("excited-giraffe", "p1", "hi"))
	want := "ccx: claude-a1b2c3d4: first\nline 1\nline 2\n\nccx: claude-a1b2c3d4: second\nline 1\nline 2"
	if err := json.Unmarshal([]byte(out), &parsed); err != nil || parsed.Out.Context != want {
		t.Fatalf("both, first first, a blank line between: %q (%v)", out, err)
	}
}

func TestLaterToNoPaneIsNotQueued(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.Target = "nobody"
	if _, err := send(d, r); connect.CodeOf(err) != connect.CodeNotFound || !notTyped(err) {
		t.Fatalf("err = %v", err)
	}
	if out := hook(t, d, userPrompt("nobody", "p", "hi")); out != "" {
		t.Fatalf("queued anyway: %q", out)
	}
}

func TestASessionHoldsAtMostMaxQueuedLaterMessages(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	for i := 0; i < 32; i++ {
		if _, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)); err != nil {
			t.Fatalf("message %d: %v", i+1, err)
		}
	}
	if _, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)); connect.CodeOf(err) != connect.CodeResourceExhausted || !notTyped(err) {
		t.Fatalf("33rd: err = %v", err)
	}
}

func TestLaterWithAWaitReportsTheTurnThatTookItThenQuestionAndDone(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 30
	run := start(d, r)
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_QUEUED {
		t.Fatalf("first ack %v", a)
	}
	// Before the turn takes it, a question or a Stop is someone else's turn.
	hook(t, d, ask("excited-giraffe", "p0"))
	hook(t, d, stop("excited-giraffe", "p0", "not this one"))
	hook(t, d, userPrompt("excited-giraffe", "p1", "go on"))
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_SENT || a.Detail != "taken by prompt p1" {
		t.Fatalf("taken ack %v", a)
	}
	hook(t, d, ask("excited-giraffe", "p1"))
	q := run.next(t)
	if q.State != ccxv1.SendResponse_STATE_QUESTION || len(q.Questions) != 1 || q.Questions[0].Header != "好きな果物" || q.Questions[0].Question != "りんごとみかんのどちらが好きですか？" || len(q.Questions[0].Options) != 2 || q.Questions[0].Options[1].Label != "みかん" || q.Questions[0].Options[1].Description != "みかんを選ぶ" {
		t.Fatalf("question ack %v", q)
	}
	hook(t, d, stop("excited-giraffe", "p1", "了解: りんご"))
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_DONE || a.Text != "了解: りんご" {
		t.Fatalf("done ack %v", a)
	}
	if rest := run.end(t); len(rest) != 0 {
		t.Fatalf("acks after done: %v", rest)
	}
}

func TestATypedSendWithAWaitFollowsItsOwnTurn(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle", "working"}}
	d := newDevin(f)
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.WaitSeconds = 30
	run := start(d, r)
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_SENT {
		t.Fatalf("sent %v", a)
	}
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("working %v", a)
	}
	// A turn for another prompt, one whose prompt only contains the header, and one
	// with the same header but another body (a second send of the same summary)
	// are not ours.
	hook(t, d, userPrompt("excited-giraffe", "p0", "something else"))
	hook(t, d, userPrompt("excited-giraffe", "px", "quoted: ccx: claude-a1b2c3d4: review 3\nline 1"))
	hook(t, d, userPrompt("excited-giraffe", "py", "ccx: claude-a1b2c3d4: review 3\nanother body"))
	hook(t, d, stop("excited-giraffe", "p0", "not ours"))
	hook(t, d, userPrompt("excited-giraffe", "p1", "ccx: claude-a1b2c3d4: review 3\nline 1\nline 2"))
	// After ours, another turn's question and Stop are still not ours.
	hook(t, d, ask("excited-giraffe", "py"))
	hook(t, d, stop("excited-giraffe", "py", "the other send's answer"))
	// The answer to a question, and another tool, are not questions.
	hook(t, d, []byte(`{"hook_event_name":"PostToolUse","tool_name":"ask_user_question","session_id":"excited-giraffe","prompt_id":"p1"}`))
	hook(t, d, []byte(`{"hook_event_name":"PreToolUse","tool_name":"exec","session_id":"excited-giraffe","prompt_id":"p1"}`))
	hook(t, d, stop("excited-giraffe", "p1", "done with it"))
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_DONE || a.Text != "done with it" {
		t.Fatalf("done %v", a)
	}
	run.end(t)
}

func TestAWaitThatRunsOutEndsQuietly(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 1
	start := time.Now()
	got, err := send(d, r)
	if err != nil || len(got) != 1 || got[0].State != ccxv1.SendResponse_STATE_QUEUED {
		t.Fatalf("acks %v err %v", got, err)
	}
	if took := time.Since(start); took < 900*time.Millisecond || took > 3*time.Second {
		t.Fatalf("waited %s, want about 1s", took)
	}
}

func TestQuestionAcksAreBounded(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 30
	run := start(d, r)
	run.next(t)
	hook(t, d, userPrompt("excited-giraffe", "p1", "go"))
	run.next(t)
	for i := 0; i < 10; i++ {
		hook(t, d, ask("excited-giraffe", "p1"))
	}
	hook(t, d, stop("excited-giraffe", "p1", strings.Repeat("あ", MaxText)))
	var questions int
	var done *ccxv1.SendResponse
	for _, a := range run.end(t) {
		switch a.State {
		case ccxv1.SendResponse_STATE_QUESTION:
			questions++
		case ccxv1.SendResponse_STATE_DONE:
			done = a
		}
	}
	if questions != 8 {
		t.Fatalf("question acks = %d, want 8", questions)
	}
	if done == nil || len(done.Text) > 65536 || len(done.Text) < 65530 || !strings.HasPrefix(done.Text, "あ") {
		t.Fatalf("done text of %d bytes", len(done.GetText()))
	}
}

func TestAWaitOverAnHourIsRefused(t *testing.T) {
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 3601
	if err := Validate(r); connect.CodeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), "3600") {
		t.Fatalf("err = %v", err)
	}
	r.WaitSeconds = 3600
	if err := Validate(r); err != nil {
		t.Fatalf("an hour: %v", err)
	}
}

// The DevinHook RPC answers with what the hook prints.
func TestServiceDevinHook(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	if _, err := send(d, req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)); err != nil {
		t.Fatal(err)
	}
	s := &Service{Devin: d}
	res, err := s.DevinHook(context.Background(), connect.NewRequest(&ccxv1.DevinHookRequest{Payload: userPrompt("excited-giraffe", "p1", "hi")}))
	if err != nil || !strings.Contains(res.Msg.GetOutput(), "additionalContext") {
		t.Fatalf("res %v err %v", res, err)
	}
	if _, err := s.DevinHook(context.Background(), connect.NewRequest(&ccxv1.DevinHookRequest{Payload: []byte("x")})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("bad payload: %v", err)
	}
}

// The relay starts the next delivery once one has typed or queued; both kinds of
// send must say so, or the next waits for the whole --wait.
func TestBothKindsOfSendSayWhenTheirTypingIsOver(t *testing.T) {
	for _, mode := range []ccxv1.DeliveryMode{ccxv1.DeliveryMode_DELIVERY_MODE_LATER, ccxv1.DeliveryMode_DELIVERY_MODE_URGENT} {
		f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle", "working"}}
		d := newDevin(f)
		r := req(mode)
		r.WaitSeconds = 30
		// done is read in the send's own goroutine, at the moment it says so: the
		// relay types the next message then, so this one must be in already.
		over := make(chan bool, 1)
		in := func() bool {
			if mode == ccxv1.DeliveryMode_DELIVERY_MODE_LATER {
				h := d.hooks()
				h.mu.Lock()
				defer h.mu.Unlock()
				return len(h.inbox["excited-giraffe"]) == 1
			}
			return f.prompted() != nil
		}
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			_ = d.Send(WithAfterTyping(ctx, func() { over <- in() }), r, func(*ccxv1.SendResponse) error { return nil })
		}()
		select {
		case ok := <-over:
			if !ok {
				t.Errorf("%v: said it was over before the message was in", mode)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("%v: typing never said it was over", mode)
		}
		cancel()
	}
}

// The sender leaving ends its wait; the wait does not run on to its end.
func TestAWaitEndsWhenTheSenderLeaves(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 30
	ctx, cancel := context.WithCancel(context.Background())
	queued := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- d.Send(ctx, r, func(*ccxv1.SendResponse) error { queued <- struct{}{}; return nil })
	}()
	<-queued
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the wait went on after the sender left")
	}
}

// A waiter that reads nothing does not hold up Devin's hooks.
func TestASlowWaiterDoesNotBlockTheHook(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	_, cancel := d.hooks().subscribe("excited-giraffe")
	defer cancel()
	ended := make(chan struct{})
	go func() {
		for i := range 100 {
			_, _ = d.Hook(stop("excited-giraffe", fmt.Sprint(i), "x"))
		}
		close(ended)
	}()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("hooks blocked on a waiter that reads nothing")
	}
}

func TestServiceDeliverPassesTheWaitOn(t *testing.T) {
	s := &Service{Devin: newDevin(&fakeHerdr{panes: devinPanes}), Log: func(string, ...any) {}}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	err := s.Deliver(context.Background(), &ccxv1.SendRequest{Target: r.Target, Sender: r.Sender, Summary: r.Summary, Body: r.Body, Mode: r.Mode, WaitSeconds: 3601}, func(*ccxv1.SendResponse) error { return nil })
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("a 3601-second wait reached Devin.Send: %v", err)
	}
}

// Once queued, a later message is delivered on the next turn whatever happens to
// the sender's stream, so a failure after that is not "not sent".
func TestALaterMessageIsNotNotSentOnceQueued(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	err := d.Send(context.Background(), req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER), func(*ccxv1.SendResponse) error {
		return errors.New("the sender went away")
	})
	if err == nil || notTyped(err) {
		t.Fatalf("err %v, marked not typed %v", err, notTyped(err))
	}
	if out := hook(t, d, userPrompt("excited-giraffe", "p1", "hi")); !strings.Contains(out, "review 3") {
		t.Fatalf("not delivered after all: %q", out)
	}
}

// Without a wait the stream ends at queued, even when a turn takes the message
// before the send returns.
func TestALaterWithoutAWaitEndsAtQueued(t *testing.T) {
	for i := range 50 {
		d := newDevin(&fakeHerdr{panes: devinPanes})
		var got []ccxv1.SendResponse_State
		err := d.Send(context.Background(), req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER), func(a *ccxv1.SendResponse) error {
			got = append(got, a.State)
			if a.State == ccxv1.SendResponse_STATE_QUEUED {
				hook(t, d, userPrompt("excited-giraffe", fmt.Sprint("p", i), "hi"))
			}
			return nil
		})
		if err != nil || len(got) != 1 {
			t.Fatalf("round %d: acks %v err %v", i, got, err)
		}
	}
}

// The receiver's words reach the sender's terminal: escapes are dropped, newlines
// kept, and a question ack keeps what the center keeps for a relayed one.
func TestQuestionAndDoneAreCleanedAndBounded(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 30
	run := start(d, r)
	run.next(t)
	hook(t, d, userPrompt("excited-giraffe", "p1", "go"))
	run.next(t)

	type option struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	}
	type question struct {
		Question string   `json:"question"`
		Header   string   `json:"header"`
		Options  []option `json:"options"`
	}
	opts := make([]option, 17)
	for i := range opts {
		opts[i] = option{Label: fmt.Sprint("o", i), Description: "d"}
	}
	opts[3].Label = "\x1b[31mred\x1b[0m"
	qs := make([]question, 9)
	for i := range qs {
		qs[i] = question{Question: fmt.Sprint("q", i), Header: "h", Options: opts}
	}
	qs[2].Question = "head" + strings.Repeat("x", 5000) + "tail"
	b, _ := json.Marshal(map[string]any{"hook_event_name": "PreToolUse", "tool_name": "ask_user_question", "session_id": "excited-giraffe", "prompt_id": "p1", "tool_input": map[string]any{"questions": qs}})
	hook(t, d, b)
	hook(t, d, stop("excited-giraffe", "p1", "line 1\x1b]0;title\x07\nline 2"))

	q := run.next(t)
	if len(q.Questions) != 8 || len(q.Questions[0].Options) != 16 || q.Questions[1].Options[3].Label != "[31mred[0m" || len(q.Questions[2].Question) != 4096 || !strings.HasSuffix(q.Questions[2].Question, "xtail") || q.Questions[7].Question != "q7" {
		t.Fatalf("question ack: %d questions, %d options, label %q, long question %d bytes", len(q.Questions), len(q.Questions[0].Options), q.Questions[1].Options[3].Label, len(q.Questions[2].Question))
	}
	if done := run.next(t); done.Text != "line 1]0;title\nline 2" {
		t.Fatalf("done text %q", done.Text)
	}
}

// Two sends of the same text each get one turn, in the order they typed.
func TestSameTextTurnsGoToTheSendsInTypingOrder(t *testing.T) {
	d := newDevin(&fakeHerdr{})
	h := d.hooks()
	a, dropA := h.expect("s", "ccx: x: y\nbody")
	b, dropB := h.expect("s", "ccx: x: y\nbody")
	defer dropA()
	defer dropB()
	owners := map[string]*typedSend{}
	h.subscribe("s")
	for _, id := range []string{"p0", "p1", "p2", "p3"} {
		prompt := "ccx: x: y\nbody"
		if id == "p0" {
			prompt = "something else"
		}
		var e hookEvent
		_ = json.Unmarshal(userPrompt("s", id, prompt), &e)
		e.owner = h.owner(e.Session, e.Prompt)
		owners[id] = e.owner
	}
	if owners["p0"] != nil || owners["p1"] != a || owners["p2"] != b || owners["p3"] != nil {
		t.Fatalf("owners p0 %p p1 %p p2 %p p3 %p, want nil %p %p nil", owners["p0"], owners["p1"], owners["p2"], owners["p3"], a, b)
	}
}

// A typed send whose turn never came leaves nothing for a later turn to give it.
func TestATypedSendThatEndsLeavesNoTurnWaiting(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3", status: []string{"idle", "working"}}
	d := newDevin(f)
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT)
	r.WaitSeconds = 1
	if _, err := send(d, r); err != nil {
		t.Fatal(err)
	}
	h := d.hooks()
	h.mu.Lock()
	n := len(h.typed["excited-giraffe"])
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d typed sends still waiting", n)
	}
}

// A turn reported without a prompt_id is still followed to its Stop.
func TestATurnWithoutAPromptIDIsFollowed(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: devinPanes})
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_LATER)
	r.WaitSeconds = 30
	run := start(d, r)
	run.next(t)
	hook(t, d, []byte(`{"hook_event_name":"UserPromptSubmit","session_id":"excited-giraffe","prompt":"go"}`))
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_SENT {
		t.Fatalf("sent %v", a)
	}
	hook(t, d, []byte(`{"hook_event_name":"Stop","session_id":"excited-giraffe","last_assistant_message":"ok"}`))
	if a := run.next(t); a.State != ccxv1.SendResponse_STATE_DONE || a.Text != "ok" {
		t.Fatalf("done %v", a)
	}
}
