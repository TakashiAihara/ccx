package collect

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// writeIncoming drops a raw hook payload into the fallback directory, used when
// the hook cannot reach ccx-agent over the socket. It is a standalone function, not
// a Spool method, on purpose: the hook is a short-lived process that must stay
// thin (#18) — it drops one file and exits, and must not initialise the seq
// counter or scan the queue the way OpenSpool does.
//
// The name is the event's id, so the drain envelopes the payload under the id the
// socket path would have carried: the two copies a lost ack produces are then one
// event to the center's dedup, not two it cannot tell apart. The id is a UUIDv7,
// which is time-ordered, so a lexical sort of the directory is roughly
// chronological — that is the order ccx-agent drains them in — and it is
// collision-free across concurrent hooks without a pid or a lock.
//
// It writes with durable=false, so no fsync at all. fsync can block for tens of
// seconds on a disk in IO wait, and the blocked thread sits in D state where no
// timeout can return the process — the hook would miss hookOverallBudget and hang
// the session it is supposed to stay out of (#204). The price is that the payload
// lives only in page cache until writeback: the window in which a power loss
// loses it runs to writeback, not to the write, and it is longest exactly when
// the disk is already backed up — the same condition this exists for. A power
// loss can also leave a zero-length .raw under its real name, which the next
// drain then wraps as an empty event. A hung session is the worse failure.
func writeIncoming(incomingDir, id string, payload []byte) error {
	if err := os.MkdirAll(incomingDir, 0o700); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(incomingDir, id+incomingExt), payload, false)
}

func newUUIDv7() string {
	id, err := uuid.NewV7()
	if err != nil {
		// NewV7 only errors if the system RNG fails, which is not a condition
		// ccx-agent can sensibly continue past — a non-unique id would break dedup.
		panic(fmt.Sprintf("uuidv7: %v", err))
	}
	return id.String()
}
