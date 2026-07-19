package collect

import (
	"io"
	"net"
	"time"
)

// hookDialTimeout bounds how long the hook will wait on the socket before
// giving up and falling back. The socket is local, so success is sub-millisecond;
// this only guards against a wedged ccxd. A hook must never block the session on
// I/O (#18), so the bound is short.
const hookDialTimeout = 2 * time.Second

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

	if deliverToSocket(socketPath, payload) {
		return 0
	}

	// Socket path failed for any reason — fall back so the event is not lost.
	// If even this fails there is genuinely nowhere to put it, but we still do
	// not fail the session.
	_ = writeIncoming(incomingPath(spoolDir), payload)
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

	// One deadline covers the whole exchange, so a ccxd that accepts the
	// connection but then stalls cannot wedge the hook.
	_ = conn.SetDeadline(time.Now().Add(hookDialTimeout))

	if err := writeFrame(conn, payload); err != nil {
		return false
	}

	var ack [1]byte
	if _, err := io.ReadFull(conn, ack[:]); err != nil {
		return false
	}
	return ack[0] == ackOK
}
