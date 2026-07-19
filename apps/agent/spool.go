package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

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
//   - A file is deleted only AFTER the center has acked it. If ccxd is killed
//     between the ack and the delete, the event is re-sent on restart — a
//     duplicate, which the center drops by event_id (#97). That is the correct
//     failure: at-least-once. Losing an event is not acceptable; sending it
//     twice is.
//
// event_id is assigned when the event is written here and stored in the file,
// NOT regenerated at send time. This is what makes the re-send after a crash a
// true duplicate (same id) rather than a new event the center cannot recognise.
type Spool struct {
	dir      string
	incoming string

	mu     sync.Mutex
	seq    uint64
	origin *ccxv1.Origin
	newID  func() string
	now    func() time.Time
}

const spoolExt = ".pb"

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

	max, err := s.maxSeqOnDisk()
	if err != nil {
		return nil, err
	}
	s.seq = max

	return s, nil
}

// IncomingDir is where the hook drops events when the socket is unreachable.
func (s *Spool) IncomingDir() string { return s.incoming }

// Append envelopes a raw hook payload and writes it to the spool, returning the
// stored event. This is the only place seq is advanced and event_id is minted.
func (s *Spool) Append(payload []byte) (*ccxv1.Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.seq++
	ev := &ccxv1.Event{
		Origin:     s.origin,
		EventId:    s.newID(),
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

	if err := atomicWrite(filepath.Join(s.dir, s.name(s.seq)), b); err != nil {
		s.seq--
		return nil, err
	}
	return ev, nil
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

// DrainIncoming moves everything the hook dropped into incoming/ (because ccxd
// was down when the hook fired) into the main queue, in name order, enveloping
// each as it goes. Returns how many were drained.
func (s *Spool) DrainIncoming() (int, error) {
	ents, err := os.ReadDir(s.incoming)
	if err != nil {
		return 0, err
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if !e.IsDir() && !strings.HasPrefix(e.Name(), ".tmp-") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // filenames lead with unixnano → roughly chronological

	n := 0
	for _, name := range names {
		p := filepath.Join(s.incoming, name)
		payload, err := os.ReadFile(p)
		if err != nil {
			return n, err
		}
		if _, err := s.Append(payload); err != nil {
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

// atomicWrite writes b to path via a temp file + rename, fsyncing the file and
// its directory so a crash cannot leave a partially written event under a real
// name. The temp lives in the same dir so the rename stays on one filesystem.
func atomicWrite(path string, b []byte) error {
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
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return err
	}
	return fsyncDir(dir)
}

func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
