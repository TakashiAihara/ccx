// Package shorttmp keeps t.TempDir() short enough for a unix socket path.
//
// Claude Code sets TMPDIR to /tmp/claude-<uid>/tmp/<session uuid>/, and t.TempDir()
// under it plus a socket name passes the 104-byte sun_path limit, so tests that
// listen on a socket fail with a timeout instead of an error (#212).
package shorttmp

import (
	"fmt"
	"os"
	"testing"
)

// Main runs the package's tests with TMPDIR pointed at a fresh directory under /tmp.
// Call it from TestMain.
func Main(m *testing.M) {
	dir, err := os.MkdirTemp("/tmp", "ccx-t")
	if err != nil {
		fmt.Fprintln(os.Stderr, "shorttmp:", err)
		os.Exit(2)
	}
	os.Setenv("TMPDIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
