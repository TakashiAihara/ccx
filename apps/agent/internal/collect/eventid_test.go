package collect

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
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
// copies must carry the same event_id, so a center that drops duplicates by
// event_id (testcenter, like the hub's primary key) stores each event once. Two
// events, so an id that never changed between hooks would fail too.
func TestAckLost_DedupingCenterStoresEachEventOnce(t *testing.T) {
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

	payloads := []string{`{"hook":"Stop","n":1}`, `{"hook":"Stop","n":2}`}
	for _, p := range payloads {
		handled := make(chan struct{})
		go func() {
			defer close(handled)
			c, err := ln.Accept()
			if err != nil {
				return
			}
			srv.handle(failWriteConn{c})
		}()
		if code := Hook(sock, spoolDir, strings.NewReader(p)); code != 0 {
			t.Fatalf("hook exit %d", code)
		}
		<-handled
	}

	if n, err := spool.DrainIncoming(); err != nil || n != 2 {
		t.Fatalf("drain: n=%d err=%v, want both fallback copies", n, err)
	}

	center, url := testcenter.Start()
	defer center.Close()
	fwd := NewForwarder(url, "")
	var ids, copies []string
	for {
		e, err := spool.Oldest()
		if err != nil {
			t.Fatal(err)
		}
		if e == nil {
			break
		}
		ids = append(ids, e.Event.GetEventId())
		copies = append(copies, string(e.Event.GetPayload()))
		if err := fwd.Forward(context.Background(), e.Event); err != nil {
			t.Fatal(err)
		}
		if err := spool.Ack(e); err != nil {
			t.Fatal(err)
		}
	}

	// Spool order: both socket copies, then both fallback copies.
	if len(ids) != 4 || ids[0] != ids[2] || ids[1] != ids[3] || ids[0] == ids[1] {
		t.Fatalf("event_ids %v: want [a b a b] with a != b", ids)
	}
	if want := append(append([]string{}, payloads...), payloads...); strings.Join(copies, "|") != strings.Join(want, "|") {
		t.Fatalf("spooled payloads %v, want %v", copies, want)
	}
	got := center.Payloads()
	if len(got) != 2 || got[0] != payloads[0] || got[1] != payloads[1] {
		t.Fatalf("center stored %v, want each event once: %v", got, payloads)
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
	if err := writeHookFrame(c, "", []byte("legacy")); err != nil {
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
	p, err := legacyReadFrame(&buf)
	if err == nil {
		t.Fatalf("old agent read the frame as payload %q", p)
	}
	if !strings.Contains(err.Error(), "frame too large") {
		t.Fatalf("old agent refused for the wrong reason: %v", err)
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
		{strings.ToUpper(good), good},
		{uuid.NewString(), "id-005"},
		{uuid.Nil.String(), "id-006"},
		{"00000000-0000-7000-0000-000000000000", "id-007"},
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

// A hook id the spool will not take is logged, because the copy a lost ack sends
// through incoming/ then becomes a duplicate the center cannot drop.
func TestHandle_LogsARejectedHookID(t *testing.T) {
	var logged []string
	var mu sync.Mutex
	logf := func(f string, a ...any) { mu.Lock(); logged = append(logged, fmt.Sprintf(f, a...)); mu.Unlock() }

	dir := t.TempDir()
	spool, err := OpenSpool(dir+"/spool", testOrigin())
	if err != nil {
		t.Fatal(err)
	}
	srv := newCollect(dir+"/a.sock", spool, nil, logf)

	for _, id := range []string{newUUIDv7(), "", strings.ToUpper(newUUIDv7()), uuid.NewString()} {
		a, b := net.Pipe()
		go srv.handle(a)
		_ = b.SetDeadline(time.Now().Add(2 * time.Second))
		if err := writeHookFrame(b, id, []byte("p")); err != nil {
			t.Fatal(err)
		}
		var ack [1]byte
		if _, err := io.ReadFull(b, ack[:]); err != nil || ack[0] != ackOK {
			t.Fatalf("ack %v err %v", ack, err)
		}
		b.Close()
	}

	mu.Lock()
	defer mu.Unlock()
	if len(logged) != 1 || !strings.Contains(logged[0], "not a UUIDv7") {
		t.Fatalf("logged %q, want one line for the v4 id only (not for the idless frame)", logged)
	}
}

// Against an agent from before #101, a real hook exchange ends in incoming/: the
// old agent refuses the frame and acks nothing, and the hook's fallback keeps the
// payload under the id it minted.
func TestHook_OldAgentRefuses_EventLandsInIncoming(t *testing.T) {
	dir := t.TempDir()
	sock := dir + "/a.sock"
	spoolDir := dir + "/spool"

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	refused := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			refused <- err
			return
		}
		defer c.Close()
		_, err = legacyReadFrame(c)
		refused <- err
	}()

	if code := Hook(sock, spoolDir, strings.NewReader(`{"old":"agent"}`)); code != 0 {
		t.Fatalf("hook exit %d", code)
	}
	if err := <-refused; err == nil || !strings.Contains(err.Error(), "frame too large") {
		t.Fatalf("old agent: %v, want it to refuse the frame as too large", err)
	}

	ents, err := os.ReadDir(incomingPath(spoolDir))
	if err != nil || len(ents) != 1 {
		t.Fatalf("incoming/: %d entries, err %v", len(ents), err)
	}
	b, err := os.ReadFile(filepath.Join(incomingPath(spoolDir), ents[0].Name()))
	if err != nil || string(b) != `{"old":"agent"}` {
		t.Fatalf("fallback holds %q (err %v)", b, err)
	}
	if _, err := uuid.Parse(strings.TrimSuffix(ents[0].Name(), ".raw")); err != nil {
		t.Errorf("fallback name %q is not the hook's UUID", ents[0].Name())
	}
}
