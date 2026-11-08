package collect

import (
	"context"
	"net/http"
	"sync"
	"time"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/hubauth"
)

// Forwarder sends one enveloped event to the center and returns nil only when
// the center has confirmed receipt. An error means "not delivered" — the caller
// keeps the event and retries it, except when the error says the center refused
// the event itself (refusedForContent); that event is moved to dead/, not
// dropped.
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
// the whole life of ccx-agent — the forward loop's backoff never fires, because it
// only fires when Forward RETURNS, and a hung call never returns. A bounded call
// turns "center hung" into "Forward errored", which the loop already retries.
const defaultForwardTimeout = 30 * time.Second

// NewForwarder builds a forwarder for the given center URL, or returns nil if
// no center is configured. A nil forwarder is not an error: ccx-agent still runs and
// spools; it simply has nowhere to drain to until a hub is set. The local side
// never depends on the center (scope.md).
func NewForwarder(hubURL, token string) Forwarder {
	if hubURL == "" {
		return nil
	}
	return &connectForwarder{
		client:  ccxv1connect.NewIngestServiceClient(http.DefaultClient, hubURL, hubauth.Options(token)...),
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
// event, forwards the bytes, and on success deletes the file. The one branch on
// the outcome reads the center's error code, not the payload. Whether the
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

	mu      sync.Mutex
	reached Reach
}

// Reach is the last outcome of forwarding to the center, since this agent started.
type Reach struct {
	LastForwarded time.Time
	LastErrorAt   time.Time
	LastError     string
}

func (l *forwardLoop) reach() Reach {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.reached
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
			l.mu.Lock()
			l.reached.LastErrorAt, l.reached.LastError = time.Now(), err.Error()
			l.mu.Unlock()

			if refusedForContent(err) {
				// Sending it again gets the same answer, and every later event waits
				// behind it (#126). Set it aside and go on to the next one now.
				dead, derr := l.spool.MoveToDead(e)
				if derr == nil {
					l.log("center refused event (seq %d, event_id %s), moved to %s: %v", e.Event.GetSeq(), e.Event.GetEventId(), dead, err)
					backoff = l.minBackoff
					continue
				}
				// Still in the queue: after a backoff, as for a failed Ack, it is sent
				// again, and a second refusal tries the move again. No tight loop.
				l.log("center refused event (seq %d, event_id %s), could not move it aside, retrying: %v", e.Event.GetSeq(), e.Event.GetEventId(), derr)
			} else {
				// Center unreachable (or failing for now). Keep the event, back off,
				// retry the SAME one.
				l.log("forward failed (seq %d), retrying: %v", e.Event.GetSeq(), err)
			}
			if !l.sleep(ctx, backoff) {
				return
			}
			backoff = l.nextBackoff(backoff)
			continue
		}

		// Center confirmed. Only now remove it from the spool.
		l.mu.Lock()
		l.reached.LastForwarded = time.Now()
		l.mu.Unlock()
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

// refusedForContent reports whether the center answered that it will not take
// the event, so sending the same bytes again cannot succeed. The center answers
// InvalidArgument for an event it will not store (a missing event_id or origin,
// apps/hub/src/services.ts). Its Ingest does not answer FailedPrecondition today;
// #126 settled on treating it the same way, as "do not resend as is".
//
// Only an error the center sent counts. The Connect client also makes up
// InvalidArgument itself when it cannot read the reply (a body that is not the
// expected message), and then the center may well have stored the event; that
// stays in the queue and is retried like every other error. So do
// Unauthenticated, Unavailable and timeouts, which clear without the event
// changing (the token is fixed, the center comes back).
func refusedForContent(err error) bool {
	if !connect.IsWireError(err) {
		return false
	}
	switch connect.CodeOf(err) {
	case connect.CodeInvalidArgument, connect.CodeFailedPrecondition:
		return true
	}
	return false
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
