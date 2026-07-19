package collect

import (
	"context"
	"net/http"
	"time"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// Forwarder sends one enveloped event to the center and returns nil only when
// the center has confirmed receipt. An error means "not delivered" — the caller
// must keep the event and retry, never drop it.
type Forwarder interface {
	Forward(ctx context.Context, ev *ccxv1.Event) error
}

// connectForwarder is the real forwarder: a Connect client to the center's
// IngestService. It sends a single-event batch per call. Batching multiple
// events is a later optimisation (#83-ish); one-at-a-time keeps ordering and
// ack semantics trivially correct for the basic daemon.
type connectForwarder struct {
	client  ccxv1connect.IngestServiceClient
	timeout time.Duration
}

// defaultForwardTimeout bounds a single Ingest call. Without it, a center that
// accepts the TCP connection but never responds would leave Forward blocked for
// the whole life of ccxd — the forward loop's backoff never fires, because it
// only fires when Forward RETURNS, and a hung call never returns. A bounded call
// turns "center hung" into "Forward errored", which the loop already retries.
const defaultForwardTimeout = 30 * time.Second

// NewForwarder builds a forwarder for the given center URL, or returns nil if
// no center is configured. A nil forwarder is not an error: ccxd still runs and
// spools; it simply has nowhere to drain to until a hub is set. The local side
// never depends on the center (scope.md).
func NewForwarder(hubURL string) Forwarder {
	if hubURL == "" {
		return nil
	}
	return &connectForwarder{
		client:  ccxv1connect.NewIngestServiceClient(http.DefaultClient, hubURL),
		timeout: defaultForwardTimeout,
	}
}

func (f *connectForwarder) Forward(ctx context.Context, ev *ccxv1.Event) error {
	// Per-call deadline. Still honours a cancelled parent ctx (shutdown); adds
	// the timeout a hung center needs to become a retryable error.
	ctx, cancel := context.WithTimeout(ctx, f.timeout)
	defer cancel()
	_, err := f.client.Ingest(ctx, connect.NewRequest(&ccxv1.IngestRequest{
		Events: []*ccxv1.Event{ev},
	}))
	return err
}

// forwardLoop drains the spool to the center, oldest first, one at a time. It
// advances only after the center acks, so the spool order is the delivery
// order — which is the acceptance condition "spooled events arrive in order".
//
// It carries no branch that depends on the payload's content. It reads an
// event, forwards the bytes, and on success deletes the file. Whether the
// payload is a SessionStart or a Stop or malformed JSON, the path is identical
// (scope.md: COLLECT + CARRY, never CONSULT).
type forwardLoop struct {
	spool     *Spool
	forwarder Forwarder
	nudge     chan struct{}
	log       func(string, ...any)

	minBackoff time.Duration
	maxBackoff time.Duration
	// idlePoll is a safety net: even if a nudge is missed, the loop re-checks
	// the spool this often.
	idlePoll time.Duration
}

func newForwardLoop(s *Spool, f Forwarder, log func(string, ...any)) *forwardLoop {
	return &forwardLoop{
		spool:      s,
		forwarder:  f,
		nudge:      make(chan struct{}, 1),
		log:        log,
		minBackoff: 100 * time.Millisecond,
		maxBackoff: 30 * time.Second,
		idlePoll:   5 * time.Second,
	}
}

// wake tells the loop to try now (called after a new event is spooled). It never
// blocks: the channel is buffered depth 1 and a pending wake already covers "try
// again".
func (l *forwardLoop) wake() {
	select {
	case l.nudge <- struct{}{}:
	default:
	}
}

func (l *forwardLoop) run(ctx context.Context) {
	backoff := l.minBackoff
	for {
		e, err := l.spool.Oldest()
		if err != nil {
			l.log("spool read error: %v", err)
			if !l.sleep(ctx, backoff) {
				return
			}
			backoff = l.nextBackoff(backoff)
			continue
		}

		if e == nil {
			// Queue empty. Wait for a nudge or the idle poll; cheap and idle.
			if !l.waitIdle(ctx) {
				return
			}
			backoff = l.minBackoff
			continue
		}

		if err := l.forwarder.Forward(ctx, e.Event); err != nil {
			if ctx.Err() != nil {
				return
			}
			// Center unreachable. Keep the event, back off, retry the SAME one.
			l.log("forward failed (seq %d), retrying: %v", e.Event.GetSeq(), err)
			if !l.sleep(ctx, backoff) {
				return
			}
			backoff = l.nextBackoff(backoff)
			continue
		}

		// Center confirmed. Only now remove it from the spool.
		if err := l.spool.Ack(e); err != nil {
			// The center already has it, but the local delete failed (a full or
			// read-only fs, say). If we looped straight back, Oldest would return
			// this same still-present event and we would re-forward it as fast as
			// the CPU allows — a busy loop hammering the center with a duplicate.
			// Back off instead; the center dedups the re-send by event_id when it
			// does go through.
			l.log("ack/delete failed (seq %d), backing off: %v", e.Event.GetSeq(), err)
			if !l.sleep(ctx, backoff) {
				return
			}
			backoff = l.nextBackoff(backoff)
			continue
		}
		backoff = l.minBackoff
	}
}

func (l *forwardLoop) waitIdle(ctx context.Context) bool {
	t := time.NewTimer(l.idlePoll)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-l.nudge:
		return true
	case <-t.C:
		return true
	}
}

func (l *forwardLoop) sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-l.nudge:
		return true
	case <-t.C:
		return true
	}
}

func (l *forwardLoop) nextBackoff(cur time.Duration) time.Duration {
	next := cur * 2
	if next > l.maxBackoff {
		return l.maxBackoff
	}
	return next
}
