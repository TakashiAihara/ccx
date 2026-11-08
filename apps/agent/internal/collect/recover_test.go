package collect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// settledTemp writes a temp into incoming/ older than tempAge.
func settledTemp(t *testing.T, incoming, name, body string) string {
	t.Helper()
	p := filepath.Join(incoming, name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	return p
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A ".tmp-" entry that is not a regular file is not the hook's: a symlink is not
// followed (that would send what it points at), and it, a fifo and a directory
// are named for the log instead of being skipped unseen (#249).
func TestRecoverTemps_LeavesNonRegularTemps(t *testing.T) {
	dir := t.TempDir()
	s := openTestSpool(t, dir)
	incoming := s.IncomingDir()
	outside := filepath.Join(dir, "outside.json")
	if err := os.WriteFile(outside, []byte(`{"secret":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(incoming, ".tmp-01a050e6-8722-7c8a-9041-f38193f5a46f.raw-1")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(incoming, ".tmp-fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(incoming, ".tmp-dir"), 0o700); err != nil {
		t.Fatal(err)
	}

	r, d, y, left := s.recoverTemps(time.Now())
	if r != 0 || d != 0 || y != 0 {
		t.Errorf("recovered %d dropped %d young %d, want none", r, d, y)
	}
	if got := strings.Join(left, ","); got != ".tmp-01a050e6-8722-7c8a-9041-f38193f5a46f.raw-1,.tmp-dir,.tmp-fifo" {
		t.Errorf("left %q, want the symlink, the directory and the fifo", got)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the symlink was moved or replaced: %v", err)
	}
	if n, err := s.PendingIncoming(); err != nil || n != 0 {
		t.Errorf("PendingIncoming = %d, %v; want nothing taken in", n, err)
	}
	if got := mustRead(t, outside); got != `{"secret":true}` {
		t.Errorf("the symlink's target was touched: %q", got)
	}
}

// A settled temp that cannot be read is left in place and named, not skipped
// unseen: the next start finds it just the same (#249).
func TestRecoverTemps_NamesAnUnreadableTemp(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	p := settledTemp(t, s.IncomingDir(), ".tmp-9", `{"a":1}`)
	readTemp = func(string) ([]byte, error) { return nil, syscall.EACCES }
	t.Cleanup(func() { readTemp = readNoFollow })

	r, d, _, left := s.recoverTemps(time.Now())
	if r != 0 || d != 0 || strings.Join(left, ",") != ".tmp-9" {
		t.Errorf("recovered %d dropped %d left %q, want only .tmp-9 left", r, d, left)
	}
	if got := mustRead(t, p); got != `{"a":1}` {
		t.Errorf("the unreadable temp was changed: %q", got)
	}
}

// The read does not follow a symlink swapped in after the directory was listed.
func TestReadNoFollow_RefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if b, err := readNoFollow(link); err == nil {
		t.Errorf("read %q through a symlink, want an error", b)
	}
	if b, err := readNoFollow(target); err != nil || string(b) != "x" {
		t.Errorf("readNoFollow(regular) = %q, %v", b, err)
	}
}

// A recovered file already under the name a recovery would take is never
// replaced: the temp is left and named instead (#249).
func TestRecoverTemps_NeverOverwritesARecoveredFile(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	incoming := s.IncomingDir()
	const id = "01a050e6-8722-7c8a-9041-f38193f5a46f"
	for name, body := range map[string]string{
		"recovered.tmp-7.raw":                  `{"first":1}`,
		id + ".raw":                            `{"by_id":1}`,
		"recovered.tmp-" + id + ".raw-333.raw": `{"by_id":2}`,
	} {
		if err := os.WriteFile(filepath.Join(incoming, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	settledTemp(t, incoming, ".tmp-7", `{"second":1}`)
	settledTemp(t, incoming, ".tmp-"+id+".raw-333", `{"by_id":3}`)

	r, _, _, left := s.recoverTemps(time.Now())
	if r != 0 || strings.Join(left, ",") != ".tmp-"+id+".raw-333,.tmp-7" {
		t.Errorf("recovered %d left %q, want both temps left", r, left)
	}
	for name, want := range map[string]string{
		"recovered.tmp-7.raw":                  `{"first":1}`,
		id + ".raw":                            `{"by_id":1}`,
		"recovered.tmp-" + id + ".raw-333.raw": `{"by_id":2}`,
		".tmp-7":                               `{"second":1}`,
		".tmp-" + id + ".raw-333":              `{"by_id":3}`,
	} {
		if got := mustRead(t, filepath.Join(incoming, name)); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

// On a filesystem that refuses hard links, a temp is still recovered by a rename
// to the first free name, and left when every name is taken.
func TestRecoverTemps_FallsBackToRenameWithoutHardLinks(t *testing.T) {
	linkFile = func(o, n string) error { return &os.LinkError{Op: "link", Old: o, New: n, Err: syscall.EPERM} }
	t.Cleanup(func() { linkFile = os.Link })
	s := openTestSpool(t, t.TempDir())
	incoming := s.IncomingDir()
	const free = "01a050e6-8722-7c8a-9041-f38193f5a471"
	const taken = "01a050e6-8722-7c8a-9041-f38193f5a472"
	const full = "01a050e6-8722-7c8a-9041-f38193f5a473"
	for name, body := range map[string]string{
		taken + ".raw":                         `{"t":0}`,
		full + ".raw":                          `{"f":0}`,
		"recovered.tmp-" + full + ".raw-3.raw": `{"f":1}`,
	} {
		if err := os.WriteFile(filepath.Join(incoming, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	settledTemp(t, incoming, ".tmp-"+free+".raw-1", `{"free":1}`)
	settledTemp(t, incoming, ".tmp-"+taken+".raw-2", `{"t":1}`)
	settledTemp(t, incoming, ".tmp-"+full+".raw-3", `{"f":2}`)

	r, _, _, left := s.recoverTemps(time.Now())
	if r != 2 || strings.Join(left, ",") != ".tmp-"+full+".raw-3" {
		t.Errorf("recovered %d left %q, want 2 recovered and the one with no free name left", r, left)
	}
	for name, want := range map[string]string{
		free + ".raw":                           `{"free":1}`,
		taken + ".raw":                          `{"t":0}`,
		"recovered.tmp-" + taken + ".raw-2.raw": `{"t":1}`,
		full + ".raw":                           `{"f":0}`,
		"recovered.tmp-" + full + ".raw-3.raw":  `{"f":1}`,
	} {
		if got := mustRead(t, filepath.Join(incoming, name)); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

// A recovered temp leaves no second name behind: the link is followed by the
// removal of the temp, so the next start does not take it in again.
func TestRecoverTemps_RemovesTheTempAfterLinking(t *testing.T) {
	links := 0
	linkFile = func(o, n string) error { links++; return os.Link(o, n) }
	t.Cleanup(func() { linkFile = os.Link })
	s := openTestSpool(t, t.TempDir())
	const id = "01a050e6-8722-7c8a-9041-f38193f5a474"
	p := settledTemp(t, s.IncomingDir(), ".tmp-"+id+".raw-4", `{"x":1}`)
	if r, _, _, _ := s.recoverTemps(time.Now()); r != 1 {
		t.Fatalf("recovered %d, want 1", r)
	}
	if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the temp is still there after it was recovered: %v", err)
	}
	// a hard link, which fails on a taken name, not a rename, which would replace it
	if links != 1 {
		t.Errorf("linkFile called %d times, want the recovery done by one hard link", links)
	}
	if r, _, _, _ := s.recoverTemps(time.Now()); r != 0 {
		t.Errorf("a second look recovered %d again", r)
	}
}

// What a drain moved before it failed is in the main queue, so the forward loop is
// woken for it rather than left until its next idle poll; the temps a recovery
// left are logged by name (#249).
func TestTakeInIncoming_WakesForAFailedDrainAndNamesLeftTemps(t *testing.T) {
	spool, err := OpenSpool(t.TempDir(), &ccxv1.Origin{Machine: "m", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	incoming := spool.IncomingDir()
	if err := os.WriteFile(filepath.Join(incoming, "01a050e6-8722-7c8a-9041-f38193f5a475.raw"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// sorts after the first and cannot be read, so the drain fails on it
	if err := os.Symlink(filepath.Join(incoming, "missing"), filepath.Join(incoming, "zz.raw")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(incoming, "missing"), filepath.Join(incoming, ".tmp-link")); err != nil {
		t.Fatal(err)
	}
	var logged []string
	srv := newCollect(testsockPathUnused, spool, &stubForwarder{}, func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) })

	srv.takeInIncoming("in the test")

	if n, err := spool.Pending(); err != nil || n != 1 {
		t.Fatalf("Pending = %d, %v; want the one event the drain moved before failing", n, err)
	}
	if len(srv.loop.nudge) != 1 {
		t.Errorf("the forward loop was not woken for the event a failed drain moved")
	}
	all := strings.Join(logged, "\n")
	if !strings.Contains(all, "left 1 temp(s)") || !strings.Contains(all, ".tmp-link") {
		t.Errorf("logged %q, want the left temp named", logged)
	}
}

const testsockPathUnused = "unused.sock"
