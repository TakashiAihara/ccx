package channel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Marker is what identifies a heartbeat turn in a transcript. Tools that count
// a session's turns (idle reapers, retro metrics) skip user records carrying it.
const Marker = `kind=\"heartbeat\"`

// Heartbeat keeps one session's prompt cache from expiring (docs/design/heartbeat.md).
//
// The cache lives an hour from the start of the last request that read it, and
// only a turn in that session reads it. So the clock is the session's own
// transcript: the last assistant record, plus Interval, is when a turn is due.
type Heartbeat struct {
	SessionID  string
	ClaudeHome string        // ~/.claude, or CLAUDE_CONFIG_DIR
	Interval   time.Duration // 50m: an hour of TTL, less generation time and slack
	MaxIdle    time.Duration // stop once no one has used the session for this long
	Push       func() error
	Log        func(string, ...any)
	Now        func() time.Time
	Sleep      func(context.Context, time.Duration)

	file  string
	mtime time.Time
	size  int64
	last  Scan
}

// Scan is what one read of a transcript tells.
type Scan struct {
	LastAssistant time.Time // the last request, heartbeat or not
	LastReal      time.Time // the last record outside a heartbeat turn
	LastBeat      time.Time // the last heartbeat that arrived
}

// poll is how often a transcript is looked at while nothing is due: a session
// that is not there yet, a heartbeat that has not arrived.
const poll = time.Minute

// Run pushes heartbeats until ctx ends.
func (h *Heartbeat) Run(ctx context.Context) {
	var sent time.Time
	for ctx.Err() == nil {
		wait := h.step(&sent)
		h.Sleep(ctx, wait)
	}
}

// step decides one thing and returns how long to wait before the next.
func (h *Heartbeat) step(sent *time.Time) time.Duration {
	if h.archived() {
		// Folded away: its cache is not wanted. Unarchiving it resumes.
		return h.Interval
	}
	s, ok := h.read()
	if !ok || s.LastAssistant.IsZero() {
		return poll // no request yet, so no cache to keep
	}
	if !sent.IsZero() {
		if s.LastBeat.Before(*sent) {
			// Pushed but not in the transcript. Either the session is mid-turn and
			// will take it when the turn ends, or this is not its transcript any
			// more (/clear starts a new id). Either way, never push a second one
			// over it: that is how a stale channel would beat forever.
			return poll
		}
		*sent = time.Time{}
	}
	now := h.Now()
	if now.Sub(s.LastReal) > h.MaxIdle {
		return h.Interval // left alone too long to be worth keeping; real use resumes it
	}
	if due := s.LastAssistant.Add(h.Interval); now.Before(due) {
		return due.Sub(now)
	}
	if err := h.Push(); err != nil {
		h.Log("ccx channel: heartbeat push failed: %v", err)
		return poll
	}
	*sent = now
	return poll
}

func (h *Heartbeat) archived() bool {
	_, err := os.Stat(filepath.Join(h.ClaudeHome, "sessions", h.SessionID, "archived"))
	return err == nil
}

// read scans the transcript, or returns the last scan if the file has not moved.
func (h *Heartbeat) read() (Scan, bool) {
	if h.file == "" {
		m, _ := filepath.Glob(filepath.Join(h.ClaudeHome, "projects", "*", h.SessionID+".jsonl"))
		if len(m) == 0 {
			return Scan{}, false
		}
		h.file = m[0]
	}
	st, err := os.Stat(h.file)
	if err != nil {
		h.file = ""
		return Scan{}, false
	}
	if st.ModTime().Equal(h.mtime) && st.Size() == h.size {
		return h.last, true
	}
	f, err := os.Open(h.file)
	if err != nil {
		return Scan{}, false
	}
	defer f.Close()
	h.last, h.mtime, h.size = ScanTranscript(f), st.ModTime(), st.Size()
	return h.last, true
}

// ScanTranscript walks the records in order. A heartbeat turn runs from a user
// record carrying Marker to the next user prompt that does not; nothing inside
// it counts as the session being used.
func ScanTranscript(r interface{ Read([]byte) (int, error) }) Scan {
	var s Scan
	inBeat := false
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		var rec struct {
			Type      string    `json:"type"`
			Timestamp time.Time `json:"timestamp"`
			IsMeta    bool      `json:"isMeta"`
			Message   struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Timestamp.IsZero() {
			continue
		}
		switch rec.Type {
		case "user":
			if bytes.Contains(line, []byte(Marker)) {
				inBeat, s.LastBeat = true, rec.Timestamp
			} else if !isToolResult(rec.Message.Content) && (!rec.IsMeta || isChannel(rec.Message.Content)) {
				// Channel events are meta records too, and a comment arriving on
				// akapen is the session being used.
				inBeat = false
			}
		case "assistant":
			s.LastAssistant = rec.Timestamp
		default:
			continue
		}
		if !inBeat {
			s.LastReal = rec.Timestamp
		}
	}
	return s
}

func isChannel(content json.RawMessage) bool {
	var s string
	return json.Unmarshal(content, &s) == nil && strings.HasPrefix(s, "<channel ")
}

func isToolResult(content json.RawMessage) bool {
	var parts []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return false
	}
	for _, p := range parts {
		if p.Type == "tool_result" {
			return true
		}
	}
	return false
}
