package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Marker is the attribute that identifies a heartbeat in the opening tag of a
// channel event (an isMeta user record). Tools that count a session's turns
// (idle reapers, retro metrics) skip records carrying it.
const Marker = `kind="heartbeat"`

// Heartbeat keeps one session's prompt cache from expiring (docs/design/heartbeat.md).
//
// The cache lives an hour from the start of the last request that read it, and
// only a turn in that session reads it. So the clock is the session's own
// transcript: the last assistant record, plus Interval, is when a turn is due.
type Heartbeat struct {
	SessionID  string
	ClaudeHome string        // ~/.claude, or CLAUDE_CONFIG_DIR
	Interval   time.Duration // 50m: an hour of TTL, less generation time and slack
	MaxIdle    time.Duration // stop once no one has used the session for this long; 0 is no cap
	Default    bool          // for a session that has not declared on or off
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

// cacheTTL is what Claude Code requests for the main conversation on a
// subscription. With 5m (API key, usage credits) a heartbeat never lands in time.
const cacheTTL = time.Hour

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
	if !h.wanted() {
		// Declared off, or folded away. Looked at again each poll, so turning it
		// back on takes effect within a minute.
		return poll
	}
	s, ok := h.read()
	if !ok || s.LastAssistant.IsZero() {
		return poll // no request yet, so no cache to keep
	}
	if !sent.IsZero() {
		if s.LastBeat.Before(*sent) && !s.LastReal.After(*sent) {
			// Pushed but not in the transcript, and nothing else happened since.
			// Either the session is mid-turn and will take it when the turn ends,
			// or this is not its transcript any more (/clear starts a new id): never
			// push a second one over it, or a stale channel beats forever. Real use
			// after the push means the session is alive and the push was lost.
			return poll
		}
		*sent = time.Time{}
	}
	now := h.Now()
	if h.MaxIdle > 0 && now.Sub(s.LastReal) > h.MaxIdle {
		return h.Interval // left alone too long to be worth keeping; real use resumes it
	}
	// Counted from the later of the two: a heartbeat whose answer failed must not
	// make the next one due at once.
	last := s.LastAssistant
	if s.LastBeat.After(last) {
		last = s.LastBeat
	}
	if due := last.Add(h.Interval); now.Before(due) {
		return due.Sub(now)
	}
	if now.Sub(last) >= cacheTTL {
		// Already expired (a resume, a suspended host): a heartbeat would only
		// rewrite the prefix early, and the next real turn does that anyway.
		return h.Interval
	}
	if err := h.Push(); err != nil {
		h.Log("ccx channel: heartbeat push failed: %v", err)
		return poll
	}
	*sent = now
	return poll
}

// wanted reads the session's declared state: archived never, then its own
// on / off (`ccx session heartbeat`), then the machine's default.
func (h *Heartbeat) wanted() bool {
	dir := filepath.Join(h.ClaudeHome, "sessions", h.SessionID)
	if _, err := os.Stat(filepath.Join(dir, "archived")); err == nil {
		return false
	}
	b, err := os.ReadFile(filepath.Join(dir, "heartbeat"))
	if err != nil {
		return h.Default
	}
	switch strings.TrimSpace(string(b)) {
	case "on":
		return true
	case "off":
		return false
	}
	return h.Default
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
	s, err := ScanTranscript(f)
	if err != nil {
		// A scan cut short would date the session from an old record and push.
		h.Log("ccx channel: reading %s: %v", h.file, err)
		return Scan{}, false
	}
	h.last, h.mtime, h.size = s, st.ModTime(), st.Size()
	return h.last, true
}

// ScanTranscript walks the records in order. A heartbeat turn runs from a user
// record carrying Marker to the next user prompt that does not; nothing inside
// it counts as the session being used.
func ScanTranscript(r interface{ Read([]byte) (int, error) }) (Scan, error) {
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
			tag := channelTag(rec.Message.Content)
			if rec.IsMeta && strings.Contains(tag, Marker) {
				inBeat, s.LastBeat = true, rec.Timestamp
			} else if !isToolResult(rec.Message.Content) && (!rec.IsMeta || tag != "") {
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
	return s, sc.Err()
}

// channelTag is the opening <channel ...> tag of a channel event, or "". Only
// the tag is looked at: a person or a tool quoting the attribute is not a beat.
func channelTag(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) != nil || !strings.HasPrefix(s, "<channel ") {
		return ""
	}
	if i := strings.IndexByte(s, '>'); i > 0 {
		return s[:i+1]
	}
	return ""
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
