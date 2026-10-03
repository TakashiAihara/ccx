// Package livetranscript grows a running session's transcript.jsonl in the store
// while the session runs (#120, docs/design/live-transcript.md).
//
// The hook does not change: it still writes the payload to the local socket and
// returns. Reading the transcript file happens here, in ccx-agent serve, off the
// session's critical path — a hook that already takes a second on a busy disk
// (#194) must not also read a transcript.
//
// The whole mechanism rests on one rule on the center's side: an append is taken
// only when its offset equals the object's current size, otherwise the center
// refuses and answers with that size. So nothing is spooled here: offsets live in
// memory, and a session this agent has not seen yet starts by asking the center
// for its size (an empty append at offset 0), then sends from there.
//
// The payload is read for two fields only (session_id, transcript_path), which is
// the one place the "ccx-agent never parses a hook payload" rule of ingest.proto is
// narrowed — to the payload's address, not to its content. Nothing here branches
// on which hook fired.
package livetranscript

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

// Appender is the center's side of that rule: append data to the session's object
// at offset, or refuse. The returned size is the object's size afterwards (or, on
// a refusal, the size it has now). Empty data appends nothing and answers the size.
type Appender interface {
	Append(ctx context.Context, session string, offset uint64, data []byte) (uint64, error)
}

// Mismatch is a refusal: offset is not the object's size, so nothing was written.
// Size is the center's current size — continue from it.
type Mismatch struct {
	Size uint64
}

func (m *Mismatch) Error() string {
	return fmt.Sprintf("offset is not the object's size; the center holds %d bytes", m.Size)
}

// Permanent is a refusal that retrying cannot fix. Global ones (a center without
// TranscriptService, a refused token) are the same for every session, so live
// sync stops altogether; the others stop only the session they came from.
type Permanent struct {
	Err    error
	Global bool
}

func (p *Permanent) Error() string { return p.Err.Error() }
func (p *Permanent) Unwrap() error { return p.Err }

// Options tunes the reading. A zero field takes the package default, so a caller
// that cares about one of them (a test does) need not spell out the rest.
//
// The defaults are chosen, not measured. What each one trades is written next to
// it; change them when a measurement says otherwise.
type Options struct {
	// MinInterval is the shortest gap between two reads of one session. A burst of
	// hooks (one per tool call) merges into one read.
	MinInterval time.Duration
	// SettleDelay: every trigger also asks for one more read this long after the
	// last trigger. Claude Code writes the transcript asynchronously, so the lines
	// a hook is about are often not on disk when it fires, and after the last
	// hook of a turn nothing else would read them.
	SettleDelay time.Duration
	// MaxSettles is how many times a settled read that finds a line still being
	// written asks for another, before it waits for the next hook.
	MaxSettles int
	// RetryDelay is the first wait after a failed append; it doubles per failure
	// up to MaxRetryDelay. The retry needs no hook.
	RetryDelay    time.Duration
	MaxRetryDelay time.Duration
	// AppendTimeout bounds one append. Without it a center that accepts the
	// connection and never answers holds the session forever (collect's forward
	// loop bounds its calls the same way).
	AppendTimeout time.Duration
	// IdleDrop forgets a session that has had nothing to read for this long. If
	// it fires again later, it starts over by asking the center for its size.
	IdleDrop time.Duration
	// MaxChunk is the most bytes one append carries. A single line longer than
	// this goes alone rather than being cut in two.
	MaxChunk int
	// MaxLine is the longest single line read whole. A transcript line is one JSON
	// record; a "line" past this is a file that is not a transcript, and the
	// session stops rather than holding it in memory or re-reading it forever.
	MaxLine int
}

const (
	defaultMinInterval   = 2 * time.Second
	defaultSettleDelay   = time.Second
	defaultMaxSettles    = 10
	defaultRetryDelay    = 5 * time.Second
	defaultMaxRetryDelay = 5 * time.Minute
	defaultAppendTimeout = 30 * time.Second
	defaultIdleDrop      = time.Hour
	defaultMaxChunk      = 4 << 20
	defaultMaxLine       = 64 << 20
)

func (o Options) withDefaults() Options {
	set := func(v *time.Duration, d time.Duration) {
		if *v == 0 {
			*v = d
		}
	}
	set(&o.MinInterval, defaultMinInterval)
	set(&o.SettleDelay, defaultSettleDelay)
	set(&o.RetryDelay, defaultRetryDelay)
	set(&o.MaxRetryDelay, defaultMaxRetryDelay)
	set(&o.AppendTimeout, defaultAppendTimeout)
	set(&o.IdleDrop, defaultIdleDrop)
	if o.MaxSettles == 0 {
		o.MaxSettles = defaultMaxSettles
	}
	if o.MaxChunk == 0 {
		o.MaxChunk = defaultMaxChunk
	}
	if o.MaxLine == 0 {
		o.MaxLine = defaultMaxLine
	}
	return o
}

// errShrank marks a local transcript shorter than the offset already appended.
var errShrank = errors.New("the local transcript is shorter than what was appended")

// errLineTooLong marks a line past MaxLine with no newline.
var errLineTooLong = errors.New("a line in the local transcript is longer than the longest line read whole")

// Sync is the concern: hook payloads in, appends out. One goroutine per session
// with something to read, so a center that stops answering holds up nobody else.
type Sync struct {
	center Appender
	opts   Options
	log    func(string, ...any)

	// mu guards ctx, sessions and halted, and is taken before a session's own
	// lock whenever both are held.
	mu       sync.Mutex
	ctx      context.Context // set by Run; nil until then
	sessions map[string]*session
	// halted is why live sync stopped for every session (a global *Permanent).
	halted string
}

// session is one session's reading state. All of it is in memory: the transcript
// file is the durable source, and the center's size is the authority on how much
// of it is already there.
type session struct {
	mu      sync.Mutex
	changed chan struct{} // a trigger arrived; buffered so a wake is never lost

	id   string
	path string

	// known: offset came from the center. Until then the first read asks for the
	// size with an empty append, instead of sending bytes the center may hold.
	known  bool
	offset uint64

	// pending is a trigger waiting to be served, next the earliest time it may be.
	pending bool
	next    time.Time
	// settle is the read after the last trigger; settles counts how many times a
	// settled read has asked for another. retryAt is the read a failed append
	// owes, failures how many failed in a row. Zero time means none.
	settle   time.Time
	settles  int
	retryAt  time.Time
	failures int
	// lastActive is the last trigger or read, for IdleDrop.
	lastActive time.Time
	// stopped is why this session is not appended again (logged, and returned by
	// Stopped). Non-empty means no further reads at all.
	stopped string

	// stop closes when the session will not read again.
	stop     chan struct{}
	stopOnce sync.Once
}

// New builds the concern. log takes one-line notices, not one per event: a busy
// session's hooks arrive per tool call.
func New(center Appender, opts Options, log func(string, ...any)) *Sync {
	return &Sync{
		center:   center,
		opts:     opts.withDefaults(),
		log:      log,
		sessions: make(map[string]*session),
	}
}

// Name identifies the concern in logs and in the concern runner's log lines.
func (s *Sync) Name() string { return "livetranscript" }

// payload is the only part of a hook payload this reads. The event itself is
// still forwarded byte for byte by collect.
type payload struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
}

// Notify is what collect calls for every spooled payload. It never waits for the
// center — a hook's return must not depend on a network round trip. A payload
// that does not name a usable transcript is not an error, it simply is not a
// trigger.
func (s *Sync) Notify(p []byte) {
	var pl payload
	if err := json.Unmarshal(p, &pl); err != nil {
		return
	}
	if !sessionIDRe.MatchString(pl.SessionID) || !plausiblePath(pl.TranscriptPath, pl.SessionID) {
		return
	}

	// s.mu is held across the update so that a session being dropped for idleness
	// cannot take this trigger with it.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.halted != "" {
		return
	}
	st := s.sessionLocked(pl.SessionID, pl.TranscriptPath)
	now := time.Now()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.stopped != "" {
		return
	}
	// A resume can land the same session in another project directory.
	st.path = pl.TranscriptPath
	st.lastActive = now
	// A trigger that arrives while another is still waiting must not push the read
	// out: the first one already asked for it.
	if !st.pending {
		st.pending = true
		st.next = now.Add(s.opts.MinInterval)
	}
	st.settle = now.Add(s.opts.SettleDelay)
	st.settles = 0
	st.wakeLocked()
}

// sessionLocked returns the session's state, starting its loop if Run is already
// running. Called with s.mu held.
func (s *Sync) sessionLocked(id, path string) *session {
	if st, ok := s.sessions[id]; ok {
		return st
	}
	st := &session{
		changed: make(chan struct{}, 1),
		id:      id,
		path:    path,
		stop:    make(chan struct{}),
	}
	s.sessions[id] = st
	if s.ctx != nil {
		go s.readLoop(s.ctx, st)
	}
	return st
}

// wakeLocked asks the session's loop to re-read its deadlines. Sending never
// blocks; a wake nobody has taken yet is remembered by the buffer.
func (st *session) wakeLocked() {
	select {
	case st.changed <- struct{}{}:
	default:
	}
}

// Stopped is session -> why it will not be appended again. The log says the same
// when it happens; the agent's status API does not carry it yet. A copy.
func (s *Sync) Stopped() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string)
	for _, st := range s.sessions {
		st.mu.Lock()
		if st.stopped != "" {
			out[st.id] = st.stopped
		}
		st.mu.Unlock()
	}
	return out
}

// Halted is why live sync stopped for every session, or "".
func (s *Sync) Halted() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.halted
}

// Run reads transcripts until ctx is cancelled. Whatever it had not finished is
// still on disk, and the session's next hook picks it up.
func (s *Sync) Run(ctx context.Context) error {
	s.mu.Lock()
	s.ctx = ctx
	for _, st := range s.sessions {
		go s.readLoop(ctx, st)
	}
	s.mu.Unlock()

	<-ctx.Done()
	s.mu.Lock()
	for _, st := range s.sessions {
		st.close()
	}
	s.mu.Unlock()
	return nil
}

func (st *session) close() {
	st.stopOnce.Do(func() { close(st.stop) })
}

// stopSession stops one session for good and says why, once.
func (s *Sync) stopSession(st *session, reason string) {
	st.mu.Lock()
	first := st.stopped == ""
	if first {
		st.stopped = reason
	}
	st.mu.Unlock()
	st.close()
	if first {
		s.log("livetranscript: session %s stopped: %s", st.id, reason)
	}
}

// halt stops every session: the center refused in a way that is the same for all
// of them, and retrying each one would re-send chunks forever for nothing.
func (s *Sync) halt(reason string) {
	s.mu.Lock()
	first := s.halted == ""
	if first {
		s.halted = reason
	}
	for _, st := range s.sessions {
		st.close()
	}
	s.mu.Unlock()
	if first {
		s.log("livetranscript: stopped for every session: %s (restart ccx-agent once the center is fixed)", reason)
	}
}

// dropIfIdle forgets a session with nothing to read for IdleDrop. Holding s.mu
// first keeps a concurrent Notify from writing a trigger into a forgotten session.
func (s *Sync) dropIfIdle(st *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.pending || !st.settle.IsZero() || !st.retryAt.IsZero() || time.Since(st.lastActive) < s.opts.IdleDrop {
		return false
	}
	if s.sessions[st.id] == st {
		delete(s.sessions, st.id)
	}
	return true
}

// readLoop is one session's whole reading life: wait until a read is due, read,
// repeat.
func (s *Sync) readLoop(ctx context.Context, st *session) {
	for {
		at, due := st.due()
		if !due {
			idle := time.NewTimer(s.opts.IdleDrop)
			select {
			case <-ctx.Done():
				idle.Stop()
				return
			case <-st.stop:
				idle.Stop()
				return
			case <-st.changed:
				idle.Stop()
			case <-idle.C:
				if s.dropIfIdle(st) {
					return
				}
			}
			continue
		}
		if wait := time.Until(at); wait > 0 {
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-st.stop:
				t.Stop()
				return
			case <-st.changed:
				t.Stop()
				continue
			case <-t.C:
			}
		}

		// Every deadline that has come is served by the read that starts now. Left
		// set, a deadline in the past stays due and the loop re-reads without pause.
		// A trigger that arrives during the read sets pending again: that is the
		// trailing read that keeps the last trigger of a burst from being dropped.
		now := time.Now()
		st.mu.Lock()
		settled := !st.settle.IsZero() && !st.settle.After(now)
		if settled {
			st.settle = time.Time{}
		}
		if !st.next.After(now) {
			st.pending = false
		}
		st.retryAt = time.Time{}
		st.lastActive = now
		st.mu.Unlock()

		partial, err := s.read(ctx, st)
		if ctx.Err() != nil {
			return
		}
		var perm *Permanent
		switch {
		case errors.As(err, &perm) && perm.Global:
			s.halt(perm.Error())
			return
		case errors.As(err, &perm):
			s.stopSession(st, perm.Error())
			return
		case err != nil:
			st.mu.Lock()
			st.failures++
			n := st.failures
			delay := s.opts.RetryDelay << min(n-1, 16)
			if delay > s.opts.MaxRetryDelay || delay <= 0 {
				delay = s.opts.MaxRetryDelay
			}
			st.retryAt = time.Now().Add(delay)
			st.mu.Unlock()
			if n == 1 {
				s.log("livetranscript: session %s: append failed, retrying with backoff: %v", st.id, err)
			}
		default:
			st.mu.Lock()
			recovered := st.failures > 0
			st.failures = 0
			// A settled read that found a line still being written asks for one
			// more, a bounded number of times: no hook may follow the last one.
			if settled && partial && st.settles < s.opts.MaxSettles && st.settle.IsZero() {
				st.settles++
				st.settle = time.Now().Add(s.opts.SettleDelay)
			}
			st.mu.Unlock()
			if recovered {
				s.log("livetranscript: session %s: appending again", st.id)
			}
		}
	}
}

// due is the earliest time a read is due and whether one is due at all.
func (st *session) due() (time.Time, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.stopped != "" {
		return time.Time{}, false
	}
	at := time.Time{}
	if st.pending {
		at = st.next
	}
	for _, t := range []time.Time{st.settle, st.retryAt} {
		if !t.IsZero() && (at.IsZero() || t.Before(at)) {
			at = t
		}
	}
	return at, !at.IsZero()
}

func (s *Sync) append(ctx context.Context, id string, offset uint64, data []byte) (uint64, error) {
	ctx, cancel := context.WithTimeout(ctx, s.opts.AppendTimeout)
	defer cancel()
	return s.center.Append(ctx, id, offset, data)
}

// read appends everything new in this session's file: from the offset up to the
// last newline, in chunks of at most MaxChunk that end at a line boundary. A line
// still being written waits for the next read — sending half of it would leave a
// fragment in the store that no later append can complete. partial reports such
// a line at the end.
func (s *Sync) read(ctx context.Context, st *session) (partial bool, err error) {
	st.mu.Lock()
	known := st.known
	st.mu.Unlock()
	if !known {
		size, err := s.append(ctx, st.id, 0, nil)
		var m *Mismatch
		switch {
		case errors.As(err, &m):
			size = m.Size
		case err != nil:
			return false, err
		}
		st.mu.Lock()
		st.offset, st.known = size, true
		st.mu.Unlock()
	}

	for {
		st.mu.Lock()
		path, offset := st.path, st.offset
		st.mu.Unlock()

		chunk, tail, err := nextChunk(path, offset, s.opts.MaxChunk, s.opts.MaxLine)
		switch {
		case errors.Is(err, errShrank):
			// The design assumes Claude Code only appends. A local file shorter
			// than what the center holds means something else rewrote it. Repairing
			// here would race the push that replaces the object with the local
			// file; so stop instead.
			s.stopSession(st, fmt.Sprintf("the local transcript is shorter than the %d bytes the center holds", offset))
			return false, nil
		case errors.Is(err, errLineTooLong):
			s.stopSession(st, fmt.Sprintf("the line at byte %d is longer than %d bytes", offset, s.opts.MaxLine))
			return false, nil
		case err != nil:
			return false, err
		case len(chunk) == 0:
			return tail, nil
		}

		size, err := s.append(ctx, st.id, offset, chunk)
		var m *Mismatch
		switch {
		case errors.As(err, &m):
			if m.Size == offset {
				// A refusal at the size we sent from would make the next round send
				// the same thing: treat it as a failure, with its backoff.
				return false, fmt.Errorf("the center refused offset %d while reporting that size", offset)
			}
			// The center knows how much of the file it holds: the object was
			// deleted, a push replaced it, or another agent appended. Continue from
			// its size; the bytes between come round in the next iteration.
			st.mu.Lock()
			st.offset = m.Size
			st.mu.Unlock()
			continue
		case err != nil:
			return false, err
		}
		st.mu.Lock()
		st.offset = size
		st.mu.Unlock()
	}
}

// sessionIDRe is Claude Code's session id — the shape that both the store's key
// and the transcript's file name use.
var sessionIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// plausiblePath decides whether to open a path a hook payload named. That path
// comes from a file other processes of the same user can write, so it is taken
// only when it can only be that session's transcript:
//
//   - absolute, and already clean (a path that still contains `..` is refused)
//   - the file is exactly `<session_id>.jsonl`
//   - it sits in a directory under a directory named `projects` (Claude Code's
//     layout)
//
// The open itself refuses a symlink in the file's place and anything that is not
// a regular file (nextChunk).
func plausiblePath(path, id string) bool {
	if path == "" || !filepath.IsAbs(path) || path != filepath.Clean(path) {
		return false
	}
	if filepath.Base(path) != id+".jsonl" {
		return false
	}
	return filepath.Base(filepath.Dir(filepath.Dir(path))) == "projects"
}

// nextChunk returns the bytes to append next: from offset, whole lines only, at
// most max bytes unless one line alone is longer (it goes alone). An empty chunk
// means nothing to send; tail then says whether bytes past the offset are a line
// still being written.
func nextChunk(path string, offset uint64, max, maxLine int) (chunk []byte, tail bool, err error) {
	// O_NOFOLLOW: a symlink in the transcript's place would send whatever it
	// points at; checked on the open itself so nothing can swap the file in
	// between. O_NONBLOCK: a FIFO there would block the open forever.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		// Gone (cleaned up, or moved: the next hook names the new path) or a
		// symlink: nothing to read. Anything else (EMFILE, EIO) is retried.
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ELOOP) {
			return nil, false, nil
		}
		return nil, false, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, false, nil
	}
	size := uint64(info.Size())
	if size < offset {
		return nil, false, errShrank
	}
	if size == offset {
		return nil, false, nil
	}

	// One cap's worth. Reading the whole tail instead would make a read cost the
	// file's size, which is the thing this avoids.
	buf := make([]byte, min(uint64(max), size-offset))
	n, err := f.ReadAt(buf, int64(offset))
	if n == 0 {
		if err == nil || errors.Is(err, io.EOF) {
			return nil, false, nil
		}
		return nil, false, err
	}
	buf = buf[:n]
	if end := bytes.LastIndexByte(buf, '\n'); end >= 0 {
		return buf[:end+1], false, nil
	}
	if len(buf) < max {
		return nil, true, nil
	}
	// A whole cap with no newline in it: one line longer than the cap. It goes
	// whole, because cutting it would put a fragment in the store as if it were a
	// line, and no later append can complete it.
	line, err := longLine(f, offset, buf, maxLine)
	if err != nil {
		return nil, false, err
	}
	return line, line == nil, nil
}

// longLine finishes the line the first read did not reach, widening the buffer a
// step at a time, up to maxLine. nil with no error: the line is still being
// written.
func longLine(f *os.File, offset uint64, first []byte, maxLine int) ([]byte, error) {
	// len(buf) is what has been read: grow keeps exactly len, so it must track
	// every read or the bytes past it are dropped at the next widening.
	buf := first
	for len(buf) <= maxLine {
		if len(buf) == cap(buf) {
			buf = grow(buf, maxLine+1)
		}
		have := len(buf)
		n, err := f.ReadAt(buf[have:cap(buf)], int64(offset)+int64(have))
		if n > 0 {
			buf = buf[:have+n]
			// The first newline ends this line. Anything after it belongs to the
			// next one, so it must not come along.
			if end := bytes.IndexByte(buf[have:], '\n'); end >= 0 {
				return buf[:have+end+1], nil
			}
		}
		if len(buf) > maxLine {
			return nil, errLineTooLong
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, nil
			}
			return nil, err
		}
	}
	return nil, errLineTooLong
}

// grow widens the buffer for the next step of an over-long line, keeping what it
// holds (its len). Doubling keeps the number of reads logarithmic in the length;
// limit caps it so one line never holds more than MaxLine+1 bytes.
func grow(b []byte, limit int) []byte {
	c := min(max(2*cap(b), len(b)+(1<<16)), limit)
	wider := make([]byte, len(b), max(c, len(b)+1))
	copy(wider, b)
	return wider
}
