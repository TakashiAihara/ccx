package message

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

const claudeID = "11111111-2222-4333-8444-555555555555"

// fakeChannels stands in for the heartbeat concern. onPush runs after an event
// is recorded, standing in for Claude Code writing it to the transcript.
type fakeChannels struct {
	home       string
	registered bool
	pushErr    error
	// pushHome, when set, is the home Push answers (a re-registration under another home).
	pushHome string
	pushed     []heartbeat.Event
	onPush     func(heartbeat.Event)
}

func (f *fakeChannels) Home(session string) (string, bool) {
	return f.home, f.registered && session == claudeID
}

func (f *fakeChannels) Push(session string, ev heartbeat.Event) (string, error) {
	if !f.registered || session != claudeID {
		return "", heartbeat.ErrNotRegistered
	}
	if f.pushErr != nil {
		return "", f.pushErr
	}
	f.pushed = append(f.pushed, ev)
	if f.onPush != nil {
		f.onPush(ev)
	}
	if f.pushHome != "" {
		return f.pushHome, nil
	}
	return f.home, nil
}

func newTranscript(t *testing.T, content string) (home, file string) {
	t.Helper()
	home = t.TempDir()
	dir := filepath.Join(home, "projects", "-cwd")
	_ = os.MkdirAll(dir, 0o755)
	file = filepath.Join(dir, claudeID+".jsonl")
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return home, file
}

func appendTo(file, s string) {
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString(s)
	_ = f.Close()
}

func testClaude(f *fakeChannels) *Claude {
	return &Claude{Channels: f, Poll: time.Millisecond, StartWait: 100 * time.Millisecond}
}

func claudeReq(mode ccxv1.DeliveryMode) Request {
	return Request{Target: claudeID, Sender: "devin-a", Summary: "review 3", Body: "line 1\nline 2", Mode: mode}
}

func sendClaude(c *Claude, r Request) ([]*ccxv1.SendResponse, error) {
	var got []*ccxv1.SendResponse
	err := c.Send(context.Background(), r, func(a *ccxv1.SendResponse) error {
		got = append(got, a)
		return nil
	})
	return got, err
}

func TestClaudePushesTheMessageAndAcksWorkingOnceTheTranscriptHasIt(t *testing.T) {
	home, file := newTranscript(t, "{\"type\":\"user\"}\n")
	f := &fakeChannels{home: home, registered: true}
	f.onPush = func(ev heartbeat.Event) {
		appendTo(file, `{"type":"user","message":{"content":"<channel source=\"ccx\" kind=\"message\" msg_id=\"`+ev.Meta["msg_id"]+`\">"}}`+"\n")
	}
	got, err := sendClaude(testClaude(f), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if err != nil || len(got) != 2 || got[0].GetState() != ccxv1.SendResponse_STATE_SENT || got[1].GetState() != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("acks %v, err %v", got, err)
	}
	if len(f.pushed) != 1 {
		t.Fatalf("pushed %d events", len(f.pushed))
	}
	ev := f.pushed[0]
	if ev.Content != "line 1\nline 2" || ev.Meta["kind"] != "message" || ev.Meta["title"] != "ccx: devin-a: review 3" || len(ev.Meta["msg_id"]) != 16 {
		t.Fatalf("event %+v", ev)
	}
}

func TestClaudeAcksNotStartedWhenTheTranscriptNeverHasIt(t *testing.T) {
	home, _ := newTranscript(t, "")
	got, err := sendClaude(testClaude(&fakeChannels{home: home, registered: true}), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_UNSPECIFIED))
	if err != nil || len(got) != 2 || got[1].GetState() != ccxv1.SendResponse_STATE_NOT_STARTED || !strings.Contains(got[1].GetDetail(), "takes it when the turn ends") {
		t.Fatalf("acks %v, err %v", got, err)
	}
}

func TestClaudeLooksOnlyAfterThePush(t *testing.T) {
	home, file := newTranscript(t, strings.Repeat("x", 64)+"\n")
	f := &fakeChannels{home: home, registered: true}
	// The pushed id is put at the start of the file, before the size read before
	// the push: a reader that ignored that offset would find it.
	f.onPush = func(ev heartbeat.Event) {
		b, _ := os.ReadFile(file)
		_ = os.WriteFile(file, append([]byte(ev.Meta["msg_id"]), b...), 0o644)
	}
	got, err := sendClaude(testClaude(f), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if err != nil || len(got) != 2 || got[1].GetState() != ccxv1.SendResponse_STATE_NOT_STARTED {
		t.Fatalf("acks %v, err %v (an id before the push's offset was taken as the message)", got, err)
	}
}

func TestClaudeFindsATranscriptThatAppearsAfterThePush(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "projects", "-cwd")
	_ = os.MkdirAll(dir, 0o755)
	f := &fakeChannels{home: home, registered: true}
	f.onPush = func(ev heartbeat.Event) {
		_ = os.WriteFile(filepath.Join(dir, claudeID+".jsonl"), []byte(ev.Meta["msg_id"]+"\n"), 0o644)
	}
	got, err := sendClaude(testClaude(f), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if err != nil || len(got) != 2 || got[1].GetState() != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("acks %v, err %v", got, err)
	}
}

func TestClaudeRefusesWithoutPushing(t *testing.T) {
	home, _ := newTranscript(t, "")
	for _, tc := range []struct {
		name string
		f    *fakeChannels
		req  Request
		code connect.Code
		text string
	}{
		{"no channel", &fakeChannels{home: home}, claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN), connect.CodeNotFound, "has no ccx channel connected"},
		{"urgent", &fakeChannels{home: home, registered: true}, claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_URGENT), connect.CodeInvalidArgument, "does not take mode urgent; it takes after-turn"},
		{"later", &fakeChannels{home: home, registered: true}, claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_LATER), connect.CodeInvalidArgument, "does not take mode later; it takes after-turn"},
		{"bad body", &fakeChannels{home: home, registered: true}, Request{Target: claudeID, Sender: "a", Summary: "s", Body: "a\x1bb"}, connect.CodeInvalidArgument, "control or format"},
	} {
		got, err := sendClaude(testClaude(tc.f), tc.req)
		if connect.CodeOf(err) != tc.code || !strings.Contains(err.Error(), tc.text) || !notTyped(err) || len(got) != 0 || len(tc.f.pushed) != 0 {
			t.Errorf("%s: err %v, marked %v, acks %v, pushed %d", tc.name, err, notTyped(err), got, len(tc.f.pushed))
		}
	}
}

func TestClaudeChannelGoneAtThePushIsNotSent(t *testing.T) {
	home, _ := newTranscript(t, "")
	c := testClaude(nil)
	c.Channels = &goneAtPush{fakeChannels{home: home, registered: true}}
	got, err := sendClaude(c, claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeNotFound || !notTyped(err) || len(got) != 0 {
		t.Fatalf("err %v, marked %v, acks %v", err, notTyped(err), got)
	}
}

// goneAtPush has the channel when Home looks and not when Push writes.
type goneAtPush struct{ fakeChannels }

func (g *goneAtPush) Push(string, heartbeat.Event) (string, error) {
	return "", heartbeat.ErrNotRegistered
}

func TestClaudeAFailedPushMayHaveBeenSent(t *testing.T) {
	home, _ := newTranscript(t, "")
	f := &fakeChannels{home: home, registered: true, pushErr: errors.New("broken pipe")}
	got, err := sendClaude(testClaude(f), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if connect.CodeOf(err) != connect.CodeUnknown || notTyped(err) || len(got) != 0 || !strings.Contains(err.Error(), "broken pipe") {
		t.Fatalf("err %v, marked %v, acks %v", err, notTyped(err), got)
	}
}

func TestServiceSendsASessionIDToClaudeAndAnythingElseToDevin(t *testing.T) {
	home, _ := newTranscript(t, "")
	ch := &fakeChannels{home: home, registered: true}
	svc := &Service{Devin: newDevin(&fakeHerdr{panes: devinPanes}), Claude: testClaude(ch)}
	if err := svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b"}, func(*ccxv1.SendResponse) error { return nil }); err != nil {
		t.Fatalf("to Claude: %v", err)
	}
	if len(ch.pushed) != 1 {
		t.Fatalf("a session id did not go to Claude (pushed %d)", len(ch.pushed))
	}
	err := svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: "no-such-devin", Sender: "a", Summary: "s", Body: "b"}, func(*ccxv1.SendResponse) error { return nil })
	if connect.CodeOf(err) != connect.CodeNotFound || !strings.Contains(err.Error(), "no herdr pane") || len(ch.pushed) != 1 {
		t.Fatalf("a name went somewhere other than Devin: %v", err)
	}

	svc.Claude = nil
	err = svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b"}, func(*ccxv1.SendResponse) error { return nil })
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !notTyped(err) || !strings.Contains(err.Error(), "heartbeat concern") {
		t.Fatalf("without Claude: %v", err)
	}
}

func TestClaudeWatchesTheTranscriptOfTheHomeItPushedTo(t *testing.T) {
	oldHome, _ := newTranscript(t, "")
	newHome, newFile := newTranscript(t, "")
	f := &fakeChannels{home: oldHome, registered: true, pushHome: newHome}
	f.onPush = func(ev heartbeat.Event) { appendTo(newFile, ev.Meta["msg_id"]+"\n") }
	got, err := sendClaude(testClaude(f), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if err != nil || len(got) != 2 || got[1].GetState() != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("acks %v, err %v (kept watching the home from before the push)", got, err)
	}
}

func TestClaudeWatchesTheTranscriptWrittenLast(t *testing.T) {
	home := t.TempDir()
	old := filepath.Join(home, "projects", "-a", claudeID+".jsonl")
	live := filepath.Join(home, "projects", "-b", claudeID+".jsonl")
	for _, p := range []string{old, live} {
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte("x\n"), 0o644)
	}
	// -a sorts first; -b was written last.
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(old, past, past)
	f := &fakeChannels{home: home, registered: true}
	f.onPush = func(ev heartbeat.Event) { appendTo(live, ev.Meta["msg_id"]+"\n") }
	got, err := sendClaude(testClaude(f), claudeReq(ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN))
	if err != nil || len(got) != 2 || got[1].GetState() != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("acks %v, err %v (watched the older transcript)", got, err)
	}
}
