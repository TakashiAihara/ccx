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
// The leading space makes it the whole attribute name: `event_kind="heartbeat"`
// on another channel's event is not a heartbeat.
const Marker = ` kind="heartbeat"`

// Heartbeat keeps one session's prompt cache from expiring (docs/design/heartbeat.md).
//
// The cache lives an hour from the start of the last request that read it, and
// only a turn in that session reads it. So the clock is the session's own
// transcript: the start of the last answered request, plus Interval, is when a
// turn is due.
type Heartbeat struct {
	SessionID  string
	ClaudeHome string        // ~/.claude, or CLAUDE_CONFIG_DIR
	Interval   time.Duration // 50m: an hour of TTL, less the minutes a heartbeat may wait (a poll, a turn starting) and slack
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
	LastAssistant time.Time // the last response record, heartbeat or not
	// LastRequest is when the last answered request started: the user record up
	// the response's parentUuid chain. The cache is read at the start of a
	// request, so the TTL counts from here, not from the response (which can come
	// minutes later). A synthetic API-error reply is not an answer.
	LastRequest time.Time
	// LastInput is the last user record of any kind. Newer than LastAssistant, and
	// recent, means a turn is starting; some user records never get a response.
	LastInput time.Time
	// ToolRunning: a tool a response asked for has not returned its result, and
	// no interrupt came since. Several can run at once (parallel calls).
	ToolRunning bool
	LastReal    time.Time // the last record outside a heartbeat turn
	LastBeat    time.Time // the last heartbeat that arrived
	// ShortTTL: the last request that wrote cache wrote it for 5 minutes only
	// (API key, usage credits). A heartbeat 50 minutes later never lands in time.
	ShortTTL bool
}

// poll is how often a transcript is looked at while nothing is due: a session
// that is not there yet, a heartbeat that has not arrived.
const poll = time.Minute

// cacheTTL is what Claude Code requests for the main conversation on a
// subscription. With 5m (API key, usage credits) a heartbeat never lands in time.
const cacheTTL = time.Hour

// turnStart bounds how long input may wait for its response and still count as
// a turn starting. Measured on real transcripts (2026-09-24): p99 30s, max 116s.
const turnStart = 5 * time.Minute

// Run pushes heartbeats until ctx ends.
func (h *Heartbeat) Run(ctx context.Context) {
	var sent time.Time
	for ctx.Err() == nil {
		// Never longer than a poll: a session declared on / off, archived, or used
		// again is noticed within a minute. The transcript is re-read only when it
		// changed, so a poll costs a few stats.
		h.Sleep(ctx, min(h.step(&sent), poll))
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
	if s.ShortTTL {
		return h.Interval // a 5-minute cache: every heartbeat would be a full rewrite
	}
	now := h.Now()
	if now.Sub(s.LastRequest) >= cacheTTL {
		// Already expired (a resume, a suspended host, a request that never
		// answered): a heartbeat would only rewrite the prefix early, and the next
		// real turn does that anyway. Checked before the running-turn test, so a
		// turn that never answered does not keep this looking forever.
		return h.Interval
	}
	if s.ToolRunning || (s.LastInput.After(s.LastAssistant) && now.Sub(s.LastInput) < turnStart) {
		// A turn is running: a tool has not returned, or input just arrived and
		// the response has not started. A heartbeat pushed now would queue behind
		// the turn and run as an extra turn after it. Input with no response for
		// longer than turnStart is taken to be one that never gets one (Esc, a
		// manual /compact, a stopped task's notice). That is a heuristic: a
		// response slower than turnStart gets one extra heartbeat turn (~0.03% of
		// the 5h window), which is cheaper than stopping keepalive after every Esc.
		return poll
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
	if h.MaxIdle > 0 && now.Sub(s.LastReal) > h.MaxIdle {
		return h.Interval // left alone too long to be worth keeping; real use resumes it
	}
	// Counted from the later of the two: a heartbeat that landed but was never
	// answered looks like a running turn for turnStart only, and must not be sent
	// again as soon as that passes.
	last := s.LastRequest
	if s.LastBeat.After(last) {
		last = s.LastBeat
	}
	if due := last.Add(h.Interval); now.Before(due) {
		return due.Sub(now)
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
	nodes := map[string]node{}
	starts := map[string]time.Time{} // assistant uuid -> its request's start
	pending := map[string]bool{}     // tool_use ids with no result yet
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		var rec struct {
			Type       string    `json:"type"`
			UUID       string    `json:"uuid"`
			ParentUUID string    `json:"parentUuid"`
			Timestamp  time.Time `json:"timestamp"`
			IsMeta     bool      `json:"isMeta"`
			APIError   bool      `json:"isApiErrorMessage"`
			Message    struct {
				Content json.RawMessage `json:"content"`
				Usage   struct {
					CacheCreation struct {
						Short int `json:"ephemeral_5m_input_tokens"`
						Long  int `json:"ephemeral_1h_input_tokens"`
					} `json:"cache_creation"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Timestamp.IsZero() {
			continue
		}
		if rec.UUID != "" {
			nodes[rec.UUID] = node{typ: rec.Type, ts: rec.Timestamp, parent: rec.ParentUUID}
		}
		switch rec.Type {
		case "user":
			tag := channelTag(rec.Message.Content)
			// A local command (/model and its output) is typed by a person but sends
			// no request, so it is not a turn starting. It still counts as use below.
			if !isLocalCommand(rec.Message.Content) {
				s.LastInput = rec.Timestamp
			}
			// Only a tool's own result, or an interrupt, ends a running tool: another
			// record (a hook's, a channel's, a sibling tool's result) can land while
			// it runs.
			for _, id := range toolIDs(rec.Message.Content, "tool_result", "tool_use_id") {
				delete(pending, id)
			}
			if isInterrupt(rec.Message.Content) {
				clear(pending)
			}
			s.ToolRunning = len(pending) > 0
			if rec.IsMeta && strings.Contains(tag, Marker) {
				inBeat, s.LastBeat = true, rec.Timestamp
			} else if !isToolResult(rec.Message.Content) && (!rec.IsMeta || tag != "") {
				// Channel events are meta records too, and a comment arriving on
				// akapen is the session being used.
				inBeat = false
			}
		case "assistant":
			if rec.APIError {
				// A reply Claude Code wrote itself for a request that failed: nothing
				// read the cache, so it is not an answer.
				continue
			}
			s.LastAssistant = rec.Timestamp
			for _, id := range toolIDs(rec.Message.Content, "tool_use", "id") {
				pending[id] = true
			}
			s.ToolRunning = len(pending) > 0
			s.LastRequest = requestStart(nodes, starts, rec.ParentUUID, rec.Timestamp)
			if rec.UUID != "" {
				starts[rec.UUID] = s.LastRequest
			}
			// A request that wrote nothing says nothing about the TTL; keep the last
			// one that did.
			if cc := rec.Message.Usage.CacheCreation; cc.Short+cc.Long > 0 {
				s.ShortTTL = cc.Long == 0
			}
		default:
			continue
		}
		if !inBeat {
			s.LastReal = rec.Timestamp
		}
	}
	return s, sc.Err()
}

// isLocalCommand is a slash command's echo or output, written as a user record
// with no request after it. `!` lines are not here: their output can start a turn.
func isLocalCommand(content json.RawMessage) bool {
	var s string
	if json.Unmarshal(content, &s) != nil {
		return false
	}
	return strings.HasPrefix(s, "<command-name>") || strings.HasPrefix(s, "<local-command-")
}

// isInterrupt is the record Esc leaves: "[Request interrupted by user..." as text.
func isInterrupt(content json.RawMessage) bool {
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		var s string
		return json.Unmarshal(content, &s) == nil && strings.HasPrefix(s, "[Request interrupted")
	}
	for _, p := range parts {
		if p.Type == "text" && strings.HasPrefix(p.Text, "[Request interrupted") {
			return true
		}
	}
	return false
}

type node struct {
	typ    string
	ts     time.Time
	parent string
}

// requestStart is when the request a response answers started: the first user
// record up its parentUuid chain (attachments sit in between). Meeting an earlier
// response first means this is a later part of the same one. Following the chain
// rather than guessing from content: cross-session messages and channel events are
// meta records that start a turn, and a local command's output can too.
func requestStart(nodes map[string]node, starts map[string]time.Time, parent string, fallback time.Time) time.Time {
	for i := 0; i < 64 && parent != ""; i++ {
		n, ok := nodes[parent]
		if !ok {
			break
		}
		switch n.typ {
		case "user":
			if n.ts.After(fallback) {
				return fallback // out of order (a fork, a compaction summary)
			}
			return n.ts
		case "assistant":
			if t, ok := starts[parent]; ok {
				return t
			}
			return fallback
		}
		parent = n.parent
	}
	return fallback
}

// toolIDs is the ids in the content blocks of one type: tool_use blocks carry
// "id", tool_result blocks "tool_use_id".
func toolIDs(content json.RawMessage, typ, key string) []string {
	var parts []map[string]any
	if json.Unmarshal(content, &parts) != nil {
		return nil
	}
	var ids []string
	for _, p := range parts {
		if p["type"] == typ {
			if id, ok := p[key].(string); ok {
				ids = append(ids, id)
			}
		}
	}
	return ids
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
