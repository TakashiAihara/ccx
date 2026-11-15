package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// Devin's hooks reach ccx-agent through `ccx-agent devin-hook` (DevinHook). They
// give what the screen cannot: the question Devin asks (PreToolUse of
// ask_user_question, with its options), the end of its turn (Stop, with its last
// answer), and a point to put a later message into a turn (UserPromptSubmit's
// additionalContext). Payloads measured on devin 3000.12.57 (#302).

// hookEvent is the part of a Devin hook payload ccx-agent reads.
type hookEvent struct {
	Name        string `json:"hook_event_name"`
	Session     string `json:"session_id"`
	PromptID    string `json:"prompt_id"`
	Prompt      string `json:"prompt"`
	ToolName    string `json:"tool_name"`
	LastMessage string `json:"last_assistant_message"`
	ToolInput   struct {
		Questions []struct {
			Question string `json:"question"`
			Header   string `json:"header"`
			Options  []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	} `json:"tool_input"`

	// taken are the later messages this UserPromptSubmit put into the turn.
	taken []*queued
	// owner is the typed send this UserPromptSubmit is the turn of, if any.
	owner *typedSend
}

const askTool = "ask_user_question"

// Wanted says whether a hook event is one ccx-agent reads, so the hook can skip
// the call for every other tool use.
func Wanted(payload []byte) bool {
	var e hookEvent
	if json.Unmarshal(payload, &e) != nil {
		return false
	}
	switch e.Name {
	case "UserPromptSubmit", "Stop":
		return true
	case "PreToolUse":
		return e.ToolName == askTool
	}
	return false
}

// typedSend is a typed send waiting for its turn: the next UserPromptSubmit whose
// prompt is its text goes to the first such send in typing order, so two sends
// of the same text each get one turn and in order.
type typedSend struct {
	text string
}

// queued is a later message waiting for its receiver's next turn. Watchers find
// theirs in hookEvent.taken by pointer.
type queued struct {
	text string
}

// MaxQueued bounds the later messages one session holds, so a receiver that never
// takes a turn does not grow ccx-agent without end.
const MaxQueued = 32

// hooks fans hook events out to the sends waiting on them and keeps the later
// messages. Both live in memory: a restart of ccx-agent drops them.
type hooks struct {
	mu    sync.Mutex
	subs  map[string]map[chan hookEvent]struct{}
	inbox map[string][]*queued
	typed map[string][]*typedSend
}

func (d *Devin) hooks() *hooks {
	d.hooksOnce.Do(func() {
		d.h = &hooks{subs: map[string]map[chan hookEvent]struct{}{}, inbox: map[string][]*queued{}, typed: map[string][]*typedSend{}}
	})
	return d.h
}

// subscribe returns the events of one session from now on. The channel is
// buffered; a waiter that falls behind loses events rather than block a hook.
func (h *hooks) subscribe(session string) (<-chan hookEvent, func()) {
	ch := make(chan hookEvent, 64)
	h.mu.Lock()
	if h.subs[session] == nil {
		h.subs[session] = map[chan hookEvent]struct{}{}
	}
	h.subs[session][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs[session], ch)
		if len(h.subs[session]) == 0 {
			delete(h.subs, session)
		}
		h.mu.Unlock()
	}
}

func (h *hooks) publish(e hookEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[e.Session] {
		select {
		case ch <- e:
		default:
		}
	}
}

func (h *hooks) queue(session, text string) (*queued, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.inbox[session]) >= MaxQueued {
		return nil, fmt.Errorf("%s already holds %d later messages that no turn has taken", session, MaxQueued)
	}
	q := &queued{text: text}
	h.inbox[session] = append(h.inbox[session], q)
	return q, nil
}

// expect registers a typed send about to type text; call it under the typing
// lock, so the order is the typing order. The returned func drops it if no turn
// took it.
func (h *hooks) expect(session, text string) (*typedSend, func()) {
	ts := &typedSend{text: text}
	h.mu.Lock()
	h.typed[session] = append(h.typed[session], ts)
	h.mu.Unlock()
	return ts, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if i := slices.Index(h.typed[session], ts); i >= 0 {
			h.typed[session] = slices.Delete(h.typed[session], i, i+1)
		}
		if len(h.typed[session]) == 0 {
			delete(h.typed, session)
		}
	}
}

// owner hands a UserPromptSubmit to the first typed send waiting for its prompt.
func (h *hooks) owner(session, prompt string) *typedSend {
	h.mu.Lock()
	defer h.mu.Unlock()
	ts := h.typed[session]
	i := slices.IndexFunc(ts, func(t *typedSend) bool { return t.text == prompt })
	if i < 0 {
		return nil
	}
	o := ts[i]
	h.typed[session] = slices.Delete(ts, i, i+1)
	return o
}

func (h *hooks) take(session string) []*queued {
	h.mu.Lock()
	defer h.mu.Unlock()
	qs := h.inbox[session]
	delete(h.inbox, session)
	return qs
}

// Hook reads one hook payload and returns what the hook prints for Devin: on
// UserPromptSubmit, the later messages for that session as additionalContext.
func (d *Devin) Hook(payload []byte) (string, error) {
	var e hookEvent
	if err := json.Unmarshal(payload, &e); err != nil {
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("devin hook payload: %w", err))
	}
	if e.Name == "" || e.Session == "" {
		return "", connect.NewError(connect.CodeInvalidArgument, errors.New("devin hook payload without hook_event_name or session_id"))
	}
	h := d.hooks()
	out := ""
	if e.Name == "UserPromptSubmit" {
		e.owner = h.owner(e.Session, e.Prompt)
		e.taken = h.take(e.Session)
		if len(e.taken) > 0 {
			texts := make([]string, len(e.taken))
			for i, q := range e.taken {
				texts[i] = q.text
			}
			b, err := json.Marshal(map[string]any{"hookSpecificOutput": map[string]string{
				"hookEventName":     "UserPromptSubmit",
				"additionalContext": strings.Join(texts, "\n\n"),
			}})
			if err != nil {
				return "", connect.NewError(connect.CodeInternal, err)
			}
			out = string(b)
		}
	}
	h.publish(e)
	return out, nil
}

// MaxText bounds the last answer a DONE ack carries.
const MaxText = 64 << 10

// MaxQuestionAcks bounds the QUESTION acks of one send, so all its acks stay
// within what the center keeps for a relayed message (16).
const MaxQuestionAcks = 8

// watch follows the receiver's hooks after the message is in: the event mine
// matches is the turn taking it (onMatch reports that), then a question in that
// turn (same prompt_id) is QUESTION and its Stop is DONE. Running out of wait, or
// the sender leaving, ends it quietly: the message is in either way.
func watch(ctx context.Context, events <-chan hookEvent, wait time.Duration, mine func(hookEvent) bool, onMatch func(hookEvent) error, emit func(*ccxv1.SendResponse) error) error {
	t := time.NewTimer(wait)
	defer t.Stop()
	matched, turn, asked := false, "", 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			return nil
		case e := <-events:
			if !matched {
				if mine(e) {
					matched, turn = true, e.PromptID
					if onMatch != nil {
						if err := onMatch(e); err != nil {
							return err
						}
					}
				}
				continue
			}
			if e.PromptID != turn {
				continue
			}
			switch {
			case e.Name == "PreToolUse" && e.ToolName == askTool && asked < MaxQuestionAcks:
				asked++
				if err := emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_QUESTION, Questions: questions(e), Detail: "prompt " + e.PromptID}); err != nil {
					return err
				}
			case e.Name == "Stop":
				text := clean(e.LastMessage)
				if len(text) > MaxText {
					text = strings.ToValidUTF8(text[:MaxText], "")
				}
				return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_DONE, Text: text, Detail: "prompt " + e.PromptID})
			}
		}
	}
}

// What one QUESTION ack keeps, the same as the center keeps for a relayed one
// (counts and the last 4096 bytes of a field), so a local sender and a relayed
// one see the same question.
const (
	MaxQuestions     = 8
	MaxOptions       = 16
	MaxQuestionBytes = 4096
)

func questions(e hookEvent) []*ccxv1.Question {
	var qs []*ccxv1.Question
	for _, q := range e.ToolInput.Questions[:min(len(e.ToolInput.Questions), MaxQuestions)] {
		out := &ccxv1.Question{Question: short(q.Question), Header: short(q.Header)}
		for _, o := range q.Options[:min(len(q.Options), MaxOptions)] {
			out.Options = append(out.Options, &ccxv1.Question_Option{Label: short(o.Label), Description: short(o.Description)})
		}
		qs = append(qs, out)
	}
	return qs
}

// clean drops what refusedInBody refuses in a body: the receiver's words reach
// the sender's terminal, and escapes there could rewrite what it shows.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if refusedInBody(r) {
			return -1
		}
		return r
	}, s)
}

// short keeps the last MaxQuestionBytes, as the center does (capDetail).
func short(s string) string {
	s = clean(s)
	if len(s) > MaxQuestionBytes {
		s = strings.ToValidUTF8(s[len(s)-MaxQuestionBytes:], "")
	}
	return s
}

// sendLater keeps req for the receiver's next turn. It types nothing, so it needs
// no lock: the turn takes it through UserPromptSubmit (Hook).
func (d *Devin) sendLater(ctx context.Context, req Request, wait time.Duration, emit func(*ccxv1.SendResponse) error, typed *bool) error {
	if _, err := d.find(ctx, req.Target); err != nil {
		return err
	}
	h := d.hooks()
	var events <-chan hookEvent
	if wait > 0 {
		// Subscribe before queueing, so the turn taking it is not missed. Without a
		// wait there is no subscription and the stream ends at queued, even when a
		// turn takes it before this returns (watch then has nothing to read).
		var cancel func()
		events, cancel = h.subscribe(req.Target)
		defer cancel()
	}
	q, err := h.queue(req.Target, headerLine(req.Sender, req.Summary)+"\n"+req.Body)
	if err != nil {
		return connect.NewError(connect.CodeResourceExhausted, err)
	}
	// Queued is the point of no return, as typing is for a typed send.
	*typed = true
	err = emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_QUEUED, Detail: "read on " + req.Target + "'s next turn (Devin's UserPromptSubmit hook runs ccx-agent devin-hook)"})
	afterTyping(ctx)
	if err != nil {
		return err
	}

	mine := func(e hookEvent) bool { return e.Name == "UserPromptSubmit" && slices.Contains(e.taken, q) }
	sent := func(e hookEvent) error {
		return emit(&ccxv1.SendResponse{State: ccxv1.SendResponse_STATE_SENT, Detail: "taken by prompt " + e.PromptID})
	}
	return watch(ctx, events, wait, mine, sent, emit)
}

// MaxWait bounds wait_seconds (Validate refuses more).
const MaxWait = time.Hour

func waitOf(req Request) time.Duration {
	return time.Duration(req.WaitSeconds) * time.Second
}

type afterTypingKey struct{}

// WithAfterTyping gives a send a function to call once its typing part is over
// (typed, queued or refused), before it waits for question / done. The relay
// starts the next claimed message then, keeping the typing order.
func WithAfterTyping(ctx context.Context, f func()) context.Context {
	return context.WithValue(ctx, afterTypingKey{}, f)
}

func afterTyping(ctx context.Context) {
	if f, ok := ctx.Value(afterTypingKey{}).(func()); ok {
		f()
	}
}
