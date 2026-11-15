package message

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// claudeSession is the shape of a Claude Code session id. A target of this
// shape is a Claude Code session; anything else is a Devin session name.
var claudeSession = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// IsClaudeSession says whether target names a Claude Code session.
func IsClaudeSession(target string) bool { return claudeSession.MatchString(target) }

// Channels pushes an event down a session's ccx channel (the heartbeat
// concern, which holds the channel connections) and says where its transcript is.
type Channels interface {
	// Home is the Claude home of a session whose channel is connected; ok is
	// false when none is.
	Home(session string) (home string, ok bool)
	Push(session string, ev heartbeat.Event) (home string, err error)
}

// Claude delivers to Claude Code sessions through their ccx channel (#138).
type Claude struct {
	Channels Channels
	// Poll is the interval of the transcript reads after the push; StartWait
	// bounds the wait for the message to show up there.
	Poll, StartWait time.Duration
}

// NewClaude reads the transcript every 250 ms for up to 10 s after the push: an
// idle session takes a channel event at once, so 10 s is ample for that, and a
// session mid-turn takes it only when the turn ends.
func NewClaude(c Channels) *Claude {
	return &Claude{Channels: c, Poll: 250 * time.Millisecond, StartWait: 10 * time.Second}
}

// Send pushes req into the session as a channel event <channel source="ccx"
// kind="message" title="ccx: <sender>: <summary>" msg_id="...">, and acks sent
// once it is written to the channel, then working once the session's transcript
// has it (Claude Code writes a channel event there when a turn takes it in), or
// not-started. An error carries NotTypedKey when nothing was pushed.
func (c *Claude) Send(ctx context.Context, req Request, emit func(*ccxv1.SendResponse) error) error {
	if err := Validate(req); err != nil {
		return markNotTyped(err)
	}
	switch req.Mode {
	case ccxv1.DeliveryMode_DELIVERY_MODE_UNSPECIFIED, ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN:
	default:
		// A channel event waits for the running turn to end (transport.md), so
		// there is no urgent; later (read on the next turn without waking) needs the
		// UserPromptSubmit inbox (#25), not built.
		return markNotTyped(connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("claude code does not take mode %s; it takes after-turn", modeName(req.Mode))))
	}

	id := newMsgID()
	ev := heartbeat.Event{Content: req.Body, Meta: map[string]string{
		"kind":   "message",
		"title":  headerLine(req.Sender, req.Summary),
		"msg_id": id,
	}}
	// The transcript's size before the push: the event is looked for only in what
	// is written after it.
	notConnected := markNotTyped(connect.NewError(connect.CodeNotFound, fmt.Errorf("session %s has no ccx channel connected to this ccx-agent (started without --dangerously-load-development-channels server:ccx, or the heartbeat concern is off)", req.Target)))
	home, ok := c.Channels.Home(req.Target)
	if !ok {
		return notConnected
	}
	file, from := transcriptEnd(home, req.Target)

	pushedHome, err := c.Channels.Push(req.Target, ev)
	if errors.Is(err, heartbeat.ErrNotRegistered) {
		// It went away between the two looks.
		return notConnected
	} else if err != nil {
		// The connection may have taken part of the line before failing.
		return connect.NewError(connect.CodeUnknown, fmt.Errorf("pushing to the ccx channel of %s: %w", req.Target, err))
	}
	if pushedHome != home {
		// The session registered again under another Claude home between the two
		// looks; its transcript is that home's, read from the start.
		home, file = pushedHome, ""
	}
	if err := emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "ccx channel of " + req.Target}); err != nil {
		return err
	}

	for end := time.Now().Add(c.StartWait); ; {
		if file == "" {
			// It appeared after the push, so all of it is new.
			file, _ = transcriptEnd(home, req.Target)
			from = 0
		}
		if file != "" && transcriptHas(file, from, id) {
			return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_WORKING, Detail: "in its transcript"})
		}
		if !time.Now().Before(end) {
			return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_NOT_STARTED, Detail: fmt.Sprintf("not in its transcript within %v; a session in the middle of a turn takes it when the turn ends", c.StartWait)})
		}
		if err := sleep(ctx, c.Poll); err != nil {
			code := connect.CodeCanceled
			if errors.Is(err, context.DeadlineExceeded) {
				code = connect.CodeDeadlineExceeded
			}
			return connect.NewError(code, err)
		}
	}
}

func modeName(m ccxv1.DeliveryMode) string {
	switch m {
	case ccxv1.DeliveryMode_DELIVERY_MODE_LATER:
		return "later"
	case ccxv1.DeliveryMode_DELIVERY_MODE_URGENT:
		return "urgent"
	}
	return m.String()
}

func newMsgID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// transcriptEnd finds the session's transcript and its size now, or "" when it
// has none yet. With several (the session ran from more than one directory), the
// one written last is the one being written.
func transcriptEnd(home, session string) (string, int64) {
	// Listed rather than globbed: a home with [ or * in it would be read as a
	// pattern and match nothing.
	dirs, _ := os.ReadDir(filepath.Join(home, "projects"))
	var file string
	var latest os.FileInfo
	for _, d := range dirs {
		p := filepath.Join(home, "projects", d.Name(), session+".jsonl")
		if st, err := os.Stat(p); err == nil && (latest == nil || st.ModTime().After(latest.ModTime())) {
			file, latest = p, st
		}
	}
	if latest == nil {
		return "", 0
	}
	return file, latest.Size()
}

// transcriptHas says whether the transcript, from byte from on, holds id. The id
// is 16 random hex digits, so finding it anywhere is finding this message.
func transcriptHas(file string, from int64, id string) bool {
	f, err := os.Open(file)
	if err != nil {
		return false
	}
	defer f.Close()
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return false
	}
	b, err := io.ReadAll(f)
	return err == nil && bytes.Contains(b, []byte(id))
}
