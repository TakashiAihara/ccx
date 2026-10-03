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
// memory, and after a restart the agent sends from 0, is told the real size, and
// continues from there.
//
// The payload is read for two fields only (session_id, transcript_path), which is
// the one place the "ccx-agent never parses a hook payload" rule of ingest.proto is
// narrowed — to the payload's address, not to its content.
package livetranscript

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

// Appender is the center's side of that rule: append data to the session's object
// at offset, or refuse. The returned size is the object's size afterwards (or, on
// a refusal, the size it has now).
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

// Options tunes the reading. A zero field takes the package default, so a caller
// that cares about one of them (a test does) need not spell out the rest.
type Options struct {
	// MinInterval is the shortest gap between two reads of one session. A burst of
	// hooks merges into one read; a trigger that arrives after a read is never
	// dropped, only carried into the next one.
	MinInterval time.Duration
	// SettleDelay is how long after Stop / SubagentStop / SessionEnd one more read
	// is scheduled. Claude Code writes the transcript asynchronously, so at Stop
	// the turn's last records are often not on disk yet.
	SettleDelay time.Duration
	// RetryDelay is how long to wait before reading again after a failed read. The
	// retry needs no hook: the next hook can be minutes away and the bytes are
	// still on disk.
	RetryDelay time.Duration
	// MaxChunk is the most bytes one append carries. A single line longer than
	// this goes alone rather than being cut in two.
	MaxChunk int
	// MaxLine is the longest single line read whole. A transcript line is one JSON
	// record; a "line" past this is a file that is not a transcript, and the
	// session stops rather than holding it in memory or re-reading it forever.
	MaxLine int
}

// The values in use. MinInterval 2s suits a session busier than a person types;
// RetryDelay 5s suits the center's usual outage; 4 MiB is one append of a busy
// transcript's worth of lines.
const (
	defaultMinInterval = 2 * time.Second
	defaultSettleDelay = time.Second
	defaultRetryDelay  = 5 * time.Second
	defaultMaxChunk    = 4 << 20
	defaultMaxLine     = 64 << 20
)

func (o Options) withDefaults() Options {
	if o.MinInterval == 0 {
		o.MinInterval = defaultMinInterval
	}
	if o.SettleDelay == 0 {
		o.SettleDelay = defaultSettleDelay
	}
	if o.RetryDelay == 0 {
		o.RetryDelay = defaultRetryDelay
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
// The session stops for good on it (see (*Sync).read).
var errShrank = errors.New("the local transcript is shorter than what was appended")

// errLineTooLong marks a line past MaxLine with no newline. The session stops on it.
var errLineTooLong = errors.New("a line in the local transcript is longer than the longest line read whole")

// Sync is the concern: hook payloads in, appends out. One goroutine per session
// with something to read, so a center that stops answering holds up nobody else.
type Sync struct {
	center Appender
	opts   Options
	log    func(string, ...any)

	mu       sync.Mutex
	ctx      context.Context // set by Run; nil until then
	sessions map[string]*session
}

// session is one session's reading state. All of it is in memory: the transcript
// file is the durable source, and the center's size is the authority on how much
// of it is already there.
type session struct {
	mu      sync.Mutex
	changed chan struct{} // a trigger arrived; buffered so a wake is never lost

	id   string
	path string

	// offset is how much of the file the center holds, as far as this agent knows.
	// It starts at 0 on purpose: the center's answer is what makes a restarted
	// agent continue instead of duplicating.
	offset uint64

	// pending is a trigger waiting to be served and next the earliest time it may
	// be served (MinInterval after the trigger that asked, or after the last read).
	pending bool
	next    time.Time
	// settle is the late read a terminal hook asked for, retryAt the read a failed
	// append owes. Zero means "none".
	settle  time.Time
	retryAt time.Time
	// stopped is why this session is not appended again (logged, and returned by
	// Stopped). Non-empty means no further reads at all.
	stopped string

	// stop closes when the session will not read again: stopped for a session, or
	// the process is going down.
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

// payload is the only part of a hook payload this reads. Parsing stops here: the
// event itself is still forwarded byte for byte by collect, and the rest of the
// payload (the prompt text, the tool input) means nothing to live sync.
type payload struct {
	HookEventName  string `json:"hook_event_name"`
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
}

// lateHooks schedule the settled read. At Stop the turn's last lines are usually
// not on disk yet, and after SessionEnd no other hook of that session will fire.
var lateHooks = map[string]bool{"Stop": true, "SubagentStop": true, "SessionEnd": true}

// Notify is what collect calls for every spooled payload. It never waits for the
// center — a hook's return must not depend on a network round trip — and a burst
// of triggers is merged by MinInterval anyway. A payload that does not name a
// usable transcript is not an error, it simply is not a trigger.
func (s *Sync) Notify(p []byte) {
	var pl payload
	if err := json.Unmarshal(p, &pl); err != nil {
		return
	}
	if !sessionIDRe.MatchString(pl.SessionID) || !plausiblePath(pl.TranscriptPath, pl.SessionID) {
		return
	}

	st := s.session(pl.SessionID, pl.TranscriptPath)
	now := time.Now()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.stopped != "" {
		return
	}
	// A trigger that arrives while another is still waiting must not push the read
	// out: the first one already asked for it.
	if !st.pending {
		st.pending = true
		st.next = now.Add(s.opts.MinInterval)
	}
	if lateHooks[pl.HookEventName] {
		// Later wins: a hook just before the deadline has not made it stale.
		if at := now.Add(s.opts.SettleDelay); st.settle.IsZero() || at.After(st.settle) {
			st.settle = at
		}
	}
	st.wakeLocked()
}

// session returns the session's state, starting its loop if Run is already
// running. A session that fired a hook and never fired again costs one parked
// goroutine, which is what collect sees anyway.
func (s *Sync) session(id, path string) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.sessions[id]
	if ok {
		return st
	}
	st = &session{
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
// blocks: the buffer is what a caller that must not wait (Notify) needs, and a
// wake nobody has taken yet is remembered by the buffer instead of being lost.
func (st *session) wakeLocked() {
	select {
	case st.changed <- struct{}{}:
	default:
	}
}

// Stopped is session -> why it will not be appended again. The log says the same
// when it happens; the agent's status API does not carry it yet. A copy: the
// caller is not the loop.
func (s *Sync) Stopped() map[string]string {
	s.mu.Lock()
	all := make([]*session, 0, len(s.sessions))
	for _, st := range s.sessions {
		all = append(all, st)
	}
	s.mu.Unlock()

	out := make(map[string]string)
	for _, st := range all {
		st.mu.Lock()
		if st.stopped != "" {
			out[st.id] = st.stopped
		}
		st.mu.Unlock()
	}
	return out
}

// Run reads transcripts until ctx is cancelled. It is a concern: it returns nil
// on cancel, and whatever it had not finished is simply not finished — those bytes
// are still on disk and this session's next hook picks them up.
func (s *Sync) Run(ctx context.Context) error {
	s.mu.Lock()
	s.ctx = ctx
	for _, st := range s.sessions {
		go s.readLoop(ctx, st)
	}
	s.mu.Unlock()

	<-ctx.Done()
	// Park every loop. A read in flight is bounded by ctx (the client hands it to
	// Append), so this returns without waiting for one that cannot finish.
	s.mu.Lock()
	all := make([]*session, 0, len(s.sessions))
	for _, st := range s.sessions {
		all = append(all, st)
	}
	s.mu.Unlock()
	for _, st := range all {
		st.halt()
	}
	return nil
}

func (st *session) halt() {
	st.mu.Lock()
	st.stopOnce.Do(func() { close(st.stop) })
	st.wakeLocked()
	st.mu.Unlock()
}

// readLoop is one session's whole reading life: wait until a read is due, read,
// repeat. Sessions are independent — each has its own deadlines and its own
// Append in flight.
func (s *Sync) readLoop(ctx context.Context, st *session) {
	for {
		at, due := st.due()
		if !due {
			// Nothing to read: wait for a trigger. A stopped session lands here
			// and stays here.
			select {
			case <-ctx.Done():
				return
			case <-st.stop:
				return
			case <-st.changed:
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
				// A deadline moved. Re-read it rather than sleeping out the old
				// one: a settled read must not wait out a long interval.
				t.Stop()
				continue
			case <-t.C:
			}
		}

		// The trigger is served by the read that starts now. One that arrives
		// during it leaves pending set, so the next read is scheduled after
		// MinInterval: that is the trailing read that keeps the last trigger of a
		// burst from being dropped.
		// The settled read and the owed retry are served by it too. Left set, a
		// deadline in the past stays due forever and the loop re-reads the file
		// without pause.
		st.mu.Lock()
		st.pending = false
		if !st.settle.IsZero() && !st.settle.After(time.Now()) {
			st.settle = time.Time{}
		}
		st.retryAt = time.Time{}
		st.mu.Unlock()

		if err := s.read(ctx, st); err != nil {
			// Re-read after RetryDelay with no hook of its own: the next hook can
			// be minutes away, and the bytes are already on disk.
			st.mu.Lock()
			st.retryAt = time.Now().Add(s.opts.RetryDelay)
			st.mu.Unlock()
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

// read appends everything new in this session's file: from the offset up to the
// last newline, in chunks of at most MaxChunk that end at a line boundary. A line
// still being written waits for the next read — sending half of it would leave a
// fragment in the store that no later append can complete.
func (s *Sync) read(ctx context.Context, st *session) error {
	for {
		st.mu.Lock()
		path, offset := st.path, st.offset
		st.mu.Unlock()

		chunk, err := nextChunk(path, offset, s.opts.MaxChunk, s.opts.MaxLine)
		switch {
		case errors.Is(err, errShrank), errors.Is(err, errLineTooLong):
			// The design assumes Claude Code only appends. A local file shorter
			// than what was appended means something else rewrote it (a tool that
			// cuts a session to make it resumable). Repairing here would race the
			// push that replaces the object with the local file; so stop instead.
			reason := fmt.Sprintf("the local transcript is shorter than the %d bytes already appended", offset)
			if errors.Is(err, errLineTooLong) {
				reason = fmt.Sprintf("the line at byte %d is longer than %d bytes", offset, s.opts.MaxLine)
			}
			st.mu.Lock()
			if st.stopped == "" {
				st.stopped = reason
				st.stopOnce.Do(func() { close(st.stop) })
			}
			st.mu.Unlock()
			s.log("livetranscript: session %s stopped: %s", st.id, reason)
			return nil
		case err != nil:
			return err
		case len(chunk) == 0:
			return nil
		}

		size, err := s.center.Append(ctx, st.id, offset, chunk)
		var m *Mismatch
		switch {
		case errors.As(err, &m):
			// The center knows how much of the file it holds: the object was
			// deleted (this offset is ahead), a push replaced it (this offset is
			// behind), or this agent restarted (offset 0). Take its size and
			// continue from there; the bytes between come round in the next
			// iteration of this same read.
			st.mu.Lock()
			st.offset = m.Size
			st.mu.Unlock()
			continue
		case err != nil:
			return err
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
//   - absolute, and already clean (a path that still contains `..` is not walked,
//     it is refused)
//   - the file is exactly `<session_id>.jsonl`
//   - it sits directly under a directory named `projects` (Claude Code's layout)
//
// Anything else is ignored, not followed.
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
// most max bytes unless one line alone is longer (it goes alone). nil means there
// is nothing to send — the file holds nothing past the offset, or what it holds
// past the offset is a line still being written.
func nextChunk(path string, offset uint64, max, maxLine int) ([]byte, error) {
	// O_NOFOLLOW: the path came from a payload, and a symlink in the transcript's
	// place would send whatever it points at. Checked on the open itself, not by a
	// Lstat before it, so nothing can swap the file in between.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		// No transcript (the session's directory was cleaned up), or a symlink.
		// Nothing to read is not a failure to retry: the next hook finds the same.
		return nil, nil
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil
	}
	size := uint64(info.Size())
	if size < offset {
		return nil, errShrank
	}
	if size == offset {
		return nil, nil
	}

	// One cap's worth. Reading the whole tail instead would make a read cost the
	// file's size, which is the thing this avoids.
	buf := make([]byte, min(uint64(max), size-offset))
	n, err := f.ReadAt(buf, int64(offset))
	if n == 0 {
		if err == nil || errors.Is(err, io.EOF) {
			return nil, nil // grew between stat and read, or empty: next read
		}
		return nil, err
	}
	buf = buf[:n]
	if end := lastNewline(buf); end >= 0 {
		return buf[:end+1], nil
	}
	// A whole cap with no newline in it: one line longer than the cap. It goes
	// whole, because cutting it would put a fragment in the store as if it were a
	// line, and no later append can complete it.
	return longLine(f, offset, buf, maxLine)
}

// longLine finishes the line the first read did not reach, widening the buffer a
// step at a time, up to maxLine.
func longLine(f *os.File, offset uint64, first []byte, maxLine int) ([]byte, error) {
	// len(buf) is what has been read: grow keeps exactly len, so it must track
	// every read or the bytes past it are dropped at the next widening.
	buf := first
	for len(buf) <= maxLine {
		if len(buf) == cap(buf) {
			buf = grow(buf)
		}
		have := len(buf)
		n, err := f.ReadAt(buf[have:cap(buf)], int64(offset)+int64(have))
		if n > 0 {
			buf = buf[:have+n]
			// The first newline ends this line. Anything after it
			// belongs to the next one, so it must not come along.
			if end := bytes.IndexByte(buf[have:], '\n'); end >= 0 {
				return buf[:have+end+1], nil
			}
			if len(buf) > maxLine {
				return nil, errLineTooLong
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, nil // the line is still being written
			}
			return nil, err
		}
	}
	return nil, errLineTooLong
}

// grow widens the buffer for the next step of an over-long line, keeping what it
// already holds. Doubling keeps the number of reads logarithmic in the length.
func grow(b []byte) []byte {
	wider := make([]byte, len(b), max(2*cap(b), len(b)+(1<<16)))
	copy(wider, b)
	return wider
}

func lastNewline(b []byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] == '\n' {
			return i
		}
	}
	return -1
}
