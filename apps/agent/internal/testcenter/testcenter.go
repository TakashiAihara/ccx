// Package testcenter is a minimal stand-in for ccx-center (#91), used by ccxd's
// tests to exercise the REAL Connect/protobuf wire — the collect unit tests and
// the binary integration test both talk to it. It implements IngestService,
// dedups by event_id, and can be flipped "unavailable" to simulate an outage.
//
// It is a test double, not the shipped center; the real hub arrives in #91. It
// lives in a normal package (not a _test file) only so both the collect package
// and the main package's tests can share it across the process boundary.
package testcenter

import (
	"context"
	"net/http/httptest"
	"sync"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// Center records the events it receives and can be made to fail.
type Center struct {
	mu      sync.Mutex
	seen    map[string]bool
	order   []*ccxv1.Event
	unavail bool
	srv     *httptest.Server
}

// Start brings up a real Connect server and returns the Center and its URL. Call
// Close (or the returned stop) when done.
func Start() (*Center, string) {
	c := &Center{seen: map[string]bool{}}
	_, handler := ccxv1connect.NewIngestServiceHandler(c)
	c.srv = httptest.NewServer(handler)
	return c, c.srv.URL
}

// Close shuts the server down.
func (c *Center) Close() { c.srv.Close() }

// SetUnavailable toggles whether Ingest returns an error (a simulated outage).
func (c *Center) SetUnavailable(v bool) {
	c.mu.Lock()
	c.unavail = v
	c.mu.Unlock()
}

// Ingest is the real handler: dedup by event_id, record order.
func (c *Center) Ingest(_ context.Context, req *connect.Request[ccxv1.IngestRequest]) (*connect.Response[ccxv1.IngestResponse], error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.unavail {
		return nil, connect.NewError(connect.CodeUnavailable, nil)
	}
	var accepted uint32
	for _, ev := range req.Msg.GetEvents() {
		if c.seen[ev.GetEventId()] {
			continue // at-least-once: duplicates are normal, drop them
		}
		c.seen[ev.GetEventId()] = true
		c.order = append(c.order, ev)
		accepted++
	}
	return connect.NewResponse(&ccxv1.IngestResponse{Accepted: accepted}), nil
}

// Payloads returns the received payloads in arrival order, as strings.
func (c *Center) Payloads() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.order))
	for i, e := range c.order {
		out[i] = string(e.GetPayload())
	}
	return out
}
