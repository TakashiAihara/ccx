package collect

import (
	"io"
	"net"
	"time"
)

// The hook's timeouts, kept short and separate. The socket is local, so success
// is sub-millisecond; these only bound the pathological cases.
const (
	// hookDialTimeout — connecting to a local socket is instant; this only
	// bounds a kernel/backlog stall.
	hookDialTimeout = 1 * time.Second
	// hookExchangeTimeout — the write+ack after a successful dial; bounds a ccxd
	// that accepted the connection but then stalled.
	hookExchangeTimeout = 1 * time.Second
	// hookOverallBudget — the hard backstop on the ENTIRE hook, socket path and
	// fallback write together. A hook must never block the session (#18,
	// scope.md); if even the fallback disk write stalls, the hook abandons it and
	// returns. It is a process about to exit, so an abandoned write goroutine
	// dies with it. Must exceed dial+exchange so the normal fallback is never cut
	// off.
	hookOverallBudget = 3 * time.Second
)

// Hook is `ccxd hook`, the client side of collect. It reads the hook payload
// from stdin, hands it to the running ccxd over the local socket, and returns.
// It does nothing else — no retry, no forwarding, no parsing of the payload
// (#18: the hook stays thin; forwarding and retry are ccxd's job).
//
// It ALWAYS exits 0. A hook that fails a session's turn because a daemon was
// down would break the one thing the whole design protects: the local side
// works regardless of anything downstream (scope.md).
//
// Two outcomes, both durable, both exit 0:
//   - socket reachable → ccxd spools it and acks → done.
//   - socket unreachable or unresponsive → write the payload to the fallback
//     spool (incoming/) and exit. ccxd drains it when it next starts.
//
// It takes the spool dir (not the incoming dir) and derives the fallback
// location itself, so the spool layout stays owned by collect.
func Hook(socketPath, spoolDir string, stdin io.Reader) int {
	payload, err := io.ReadAll(stdin)
	if err != nil {
		// Could not even read the payload. Nothing to spool; do not fail the
		// session over it.
		return 0
	}

	// Do the delivery under a hard overall budget. Both the socket exchange and
	// the fallback disk write are bounded individually, but this is the backstop
	// that guarantees the hook returns even if some syscall wedges in a way the
	// per-step deadlines miss (a hung fs on the fallback write, say). We are about
	// to exit, so abandoning the goroutine is free.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if deliverToSocket(socketPath, payload) {
			return
		}
		// Socket path failed for any reason — fall back so the event is not lost.
		_ = writeIncoming(incomingPath(spoolDir), payload)
	}()

	select {
	case <-done:
	case <-time.After(hookOverallBudget):
		// Everything downstream stalled. Protect the session and return; the
		// event may be lost in this rare case, but a blocked session is the worse
		// failure (scope.md: local must never be held hostage to anything).
	}
	return 0
}

// deliverToSocket returns true only if ccxd acknowledged durable receipt. Any
// error, timeout, or unexpected ack is a false — the caller then falls back.
func deliverToSocket(socketPath string, payload []byte) bool {
	conn, err := net.DialTimeout("unix", socketPath, hookDialTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()

	// A separate, short deadline on the post-dial exchange, so a ccxd that
	// accepted the connection but then stalls cannot wedge the hook. Kept
	// distinct from the dial timeout so the worst case is dial+exchange, not
	// twice the dial timeout.
	_ = conn.SetDeadline(time.Now().Add(hookExchangeTimeout))

	if err := writeFrame(conn, payload); err != nil {
		return false
	}

	var ack [1]byte
	if _, err := io.ReadFull(conn, ack[:]); err != nil {
		return false
	}
	return ack[0] == ackOK
}
