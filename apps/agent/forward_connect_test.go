package main

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// center is a real IngestService, dedup-by-event_id, used to exercise the
// actual Connect wire (not the stubForwarder interface). This is where the real
// protobuf-over-HTTP path is verified.
type center struct {
	mu      sync.Mutex
	seen    map[string]bool
	order   []*ccxv1.Event
	unavail bool
}

func newCenter() *center { return &center{seen: map[string]bool{}} }

func (c *center) setUnavailable(v bool) {
	c.mu.Lock()
	c.unavail = v
	c.mu.Unlock()
}

func (c *center) Ingest(_ context.Context, req *connect.Request[ccxv1.IngestRequest]) (*connect.Response[ccxv1.IngestResponse], error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.unavail {
		return nil, connect.NewError(connect.CodeUnavailable, nil)
	}
	var accepted uint32
	for _, ev := range req.Msg.GetEvents() {
		if c.seen[ev.GetEventId()] {
			continue // dedup: at-least-once means duplicates are normal
		}
		c.seen[ev.GetEventId()] = true
		c.order = append(c.order, ev)
		accepted++
	}
	return connect.NewResponse(&ccxv1.IngestResponse{Accepted: accepted}), nil
}

func (c *center) payloads() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.order))
	for i, e := range c.order {
		out[i] = string(e.GetPayload())
	}
	return out
}

// startCenter mounts the real generated Connect handler on an httptest server.
func startCenter(t *testing.T) (*center, string) {
	t.Helper()
	c := newCenter()
	path, handler := ccxv1connect.NewIngestServiceHandler(c)
	mux := httptest.NewServer(handler)
	t.Cleanup(mux.Close)
	_ = path
	return c, mux.URL
}

// The real connectForwarder against the real server: an enveloped event goes
// over actual protobuf-over-HTTP and arrives with its payload and envelope
// intact.
func TestConnectForwarder_RealWire(t *testing.T) {
	c, url := startCenter(t)
	fwd := NewForwarder(url)

	ev := &ccxv1.Event{
		Origin:   &ccxv1.Origin{Machine: "d1", User: "root"},
		EventId:  "01J-test-id",
		Seq:      7,
		Producer: ccxv1.Producer_PRODUCER_CLAUDE_CODE_HOOK,
		Payload:  []byte(`{"hook_event_name":"Stop","session_id":"abc"}`),
	}
	if err := fwd.Forward(context.Background(), ev); err != nil {
		t.Fatalf("forward: %v", err)
	}

	got := c.payloads()
	if len(got) != 1 || got[0] != `{"hook_event_name":"Stop","session_id":"abc"}` {
		t.Fatalf("center did not receive the payload intact: %v", got)
	}
}

// An unavailable center makes Forward return an error, so the loop keeps and
// retries the event rather than dropping it.
func TestConnectForwarder_UnavailableReturnsError(t *testing.T) {
	c, url := startCenter(t)
	c.setUnavailable(true)
	fwd := NewForwarder(url)

	err := fwd.Forward(context.Background(), &ccxv1.Event{EventId: "x", Payload: []byte("y")})
	if err == nil {
		t.Fatal("forward against an unavailable center must return an error, not nil")
	}
}

// Duplicate event_id is dropped by the center — the at-least-once contract.
func TestConnectForwarder_DedupByEventID(t *testing.T) {
	c, url := startCenter(t)
	fwd := NewForwarder(url)
	ev := &ccxv1.Event{EventId: "same", Payload: []byte("once")}

	for i := 0; i < 3; i++ {
		if err := fwd.Forward(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	if got := c.payloads(); len(got) != 1 {
		t.Errorf("dedup failed: sent 3 with same id, center kept %d", len(got))
	}
}
