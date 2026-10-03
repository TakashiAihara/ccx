package collect

import (
	"os"
	"testing"
)

func countFsync(t *testing.T) *int {
	t.Helper()
	n := 0
	orig := fsync
	fsync = func(f *os.File) error { n++; return orig(f) }
	t.Cleanup(func() { fsync = orig })
	return &n
}

// The hook's fallback write must not fsync (#204): on a disk stalled in IO wait
// fsync parks the thread in D state, and the hook process cannot exit past
// hookOverallBudget until it returns.
func TestWriteIncoming_DoesNotFsync(t *testing.T) {
	n := countFsync(t)

	if err := writeIncoming(t.TempDir(), []byte(`{"fallback":1}`)); err != nil {
		t.Fatal(err)
	}
	if *n != 0 {
		t.Errorf("writeIncoming called fsync %d times, want 0", *n)
	}
}

// The agent's spool keeps fsyncing both the file and its directory: an acked
// event is a durability promise.
func TestSpoolAppend_FsyncsFileAndDir(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	n := countFsync(t)

	if _, err := s.Append([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if *n != 2 {
		t.Errorf("Append called fsync %d times, want 2 (file + dir)", *n)
	}
}
