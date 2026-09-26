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

// metaKey is packages/core/src/session-state.ts META_KEY (change both): a file
// under meta/ with another name is not a key.
var metaKey = regexp.MustCompile(`^[a-z0-9_][a-z0-9_.-]{0,127}$`)

// Server is the AgentService handler. Heartbeat and Collect are nil when their
// concern is off; the answer then says so instead of failing.
type Server struct {
	Heartbeat  *heartbeat.Concern
	Collect    *collect.Collect
	ClaudeHome string // the agent's own ~/.claude, for a request that names none
	// Remote ignores the request's claude_home. A caller on another host cannot
	// know this host's CLAUDE_CONFIG_DIR, and honouring it would let any token
	// holder point the agent's reads at any directory.
	Remote bool
}

func (s *Server) GetSessionStatus(_ context.Context, req *connect.Request[ccxv1.GetSessionStatusRequest]) (*connect.Response[ccxv1.GetSessionStatusResponse], error) {
	sid := req.Msg.GetSessionId()
	if !sessionID.MatchString(sid) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("session_id %q is not a Claude Code session id", sid))
	}
	asked := req.Msg.GetClaudeHome()
	if s.Remote || !filepath.IsAbs(asked) {
		asked = ""
	}
	home := asked
	if home == "" {
		home = s.ClaudeHome
	}
	var hb heartbeat.Status
	if s.Heartbeat != nil {
		hb = s.Heartbeat.Status(sid, asked)
		if hb.Registered {
			// The channel knows its session's home; the asker may not (curl).
			home = hb.Home
		}
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
		h := out.Heartbeat
		h.Enabled, h.Wanted, h.Registered, h.Sent = hb.Listening, hb.Wanted, hb.Registered, uint32(hb.Sent)
		h.NextAt, h.LastSentAt = ts(hb.Next), ts(hb.LastSent)
	}
	if s.Collect != nil {
		st, err := s.Collect.Status()
		c := out.Collect
		if err != nil {
			// A spool problem is collect's, not the session's: say so here and keep
			// the rest of the answer.
			c.SpoolError = err.Error()
		}
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
	// Bun.file().exists(), which the TS reader uses, is false for a directory.
	if fi, err := os.Stat(filepath.Join(dir, "archived")); err == nil && !fi.IsDir() {
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
		if e.IsDir() || !metaKey.MatchString(e.Name()) {
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
	lock       *os.File
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
	// The request is two short strings.
	handler := func(s *Server) http.Handler {
		path, h := ccxv1connect.NewAgentServiceHandler(s, connect.WithReadMaxBytes(64<<10))
		mux := http.NewServeMux()
		mux.Handle(path, h)
		return mux
	}
	server := func(h http.Handler) *http.Server {
		return &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute}
	}

	ln, err := c.listenUnix()
	if err != nil {
		return err
	}
	defer c.lock.Close()
	defer os.Remove(c.socketPath)
	servers := []*http.Server{server(handler(c.server))}
	listeners := []net.Listener{ln}

	if c.listen != "" {
		if c.token == "" {
			// The TCP side is for other hosts; without a token it would answer anyone
			// on the network. The unix side stays up.
			c.log("api: not listening on %s: no hub token (CCX_HUB_TOKEN or hub-token) to require", c.listen)
		} else if tln, err := net.Listen("tcp", c.listen); err != nil {
			c.log("api: not listening on %s: %v", c.listen, err)
		} else {
			remote := *c.server
			remote.Remote = true
			servers = append(servers, server(RequireBearer(c.token, handler(&remote))))
			listeners = append(listeners, tln)
			c.log("api: listening on %s (bearer required)", tln.Addr())
		}
	}

	// Each listener stands alone: a TCP side that fails must not take the unix
	// side (statusline) down with it. Serve already retries temporary accept
	// errors, so an error here is the listener gone; it is logged, not hidden.
	for i, srv := range servers {
		go func() {
			if err := srv.Serve(listeners[i]); !errors.Is(err, http.ErrServerClosed) {
				c.log("api: %s stopped: %v", listeners[i].Addr(), err)
			}
		}()
	}
	<-ctx.Done()
	for _, srv := range servers {
		_ = srv.Close()
	}
	return nil
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
	// Kept on c and closed when run returns: an *os.File nobody references is
	// closed by its finalizer, which would drop the lock while serve runs.
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("another ccx-agent serve holds %s.lock: %w", c.socketPath, err)
	}
	if err := os.Remove(c.socketPath); err != nil && !os.IsNotExist(err) {
		lock.Close()
		return nil, err
	}
	ln, err := net.Listen("unix", c.socketPath)
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err := os.Chmod(c.socketPath, 0o600); err != nil {
		ln.Close()
		lock.Close()
		return nil, err
	}
	c.lock = lock
	return ln, nil
}

// RequireBearer refuses a request that does not carry the token. The scheme
// is case-insensitive (RFC 9110 11.1); the token is not.
func RequireBearer(token string, next http.Handler) http.Handler {
	want := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scheme, got, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare([]byte(got), want) != 1 {
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
