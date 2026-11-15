package channel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
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
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// fakeMessages stands in for ccx-agent's MessageService.
type fakeMessages struct {
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
	text, isErr := call(t, SendTool(sid, messagesClient(t, f)), `{"target":"bird-baseball","body":"hi","summary":"s","mode":"urgent","machine":"ccx1","user":"dev"}`)
	if isErr || text != "sent  pane w1:p1\nworking" {
		t.Fatalf("text %q, isErr %v", text, isErr)
	}
	g := f.got
	if g.GetSender() != sid || g.GetTarget() != "bird-baseball" || g.GetBody() != "hi" || g.GetSummary() != "s" ||
		g.GetMode() != ccxv1.DeliveryMode_DELIVERY_MODE_URGENT || g.GetMachine() != "ccx1" || g.GetUser() != "dev" {
		t.Fatalf("request %v", g)
	}
}

func TestSendToolDefaultsToAfterTurnAndRefusesAnUnknownMode(t *testing.T) {
	f := &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_SENT}}}
	tool := SendTool(sid, messagesClient(t, f))
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
	} {
		text, isErr := call(t, SendTool(sid, messagesClient(t, tc.f)), `{"target":"t","body":"b","summary":"s"}`)
		if !isErr || text != tc.prefix {
			t.Errorf("%s: %q", tc.name, text)
		}
	}

	// No ccx-agent on the socket: never reached, so not sent.
	text, isErr := call(t, SendTool(sid, UnixMessageClient(filepath.Join(t.TempDir(), "none.sock"))), `{"target":"t","body":"b","summary":"s"}`)
	if !isErr || !strings.HasPrefix(text, "not sent: ") {
		t.Fatalf("unreachable: %q", text)
	}
	// An older ccx-agent without MessageService.
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()
	text, isErr = call(t, SendTool(sid, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL)), `{"target":"t","body":"b","summary":"s"}`)
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
	text, isErr := call(t, SendTool(sid, messagesClient(t, f)), `{"target":"`+sid+`","body":"b","summary":"s"}`)
	if !isErr || text != "not sent: that is this session" || f.got != nil {
		t.Fatalf("text %q, sent %v", text, f.got)
	}
}

// slowMessages holds each send until released, and counts the sends running at once.
type slowMessages struct {
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
	tool := SendTool(sid, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL))
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

	var n atomic.Int32
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(sendFunc(func(ctx context.Context, st *connect.ServerStream[ccxv1.SendResponse]) error {
		// Each send takes two thirds of the timeout: one that has already spent
		// part of its time waiting would run out in the middle of its own.
		n.Add(1)
		select {
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
		return st.Send(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT})
	})))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	tool := SendTool(sid, ccxv1connect.NewMessageServiceClient(srv.Client(), srv.URL))

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
