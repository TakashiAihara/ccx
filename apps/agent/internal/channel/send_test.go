package channel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/message"
	"github.com/TakashiAihara/ccx/apps/agent/internal/testsock"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// fakeMessages stands in for ccx-agent's MessageService.
type fakeMessages struct {
	ccxv1connect.UnimplementedMessageServiceHandler
	got  *ccxv1.SendRequest
	acks []*ccxv1.SendResponse
	err  error
}

func (f *fakeMessages) Send(_ context.Context, r *connect.Request[ccxv1.SendRequest], s *connect.ServerStream[ccxv1.SendResponse]) error {
	f.got = r.Msg
	for _, a := range f.acks {
		if err := s.Send(a); err != nil {
			return err
		}
	}
	return f.err
}

func messagesClient(t *testing.T, f *fakeMessages) ccxv1connect.MessageServiceClient {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(f))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL)
}

const sid = "abcdef12-3456-4789-8abc-def012345678"

func call(t *testing.T, tool Tool, args string) (string, bool) {
	t.Helper()
	return tool.Call(context.Background(), json.RawMessage(args))
}

func TestSendToolSendsAsThisSessionAndListsTheAcks(t *testing.T) {
	f := &fakeMessages{acks: []*ccxv1.SendResponse{
		{State: ccxv1.SendResponse_STATE_SENT, Detail: "pane w1:p1"},
		{State: ccxv1.SendResponse_STATE_WORKING},
	}}
	text, isErr := call(t, SendTool(sid, "", metaOff, messagesClient(t, f)), `{"target":"bird-baseball","body":"hi","summary":"s","mode":"urgent","machine":"ccx1","user":"dev"}`)
	if isErr || text != "sent  pane w1:p1\nworking" {
		t.Fatalf("text %q, isErr %v", text, isErr)
	}
	g := f.got
	if g.GetSender() != sid || g.GetTarget() != "bird-baseball" || g.GetBody() != "hi" || g.GetSummary() != "s" ||
		g.GetMode() != ccxv1.DeliveryMode_DELIVERY_MODE_URGENT || g.GetMachine() != "ccx1" || g.GetUser() != "dev" {
		t.Fatalf("request %v", g)
	}
}

func TestSendToolRepliesByMsgIDAndNeedsATargetOrAReplyTo(t *testing.T) {
	f := &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_SENT}}}
	tool := SendTool(sid, "", metaOff, messagesClient(t, f))
	if text, isErr := call(t, tool, `{"reply_to":"870ca1f60db13297","body":"ok","summary":"re"}`); isErr || text != "sent" {
		t.Fatalf("text %q, isErr %v", text, isErr)
	}
	if g := f.got; g.GetReplyTo() != "870ca1f60db13297" || g.GetTarget() != "" || g.GetSender() != sid || g.GetBody() != "ok" {
		t.Fatalf("request %v", g)
	}

	f.got = nil
	text, isErr := call(t, tool, `{"body":"ok","summary":"re"}`)
	if !isErr || text != "not sent: give target, or reply_to" || f.got != nil {
		t.Fatalf("text %q, sent %v", text, f.got)
	}
}

func TestSendToolDefaultsToAfterTurnAndRefusesAnUnknownMode(t *testing.T) {
	f := &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_SENT}}}
	tool := SendTool(sid, "", metaOff, messagesClient(t, f))
	if _, isErr := call(t, tool, `{"target":"t","body":"b","summary":"s"}`); isErr || f.got.GetMode() != ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN || f.got.GetMachine() != "" {
		t.Fatalf("mode %v, machine %q", f.got.GetMode(), f.got.GetMachine())
	}
	f.got = nil
	text, isErr := call(t, tool, `{"target":"t","body":"b","summary":"s","mode":"soon"}`)
	if !isErr || !strings.HasPrefix(text, "not sent: mode must be one of") || f.got != nil {
		t.Fatalf("text %q, sent %v", text, f.got)
	}
	if text, isErr := call(t, tool, `not json`); !isErr || !strings.HasPrefix(text, "not sent: arguments") {
		t.Fatalf("bad arguments: %q", text)
	}
}

func TestSendToolSaysNotSentOnlyWhenNothingWasTyped(t *testing.T) {
	refused := connect.NewError(connect.CodeFailedPrecondition, errors.New("has text in its input box"))
	refused.Meta().Set(message.NotTypedKey, "1")
	for _, tc := range []struct {
		name   string
		f      *fakeMessages
		prefix string
	}{
		{"refused before typing", &fakeMessages{err: refused}, "not sent: has text in its input box"},
		{"failed after typing", &fakeMessages{err: connect.NewError(connect.CodeUnknown, errors.New("prompt broke"))}, "may have been sent (look at the receiver before sending again): prompt broke"},
		{"lost after an ack", &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_SENT}}, err: connect.NewError(connect.CodeUnknown, errors.New("gone"))}, "sent\nsent, then lost the ack stream: gone"},
		{"lost after queued", &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_QUEUED}}, err: connect.NewError(connect.CodeUnknown, errors.New("gone"))}, "queued\nqueued, then lost the ack stream: gone"},
		{"lost after queued and taken", &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_QUEUED}, {State: ccxv1.SendResponse_STATE_SENT}}, err: connect.NewError(connect.CodeUnknown, errors.New("gone"))}, "queued\nsent\nsent, then lost the ack stream: gone"},
	} {
		text, isErr := call(t, SendTool(sid, "", metaOff, messagesClient(t, tc.f)), `{"target":"t","body":"b","summary":"s"}`)
		if !isErr || text != tc.prefix {
			t.Errorf("%s: %q", tc.name, text)
		}
	}

	// No ccx-agent on the socket: never reached, so not sent.
	none := filepath.Join(t.TempDir(), "none.sock")
	text, isErr := call(t, SendTool(sid, "", metaOff, UnixMessageClient(func() string { return none })), `{"target":"t","body":"b","summary":"s"}`)
	if !isErr || !strings.HasPrefix(text, "not sent: ") {
		t.Fatalf("unreachable: %q", text)
	}
	// An older ccx-agent without MessageService.
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()
	text, isErr = call(t, SendTool(sid, "", metaOff, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL)), `{"target":"t","body":"b","summary":"s"}`)
	if !isErr || !strings.HasPrefix(text, "not sent: ") {
		t.Fatalf("unimplemented: %q", text)
	}
}

func TestServerOffersAndRunsItsTools(t *testing.T) {
	pr, pw := io.Pipe()
	outR, outW := io.Pipe()
	s := NewServer("ccx", "0", outW)
	release := make(chan struct{})
	s.Tools = []Tool{{Name: "slow", Description: "d", Schema: map[string]any{"type": "object"},
		Call: func(_ context.Context, args json.RawMessage) (string, bool) {
			<-release
			return "done " + string(args), false
		}}}
	go func() { _ = s.Serve(pr) }()
	out := bufio.NewScanner(outR)
	next := func() map[string]any {
		t.Helper()
		ch := make(chan map[string]any, 1)
		go func() {
			var m map[string]any
			if out.Scan() {
				_ = json.Unmarshal(out.Bytes(), &m)
			}
			ch <- m
		}()
		select {
		case m := <-ch:
			return m
		case <-time.After(2 * time.Second):
			t.Fatal("no answer")
			return nil
		}
	}
	write := func(s string) { _, _ = pw.Write([]byte(s + "\n")) }

	write(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	caps := next()["result"].(map[string]any)["capabilities"].(map[string]any)
	if _, ok := caps["tools"]; !ok {
		t.Fatal("tools not in the capabilities")
	}
	write(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	list := next()["result"].(map[string]any)["tools"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["name"] != "slow" || list[0].(map[string]any)["inputSchema"] == nil {
		t.Fatalf("tools/list = %v", list)
	}
	// A call still running does not hold a ping.
	write(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{"a":1}}}`)
	write(`{"jsonrpc":"2.0","id":4,"method":"ping"}`)
	if m := next(); m["id"] != float64(4) {
		t.Fatalf("ping waited behind the call: %v", m)
	}
	close(release)
	m := next()
	res := m["result"].(map[string]any)
	if m["id"] != float64(3) || res["isError"] != false || res["content"].([]any)[0].(map[string]any)["text"] != `done {"a":1}` {
		t.Fatalf("tools/call = %v", m)
	}
	write(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}`)
	if m := next(); m["error"] == nil {
		t.Fatalf("unknown tool answered: %v", m)
	}
	_ = pw.Close()
}

func TestSendToolRefusesThisSessionAsTheTarget(t *testing.T) {
	f := &fakeMessages{}
	text, isErr := call(t, SendTool(sid, "", metaOff, messagesClient(t, f)), `{"target":"`+sid+`","body":"b","summary":"s"}`)
	if !isErr || text != "not sent: that is this session" || f.got != nil {
		t.Fatalf("text %q, sent %v", text, f.got)
	}
}

// slowMessages holds each send until released, and counts the sends running at once.
type slowMessages struct {
	ccxv1connect.UnimplementedMessageServiceHandler
	release       chan struct{}
	running, peak atomic.Int32
}

func (s *slowMessages) Send(_ context.Context, _ *connect.Request[ccxv1.SendRequest], st *connect.ServerStream[ccxv1.SendResponse]) error {
	n := s.running.Add(1)
	defer s.running.Add(-1)
	for p := s.peak.Load(); n > p && !s.peak.CompareAndSwap(p, n); p = s.peak.Load() {
	}
	<-s.release
	return st.Send(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT})
}

func TestSendToolSendsOneAtATime(t *testing.T) {
	s := &slowMessages{release: make(chan struct{})}
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(s))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	tool := SendTool(sid, "", metaOff, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL))
	done := make(chan string, 2)
	for i := 0; i < 2; i++ {
		go func() {
			text, _ := tool.Call(context.Background(), json.RawMessage(`{"target":"t","body":"b","summary":"s"}`))
			done <- text
		}()
	}
	time.Sleep(200 * time.Millisecond)
	close(s.release)
	for i := 0; i < 2; i++ {
		if got := <-done; got != "sent" {
			t.Fatalf("send %d: %q", i, got)
		}
	}
	if p := s.peak.Load(); p != 1 {
		t.Fatalf("%d sends ran at once", p)
	}
}

// A send waiting behind others gets its whole time once its turn comes, not what
// is left after the wait.
func TestSendToolStartsTheTimeoutWhenTheSendsTurnComes(t *testing.T) {
	old := sendTimeout
	sendTimeout = 300 * time.Millisecond
	defer func() { sendTimeout = old }()

	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(sendFunc(func(ctx context.Context, st *connect.ServerStream[ccxv1.SendResponse]) error {
		// Each send takes two thirds of the timeout: one that has already spent
		// part of its time waiting would run out in the middle of its own.
		select {
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
		return st.Send(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT})
	})))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	tool := SendTool(sid, "", metaOff, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL))

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = tool.Call(context.Background(), json.RawMessage(`{"target":"t","body":"b","summary":"s"}`))
		}()
		time.Sleep(30 * time.Millisecond)
	}
	text, isErr := tool.Call(context.Background(), json.RawMessage(`{"target":"t","body":"b","summary":"s"}`))
	wg.Wait()
	if isErr || text != "sent" {
		t.Fatalf("the third send: %q (its time ran out while it waited)", text)
	}
}

type sendFunc func(context.Context, *connect.ServerStream[ccxv1.SendResponse]) error

func (f sendFunc) Send(ctx context.Context, _ *connect.Request[ccxv1.SendRequest], st *connect.ServerStream[ccxv1.SendResponse]) error {
	return f(ctx, st)
}

func (sendFunc) DevinHook(context.Context, *connect.Request[ccxv1.DevinHookRequest]) (*connect.Response[ccxv1.DevinHookResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, nil)
}

// A ccx-agent that never answers ends the call at the timeout, as "may have been sent".
func TestSendToolGivesUpAtTheTimeout(t *testing.T) {
	old := sendTimeout
	sendTimeout = 100 * time.Millisecond
	defer func() { sendTimeout = old }()
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(sendFunc(func(ctx context.Context, _ *connect.ServerStream[ccxv1.SendResponse]) error {
		<-ctx.Done()
		return ctx.Err()
	})))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	start := time.Now()
	text, isErr := call(t, SendTool(sid, "", metaOff, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL)), `{"target":"t","body":"b","summary":"s"}`)
	if !isErr || !strings.HasPrefix(text, "may have been sent") || time.Since(start) > 2*time.Second {
		t.Fatalf("text %q after %v", text, time.Since(start))
	}
}

func TestSendToolNamesTheQueuedAck(t *testing.T) {
	f := &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_QUEUED, Detail: "next turn"}}}
	text, isErr := call(t, SendTool(sid, "", metaOff, messagesClient(t, f)), `{"target":"bird-baseball","body":"hi","summary":"s","mode":"later"}`)
	if isErr || text != "queued  next turn" {
		t.Fatalf("text %q, isErr %v", text, isErr)
	}
}

// The API socket is resolved on every dial: a send that found no agent at the
// first path reaches it once the path moves (a systemd agent coming back under
// /run/user), without a session restart.
func TestUnixMessageClientResolvesThePathOnEveryDial(t *testing.T) {
	sock := testsock.Path(t, "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(&fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_SENT}}}))
	srv := httptest.NewUnstartedServer(mux)
	srv.Listener = ln
	srv.Start()
	defer srv.Close()

	var path atomic.Value
	path.Store(sock + ".elsewhere")
	tool := SendTool(sid, "", metaOff, UnixMessageClient(func() string { return path.Load().(string) }))
	if text, isErr := call(t, tool, `{"target":"t","body":"b","summary":"s"}`); !isErr || !strings.HasPrefix(text, "not sent: ") {
		t.Fatalf("before the move: %q", text)
	}
	path.Store(sock)
	if text, isErr := call(t, tool, `{"target":"t","body":"b","summary":"s"}`); isErr || text != "sent" {
		t.Fatalf("after the move: %q (error %v)", text, isErr)
	}
}
