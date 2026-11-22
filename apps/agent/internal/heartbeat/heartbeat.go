package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/declared"
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

	// pid is the session's claude process and pidStart its start time (clock
	// ticks since boot), read when the channel registered; 0 when it was not
	// one (the session is then never reaped).
	pid      int
	pidStart uint64
	// boot is the host's boot id when it registered: with pid and pidStart it
	// names the process across reboots.
	boot string
	// signalled: the reaper sent this process SIGTERM, or its reaped file says it
	// did before this registration. The reaper's goroutine writes it and the
	// keepMin count reads it under Concern.mu, so it is atomic.
	signalled atomic.Bool
	// pidNoted: the reaper has already said why it keeps this session because of
	// its pid file. Only the reaper's goroutine touches it.
	pidNoted bool

	// readMu: read runs in the heartbeat's own loop and in the reaper.
	readMu sync.Mutex
	file   string
	mtime  time.Time
	size   int64
	last   Scan
	// shortTTL is what the last read said, to log only when it changes.
	shortTTL bool

	mu    sync.Mutex
	stats Stats
}

// Stats is what a heartbeat has done, for the agent's status API (kaneo ccx#34).
type Stats struct {
	Next     time.Time // when the next heartbeat is due; zero when none is scheduled
	Sent     int
	LastSent time.Time
	// IdleReason is why no heartbeat is scheduled (#274): one of the Idle*
	// values, or "" when one is scheduled (Next is set) or none of them applies:
	// a pushed beat waiting to land, a failed push, no answered request yet, a
	// transcript that could not be read. (The status API also answers "" for a
	// session whose channel is not registered.)
	IdleReason string
	// BeatsSinceReal is Scan.BeatsSinceReal as of the last read that succeeded
	// (#362); 0 until one has.
	BeatsSinceReal int
}

// Why a heartbeat is not scheduled (Stats.IdleReason). These strings are the
// status API's values.
const (
	IdleNotWanted   = "not_wanted"   // declared off, archived, or off by default
	IdleShortTTL    = "short_ttl"    // the last request wrote a 5-minute cache
	IdleExpired     = "expired"      // the cache is already gone
	IdleTurnRunning = "turn_running" // a turn is running; a beat would queue behind it
	IdleMaxIdle     = "max_idle"     // no real use for longer than MaxIdle
)

// Stats is safe to call while Run is running.
func (h *Heartbeat) Stats() Stats {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stats
}

// Scan is what one read of a transcript tells.
type Scan struct {
	LastAssistant time.Time // the last response record, heartbeat or not
	// LastRequest is when the last answered request started: the user record up
	// the parentUuid chain of the response's first record (later records of the
	// same message.id keep it). The cache is read at the start of a
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
	// BeatsSinceReal is how many heartbeats arrived after LastReal: a person's
	// prompt, another channel's event or another session's message sets it back to 0.
	BeatsSinceReal int
	// ShortTTL: the last request that wrote cache wrote it for 5 minutes only
	// (API key, usage credits). A heartbeat 50 minutes later never lands in time.
	ShortTTL bool
	// Background is the background work started and not yet ended: task id ->
	// when its start was recorded. A task outlives neither the process that
	// started it nor a resume, so a reader keeps only those started since the
	// current process did (BackgroundSince).
	Background map[string]time.Time
}

// BackgroundSince: background work started after t (the session's process
// start) has not ended.
func (s Scan) BackgroundSince(t time.Time) bool {
	for _, at := range s.Background {
		if at.After(t) {
			return true
		}
	}
	return false
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
	// Only the branch that waits for a due time schedules one; every other branch
	// is waiting on something else (a declaration, a turn, a landing).
	var next time.Time
	var reason string
	var s Scan
	var ok bool
	defer func() {
		h.mu.Lock()
		h.stats.Next, h.stats.IdleReason = next, reason
		// A read that failed (no transcript, an I/O or scan error) says nothing
		// about the count: keep the last one read rather than show 0.
		if ok {
			h.stats.BeatsSinceReal = s.BeatsSinceReal
		}
		h.mu.Unlock()
	}()
	if !h.wanted() {
		// Declared off, or folded away. Looked at again each poll, so turning it
		// back on takes effect within a minute. Still read: the count of beats is
		// the transcript's history, not the declaration's, and a declaration
		// must not set it to 0.
		reason = IdleNotWanted
		s, ok = h.read()
		return poll
	}
	s, ok = h.read()
	if !ok || s.LastAssistant.IsZero() {
		return poll // no request yet, so no cache to keep
	}
	if s.ShortTTL != h.shortTTL {
		// Logged on the change only: keepalive stopping here is silent otherwise (#274).
		// Worded as what was seen, not as keepalive's state: the session can still
		// be expired or idle after a 1-hour write, and a new session logs its first
		// 5-minute write too (nothing was running before it).
		if s.ShortTTL {
			h.Log("ccx channel: heartbeat for %s: the last request wrote a 5-minute cache, no beats until one writes a 1-hour cache", h.SessionID)
		} else {
			h.Log("ccx channel: heartbeat for %s: the last request wrote a 1-hour cache again", h.SessionID)
		}
		h.shortTTL = s.ShortTTL
	}
	if s.ShortTTL {
		reason = IdleShortTTL
		return h.Interval // a 5-minute cache: every heartbeat would be a full rewrite
	}
	now := h.Now()
	if now.Sub(s.LastRequest) >= cacheTTL {
		// Already expired (a resume, a suspended host, a request that never
		// answered): a heartbeat would only rewrite the prefix early, and the next
		// real turn does that anyway. Checked before the running-turn test, so a
		// turn that never answered does not keep this looking forever.
		reason = IdleExpired
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
		reason = IdleTurnRunning
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
		reason = IdleMaxIdle
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
		next = due
		return due.Sub(now)
	}
	if err := h.Push(); err != nil {
		h.Log("ccx channel: heartbeat push failed: %v", err)
		return poll
	}
	*sent = now
	h.mu.Lock()
	h.stats.Sent++
	h.stats.LastSent = now
	h.mu.Unlock()
	return poll
}

// wanted reads the session's declared state: archived never, then its own
// on / off (`ccx session heartbeat`), then the machine's default.
func (h *Heartbeat) wanted() bool {
	dir := filepath.Join(h.ClaudeHome, "sessions", h.SessionID)
	// A directory named archived is not the flag (the TS reader and the status
	// API agree: Bun.file().exists() is false for it).
	if fi, err := os.Stat(filepath.Join(dir, "archived")); err == nil && !fi.IsDir() {
		return false
	}
	// The status API (api.ReadDeclared) reads the same file the same way (#191)
	switch declared.Text(filepath.Join(dir, "heartbeat")) {
	case "on":
		return true
	case "off":
		return false
	}
	return h.Default
}

// read scans the transcript, or returns the last scan if the file has not moved.
func (h *Heartbeat) read() (Scan, bool) {
	h.readMu.Lock()
	defer h.readMu.Unlock()
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
// record carrying Marker to the next user prompt, other channel event or
// cross-session message; nothing inside it counts as the session being used.
func ScanTranscript(r interface{ Read([]byte) (int, error) }) (Scan, error) {
	s := Scan{Background: map[string]time.Time{}}
	inBeat := false
	nodes := map[string]node{}
	starts := map[string]time.Time{}    // assistant uuid -> its request's start
	pending := map[string]bool{}        // tool_use ids with no result yet
	toolNames := map[string]string{}    // tool_use id -> the tool's name
	responses := map[string]time.Time{} // response (message) id -> its request's start
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
			// An object for most tools, but a string (an error) or an array for
			// others; a typed struct would make Unmarshal drop the whole record.
			ToolResult json.RawMessage `json:"toolUseResult"`
			// A notification delivered while a turn runs is not a user record but an
			// attachment of type queued_command, its text in prompt.
			Attachment struct {
				Type   string `json:"type"`
				Prompt string `json:"prompt"`
			} `json:"attachment"`
			Message struct {
				ID      string          `json:"id"`
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
			resultIDs := toolIDs(rec.Message.Content, "tool_result", "tool_use_id")
			// Only an end (TaskStop's task_id) needs to know which tool a result came
			// from, told by the tool_use that asked for it. A record carries one
			// tool_result (measured: none with more than one), so the first is its tool.
			tool := ""
			if len(resultIDs) > 0 {
				tool = toolNames[resultIDs[0]]
			}
			tr := parseToolResult(rec.ToolResult, tool)
			trackBackground(s.Background, tr.backgroundTaskID, tr.taskID, tr.agentID, tr.status, tr.stopped, rec.Message.Content, rec.Timestamp)
			tag := channelTag(rec.Message.Content)
			// A local command (/model and its output) is typed by a person but sends
			// no request, so it is not a turn starting. It still counts as use below.
			// An interrupt (Esc) ends a turn rather than starting one; counting it
			// would hold a heartbeat for turnStart, past the TTL if it came late.
			if !isLocalCommand(rec.Message.Content) && !isInterrupt(rec.Message.Content) {
				s.LastInput = rec.Timestamp
			}
			// Only a tool's own result, or an interrupt, ends a running tool: another
			// record (a hook's, a channel's, a sibling tool's result) can land while
			// it runs.
			for _, id := range resultIDs {
				delete(pending, id)
			}
			if isInterrupt(rec.Message.Content) {
				// Esc ends the turn, answered or not: nothing is running any more.
				clear(pending)
				s.LastInput = time.Time{}
			}
			s.ToolRunning = len(pending) > 0
			if rec.IsMeta && strings.Contains(tag, Marker) {
				inBeat, s.LastBeat = true, rec.Timestamp
				s.BeatsSinceReal++
			} else if !isToolResult(rec.Message.Content) && (!rec.IsMeta || tag != "" || isCrossSessionMessage(rec.Message.Content)) {
				// Channel events and cross-session messages are meta records too: a
				// comment arriving on akapen, or another session asking for work, is
				// the session being used.
				inBeat = false
			}
		case "assistant":
			if rec.APIError {
				// A reply Claude Code wrote itself for a request that failed: nothing
				// read the cache, so it is not an answer.
				continue
			}
			s.LastAssistant = rec.Timestamp
			// Tools run while their response streams, so one of their results can be
			// the parent of a later block of that same response. The response id, not
			// the parent chain, says which request the block answers. This assumes a
			// response's blocks are never split by another response's.
			start, seen := responses[rec.Message.ID]
			if !seen {
				start = requestStart(nodes, starts, rec.ParentUUID, rec.Timestamp)
				if !start.Equal(s.LastRequest) {
					// A response to a new request: any tool the earlier one left without a
					// result was abandoned (a rewind, a crash), or it would not have moved
					// on. Parallel calls share one request, so they are not dropped here.
					clear(pending)
				}
				if rec.Message.ID != "" {
					responses[rec.Message.ID] = start
				}
			}
			for _, id := range toolIDs(rec.Message.Content, "tool_use", "id") {
				pending[id] = true
			}
			for id, name := range toolUseNames(rec.Message.Content) {
				toolNames[id] = name
			}
			s.ToolRunning = len(pending) > 0
			s.LastRequest = start
			if rec.UUID != "" {
				starts[rec.UUID] = s.LastRequest
			}
			// A request that wrote nothing says nothing about the TTL; keep the last
			// one that did.
			if cc := rec.Message.Usage.CacheCreation; cc.Short+cc.Long > 0 {
				s.ShortTTL = cc.Long == 0
			}
		case "attachment":
			// Only the end of background work is read from it: the record is not use
			// of the session and changes nothing else about it.
			if rec.Attachment.Type == "queued_command" {
				endNotified(s.Background, rec.Attachment.Prompt)
			}
			continue
		default:
			continue
		}
		if !inBeat {
			s.LastReal, s.BeatsSinceReal = rec.Timestamp, 0
		}
	}
	return s, sc.Err()
}

// toolResultFields are the toolUseResult fields background tracking reads.
type toolResultFields struct {
	backgroundTaskID, taskID, agentID, status, stopped string
}

// parseToolResult reads the fields background tracking uses from a toolUseResult.
// The start fields (backgroundTaskId, taskId, agentId with its status) are read
// whatever the tool: they only ever keep a session, and a start missed because a
// tool was renamed would let a session with live work be stopped. The end field
// (task_id) is read only from a TaskStop, since a stray one would end live work.
// Only an object is decoded (most results are, and the rest are not worth an
// allocation), and a value that is not a string is ignored.
func parseToolResult(raw json.RawMessage, tool string) toolResultFields {
	if len(raw) == 0 || raw[0] != '{' {
		return toolResultFields{}
	}
	var o struct {
		BackgroundTaskID json.RawMessage `json:"backgroundTaskId"`
		TaskID           json.RawMessage `json:"taskId"`
		AgentID          json.RawMessage `json:"agentId"`
		Status           json.RawMessage `json:"status"`
		Stopped          json.RawMessage `json:"task_id"`
	}
	if json.Unmarshal(raw, &o) != nil {
		return toolResultFields{}
	}
	str := func(v json.RawMessage) string {
		var s string
		_ = json.Unmarshal(v, &s)
		return s
	}
	f := toolResultFields{
		backgroundTaskID: str(o.BackgroundTaskID),
		taskID:           str(o.TaskID),
		agentID:          str(o.AgentID),
		status:           str(o.Status),
	}
	if tool == "TaskStop" {
		f.stopped = str(o.Stopped)
	}
	return f
}

// toolUseNames is the name of each tool_use block in the content, by its id.
func toolUseNames(content json.RawMessage) map[string]string {
	var parts []struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return nil
	}
	var names map[string]string
	for _, p := range parts {
		if p.Type == "tool_use" && p.ID != "" {
			if names == nil {
				names = map[string]string{}
			}
			names[p.ID] = p.Name
		}
	}
	return names
}

var (
	taskIDs = regexp.MustCompile(`<task-id>([^<]+)</task-id>`)
	// One record can carry several notifications; each is read on its own.
	notificationBlock = regexp.MustCompile(`(?s)<task-notification>(.*?)</task-notification>`)
)

// monitorExpired stands in the text for an <event> that says its Monitor expired,
// so the expiry stays attached to the notification it came in after the event's
// body is gone. NUL does not occur in the text outside the bodies it replaces.
const monitorExpired = "\x00monitor-expired\x00"

// quotedTags are the notification parts that hold a command's output or a tool's
// own words, which can quote anything: task ids, status tags, a whole notification.
var quotedTags = [...]struct{ open, close string }{
	{"<event>", "</event>"},
	{"<summary>", "</summary>"},
	{"<result>", "</result>"},
}

// finder is the next place a pattern occurs at or after a position, remembered:
// positions only move forward, so what was found stays right until it is passed
// and nothing is searched from the start again.
type finder struct {
	s, pat string
	at     int
	none   bool
}

func newFinder(s, pat string) *finder { return &finder{s: s, pat: pat, at: -1} }

func (f *finder) next(from int) int {
	if f.none {
		return -1
	}
	if f.at >= from {
		return f.at
	}
	i := strings.Index(f.s[from:], f.pat)
	if i < 0 {
		f.none = true
		return -1
	}
	f.at = from + i
	return f.at
}

// stripQuoted removes the quoted bodies of a notification record in one pass from
// left to right. Whichever of <event>, <summary> and <result> opens first is
// taken, and its body runs to its own closing tag, matched by depth against the
// same tag only: another tag inside it, or a notification quoted whole with its own
// <result>, is just content. An <event> that says its Monitor expired leaves a
// marker. A body that never closes runs to the end and is dropped with it, which
// ends no task and so keeps the session.
//
// A literal closing tag with no opening one inside a body is out of scope: it ends
// the body early. Nothing is known to write one.
func stripQuoted(s string) string {
	var opens, closes [len(quotedTags)]*finder
	for i, t := range quotedTags {
		opens[i], closes[i] = newFinder(s, t.open), newFinder(s, t.close)
	}
	var out strings.Builder
	pos := 0
	for {
		first, tag := -1, 0
		for i := range quotedTags {
			if at := opens[i].next(pos); at >= 0 && (first < 0 || at < first) {
				first, tag = at, i
			}
		}
		if first < 0 {
			out.WriteString(s[pos:])
			return out.String()
		}
		out.WriteString(s[pos:first])
		open, closing := quotedTags[tag].open, quotedTags[tag].close
		start := first + len(open)
		depth, cur := 1, start
		for depth > 0 {
			c := closes[tag].next(cur)
			if c < 0 {
				return out.String()
			}
			if o := opens[tag].next(cur); o >= 0 && o < c {
				depth++
				cur = o + len(open)
				continue
			}
			depth--
			cur = c + len(closing)
			if depth == 0 && tag == 0 && strings.HasPrefix(strings.TrimSpace(s[start:c]), "[Monitor expired") {
				out.WriteString(monitorExpired)
			}
		}
		pos = cur
	}
}

// trackBackground records background work starting or ending in one user record.
// A start is what a tool's result says it launched (a backgroundTaskId, a Monitor's
// taskId, an async Agent's agentId), read from any tool's result: a start that is
// not one only keeps a session, and a tool renamed must not hide live work. An end
// is a TaskStop's task_id, which counts only from that tool, or a notification
// (see endNotified).
func trackBackground(bg map[string]time.Time, bash, monitor, agent, status, stopped string, content json.RawMessage, ts time.Time) {
	for _, id := range []string{bash, monitor} {
		if id != "" {
			bg[id] = ts
		}
	}
	if agent != "" && status == "async_launched" {
		bg[agent] = ts
	}
	if stopped != "" {
		delete(bg, stopped)
	}
	var s string
	if json.Unmarshal(content, &s) == nil {
		endNotified(bg, s)
	}
}

// endNotified ends the background tasks a <task-notification> text reports done:
// the text must start with it (as for channelTag), and each notification in it ends
// only its own task ids, by its own <status> or by a Monitor's expiry (an event whose
// text starts with "[Monitor expired"). A Monitor's other events end nothing, and
// text quoted inside a body names no task. The same text arrives as a user record's
// content, or, when delivered during a turn, as an attachment's prompt.
func endNotified(bg map[string]time.Time, s string) {
	if !strings.HasPrefix(s, "<task-notification>") {
		return
	}
	s = stripQuoted(s)
	for _, block := range notificationBlock.FindAllStringSubmatch(s, -1) {
		body := block[1]
		if !strings.Contains(body, "<status>") && !strings.Contains(body, monitorExpired) {
			continue
		}
		for _, m := range taskIDs.FindAllStringSubmatch(body, -1) {
			delete(bg, m[1])
		}
	}
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

// requestStart is when the request a response's first record answers started: the
// first user record up its parentUuid chain (attachments sit in between; later
// records of the same response are keyed by message.id instead). Meeting an earlier
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

// crossSessionIntro is the line Claude Code puts before a cross-session message's
// tag (the shape reported in #184). A record starting at the tag is taken as one
// too.
const crossSessionIntro = "Another Claude session sent a message:\n"

// isCrossSessionMessage is a message another session sent, as Claude Code writes
// it. Only the start is matched, as for channelTag: a person or a tool quoting the
// tag is not one.
func isCrossSessionMessage(content json.RawMessage) bool {
	var s string
	if json.Unmarshal(content, &s) != nil {
		return false
	}
	return strings.HasPrefix(strings.TrimPrefix(s, crossSessionIntro), "<cross-session-message ")
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
