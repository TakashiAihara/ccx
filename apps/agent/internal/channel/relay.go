package channel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"
)

// retry is how soon a channel tries serve again after it was not there or went
// away. A heartbeat is due at most once in 50 minutes, so a minute costs nothing.
const retry = time.Minute

// Relay registers this session with ccx-agent serve and pushes every event serve
// sends, until ctx ends. serve being down is normal (not started yet,
// restarted to pick up config): keep trying, never fail the session.
func Relay(ctx context.Context, socketPath, sessionID string, s *Server, log func(string, ...any)) {
	for ctx.Err() == nil {
		if err := relayOnce(ctx, socketPath, sessionID, s); err != nil {
			log("ccx channel: serve at %s: %v (retrying in %v)", socketPath, err, retry)
		}
		select {
		case <-ctx.Done():
		case <-time.After(retry):
		}
	}
}

func relayOnce(ctx context.Context, socketPath, sessionID string, s *Server) error {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() { <-ctx.Done(); conn.Close() }()

	if err := json.NewEncoder(conn).Encode(map[string]string{"session": sessionID}); err != nil {
		return err
	}
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		var ev struct {
			Content string            `json:"content"`
			Meta    map[string]string `json:"meta"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		if err := s.Push(ev.Content, ev.Meta); err != nil {
			return err
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return errors.New("serve closed the connection")
}
