package resume

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// The wake signal (#261, D-11): the center calls AgentService.Wake on an agent
// that told it its api_url, and the agent claims at once instead of waiting for
// the next poll. The claim path itself is unchanged.

func payloadOf(t *testing.T, e *ccxv1.Event) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		t.Fatalf("payload %q: %v", e.Payload, err)
	}
	return m
}

func TestTheRunningListCarriesTheAPIURLWhenOneIsSet(t *testing.T) {
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := New(Options{
		Machine: "m1", User: "dev", DefaultHome: t.TempDir(), Center: c,
		Run:    func(context.Context, RunRequest) (int, string) { return 0, "" },
		APIURL: "http://10.1.2.3:8792",
		Now:    func() time.Time { return clock },
		Log:    t.Logf,
	})
	r.Tick(context.Background())
	if len(c.ingested) != 1 {
		t.Fatalf("ingested %d events, want 1", len(c.ingested))
	}
	var url string
	if err := json.Unmarshal(payloadOf(t, c.ingested[0])["api_url"], &url); err != nil || url != "http://10.1.2.3:8792" {
		t.Fatalf("api_url = %q (%v), want http://10.1.2.3:8792", url, err)
	}
}

func TestTheRunningListLeavesOutTheAPIURLWhenNoneIsSet(t *testing.T) {
	c := &fakeCenter{}
	clock := time.Unix(1_800_000_000, 0)
	r := newConcern(t, t.TempDir(), c, &clock, func(context.Context, RunRequest) (int, string) { return 0, "" })
	r.Tick(context.Background())
	if _, ok := payloadOf(t, c.ingested[0])["api_url"]; ok {
		t.Fatalf("payload %s carries api_url with none set", c.ingested[0].Payload)
	}
}

// With a poll far longer than the test, only a wake can make the claim happen.
func TestWakeClaimsWithoutWaitingForThePoll(t *testing.T) {
	c := &fakeCenter{}
	r := New(Options{
		Machine: "m1", User: "dev", DefaultHome: t.TempDir(), Center: c,
		Run:  func(context.Context, RunRequest) (int, string) { return 0, "" },
		Poll: time.Hour,
		Log:  t.Logf,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	claims := func() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.claims) }
	time.Sleep(100 * time.Millisecond)
	if n := claims(); n != 0 {
		t.Fatalf("claimed %d times before any wake, with a poll of an hour", n)
	}

	r.Wake()
	deadline := time.Now().Add(2 * time.Second)
	for claims() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := claims(); n != 1 {
		t.Fatalf("claimed %d times after one wake, want 1", n)
	}
}

// Wake never blocks the caller (an RPC handler), even with no Run loop to take it,
// and several wakes before the loop gets to them make one claim, not a queue of them.
func TestWakeDoesNotBlockAndWakesCoalesce(t *testing.T) {
	c := &fakeCenter{}
	r := New(Options{
		Machine: "m1", User: "dev", DefaultHome: t.TempDir(), Center: c,
		Run:  func(context.Context, RunRequest) (int, string) { return 0, "" },
		Poll: time.Hour,
		Log:  t.Logf,
	})
	returned := make(chan struct{})
	go func() {
		for i := 0; i < 5; i++ {
			r.Wake()
		}
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("Wake blocked with no Run loop")
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.Run(ctx); close(done) }()
	time.Sleep(300 * time.Millisecond)
	cancel()
	<-done
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.claims) != 1 {
		t.Fatalf("claimed %d times for five wakes before the loop ran, want 1", len(c.claims))
	}
}
