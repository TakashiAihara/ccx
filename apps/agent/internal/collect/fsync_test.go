package collect

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// recordFsync swaps the package's fsync seam for one that records whether each
// synced file was a directory. Tests using it must not run in parallel: the seam
// is a package variable.
func recordFsync(t *testing.T) *[]bool {
	t.Helper()
	var isDir []bool
	orig := fsync
	fsync = func(f *os.File) error {
		fi, err := f.Stat()
		if err != nil {
			t.Fatal(err)
		}
		isDir = append(isDir, fi.IsDir())
		return orig(f)
	}
	t.Cleanup(func() { fsync = orig })
	return &isDir
}

// The hook's fallback write must not fsync (#204): on a disk stalled in IO wait
// fsync parks the thread in D state, and the hook process cannot exit past
// hookOverallBudget until it returns.
func TestWriteIncoming_DoesNotFsync(t *testing.T) {
	synced := recordFsync(t)
	dir := t.TempDir()

	if err := writeIncoming(dir, []byte(`{"fallback":1}`)); err != nil {
		t.Fatal(err)
	}
	if len(*synced) != 0 {
		t.Errorf("writeIncoming called fsync %d times, want 0", len(*synced))
	}

	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || !strings.HasSuffix(ents[0].Name(), ".raw") {
		t.Fatalf("want exactly one .raw file, got %v", ents)
	}
	b, _ := os.ReadFile(filepath.Join(dir, ents[0].Name()))
	if string(b) != `{"fallback":1}` {
		t.Errorf("payload: got %q", b)
	}
}

// The agent's spool keeps fsyncing the file and then its directory: an acked
// event is a durability promise.
func TestSpoolAppend_FsyncsFileThenDir(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	synced := recordFsync(t)

	if _, err := s.Append([]byte("a")); err != nil {
		t.Fatal(err)
	}
	got := *synced
	if len(got) != 2 || got[0] || !got[1] {
		t.Errorf("Append fsync targets (isDir): got %v, want [false true]", got)
	}
}

// The tests above only see syncs made through the fsync seam. This keeps the
// seam the only way the package syncs, so a direct (*os.File).Sync or a
// syscall-level fsync cannot slip past them.
func TestFsyncSeamIsTheOnlySync(t *testing.T) {
	direct := regexp.MustCompile(`\.Sync\(\)|Fsync\(|Fdatasync\(|syscall\.Sync\(`)
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			if direct.MatchString(line) && !strings.HasPrefix(line, "var fsync = ") {
				t.Errorf("%s:%d syncs outside the fsync seam: %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
