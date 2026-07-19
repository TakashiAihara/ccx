package collect

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// writeIncoming drops a raw hook payload into the fallback directory, used when
// the hook cannot reach ccxd over the socket. It is a standalone function, not
// a Spool method, on purpose: the hook is a short-lived process that must stay
// thin (#18) — it drops one file and exits, and must not initialise the seq
// counter or scan the queue the way OpenSpool does.
//
// The name leads with a UUIDv7, which is time-ordered, so a lexical sort of the
// directory is roughly chronological — that is the order ccxd drains them in.
// UUIDv7 also makes the name collision-free across concurrent hooks without a
// pid or a lock.
func writeIncoming(incomingDir string, payload []byte) error {
	if err := os.MkdirAll(incomingDir, 0o700); err != nil {
		return err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(incomingDir, id.String()+".raw"), payload)
}

func newUUIDv7() string {
	id, err := uuid.NewV7()
	if err != nil {
		// NewV7 only errors if the system RNG fails, which is not a condition
		// ccxd can sensibly continue past — a non-unique id would break dedup.
		panic(fmt.Sprintf("uuidv7: %v", err))
	}
	return id.String()
}
