package concern_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/collect"
	"github.com/TakashiAihara/ccx/apps/agent/internal/concern"
)

func quiet(string, ...any) {}

// fake is a controllable concern.
type fake struct {
	name    string
	started int32
	ran     func(ctx context.Context) error
}

func (f *fake) Name() string { return f.name }
func (f *fake) Run(ctx context.Context) error {
	atomic.AddInt32(&f.started, 1)
	if f.ran != nil {
		return f.ran(ctx)
	}
	<-ctx.Done()
	return nil
}

// collect.Collect must satisfy the interface — the whole point of the seam.
var _ concern.Concern = (*collect.Collect)(nil)

// With no concerns, Run is idle until ctx is cancelled (a valid state: someone
// who wants the CLI but none of the daemon behaviours — ADR 0002).
func TestRun_NoConcerns_IdleUntilCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- concern.Run(ctx, quiet) }()

	select {
	case <-done:
		t.Fatal("Run returned before ctx was cancelled")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("idle Run should return nil, got %v", err)
	}
}

// All enabled concerns start, and Run blocks until ctx is cancelled.
func TestRun_StartsAllConcerns(t *testing.T) {
	a := &fake{name: "a"}
	b := &fake{name: "b"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- concern.Run(ctx, quiet, a, b) }()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&a.started) == 1 && atomic.LoadInt32(&b.started) == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if atomic.LoadInt32(&a.started) != 1 || atomic.LoadInt32(&b.started) != 1 {
		t.Fatal("both concerns should have started")
	}
	cancel()
	<-done
}

// One concern failing winds the whole process down — ccxd lives and dies as one
// process (ADR 0002). The healthy concern's ctx is cancelled, and the error is
// returned.
func TestRun_OneFailureCancelsTheRest(t *testing.T) {
	boom := errors.New("boom")
	failer := &fake{name: "failer", ran: func(context.Context) error { return boom }}
	healthyCancelled := make(chan struct{})
	healthy := &fake{name: "healthy", ran: func(ctx context.Context) error {
		<-ctx.Done()
		close(healthyCancelled)
		return nil
	}}

	err := concern.Run(context.Background(), quiet, failer, healthy)

	select {
	case <-healthyCancelled:
	default:
		t.Error("the healthy concern should have been cancelled when the other failed")
	}
	if !errors.Is(err, boom) {
		t.Errorf("Run should surface the failing concern's error, got %v", err)
	}
}
