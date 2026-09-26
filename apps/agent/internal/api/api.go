// Package api answers AgentService (kaneo ccx#34): what the agent knows about a
// session, for statusline on this host and for agents on other hosts.
//
// One handler, two listeners. The unix socket is always on and guarded by its
// 0600 mode; the TCP listener is off unless an address is configured, and then
// demands the hub token. One protocol for both, so a field added is added once.
package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/TakashiAihara/ccx/apps/agent/internal/collect"
	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	"github.com/TakashiAihara/ccx/packages/core/config"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// sessionID is the shape Claude Code gives a session. The id becomes a path.
var sessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// metaKey is packages/core/src/session-state.ts META_KEY: a file under meta/
// with another name is not a key.
var metaKey = regexp.MustCompile(`^[a-z0-9_][a-z0-9_.-]{0,127}$`)

// Server is the AgentService handler. Heartbeat and Collect are nil when their
// concern is off; the answer then says so instead of failing.
type Server struct {
	Heartbeat  *heartbeat.Concern
	Collect    *collect.Collect
	ClaudeHome string // the agent's own ~/.claude, for a request that names none
}

func (s *Server) GetSessionStatus(_ context.Context, req *connect.Request[ccxv1.GetSessionStatusRequest]) (*connect.Response[ccxv1.GetSessionStatusResponse], error) {
	sid := req.Msg.GetSessionId()
	if !sessionID.MatchString(sid) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("session_id %q is not a Claude Code session id", sid))
	}
	home := req.Msg.GetClaudeHome()
	if home == "" || !filepath.IsAbs(home) {
		home = s.ClaudeHome
	}

	declared, hbDeclared, err := ReadDeclared(filepath.Join(home, "sessions", sid))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &ccxv1.GetSessionStatusResponse{
		Declared:  declared,
		Heartbeat: &ccxv1.HeartbeatStatus{Declared: hbDeclared},
		Collect:   &ccxv1.CollectStatus{},
	}
	if s.Heartbeat != nil {
		st := s.Heartbeat.Status(sid, req.Msg.GetClaudeHome())
		h := out.Heartbeat
		h.Enabled, h.Wanted, h.Registered, h.Sent = true, st.Wanted, st.Registered, uint32(st.Sent)
		h.NextAt, h.LastSentAt = ts(st.Next), ts(st.LastSent)
	}
	if s.Collect != nil {
		st, err := s.Collect.Status()
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("spool: %w", err))
		}
		c := out.Collect
		c.Enabled, c.CenterConfigured, c.Pending = true, st.CenterConfigured, uint32(st.Pending)
		c.LastForwardedAt, c.LastErrorAt, c.LastError = ts(st.LastForwarded), ts(st.LastErrorAt), st.LastError
	}
	return connect.NewResponse(out), nil
}

func ts(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}

// ReadDeclared reads a session's declared state the way session-state.ts
// readDeclared does: archived is an empty file, label / task / heartbeat are
// trimmed text, metadata is meta/<key> with one trailing newline removed.
// A meta/ that is there but unreadable is an error, not an empty set.
func ReadDeclared(dir string) (*ccxv1.SessionState, string, error) {
	text := func(name string) string {
		b, _ := os.ReadFile(filepath.Join(dir, name))
		return strings.TrimSpace(string(b))
	}
	st := &ccxv1.SessionState{Label: text("label"), Task: text("task"), Metadata: map[string]string{}}
	if _, err := os.Stat(filepath.Join(dir, "archived")); err == nil {
		st.Archived = true
	}
	hb := text("heartbeat")
	if hb != "on" && hb != "off" {
		hb = ""
	}

	ents, err := os.ReadDir(filepath.Join(dir, "meta"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	for _, e := range ents {
		if !metaKey.MatchString(e.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, "meta", e.Name()))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.EISDIR) {
				continue
			}
			return nil, "", err
		}
		st.Metadata[e.Name()] = strings.TrimSuffix(string(b), "\n")
	}
	return st, hb, nil
}

// Concern serves AgentService on the configured listeners.
type Concern struct {
	server     *Server
	socketPath string
	listen     string
	token      string
	log        func(string, ...any)
}

func New(cfg config.Config, srv *Server, log func(string, ...any)) *Concern {
	return &Concern{server: srv, socketPath: cfg.APISocketPath, listen: cfg.APIListen, token: cfg.HubToken, log: log}
}

func (c *Concern) Name() string { return "api" }

// maxUnixPath: see the heartbeat concern.
const maxUnixPath = 104

// Run never fails the process: a status API that cannot open must not take
// collect down with it. The reason is in the log.
func (c *Concern) Run(ctx context.Context) error {
	if err := c.run(ctx); err != nil {
		c.log("api off: %v", err)
		<-ctx.Done()
	}
	return nil
}

func (c *Concern) run(ctx context.Context) error {
	path, handler := ccxv1connect.NewAgentServiceHandler(c.server)
	mux := http.NewServeMux()
	mux.Handle(path, handler)

	ln, err := c.listenUnix()
	if err != nil {
		return err
	}
	defer os.Remove(c.socketPath)
	servers := []*http.Server{{Handler: mux, ReadHeaderTimeout: 5 * time.Second}}
	listeners := []net.Listener{ln}

	if c.listen != "" {
		if c.token == "" {
			// The TCP side is for other hosts; without a token it would answer anyone
			// on the network. The unix side stays up.
			c.log("api: not listening on %s: no hub token (CCX_HUB_TOKEN or hub-token) to require", c.listen)
		} else if tln, err := net.Listen("tcp", c.listen); err != nil {
			c.log("api: not listening on %s: %v", c.listen, err)
		} else {
			servers = append(servers, &http.Server{Handler: RequireBearer(c.token, mux), ReadHeaderTimeout: 5 * time.Second})
			listeners = append(listeners, tln)
			c.log("api: listening on %s (bearer required)", tln.Addr())
		}
	}

	errs := make(chan error, len(servers))
	for i, srv := range servers {
		go func() { errs <- srv.Serve(listeners[i]) }()
	}
	select {
	case <-ctx.Done():
	case err = <-errs:
	}
	for _, srv := range servers {
		_ = srv.Close()
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// listenUnix binds the socket under a lock, as the heartbeat concern does: a
// second serve must not remove the socket the running one listens on.
func (c *Concern) listenUnix() (net.Listener, error) {
	if len(c.socketPath) >= maxUnixPath {
		return nil, fmt.Errorf("api socket path is %d bytes, over the %d-byte unix-socket limit: %s\nset CCX_API_SOCKET to a shorter path",
			len(c.socketPath), maxUnixPath, c.socketPath)
	}
	if err := os.MkdirAll(filepath.Dir(c.socketPath), 0o700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(c.socketPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	// Held for the life of the process: the fd is never closed, so the lock is
	// released when serve exits.
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("another ccx-agent serve holds %s.lock: %w", c.socketPath, err)
	}
	if err := os.Remove(c.socketPath); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	ln, err := net.Listen("unix", c.socketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(c.socketPath, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// RequireBearer refuses a request that does not carry the token.
func RequireBearer(token string, next http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// UnixClient is an AgentService client over the unix socket.
func UnixClient(socketPath string) ccxv1connect.AgentServiceClient {
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
	}}
	// The host is not used; the dialer ignores it.
	return ccxv1connect.NewAgentServiceClient(hc, "http://ccx-agent")
}
