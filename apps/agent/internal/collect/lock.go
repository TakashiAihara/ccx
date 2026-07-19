package collect

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// singleInstanceLock is an exclusive advisory lock (flock) held for the process
// lifetime. It is what actually enforces "one ccxd per spool" — the socket
// probe in listen() cannot, because probe → remove → bind is three steps a
// second ccxd can interleave with, and the remove step can even delete the first
// instance's live socket. flock has no such window: the second acquirer fails
// immediately, and the kernel releases the lock when the holder dies, so a crash
// leaves nothing to clean up.
//
// The lock guards the spool, not the socket: two ccxd writing one spool would
// race the seq counter, which is the corruption that matters.
type singleInstanceLock struct {
	f *os.File
}

func acquireLock(spoolDir string) (*singleInstanceLock, error) {
	if err := os.MkdirAll(spoolDir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(spoolDir, "ccxd.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if err == syscall.EWOULDBLOCK {
			return nil, fmt.Errorf("another ccxd already holds the spool at %s", spoolDir)
		}
		return nil, err
	}
	return &singleInstanceLock{f: f}, nil
}

// release drops the lock. The kernel also drops it automatically if the process
// dies without calling this, so it is a tidy-up, not the safety mechanism.
func (l *singleInstanceLock) release() {
	if l == nil || l.f == nil {
		return
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	_ = l.f.Close()
}
