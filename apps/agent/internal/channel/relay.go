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
var retry = time.Minute

// Relay registers this session with ccx-agent serve and pushes every event serve
// sends, until ctx ends. serve being down is normal (not started yet,
// restarted to pick up config): keep trying, never fail the session.
func Relay(ctx context.Context, socketPath, sessionID, claudeHome string, s *Server, log func(string, ...any)) {
	quiet := false
	for ctx.Err() == nil {
		connected, err := relayOnce(ctx, socketPath, sessionID, claudeHome, s)
		// Said once per outage, not every minute: serve being off (or the concern
		// turned off) is a normal state and must not fill the session's MCP log.
		if connected {
			quiet = false
		}
		if err != nil && !quiet {
			log("ccx channel: serve at %s: %v (retrying every %v, quiet until it answers)", socketPath, err, retry)
			quiet = true
		}
		select {
		case <-ctx.Done():
		case <-time.After(retry):
		}
	}
}

func relayOnce(ctx context.Context, socketPath, sessionID, claudeHome string, s *Server) (connected bool, err error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()

	reg := map[string]string{"session": sessionID}
	if claudeHome != "" {
		reg["claudeHome"] = claudeHome
	}
	if err := json.NewEncoder(conn).Encode(reg); err != nil {
		return true, err
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
			return true, err
		}
	}
	if err := sc.Err(); err != nil {
		return true, err
	}
	return true, errors.New("serve closed the connection")
}
