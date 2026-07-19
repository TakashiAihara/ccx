package collect

import (
	"context"
	"testing"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
)

// The real connectForwarder against the real Connect server (via testcenter):
// an enveloped event goes over actual protobuf-over-HTTP and arrives with its
// payload and envelope intact.
func TestConnectForwarder_RealWire(t *testing.T) {
	c, url := testcenter.Start()
	defer c.Close()
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

	got := c.Payloads()
	if len(got) != 1 || got[0] != `{"hook_event_name":"Stop","session_id":"abc"}` {
		t.Fatalf("center did not receive the payload intact: %v", got)
	}
}

// An unavailable center makes Forward return an error, so the loop keeps and
// retries the event rather than dropping it.
func TestConnectForwarder_UnavailableReturnsError(t *testing.T) {
	c, url := testcenter.Start()
	defer c.Close()
	c.SetUnavailable(true)
	fwd := NewForwarder(url)

	err := fwd.Forward(context.Background(), &ccxv1.Event{EventId: "x", Payload: []byte("y")})
	if err == nil {
		t.Fatal("forward against an unavailable center must return an error, not nil")
	}
}

// Duplicate event_id is dropped by the center — the at-least-once contract.
func TestConnectForwarder_DedupByEventID(t *testing.T) {
	c, url := testcenter.Start()
	defer c.Close()
	fwd := NewForwarder(url)
	ev := &ccxv1.Event{EventId: "same", Payload: []byte("once")}

	for i := 0; i < 3; i++ {
		if err := fwd.Forward(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	if got := c.Payloads(); len(got) != 1 {
		t.Errorf("dedup failed: sent 3 with same id, center kept %d", len(got))
	}
}
