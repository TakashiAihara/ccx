package collect

import (
	"encoding/binary"
	"fmt"
	"io"
)

// The hook↔ccx-agent wire is deliberately minimal: one framed payload in, one ack
// byte back.
//
//	hook → ccx-agent:  [4-byte big-endian length][payload bytes]
//	hook → ccx-agent:  [4-byte big-endian length, top bit set][36-byte event
//	                   id][payload bytes]
//	ccx-agent → hook:  [1 byte] ackOK once the payload is durably spooled
//
// The top bit of the length says a 36-byte event id (#101) precedes the payload.
// No length can reach it (maxFrame is far below 2^31). A reader from before the
// flag existed caps the header
// at maxFrame, reads a flagged header as a length far past the cap, and refuses the
// frame as too large instead of spooling 36 bytes of id as the head of a truncated
// payload. It acks nothing, so the hook falls back to incoming/ and the event
// survives — spooled once per path, under one id, which the center can drop.
//
// The ack is the receipt. The hook treats "I got ackOK" as "ccx-agent has this on
// disk" and only then considers the socket path a success. Anything else —
// no ack, wrong byte, timeout, a dead socket — sends the hook to its fallback
// (write to incoming/, exit 0), so an event is never lost, only ever
// duplicated at worst (which the center drops by event_id).
const (
	ackOK byte = 1

	// hookFrameIDFlag marks a frame as carrying the event's id.
	hookFrameIDFlag uint32 = 1 << 31

	// hookIDLen is the width of a canonical UUID string. Fixed width is what lets
	// the reader find the payload without a length of its own, and it is also the
	// only spelling of an id the spool takes as a dedup key.
	hookIDLen = 36

	// A hook payload is JSON of at most tens of KB in practice. Cap the frame
	// well above that but far below anything that could OOM ccx-agent on a bad
	// length prefix.
	maxFrame = 64 << 20 // 64 MiB
)

// writeFrame writes the idless frame form, [length][payload]. It is what a hook
// with no event id to carry sends.
func writeFrame(w io.Writer, payload []byte) error {
	return writeHookFrame(w, "", payload)
}

// writeHookFrame writes one frame, carrying id when the hook has one to carry.
func writeHookFrame(w io.Writer, id string, payload []byte) error {
	if len(payload) > maxFrame {
		return fmt.Errorf("payload too large: %d bytes", len(payload))
	}
	// The reader takes the id at a fixed offset, so a width it cannot trust
	// desyncs the frame. Refuse to send it rather than send something only the
	// receiver can reinterpret.
	if id != "" && len(id) != hookIDLen {
		return fmt.Errorf("event id is %d bytes, want a %d-byte canonical UUID", len(id), hookIDLen)
	}

	flag := uint32(0)
	if id != "" {
		flag = hookFrameIDFlag
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload))|flag)
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if id != "" {
		if _, err := io.WriteString(w, id); err != nil {
			return err
		}
	}
	_, err := w.Write(payload)
	return err
}

// readHookFrame reads one frame of either form. The id is "" for the idless form,
// which leaves the agent free to mint one.
func readHookFrame(r io.Reader) (string, []byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return "", nil, err
	}
	header := binary.BigEndian.Uint32(hdr[:])
	n := header &^ hookFrameIDFlag
	if n > maxFrame {
		return "", nil, fmt.Errorf("frame too large: %d bytes", n)
	}

	id := ""
	if header&hookFrameIDFlag != 0 {
		var buf [hookIDLen]byte
		if _, err := io.ReadFull(r, buf[:]); err != nil {
			return "", nil, err
		}
		id = string(buf[:])
	}

	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return "", nil, err
	}
	return id, payload, nil
}
