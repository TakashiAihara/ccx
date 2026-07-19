package main

import (
	"encoding/binary"
	"fmt"
	"io"
)

// The hook↔ccxd wire is deliberately minimal: one framed payload in, one ack
// byte back.
//
//	hook → ccxd:  [4-byte big-endian length][payload bytes]
//	ccxd → hook:  [1 byte] ackOK once the payload is durably spooled
//
// The ack is the receipt. The hook treats "I got ackOK" as "ccxd has this on
// disk" and only then considers the socket path a success. Anything else —
// no ack, wrong byte, timeout, a dead socket — sends the hook to its fallback
// (write to incoming/, exit 0), so an event is never lost, only ever
// duplicated at worst (which the center drops by event_id).
const (
	ackOK byte = 1

	// A hook payload is JSON of at most tens of KB in practice. Cap the frame
	// well above that but far below anything that could OOM ccxd on a bad
	// length prefix.
	maxFrame = 64 << 20 // 64 MiB
)

func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) > maxFrame {
		return fmt.Errorf("payload too large: %d bytes", len(payload))
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func readFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > maxFrame {
		return nil, fmt.Errorf("frame too large: %d bytes", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
