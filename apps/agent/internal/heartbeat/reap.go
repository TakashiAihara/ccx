package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// reapRecord is what one stop leaves: a line in the session's `reaped` file and
// the body of the event sent to the center (PRODUCER_CCX_AGENT_REAPED).
type reapRecord struct {
	At       string `json:"at"`
	Reason   string `json:"reason"`
	PID      int    `json:"pid"`
	PSSBytes int64  `json:"pssBytes"`
	// Start is the process's start time in clock ticks since boot and Boot the
	// host's boot id (/proc/sys/kernel/random/boot_id): together with PID they name
	// one process, so a later registration can tell it was already signalled. Start
	// alone repeats after a reboot.
	Start uint64 `json:"start"`
	Boot  string `json:"boot"`
}

// bootID is the host's boot id: constant for a boot and different for the next.
func bootID(root string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(root, "sys", "kernel", "random", "boot_id"))
	id := strings.TrimSpace(string(b))
	return id, err == nil && id != ""
}

// procDir is where the process table is read from; tests point it at a fake.
func (c *Concern) procDir() string {
	if c.procRoot != "" {
		return c.procRoot
	}
	return "/proc"
}

func (c *Concern) signal(pid int) error {
	if c.kill != nil {
		return c.kill(pid)
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}

// procStat is what /proc/<pid>/stat says that a reaper needs.
type procStat struct {
	comm  string
	state string
	ppid  int
	start uint64 // clock ticks since boot
}

// readProcStat parses /proc/<pid>/stat. The command name sits in parentheses and
// may itself hold spaces or parentheses, so the fields are counted from the last ')'.
func readProcStat(root string, pid int) (procStat, bool) {
	b, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return procStat{}, false
	}
	s := string(b)
	i, j := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if i < 0 || j < i {
		return procStat{}, false
	}
	f := strings.Fields(s[j+1:])
	// f[0] is field 3 (state), so field 4 (ppid) is f[1] and field 22 (starttime) is f[19].
	if len(f) < 20 {
		return procStat{}, false
	}
	ppid, err1 := strconv.Atoi(f[1])
	start, err2 := strconv.ParseUint(f[19], 10, 64)
	if err1 != nil || err2 != nil {
		return procStat{}, false
	}
	return procStat{comm: s[i+1 : j], state: f[0], ppid: ppid, start: start}, true
}

// claudeProc is the process's start time when pid is a running `claude`. A
// zombie or dead one keeps its command name but is not running anything.
func claudeProc(root string, pid int) (uint64, bool) {
	st, ok := readProcStat(root, pid)
	if !ok || st.comm != "claude" || strings.ContainsAny(st.state, "ZXx") {
		return 0, false
	}
	return st.start, true
}

// bootTime is btime from /proc/stat: the wall-clock second the host booted.
func bootTime(root string) (int64, bool) {
	b, err := os.ReadFile(filepath.Join(root, "stat"))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}

// NOTE: CLK_TCK is taken to be 100 (every mainstream Linux build), so
// starttime ticks are centiseconds; read it with sysconf if a host differs.
const clkTck = 100

// startWallClock is when a process started, from the host's boot time and its
// start in ticks since boot.
func startWallClock(btime int64, start uint64) time.Time {
	return time.Unix(btime+int64(start/clkTck), int64(start%clkTck)*int64(time.Second/clkTck))
}

// treePSS is the proportional set size, in bytes, of pid and its descendants. It
// is a report, not a gate: a process whose smaps_rollup cannot be read is skipped.
func treePSS(root string, pid int) int64 {
	ents, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	children := map[int][]int{}
	for _, e := range ents {
		p, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if st, ok := readProcStat(root, p); ok {
			children[st.ppid] = append(children[st.ppid], p)
		}
	}
	var total int64
	seen := map[int]bool{pid: true}
	for queue := []int{pid}; len(queue) > 0; queue = queue[1:] {
		total += pssOf(root, queue[0])
		for _, ch := range children[queue[0]] {
			if !seen[ch] {
				seen[ch] = true
				queue = append(queue, ch)
			}
		}
	}
	return total
}

func pssOf(root string, pid int) int64 {
	b, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "smaps_rollup"))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "Pss:"); ok {
			f := strings.Fields(v)
			if len(f) == 2 && f[1] == "kB" {
				if kb, err := strconv.ParseInt(f[0], 10, 64); err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 0
}

// pinned: `ccx session pin` left the flag file (a directory of that name is not it,
// as for archived).
func (h *Heartbeat) pinned() bool {
	fi, err := os.Stat(filepath.Join(h.ClaudeHome, "sessions", h.SessionID, "pinned"))
	if err == nil {
		return !fi.IsDir()
	}
	// Only a flag that is not there means not pinned: a path that cannot be read
	// (a permission, a loop, an I/O error) may hide one, and a reaper that cannot
	// tell keeps the session.
	return !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR)
}

// expired: keepalive has let go of the session and its cache is gone, and nothing
// is running in it. Every unknown keeps it (an unreadable transcript, a missing
// answer). procStart is when its claude process started: background work from
// before that died with the process, and a process that just started (a resume
// of an old transcript) has not been left alone for any time yet.
func (h *Heartbeat) expired(now, procStart time.Time) (Scan, bool) {
	if h.pinned() {
		return Scan{}, false
	}
	s, ok := h.read()
	if !ok || s.LastAssistant.IsZero() {
		return Scan{}, false
	}
	// A session keepalive holds waits out maxIdle; one it does not (declared off,
	// archived) has nothing to wait for once its cache is cold (user decision
	// 2026-11-22), so the cache TTL below is its whole clock.
	idle := now.Sub(idleSince(s, procStart))
	if h.wanted() {
		if h.MaxIdle <= 0 || idle <= h.MaxIdle {
			return Scan{}, false
		}
	} else if idle < cacheTTL {
		return Scan{}, false
	}
	last := s.LastRequest
	if s.LastBeat.After(last) {
		last = s.LastBeat
	}
	if procStart.After(last) {
		last = procStart
	}
	if now.Sub(last) < cacheTTL {
		return Scan{}, false
	}
	if s.ToolRunning || (s.LastInput.After(s.LastAssistant) && now.Sub(s.LastInput) < turnStart) {
		return Scan{}, false
	}
	if s.BackgroundSince(procStart) {
		return Scan{}, false
	}
	return s, true
}

// idleSince is when the session was last left alone from: the last real use, or
// the process start when that is later (a resume has not been idle since the
// transcript's last record). Never the zero time: a scan with no real record
// would make the idle time overflow.
func idleSince(s Scan, procStart time.Time) time.Time {
	if procStart.After(s.LastReal) {
		return procStart
	}
	return s.LastReal
}

// reapedBefore: the session's reaped file already has a line for this very
// process (pid, start time and boot id). A serve restart or a channel reconnect makes a new
// Heartbeat, and a claude that ignored SIGTERM must not be signalled and recorded
// again for it.
func (h *Heartbeat) reapedBefore() bool {
	if h.signalled.Load() {
		return true
	}
	b, err := os.ReadFile(filepath.Join(h.ClaudeHome, "sessions", h.SessionID, "reaped"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		var r struct {
			PID   int    `json:"pid"`
			Start uint64 `json:"start"`
			Boot  string `json:"boot"`
		}
		// A record without a boot id (an earlier format) names no boot and does not match.
		if json.Unmarshal([]byte(line), &r) == nil && r.PID == h.pid && r.Start == h.pidStart && r.Boot == h.boot {
			h.signalled.Store(true)
			return true
		}
	}
	return false
}

// ownsPID: the pid is still the claude that registered, and Claude Code's own
// record of that process (`<home>/sessions/<pid>.json`) names this session. After
// /clear the same process runs a new session id while its channel stays
// registered under the old one, and the pid file is how the two are told apart.
// Measured on Claude Code 2.1.330 (d1, 2026-11-22, a throwaway interactive
// session): after /clear the file's sessionId changed to the new id within 5
// seconds, so the old registration stops matching and is kept. This depends on
// Claude Code rewriting the field: a version that stopped would leave the old id
// matching, and the reaper would stop the process now running the new session.
// Anything unreadable keeps the session.
func (c *Concern) ownsPID(root string, h *Heartbeat) bool {
	if start, ok := claudeProc(root, h.pid); !ok || start != h.pidStart {
		return false
	}
	var d struct {
		SessionID string `json:"sessionId"`
	}
	b, err := os.ReadFile(filepath.Join(h.ClaudeHome, "sessions", strconv.Itoa(h.pid)+".json"))
	if err == nil {
		err = json.Unmarshal(b, &d)
	}
	if err == nil && d.SessionID == h.SessionID {
		return true
	}
	if !h.pidNoted {
		h.pidNoted = true
		if err != nil {
			c.log("reap: keeping %s: its pid file for %d cannot be read: %v", h.SessionID, h.pid, err)
		} else {
			c.log("reap: keeping %s: pid %d now runs session %q", h.SessionID, h.pid, d.SessionID)
		}
	}
	return false
}

// reapLoop stops at most one expired session per tick.
func (c *Concern) reapLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.reap.Interval):
		}
		c.reapOnce(ctx, time.Now())
	}
}

// running counts the sessions keepMin protects: registered (a channel is connected)
// and not already signalled (one that was is on its way out, not a session left running).
// The caller holds c.mu.
func (c *Concern) running() int {
	n := 0
	for _, h := range c.registered {
		if !h.signalled.Load() {
			n++
		}
	}
	return n
}

// reapOnce stops the oldest expired session, if there is one and more than
// KeepMin would remain.
func (c *Concern) reapOnce(ctx context.Context, now time.Time) {
	c.mu.Lock()
	hs := make([]*Heartbeat, 0, len(c.registered))
	for _, h := range c.registered {
		hs = append(hs, h)
	}
	c.mu.Unlock()
	// Reads the reaped files, so it is not done under the lock.
	for _, h := range hs {
		if h.pid > 1 {
			h.reapedBefore()
		}
	}
	c.mu.Lock()
	short := c.running()-1 < c.reap.KeepMin
	c.mu.Unlock()
	if short {
		return
	}

	root := c.procDir()
	btime, ok := bootTime(root)
	if !ok {
		return
	}
	type candidate struct {
		h *Heartbeat
		// idle is when the session was last left alone from (idleSince): the order
		// is by this, the clock the expiry test counts, not by the raw last use. A
		// resumed old transcript is as fresh as its process, and a transcript with
		// no real record (zero last use) is not older than everything.
		idle time.Time
	}
	var cands []candidate
	for _, h := range hs {
		if h.pid <= 1 || h.signalled.Load() {
			continue
		}
		procStart := startWallClock(btime, h.pidStart)
		if s, ok := h.expired(now, procStart); ok {
			cands = append(cands, candidate{h, idleSince(s, procStart)})
		}
	}
	sort.Slice(cands, func(i, j int) bool {
		if !cands[i].idle.Equal(cands[j].idle) {
			return cands[i].idle.Before(cands[j].idle)
		}
		return cands[i].h.SessionID < cands[j].h.SessionID
	})
	for _, cd := range cands {
		h := cd.h
		procStart := startWallClock(btime, h.pidStart)
		// Before the walk, so a session that is not this process's (after /clear) or
		// has no readable pid file does not cost a walk of /proc on every tick.
		if !c.ownsPID(root, h) {
			continue
		}
		pss := treePSS(root, h.pid)
		if c.beforeSignal != nil {
			c.beforeSignal()
		}
		// Everything is looked at again after the slow part, right before the signal,
		// which keeps the window small: the session pinned or used, or the transcript
		// moved on while the walk ran, then the process itself.
		fresh, ok := h.expired(now, procStart)
		if !ok {
			continue
		}
		if c.afterRecheck != nil {
			c.afterRecheck()
		}
		// Last, so the pid file read closest to the signal is the one that counts.
		if !c.ownsPID(root, h) {
			continue
		}
		// Re-counted under the lock: a session may have gone, or been signalled, since
		// the count above. Marked signalled here so it stops counting at once; the
		// signal itself is sent outside the lock.
		// A shutdown that arrived during the walk stops here, before anything is marked
		// or sent; once the signal is out the record is finished whatever the context.
		c.mu.Lock()
		still := c.registered[h.SessionID] == h
		short := c.running()-1 < c.reap.KeepMin
		stopped := ctx.Err() != nil
		if still && !short && !stopped {
			h.signalled.Store(true)
		}
		c.mu.Unlock()
		if short || stopped {
			return
		}
		if !still {
			continue
		}
		if err := c.signal(h.pid); err != nil {
			h.signalled.Store(false)
			c.log("reap: signalling %s (pid %d): %v", h.SessionID, h.pid, err)
			continue
		}
		c.record(h, now.Sub(idleSince(fresh, procStart)), now, pss)
		return
	}
}

// record leaves the three traces of a stop. The local file comes first and does
// not depend on the center; a failure of one is logged and does not stop the others.
func (c *Concern) record(h *Heartbeat, idle time.Duration, now time.Time, pss int64) {
	c.log("reap: stopped %s (expired, %d MiB, idle %v)", h.SessionID, pss>>20, idle.Round(time.Second))
	rec := reapRecord{At: now.UTC().Format(time.RFC3339), Reason: "expired", PID: h.pid, PSSBytes: pss, Start: h.pidStart, Boot: h.boot}
	line, err := json.Marshal(rec)
	if err != nil {
		c.log("reap: encoding the record of %s: %v", h.SessionID, err)
		return
	}
	if err := appendLine(filepath.Join(h.ClaudeHome, "sessions", h.SessionID), "reaped", line); err != nil {
		c.log("reap: writing the record of %s: %v", h.SessionID, err)
	}
	if c.Record == nil {
		return
	}
	payload, err := json.Marshal(struct {
		SessionID string     `json:"session_id"`
		Reaped    reapRecord `json:"reaped"`
	}{h.SessionID, rec})
	if err == nil {
		err = c.Record(payload)
	}
	if err != nil {
		c.log("reap: sending the record of %s to the spool: %v", h.SessionID, err)
	}
}

func appendLine(dir, name string, line []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_APPEND|os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	// A last line that was cut short (a crash mid-write) has no newline, and this
	// line would be glued to it and lost with it.
	prefix := ""
	if fi, serr := f.Stat(); serr == nil && fi.Size() > 0 {
		var last [1]byte
		if _, rerr := f.ReadAt(last[:], fi.Size()-1); rerr == nil && last[0] != '\n' {
			prefix = "\n"
		}
	}
	_, err = fmt.Fprintf(f, "%s%s\n", prefix, line)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
