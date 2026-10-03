package collect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// The spool is a FIFO of enveloped events waiting to be forwarded. It is a
// directory of numbered files — one file per event, named by its seq — and
// nothing else. There is no index file and no database.
//
// That shape is deliberate, and it mirrors the repodir design: each event
// carries its own truth in its own file, so there is no single registry whose
// corruption would lose everything. seq is the filename, zero-padded so lexical
// order is numeric order, which is FIFO order.
//
// Durability rests on two rules:
//
//   - Every file is created by write-temp-then-rename, so a file that exists is
//     complete; a crash mid-write leaves a .tmp, never a half-event under a
//     real name.
//   - A file is deleted only AFTER the center has acked it. If ccx-agent is killed
//     between the ack and the delete, the event is re-sent on restart — a
//     duplicate, which the center drops by event_id (#97). That is the correct
//     failure: at-least-once. Losing an event is not acceptable; sending it
//     twice is.
//
// The hook assigns the event's identity — event_id — because it is the one point
// that sees the event before it forks into socket-or-fallback, so both copies of a
// lost-ack delivery carry one id and the center drops the duplicate. The agent
// assigns the processing metadata (seq, received_at, Origin), which are facts about
// how it handled the event. It mints an event_id only when the caller supplied none:
// a hook with no id to send, a fallback file not named by one.
//
// Whichever way it was assigned, the id is stored in the file and NOT regenerated
// at send time. That is what makes the re-send after a crash a true duplicate (same
// id) rather than a new event the center cannot recognise.
type Spool struct {
	dir      string
	incoming string

	mu     sync.Mutex
	seq    uint64
	origin *ccxv1.Origin
	newID  func() string
	now    func() time.Time
}

const (
	spoolExt    = ".pb"
	incomingExt = ".raw"
)

// incomingPath is the single definition of where the fallback lives relative to
// the spool dir. Both OpenSpool and the hook path derive it from here so the
// layout has one source of truth (the hook must find incoming/ without opening
// the whole spool).
func incomingPath(spoolDir string) string { return filepath.Join(spoolDir, "incoming") }

// OpenSpool prepares the spool directory (and its incoming/ fallback) and
// recovers the seq counter from whatever is already on disk, so seq keeps
// climbing across restarts instead of colliding with un-drained files.
func OpenSpool(dir string, origin *ccxv1.Origin) (*Spool, error) {
	incoming := incomingPath(dir)
	if err := os.MkdirAll(incoming, 0o700); err != nil {
		return nil, err
	}

	s := &Spool{
		dir:      dir,
		incoming: incoming,
		origin:   origin,
		newID:    newUUIDv7,
		now:      time.Now,
	}

	// Sweep stray temp files left by a crash mid-atomicWrite. They are never
	// read (only .pb / .raw names are), but without a reaper they accumulate
	// across crash cycles. Best-effort — a failure here is not fatal.
	reapTemps(dir)
	reapTemps(incoming)

	max, err := s.maxSeqOnDisk()
	if err != nil {
		return nil, err
	}
	s.seq = max

	return s, nil
}

// reapTemps removes leftover ".tmp-*" files (atomicWrite's staging files) from a
// directory. A complete event is always renamed to its real name; anything still
// carrying the temp prefix is a partial write from a crash and is safe to drop.
func reapTemps(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() && strings.HasPrefix(e.Name(), ".tmp-") {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// IncomingDir is where the hook drops events when the socket is unreachable.
func (s *Spool) IncomingDir() string { return s.incoming }

// Dir is the spool's root directory. Exposed so the single-instance lock can
// live beside the resource it protects (two ccx-agent writing one spool would race
// the seq counter).
func (s *Spool) Dir() string { return s.dir }

// Append envelopes a raw hook payload under an id the spool mints. Callers that
// have an id to carry — the socket handler, the fallback drain — pass it to
// AppendID.
func (s *Spool) Append(payload []byte) (*ccxv1.Event, error) {
	return s.AppendID("", payload)
}

// AppendID envelopes a raw hook payload under the event's id and writes it to the
// spool, returning the stored event. This is the only place seq is advanced.
func (s *Spool) AppendID(id string, payload []byte) (*ccxv1.Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.seq++
	ev := &ccxv1.Event{
		Origin:     s.origin,
		EventId:    s.eventID(id),
		Seq:        s.seq,
		ReceivedAt: timestamppb.New(s.now()),
		// The only producer that exists in #90. It is set from HOW the event
		// arrived (via the hook path), never from what the payload contains —
		// so this stays a COLLECT+CARRY assignment, not a CONSULT.
		Producer: ccxv1.Producer_PRODUCER_CLAUDE_CODE_HOOK,
		Payload:  payload,
	}

	b, err := proto.Marshal(ev)
	if err != nil {
		s.seq-- // nothing was written; do not burn the seq
		return nil, err
	}

	if err := atomicWrite(filepath.Join(s.dir, s.name(s.seq)), b, true); err != nil {
		s.seq--
		return nil, err
	}
	return ev, nil
}

// eventID is the id the envelope carries: the caller's when it is a UUIDv7 in the
// 36-byte form the hook writes, a freshly minted one otherwise. It is stored in the
// lowercase form uuid prints, because the center's key is case-sensitive and the
// copy of the same event that went the other path is spelled that way. Only the
// hook's own ids are trusted as dedup keys; anything else (nil, a name another
// tool chose) is someone else's naming, and a fixed one reused would make the
// center drop every later event under it.
func (s *Spool) eventID(id string) string {
	if len(id) != hookIDLen {
		return s.newID()
	}
	u, err := uuid.Parse(id)
	if err != nil || u.Version() != 7 || u.Variant() != uuid.RFC4122 {
		return s.newID()
	}
	return u.String()
}

// Entry is one spooled event and the file that holds it.
type Entry struct {
	Path  string
	Event *ccxv1.Event
}

// Oldest returns the front of the queue, or nil if the queue is empty.
func (s *Spool) Oldest() (*Entry, error) {
	names, err := s.sortedNames()
	if err != nil || len(names) == 0 {
		return nil, err
	}
	path := filepath.Join(s.dir, names[0])
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var ev ccxv1.Event
	if err := proto.Unmarshal(b, &ev); err != nil {
		return nil, fmt.Errorf("corrupt spool file %s: %w", path, err)
	}
	return &Entry{Path: path, Event: &ev}, nil
}

// Ack removes an event from the queue. Called ONLY after the center has
// confirmed receipt — never before.
func (s *Spool) Ack(e *Entry) error {
	err := os.Remove(e.Path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Pending counts events still waiting to be forwarded.
func (s *Spool) Pending() (int, error) {
	names, err := s.sortedNames()
	return len(names), err
}

// isIncoming is what DrainIncoming takes from incoming/: a file, not a temp
// file still being written. PendingIncoming counts by the same rule.
func isIncoming(e os.DirEntry) bool {
	return !e.IsDir() && !strings.HasPrefix(e.Name(), ".tmp-")
}

// PendingIncoming counts what hooks left in incoming/ and the next start will
// drain. A missing incoming/ holds nothing (the hook recreates it when it
// falls back); any other read error is returned.
func (s *Spool) PendingIncoming() (int, error) {
	ents, err := os.ReadDir(s.incoming)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	n := 0
	for _, e := range ents {
		if isIncoming(e) {
			n++
		}
	}
	return n, err
}

// DrainIncoming moves everything the hook dropped into incoming/ (because ccx-agent
// was down when the hook fired) into the main queue, in name order, enveloping
// each as it goes. Returns how many were drained.
func (s *Spool) DrainIncoming() (int, error) {
	ents, err := os.ReadDir(s.incoming)
	if err != nil {
		return 0, err
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if isIncoming(e) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // names lead with a UUIDv7 → roughly chronological

	n := 0
	for _, name := range names {
		p := filepath.Join(s.incoming, name)
		payload, err := os.ReadFile(p)
		if err != nil {
			return n, err
		}
		// The name is the id the hook minted, so the fallback copy is enveloped
		// under the same event_id the socket path carried. A name that is not one
		// gets an id minted for it rather than dropped: the event is worth more
		// than the id it arrived with. Unlike handle this is not logged, since only
		// the hook writes here and it names every file by a v7.
		if _, err := s.AppendID(strings.TrimSuffix(name, incomingExt), payload); err != nil {
			return n, err
		}
		// Enveloped and durably in the main queue now; safe to drop the raw.
		if err := os.Remove(p); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func (s *Spool) name(seq uint64) string {
	// uint64 is at most 20 digits; pad so lexical == numeric.
	return fmt.Sprintf("%020d%s", seq, spoolExt)
}

func (s *Spool) sortedNames() ([]string, error) {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), spoolExt) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func (s *Spool) maxSeqOnDisk() (uint64, error) {
	names, err := s.sortedNames()
	if err != nil || len(names) == 0 {
		return 0, err
	}
	last := names[len(names)-1]
	var seq uint64
	if _, err := fmt.Sscanf(strings.TrimSuffix(last, spoolExt), "%d", &seq); err != nil {
		return 0, fmt.Errorf("unparseable spool filename %q: %w", last, err)
	}
	return seq, nil
}

// atomicWrite writes b to path via a temp file + rename. The rename is what makes
// the write atomic for a reader looking at the same directory: what it sees under
// the real name is either nothing or all of b, never a prefix. The temp lives in
// the same dir so the rename stays on one filesystem.
//
// durable adds the fsync pair (the temp file, then the directory). Only that also
// carries the atomicity across a crash: without it the data can sit in page cache
// while the rename is already committed, so ext4 delalloc can persist the new name
// and leave a zero-length file under it after a power loss. fsync is also what
// survives a kernel panic, so only callers whose file is a durability promise pay
// for it. Callers that cannot wait for an fsync pass false — it is a blocking
// syscall, and a thread waiting on a stalled disk cannot be rescued by a timeout.
// That buys back the fsync only; the create and rename can stall too.
func atomicWrite(path string, b []byte, durable bool) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()

	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if durable {
		if err := fsync(tmp); err != nil {
			_ = tmp.Close()
			cleanup()
			return err
		}
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return err
	}
	if !durable {
		return nil
	}
	return fsyncDir(dir)
}

// fsync is a package variable so a test can count the syncs and assert that the
// hot paths do or do not make them (#204) without asserting on disk behaviour.
var fsync = func(f *os.File) error { return f.Sync() }

func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return fsync(d)
}
