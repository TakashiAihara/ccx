package channel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/message"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// sendTimeout bounds one send_message call, as `ccx msg send --timeout` does.
// A variable so a test can shorten it.
var sendTimeout = 60 * time.Second

var modes = map[string]ccxv1.DeliveryMode{
	"later":      ccxv1.DeliveryMode_DELIVERY_MODE_LATER,
	"after-turn": ccxv1.DeliveryMode_DELIVERY_MODE_AFTER_TURN,
	"urgent":     ccxv1.DeliveryMode_DELIVERY_MODE_URGENT,
}

var states = map[ccxv1.SendResponse_State]string{
	ccxv1.SendResponse_STATE_SENT:        "sent",
	ccxv1.SendResponse_STATE_WORKING:     "working",
	ccxv1.SendResponse_STATE_NOT_STARTED: "not-started",
	ccxv1.SendResponse_STATE_QUEUED:      "queued",
}

type sendArgs struct {
	Target  string `json:"target"`
	Body    string `json:"body"`
	Summary string `json:"summary"`
	Mode    string `json:"mode"`
	Machine string `json:"machine"`
	User    string `json:"user"`
}

// SendTool is the send_message tool: the same send as `ccx msg send`, through
// this machine's ccx-agent (MessageService on its API socket). The sender name is
// the whole session id, as the CLI names a Claude Code sender, so the receiver can
// answer to it. Sends go one at a time and the 60 s starts when a send's turn
// comes: Claude Code calls tools in parallel, and a send that had spent part of
// its time waiting behind others would have less left for its own delivery,
// running out mid-send and ending as "may have been sent".
func SendTool(sessionID string, client ccxv1connect.MessageServiceClient) Tool {
	var mu sync.Mutex
	return Tool{
		Name: "send_message",
		Description: "Send a message to another running session through ccx: a Devin session by its name, or a Claude Code session by its id, " +
			"on this machine or (with machine) another. The receiver sees this session's id as the sender and can answer to it. " +
			"Returns each ack (sent, then working or not-started; queued for later). " +
			"\"not sent\" means nothing reached the receiver; \"may have been sent\" means look before sending again.",
		Schema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"target":  map[string]any{"type": "string", "description": "the receiver: a Devin session name as herdr shows it, or a Claude Code session id"},
				"body":    map[string]any{"type": "string", "description": "the message"},
				"summary": map[string]any{"type": "string", "description": "one line the receiver sees as `ccx: <sender>: <summary>` (at most 80 bytes)"},
				"mode":    map[string]any{"type": "string", "enum": []string{"later", "after-turn", "urgent"}, "description": "how it is read (default after-turn)"},
				"machine": map[string]any{"type": "string", "description": "the machine whose ccx-agent delivers it, through the center (default: this one)"},
				"user":    map[string]any{"type": "string", "description": "the OS user whose ccx-agent delivers it (default: this agent's)"},
			},
			"required": []string{"target", "body", "summary"},
		},
		Call: func(ctx context.Context, raw json.RawMessage) (string, bool) {
			var a sendArgs
			if err := json.Unmarshal(raw, &a); err != nil {
				return "not sent: arguments: " + err.Error(), true
			}
			if a.Mode == "" {
				a.Mode = "after-turn"
			}
			mode, ok := modes[a.Mode]
			if !ok {
				return "not sent: mode must be one of later, after-turn, urgent", true
			}
			if a.Target == sessionID {
				return "not sent: that is this session", true
			}
			mu.Lock()
			defer mu.Unlock()
			ctx, cancel := context.WithTimeout(ctx, sendTimeout)
			defer cancel()
			stream, err := client.Send(ctx, connect.NewRequest(&ccxv1.SendRequest{
				Target: a.Target, Body: a.Body, Summary: a.Summary, Mode: mode, Machine: a.Machine, User: a.User,
				Sender: sessionID,
			}))
			if err != nil {
				return failure(err, nil), true
			}
			var lines []string
			for stream.Receive() {
				r := stream.Msg()
				line := states[r.GetState()]
				if line == "" {
					line = r.GetState().String()
				}
				if r.GetDetail() != "" {
					line += "  " + r.GetDetail()
				}
				lines = append(lines, line)
			}
			if err := stream.Err(); err != nil {
				return failure(err, lines), true
			}
			return strings.Join(lines, "\n"), false
		},
	}
}

// failure words an error as the CLI does (apps/cli/src/msg.ts failurePrefix):
// "not sent" only when ccx-agent says nothing was typed or was never reached.
func failure(err error, lines []string) string {
	prefix := "may have been sent (look at the receiver before sending again)"
	ce := new(connect.Error)
	switch {
	case len(lines) > 0:
		// A later message is queued, not sent, until a turn takes it (sent).
		state := "sent"
		if strings.HasPrefix(lines[0], "queued") && !slices.ContainsFunc(lines, func(l string) bool { return strings.HasPrefix(l, "sent") }) {
			state = "queued"
		}
		prefix = strings.Join(lines, "\n") + "\n" + state + ", then lost the ack stream"
	case errors.As(err, &ce) && ce.Meta().Get(message.NotTypedKey) != "":
		prefix = "not sent"
	case connect.CodeOf(err) == connect.CodeUnimplemented, connect.CodeOf(err) == connect.CodeResourceExhausted, unreachable(err):
		prefix = "not sent"
	}
	msg := err.Error()
	if errors.As(err, &ce) {
		msg = ce.Message()
	}
	return fmt.Sprintf("%s: %s", prefix, msg)
}

// unreachable is a socket that was never connected to, so ccx-agent did nothing.
func unreachable(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}

// UnixMessageClient is a MessageService client over ccx-agent's API socket.
// socketPath is called on every dial, as Relay does, so a session that started
// while a systemd agent was restarting reaches it under /run/user once it is up.
func UnixMessageClient(socketPath func() string) ccxv1connect.MessageServiceClient {
	h := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath())
		},
	}}
	// The host is not used; the dialer ignores it.
	return ccxv1connect.NewMessageServiceClient(h, "http://ccx-agent")
}
