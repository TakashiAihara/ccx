package collect

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// failWriteConn is a conn whose ack write never reaches the hook: the agent has
// spooled the event, then the ack is lost. That is #101's race, which the IO
// stalls of 2026-10-03 turned from rare into one per stalled event.
type failWriteConn struct{ net.Conn }

func (failWriteConn) Write([]byte) (int, error) { return 0, fmt.Errorf("ack lost") }

func drainAll(t *testing.T, s *Spool) []string {
	t.Helper()
	var ids []string
	for {
		e, err := s.Oldest()
		if err != nil {
			t.Fatal(err)
		}
		if e == nil {
			return ids
		}
		ids = append(ids, e.Event.GetEventId())
		if err := s.Ack(e); err != nil {
			t.Fatal(err)
		}
	}
}

// The ack-lost race: the socket path spools the event, the hook falls back and
// writes it to incoming/ as well, and the drain spools it a second time. Both
// copies must carry the same event_id, or the center keeps both.
func TestAckLost_BothCopiesCarryTheHooksEventID(t *testing.T) {
	dir := t.TempDir()
	sock := dir + "/a.sock"
	spoolDir := dir + "/spool"
	spool, err := OpenSpool(spoolDir, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	srv := newCollect(sock, spool, nil, quietLog)

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		srv.handle(failWriteConn{c})
	}()

	if code := Hook(sock, spoolDir, strings.NewReader(`{"hook":"Stop"}`)); code != 0 {
		t.Fatalf("hook exit %d", code)
	}
	<-handled

	if n, err := spool.DrainIncoming(); err != nil || n != 1 {
		t.Fatalf("drain: n=%d err=%v, want the fallback copy", n, err)
	}

	ids := drainAll(t, spool)
	if len(ids) != 2 {
		t.Fatalf("spool holds %d events, want 2 (socket copy + fallback copy)", len(ids))
	}
	if ids[0] == "" || ids[0] != ids[1] {
		t.Fatalf("event_ids %q and %q: the center can only drop the duplicate if they match", ids[0], ids[1])
	}
	if _, err := uuid.Parse(ids[0]); err != nil {
		t.Errorf("event_id %q is not a UUID: %v", ids[0], err)
	}
}

// The fallback file is named by the event_id the hook minted, and the drain
// carries that name into the envelope.
func TestDrainIncoming_UsesTheFileNameAsEventID(t *testing.T) {
	dir := t.TempDir()
	spoolDir := dir + "/spool"

	// No agent on the socket: the hook goes straight to the fallback.
	if code := Hook(dir+"/none.sock", spoolDir, strings.NewReader("p")); code != 0 {
		t.Fatalf("hook exit %d", code)
	}
	ents, err := os.ReadDir(incomingPath(spoolDir))
	if err != nil || len(ents) != 1 {
		t.Fatalf("incoming/: %d entries, err %v", len(ents), err)
	}
	stem := strings.TrimSuffix(ents[0].Name(), ".raw")

	s := openTestSpool(t, spoolDir)
	if _, err := s.DrainIncoming(); err != nil {
		t.Fatal(err)
	}
	if ids := drainAll(t, s); len(ids) != 1 || ids[0] != stem {
		t.Fatalf("drained ids %v, want [%s]", ids, stem)
	}
}

// A .raw whose name is not a UUID (left by something other than the hook) is
// still drained, with an id the agent mints. Dropping it would lose the event.
func TestDrainIncoming_NonUUIDNameGetsAMintedID(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(s.IncomingDir(), "garbage.raw"), []byte("p"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DrainIncoming(); err != nil {
		t.Fatal(err)
	}
	if ids := drainAll(t, s); len(ids) != 1 || ids[0] != "id-001" {
		t.Fatalf("drained ids %v, want [id-001] from the spool's own minter", ids)
	}
}

// A socket frame without an id (a hook from before #101, still running during an
// upgrade) is spooled and acked, with an id the agent mints.
func TestHandle_LegacyFrameWithoutID(t *testing.T) {
	_, sock, spoolDir, cancel := startServer(t, nil)
	defer cancel()

	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if err := writeFrame(c, []byte("legacy")); err != nil {
		t.Fatal(err)
	}
	var ack [1]byte
	if _, err := io.ReadFull(c, ack[:]); err != nil || ack[0] != ackOK {
		t.Fatalf("ack %v err %v", ack, err)
	}

	s, err := OpenSpool(spoolDir, testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	e, err := s.Oldest()
	if err != nil || e == nil {
		t.Fatalf("nothing spooled: %v", err)
	}
	if string(e.Event.GetPayload()) != "legacy" {
		t.Errorf("payload %q", e.Event.GetPayload())
	}
	if _, err := uuid.Parse(e.Event.GetEventId()); err != nil {
		t.Errorf("minted event_id %q is not a UUID", e.Event.GetEventId())
	}
}

// legacyReadFrame is the agent's frame reader as released before #101, frozen
// here on purpose: it stands for an agent binary that is still running while the
// hook binary on disk has been upgraded.
func legacyReadFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > 64<<20 {
		return nil, fmt.Errorf("frame too large: %d bytes", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// An old agent must refuse a frame that carries an id rather than spool the id
// bytes as part of the payload. Refusing means no ack, so the new hook falls back
// to incoming/ and the event survives.
func TestHookFrame_RefusedByAnAgentFromBefore101(t *testing.T) {
	var buf bytes.Buffer
	id := newUUIDv7()
	if err := writeHookFrame(&buf, id, []byte(`{"x":1}`)); err != nil {
		t.Fatal(err)
	}
	if p, err := legacyReadFrame(&buf); err == nil {
		t.Fatalf("old agent read the frame as payload %q", p)
	}
}

func TestHookFrame_RoundTrip(t *testing.T) {
	for _, tc := range []struct{ id, payload string }{
		{newUUIDv7(), `{"hook":"Stop"}`},
		{newUUIDv7(), ""},
		{"", "no id"},
	} {
		var buf bytes.Buffer
		if err := writeHookFrame(&buf, tc.id, []byte(tc.payload)); err != nil {
			t.Fatal(err)
		}
		id, p, err := readHookFrame(&buf)
		if err != nil {
			t.Fatal(err)
		}
		if id != tc.id || string(p) != tc.payload {
			t.Errorf("round trip: got (%q, %q), want (%q, %q)", id, p, tc.id, tc.payload)
		}
		if buf.Len() != 0 {
			t.Errorf("%d bytes left unread", buf.Len())
		}
	}
}

// An id that is not a canonical UUID is not trusted as the dedup key; the spool
// mints its own instead of storing it.
func TestAppendID_RejectsNonUUID(t *testing.T) {
	s := openTestSpool(t, t.TempDir())
	good := newUUIDv7()
	for _, tc := range []struct{ in, want string }{
		{good, good},
		{"", "id-001"},
		{"not-a-uuid", "id-002"},
		{strings.ReplaceAll(good, "-", ""), "id-003"},
		{strings.Repeat("z", 36), "id-004"},
	} {
		ev, err := s.AppendID(tc.in, []byte("p"))
		if err != nil {
			t.Fatal(err)
		}
		if ev.GetEventId() != tc.want {
			t.Errorf("AppendID(%q): event_id %q, want %q", tc.in, ev.GetEventId(), tc.want)
		}
	}
}
