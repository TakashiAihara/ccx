// Package channel is the per-session half of ccx-agent: the MCP channel server
// that Claude Code spawns over stdio (ADR 0002, "the one process boundary that is
// imposed"). Today it carries one thing, the prompt-cache heartbeat
// (docs/design/heartbeat.md). Broker messages (#23) arrive through the same push.
package channel

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// Instructions are what the session reads about this server. The heartbeat is
// only worth anything if the turn it wakes is short, and nothing but the
// session itself can keep it short.
const Instructions = `ccx keeps this session's prompt cache warm while it sits idle. ` +
	`An event <channel kind="heartbeat"> is not a message from anyone and asks for nothing. ` +
	`Answer it with a single "." and end the turn: call no tools, do not resume earlier work, do not mention it. ` +
	`Anything that arrives together with it (a person's message, another channel event) is handled as usual.`

// Server is a minimal MCP server over newline-delimited JSON-RPC on stdio.
//
// Hand-written rather than an SDK: a channel needs the initialize answer, ping,
// and one notification, and transport.md measured that this minimum registers.
type Server struct {
	name, version string

	mu    sync.Mutex
	out   *json.Encoder
	ready chan struct{}
	once  sync.Once
}

// NewServer writes to w. Push may be called from any goroutine.
func NewServer(name, version string, w io.Writer) *Server {
	return &Server{name: name, version: version, out: json.NewEncoder(w), ready: make(chan struct{})}
}

// Ready closes when the client has finished initializing. A notification sent
// before that is outside the MCP lifecycle and may be dropped without a word.
func (s *Server) Ready() <-chan struct{} { return s.ready }

type request struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Serve answers requests from r until it closes. Claude Code ends a session by
// closing stdin, so returning is how the process knows to exit.
func (s *Server) Serve(r io.Reader) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var req request
		if json.Unmarshal(sc.Bytes(), &req) != nil || len(req.ID) == 0 {
			// Notifications need no answer, and a line that is not JSON has no id
			// to answer to.
			if req.Method == "notifications/initialized" {
				s.once.Do(func() { close(s.ready) })
			}
			continue
		}
		switch req.Method {
		case "initialize":
			var p struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &p)
			s.reply(req.ID, map[string]any{
				// Echo the client's revision: a channel is one-way and uses nothing
				// that differs between revisions.
				"protocolVersion": p.ProtocolVersion,
				"capabilities":    map[string]any{"experimental": map[string]any{"claude/channel": map[string]any{}}},
				"serverInfo":      map[string]any{"name": s.name, "version": s.version},
				"instructions":    Instructions,
			})
		case "ping":
			s.reply(req.ID, map[string]any{})
		default:
			s.write(map[string]any{"jsonrpc": "2.0", "id": req.ID,
				"error": map[string]any{"code": -32601, "message": "method not found: " + req.Method}})
		}
	}
	return sc.Err()
}

// Push sends one channel event. Keys in meta must be letters, digits and
// underscores: Claude Code drops any other key without a word.
func (s *Server) Push(content string, meta map[string]string) error {
	return s.write(map[string]any{"jsonrpc": "2.0", "method": "notifications/claude/channel",
		"params": map[string]any{"content": content, "meta": meta}})
}

func (s *Server) reply(id json.RawMessage, result any) {
	_ = s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (s *Server) write(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.out.Encode(v)
}
