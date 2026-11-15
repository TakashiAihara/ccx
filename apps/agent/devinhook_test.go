package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testsock"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

type hookAgent struct {
	ccxv1connect.UnimplementedMessageServiceHandler
	calls atomic.Int32
}

func (h *hookAgent) DevinHook(_ context.Context, req *connect.Request[ccxv1.DevinHookRequest]) (*connect.Response[ccxv1.DevinHookResponse], error) {
	h.calls.Add(1)
	return connect.NewResponse(&ccxv1.DevinHookResponse{Output: `{"from":"agent"}`}), nil
}

// serveHookAgent answers MessageService on CCX_API_SOCKET, as serve does.
func serveHookAgent(t *testing.T) *hookAgent {
	sock := testsock.Path(t, "api.sock")
	t.Setenv("CCX_API_SOCKET", sock)
	h := &hookAgent{}
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(h))
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return h
}

const stopPayload = `{"hook_event_name":"Stop","last_assistant_message":"ok","session_id":"s","prompt_id":"p"}`

func TestDevinHookPrintsWhatTheAgentAnswers(t *testing.T) {
	h := serveHookAgent(t)
	var out bytes.Buffer
	if code := cmdDevinHook(strings.NewReader(stopPayload), &out); code != 0 || out.String() != `{"from":"agent"}` || h.calls.Load() != 1 {
		t.Fatalf("exit %d, out %q, calls %d", code, out.String(), h.calls.Load())
	}
}

func TestDevinHookSkipsEventsItDoesNotUse(t *testing.T) {
	h := serveHookAgent(t)
	var out bytes.Buffer
	in := `{"hook_event_name":"PreToolUse","tool_name":"exec","session_id":"s"}`
	if code := cmdDevinHook(strings.NewReader(in), &out); code != 0 || out.Len() != 0 || h.calls.Load() != 0 {
		t.Fatalf("exit %d, out %q, calls %d", code, out.String(), h.calls.Load())
	}
}

// A down agent never fails Devin's turn.
func TestDevinHookWithNoAgentExitsZeroAndPrintsNothing(t *testing.T) {
	t.Setenv("CCX_API_SOCKET", testsock.Path(t, "none.sock"))
	var out bytes.Buffer
	if code := cmdDevinHook(strings.NewReader(stopPayload), &out); code != 0 || out.Len() != 0 {
		t.Fatalf("exit %d, out %q", code, out.String())
	}
}

type failingReader struct{ r io.Reader }

func (f *failingReader) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err == io.EOF {
		return n, errors.New("broken pipe")
	}
	return n, err
}

// A payload that did not arrive whole, or is over 1 MiB, is not passed on.
func TestDevinHookSkipsAPayloadItCouldNotReadWhole(t *testing.T) {
	h := serveHookAgent(t)
	big := `{"hook_event_name":"Stop","session_id":"s","last_assistant_message":"` + strings.Repeat("x", 1<<20) + `"}`
	for _, in := range []io.Reader{&failingReader{strings.NewReader(stopPayload)}, strings.NewReader(big)} {
		var out bytes.Buffer
		if code := cmdDevinHook(in, &out); code != 0 || out.Len() != 0 {
			t.Fatalf("exit %d, out %q", code, out.String())
		}
	}
	if n := h.calls.Load(); n != 0 {
		t.Fatalf("%d calls", n)
	}
}

type stuckAgent struct {
	ccxv1connect.UnimplementedMessageServiceHandler
}

func (stuckAgent) DevinHook(ctx context.Context, _ *connect.Request[ccxv1.DevinHookRequest]) (*connect.Response[ccxv1.DevinHookResponse], error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// A stuck agent costs Devin's turn the budget (2 s), not Devin's own hook timeout.
func TestDevinHookGivesUpOnAStuckAgent(t *testing.T) {
	sock := testsock.Path(t, "api.sock")
	t.Setenv("CCX_API_SOCKET", sock)
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewMessageServiceHandler(stuckAgent{}))
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	start := time.Now()
	var out bytes.Buffer
	if code := cmdDevinHook(strings.NewReader(stopPayload), &out); code != 0 || out.Len() != 0 {
		t.Fatalf("exit %d, out %q", code, out.String())
	}
	if took := time.Since(start); took < 1500*time.Millisecond || took > 4*time.Second {
		t.Fatalf("took %s, want about 2s", took)
	}
}
