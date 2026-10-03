package collect

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// The live transcript (#120) learns of a session from the hook events collect
// receives. collect hands it the payload after the event is spooled and acked,
// and nothing about the event's own path changes.
func TestObserverGetsEachSpooledPayloadAfterTheAck(t *testing.T) {
	dir := t.TempDir()
	sock := dir + "/ccx-agent.sock"
	spool, err := OpenSpool(dir+"/spool", &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCollect(sock, spool, nil, quietLog)

	var mu sync.Mutex
	var got []string
	block := make(chan struct{})
	srv.Observe(func(p []byte) {
		<-block // a slow observer must not hold the hook
		mu.Lock()
		got = append(got, string(p))
		mu.Unlock()
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Run(ctx) }()
	waitFor(t, 2*time.Second, func() bool { return canDial(sock) })

	t0 := time.Now()
	for _, p := range []string{`{"n":1}`, `{"n":2}`} {
		if code := Hook(sock, t.TempDir(), strings.NewReader(p)); code != 0 {
			t.Fatalf("hook exit %d", code)
		}
	}
	if d := time.Since(t0); d > hookExchangeTimeout {
		t.Fatalf("hooks took %v: the observer held them", d)
	}
	if n, _ := spool.Pending(); n != 2 {
		t.Fatalf("spool holds %d events, want 2 (the socket path must still be taken)", n)
	}

	close(block)
	waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got) == 2
	})
	mu.Lock()
	defer mu.Unlock()
	joined := strings.Join(got, ",")
	if !strings.Contains(joined, `{"n":1}`) || !strings.Contains(joined, `{"n":2}`) {
		t.Fatalf("observer got %v", got)
	}
}
