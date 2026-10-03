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
	// hookExchangeTimeout — the write+ack after a successful dial; bounds a ccx-agent
	// that accepted the connection but then stalled.
	hookExchangeTimeout = 1 * time.Second
	// hookOverallBudget — the hard backstop on the ENTIRE hook, socket path and
	// fallback write together. A hook must never block the session (#18,
	// scope.md), so even if some syscall wedges in a way the per-step deadlines
	// miss, the hook gives up on it and returns. Must exceed dial+exchange so the
	// normal fallback is never cut off. A syscall sitting in D state is the one
	// thing it cannot bound — nothing ends the process while it is in one.
	hookOverallBudget = 3 * time.Second
)

// Hook is `ccx-agent hook`, the client side of collect. It reads the hook payload
// from stdin, hands it to the running ccx-agent over the local socket, and returns.
// It does nothing else — no retry, no forwarding, no parsing of the payload
// (#18: the hook stays thin; forwarding and retry are ccx-agent's job).
//
// It ALWAYS exits 0. A hook that fails a session's turn because a daemon was
// down would break the one thing the whole design protects: the local side
// works regardless of anything downstream (scope.md).
//
// Two outcomes, both exit 0, but only one of them is durable:
//   - socket reachable → ccx-agent spools it durably and acks → done.
//   - socket unreachable or unresponsive → write the payload to the fallback
//     spool (incoming/) and exit. That write is atomic but not fsynced, so a
//     power loss before writeback can take it. ccx-agent drains whatever
//     survived when it next starts.
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

	// The event's identity, minted here because this is the one point that sees the
	// event before it forks into socket-or-fallback. Both paths carry this id, so
	// the double delivery a lost ack causes is one event the center recognises
	// rather than two it cannot tell apart.
	id := newUUIDv7()

	// Do the delivery under a hard overall budget. Both the socket exchange and
	// the fallback disk write are bounded individually, but this is the backstop
	// that guarantees the hook returns even if some syscall wedges in a way the
	// per-step deadlines miss.
	//
	// Giving up on the goroutine is not free if it sits in a D-state syscall: the
	// process cannot exit until that returns. fsync on a disk in IO wait did
	// exactly that for tens of seconds (#194), so the fallback write skips fsync
	// (#204). Its other syscalls (mkdir, create, rename) can still stall on such a
	// disk; this budget does not cover that case.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if deliverToSocket(socketPath, id, payload) {
			return
		}
		// Socket path failed for any reason — fall back so the event is not lost.
		_ = writeIncoming(incomingPath(spoolDir), id, payload)
	}()

	select {
	case <-done:
	case <-time.After(hookOverallBudget):
		// Everything downstream stalled. Protect the session and return. After a
		// successful dial ccx-agent has usually already spooled the event and only
		// the ack was late, so the event survives; it is lost only if it never
		// reached the socket side. A blocked session is still the worse failure
		// (scope.md: local must never be held hostage to anything).
	}
	return 0
}

// deliverToSocket returns true only if ccx-agent acknowledged durable receipt. Any
// error, timeout, or unexpected ack is a false — the caller then falls back.
func deliverToSocket(socketPath, id string, payload []byte) bool {
	conn, err := net.DialTimeout("unix", socketPath, hookDialTimeout)
	if err != nil {
		return false
	}
	defer conn.Close()

	// A separate, short deadline on the post-dial exchange, so a ccx-agent that
	// accepted the connection but then stalls cannot wedge the hook. Kept
	// distinct from the dial timeout so the worst case is dial+exchange, not
	// twice the dial timeout.
	_ = conn.SetDeadline(time.Now().Add(hookExchangeTimeout))

	if err := writeHookFrame(conn, id, payload); err != nil {
		return false
	}

	var ack [1]byte
	if _, err := io.ReadFull(conn, ack[:]); err != nil {
		return false
	}
	return ack[0] == ackOK
}
