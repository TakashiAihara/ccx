// Package heartbeat is the ccx-agent concern that keeps idle sessions' prompt
// caches warm (docs/design/heartbeat.md). Each session's `ccx-agent channel`
// registers on the channel socket; this concern decides from the session's own
// transcript when a heartbeat is due and sends it down that connection.
package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/TakashiAihara/ccx/packages/core/config"
)

// Register is the one line a channel sends after connecting.
type Register struct {
	Session string `json:"session"`
	// ClaudeHome is the session's CLAUDE_CONFIG_DIR, when it set one. serve runs
	// under systemd with its own environment and would look in ~/.claude.
	ClaudeHome string `json:"claudeHome,omitempty"`
	// PID is the session's claude process (the channel's parent), as a decimal
	// string. Older channels leave it out; such a session is never reclaimed.
	PID string `json:"pid,omitempty"`
}

// sessionID is the shape Claude Code gives a session. Anything else is refused:
// the id becomes a path and a glob.
var sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Event is one line serve sends a channel: push this into the session.
type Event struct {
	Content string            `json:"content"`
	Meta    map[string]string `json:"meta"`
}

// Beat is the heartbeat event. `kind` is what Marker matches in the transcript.
var Beat = Event{Content: "heartbeat", Meta: map[string]string{"kind": "heartbeat"}}

// Concern serves the channel socket.
type Concern struct {
	socketPath string
	claudeHome string
	cfg        config.Heartbeat
	reap       config.Reap
	log        func(string, ...any)

	// Record, when set, is handed each stop's record to carry to the center.
	// A failure is logged; the local record is written either way.
	Record func(payload []byte) error

	// procRoot and kill are what a stop reads and does; tests replace them.
	procRoot string
	kill     func(pid int) error
	// beforeSignal runs after a stop's process tree is measured and before the
	// checks that precede the signal; a test closes the window it leaves.
	beforeSignal func()
	// afterRecheck runs after the session's expiry is checked again and before the
	// last check of its process.
	afterRecheck func()

	mu         sync.Mutex
	registered map[string]*Heartbeat // session id -> its running heartbeat
	channels   map[string]*channel   // session id -> its connection, for Push
	listening  atomic.Bool

	retryAfter time.Duration // 0 is a minute; tests shorten it
	lastErr    string
}

// Status is one session's heartbeat as the agent sees it (kaneo ccx#34).
type Status struct {
	// Listening: the channel socket is up. The concern can be on in config and
	// still off here (a socket path too long, another serve holding the lock).
	Listening  bool
	Wanted     bool
	Registered bool
	Home       string // the ClaudeHome the answer was read from
	Stats
}

// Status answers for a session whether or not its channel is connected: an
// unconnected one still has a declaration, it just has no way to be beaten.
// home is the session's CLAUDE_CONFIG_DIR as the asker knows it; a connected
// session's own registration wins, as it does for the beats themselves.
func (c *Concern) Status(session, home string) Status {
	c.mu.Lock()
	h := c.registered[session]
	c.mu.Unlock()
	if h != nil {
		return Status{Listening: c.listening.Load(), Wanted: h.wanted(), Registered: true, Home: h.ClaudeHome, Stats: h.Stats()}
	}
	if home == "" || !filepath.IsAbs(home) {
		home = c.claudeHome
	}
	probe := &Heartbeat{SessionID: session, ClaudeHome: home, Default: c.cfg.Default}
	return Status{Listening: c.listening.Load(), Wanted: probe.wanted(), Home: home}
}

func New(cfg config.Config, log func(string, ...any)) *Concern {
	home := os.Getenv("CLAUDE_CONFIG_DIR")
	if home == "" {
		h, _ := os.UserHomeDir()
		home = filepath.Join(h, ".claude")
	}
	return &Concern{socketPath: cfg.ChannelSocketPath, claudeHome: home, cfg: cfg.Heartbeat, reap: cfg.Reap, log: log}
}

func (c *Concern) Name() string { return "heartbeat" }

// maxUnixPath is the unix socket path limit (108 on Linux, 104 on the BSDs,
// with the terminator, so 103 usable there). At or over it, bind fails with a
// bare "invalid argument".
const maxUnixPath = 104

// Run never fails the process. The concern is on by default and inert for
// anyone without the channel, so a socket it cannot set up (a path too long, a
// second serve holding the lock) turns off the heartbeat alone, with the reason
// in the log; collect keeps running. Like the api concern it tries again every
// retry, so a serve that takes over from one that stopped brings the heartbeat
// up too (#185); a reason repeated is logged once until it is up again.
func (c *Concern) Run(ctx context.Context) error {
	if c.reap.Enabled {
		// Run does not return while a tick is still reading or signalling.
		var loop sync.WaitGroup
		loop.Add(1)
		go func() { defer loop.Done(); c.reapLoop(ctx) }()
		defer loop.Wait()
	}
	for {
		err := c.run(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if msg := fmt.Sprint(err); err != nil && msg != c.lastErr {
			c.log("heartbeat off, retrying every %v: %v", c.retry(), err)
			c.lastErr = msg
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(c.retry()):
		}
	}
}

func (c *Concern) retry() time.Duration {
	if c.retryAfter > 0 {
		return c.retryAfter
	}
	return time.Minute
}

func (c *Concern) run(ctx context.Context) error {
	if len(c.socketPath) >= maxUnixPath {
		return fmt.Errorf("channel socket path is %d bytes, over the %d-byte unix-socket limit: %s\nset CCX_CHANNEL_SOCKET to a shorter path",
			len(c.socketPath), maxUnixPath, c.socketPath)
	}
	if err := os.MkdirAll(filepath.Dir(c.socketPath), 0o700); err != nil {
		return err
	}
	// Held before the socket is touched: a second serve must not remove the
	// socket the running one is listening on (collect's lock does not cover
	// this; the concerns start at once, and collect may be off).
	lock, err := os.OpenFile(c.socketPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another ccx-agent serve holds %s.lock: %w", c.socketPath, err)
	}
	// Under the lock, a socket left here is from a serve that died.
	if err := os.Remove(c.socketPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	ln, err := net.Listen("unix", c.socketPath)
	if err != nil {
		return err
	}
	defer os.Remove(c.socketPath)
	if err := os.Chmod(c.socketPath, 0o600); err != nil {
		ln.Close()
		return err
	}
	go func() { <-ctx.Done(); ln.Close() }()
	if c.lastErr != "" {
		c.log("heartbeat up again on %s", c.socketPath)
		c.lastErr = ""
	}
	c.listening.Store(true)
	defer c.listening.Store(false)
	c.accept(ctx, ln, acceptRetry)
	return nil
}

// acceptRetry is the pause after a failed Accept. Giving up would leave the
// socket in place with nobody accepting, so every session that connects later
// (a new one, or one reconnecting after a restart) would be silently unserved;
// errors like EMFILE pass.
const acceptRetry = time.Second

func (c *Concern) accept(ctx context.Context, ln net.Listener, retry time.Duration) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log("heartbeat: accept: %v (retrying)", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(retry):
			}
			continue
		}
		go c.serve(ctx, conn)
	}
}

// serve runs one session's heartbeat for as long as its channel stays connected.
func (c *Concern) serve(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := r.ReadBytes('\n')
	var reg Register
	if err != nil || json.Unmarshal(line, &reg) != nil || !sessionID.MatchString(reg.Session) {
		c.log("heartbeat: a channel connected without registering a session id")
		return
	}
	home := c.claudeHome
	if reg.ClaudeHome != "" && filepath.IsAbs(reg.ClaudeHome) {
		home = reg.ClaudeHome
	}
	_ = conn.SetReadDeadline(time.Time{})

	// The channel never sends again; a read returning is the session going away.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _, _ = r.ReadByte(); cancel() }()

	ch := &channel{conn: conn, out: json.NewEncoder(conn), home: home}
	h := &Heartbeat{
		SessionID: reg.Session, ClaudeHome: home,
		Interval: c.cfg.Interval, MaxIdle: c.cfg.MaxIdle, Default: c.cfg.Default,
		Push: func() error { return ch.send(Beat) },
		Log: c.log,
		Now: time.Now,
		Sleep: func(ctx context.Context, d time.Duration) {
			select {
			case <-ctx.Done():
			case <-time.After(d):
			}
		},
	}
	// A session is only ever stopped through the pid it registered, and only
	// while that pid is still the same `claude` process.
	if c.reap.Enabled {
		pid, err := strconv.Atoi(reg.PID)
		if err != nil || pid <= 1 {
			c.log("reap: session %s registered no usable pid (%q); it will not be reaped", reg.Session, reg.PID)
		} else if boot, ok := bootID(c.procDir()); !ok {
			// Checked first: without /proc (macOS) every pid would look like "not a claude".
			c.log("reap: session %s: the host's boot id cannot be read; it will not be reaped", reg.Session)
		} else if start, ok := claudeProc(c.procDir(), pid); !ok {
			c.log("reap: session %s registered pid %d, which is not a claude process; it will not be reaped", reg.Session, pid)
		} else {
			h.pid, h.pidStart, h.boot = pid, start, boot
			// A reconnect of a process that was already signalled starts out signalled,
			// so keepMin does not count it as running.
			h.reapedBefore()
		}
	}
	c.mu.Lock()
	if c.registered == nil {
		c.registered = map[string]*Heartbeat{}
	}
	c.registered[reg.Session] = h
	if c.channels == nil {
		c.channels = map[string]*channel{}
	}
	c.channels[reg.Session] = ch
	c.mu.Unlock()
	defer func() {
		// A reconnect can register the same session before this one winds down;
		// only remove the entry that is still ours.
		c.mu.Lock()
		if c.registered[reg.Session] == h {
			delete(c.registered, reg.Session)
		}
		if c.channels[reg.Session] == ch {
			delete(c.channels, reg.Session)
		}
		c.mu.Unlock()
	}()
	h.Run(ctx)
}

// channel is one registered session's connection. The heartbeat and Push both
// write to it, so the writes take turns.
type channel struct {
	mu   sync.Mutex
	conn net.Conn
	out  *json.Encoder
	home string
}

func (ch *channel) send(ev Event) error {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	_ = ch.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := ch.out.Encode(ev)
	if err != nil {
		// A json.Encoder keeps its first write error and returns it for every
		// later Encode, and part of the line may be out: close, so serve drops the
		// registration and the channel reconnects on a clean line.
		ch.conn.Close()
	}
	return err
}

// ErrNotRegistered is Push's answer for a session whose ccx channel is not
// connected to this serve: nothing was sent.
var ErrNotRegistered = errors.New("no ccx channel is registered for this session")

// Push sends ev down a registered session's channel (a message, #138) and
// returns the Claude home its transcript is under. A nil error means the event
// was written to the channel, not that Claude Code took it: channel
// notifications are not acknowledged (docs/design/transport.md).
func (c *Concern) Push(session string, ev Event) (home string, err error) {
	c.mu.Lock()
	ch := c.channels[session]
	c.mu.Unlock()
	if ch == nil {
		return "", ErrNotRegistered
	}
	return ch.home, ch.send(ev)
}

// Home is the Claude home of a registered session; ok is false when its channel
// is not connected.
func (c *Concern) Home(session string) (home string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ch := c.channels[session]; ch != nil {
		return ch.home, true
	}
	return "", false
}
