// Package testsock gives tests a unix socket path that fits the sun_path limit.
//
// t.TempDir() nests under TMPDIR and the test's name, so a socket under it can pass
// the limits when TMPDIR is long — Claude Code sets /tmp/claude-<uid>/tmp/<session
// uuid>/ — and listening fails (#212). The limits are ccx's own check (about 104
// bytes: collect, heartbeat, api), macOS's sun_path (104 with the NUL) and Linux's
// (108). The directory is made directly under /tmp, whatever TMPDIR says.
//
// It lives in a normal package (not a _test file) only so several packages' tests
// can share it, like testcenter.
package testsock

import (
	"os"
	"path/filepath"
	"testing"
)

// Dir is a fresh directory under /tmp, removed when the test ends.
func Dir(t testing.TB) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "ccx-t")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// Path is name inside a fresh Dir.
func Path(t testing.TB, name string) string {
	t.Helper()
	return filepath.Join(Dir(t), name)
}
