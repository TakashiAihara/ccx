package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/collect"
	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	"github.com/TakashiAihara/ccx/packages/core/config"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

const sid = "00000000-0000-4000-8000-000000000001"

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The same files session-state.ts writes read back the same way.
func TestReadDeclared(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions", sid)
	write(t, filepath.Join(dir, "archived"), "")
	write(t, filepath.Join(dir, "label"), " fix ci \n")
	write(t, filepath.Join(dir, "task"), "ccx#34\n")
	write(t, filepath.Join(dir, "heartbeat"), "on\n")
	write(t, filepath.Join(dir, "meta", "done"), "")
	write(t, filepath.Join(dir, "meta", "note"), " two lines\nkept \n")
	write(t, filepath.Join(dir, "meta", "Upper"), "not a key")
	if err := os.MkdirAll(filepath.Join(dir, "meta", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	st, hb, err := ReadDeclared(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A directory named archived is not the flag (Bun.file().exists() is false for it).
	other := t.TempDir()
	if err := os.MkdirAll(filepath.Join(other, "archived"), 0o755); err != nil {
		t.Fatal(err)
	}
	if o, _, _ := ReadDeclared(other); o.Archived {
		t.Error("a directory named archived read as archived")
	}
	if !st.Archived || st.Label != "fix ci" || st.Task != "ccx#34" || hb != "on" {
		t.Errorf("got archived=%v label=%q task=%q heartbeat=%q", st.Archived, st.Label, st.Task, hb)
	}
	want := map[string]string{"done": "", "note": " two lines\nkept "}
	if len(st.Metadata) != len(want) {
		t.Errorf("metadata = %q, want %q", st.Metadata, want)
	}
	for k, v := range want {
		if got, ok := st.Metadata[k]; !ok || got != v {
			t.Errorf("metadata[%q] = %q (present %v), want %q", k, got, ok, v)
		}
	}

	write(t, filepath.Join(dir, "heartbeat"), "maybe\n")
	if _, hb, _ := ReadDeclared(dir); hb != "" {
		t.Errorf("an unknown heartbeat value read as %q, want empty", hb)
	}
}

// A session nobody declared anything for is empty, not an error.
func TestReadDeclaredMissing(t *testing.T) {
	st, hb, err := ReadDeclared(filepath.Join(t.TempDir(), "nope"))
	if err != nil || st.Archived || st.Label != "" || hb != "" || len(st.Metadata) != 0 {
		t.Errorf("got %v %q %v", st, hb, err)
	}
}

// meta/ that exists but cannot be listed must not read as "no metadata".
func TestReadDeclaredUnreadableMeta(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "meta"), "a file where a directory belongs")
	if _, _, err := ReadDeclared(dir); err == nil {
		t.Error("want an error")
	}
}

func TestRequireBearerEmptyTokenOpensNothing(t *testing.T) {
	h := RequireBearer("", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	for _, header := range []string{"", "Bearer", "Bearer "} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", nil)
		req.Header.Set("Authorization", header)
		h.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Errorf("empty token, Authorization %q: got %d", header, rec.Code)
		}
	}
}

func TestRequireBearer(t *testing.T) {
	h := RequireBearer("s3cret", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	for _, c := range []struct {
		header string
		want   int
	}{{"", 401}, {"Bearer wrong", 401}, {"s3cret", 401}, {"Basic s3cret", 401}, {"Bearer s3cret", 200}, {"bearer s3cret", 200}, {"Bearer  s3cret", 200}, {"Bearer s3cretx", 401}} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", nil)
		if c.header != "" {
			req.Header.Set("Authorization", c.header)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("Authorization %q: got %d, want %d", c.header, rec.Code, c.want)
		}
	}
}

func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "ccx-api")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func waitDial(t *testing.T, network, addr string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if c, err := net.Dial(network, addr); err == nil {
			c.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s %s never came up", network, addr)
}

// End to end over the unix socket, with the real concerns behind it: the
// channel registration, the heartbeat's schedule, the spool's backlog, and the
// declared state all come back in one answer.
func TestGetSessionStatusOverUnixSocket(t *testing.T) {
	work := shortDir(t)
	home := filepath.Join(work, "claude")
	now := time.Now().UTC()
	write(t, filepath.Join(home, "projects", "-cwd", sid+".jsonl"),
		`{"type":"user","timestamp":"`+now.Add(-2*time.Minute).Format(time.RFC3339Nano)+`","message":{"content":"hi"}}`+"\n"+
			`{"type":"assistant","timestamp":"`+now.Add(-time.Minute).Format(time.RFC3339Nano)+`","message":{"content":[]}}`+"\n")
	write(t, filepath.Join(home, "sessions", sid, "label"), "lbl\n")
	write(t, filepath.Join(home, "sessions", sid, "heartbeat"), "on\n")

	cfg := config.Config{
		SpoolDir:          filepath.Join(work, "spool"),
		SocketPath:        filepath.Join(work, "h.sock"),
		ChannelSocketPath: filepath.Join(work, "c.sock"),
		APISocketPath:     filepath.Join(work, "a.sock"),
		Heartbeat:         config.Heartbeat{Interval: 50 * time.Minute},
	}
	col, err := collect.New(cfg, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	hb := heartbeat.New(cfg, t.Logf)
	srv := &Server{Heartbeat: hb, Collect: col, ClaudeHome: filepath.Join(work, "elsewhere")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, c := range []interface{ Run(context.Context) error }{col, hb, New(cfg, srv, t.Logf)} {
		go func() { _ = c.Run(ctx) }()
	}
	waitDial(t, "unix", cfg.APISocketPath)
	waitDial(t, "unix", cfg.ChannelSocketPath) // heartbeat reports enabled once its socket is up
	if fi, err := os.Stat(cfg.APISocketPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("api socket mode: %v %v", fi, err)
	}

	client := UnixClient(cfg.APISocketPath)
	ask := func() *ccxv1.GetSessionStatusResponse {
		t.Helper()
		res, err := client.GetSessionStatus(context.Background(), connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid, ClaudeHome: home}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg
	}

	// Before the channel connects: declared, wanted, but no way to beat it.
	// Polled: the socket can accept a dial a moment before the concern marks
	// itself listening.
	got := ask()
	for i := 0; i < 100 && !got.Heartbeat.GetListening(); i++ {
		time.Sleep(10 * time.Millisecond)
		got = ask()
	}
	if got.Declared.GetLabel() != "lbl" || got.Heartbeat.GetDeclared() != "on" || !got.Heartbeat.GetEnabled() || !got.Heartbeat.GetListening() ||
		!got.Heartbeat.GetWanted() || got.Heartbeat.GetRegistered() || got.Heartbeat.GetNextAt() != nil {
		t.Errorf("before register: %v", got)
	}
	if !got.Collect.GetEnabled() || got.Collect.GetCenterConfigured() || got.Collect.GetPending() != 0 {
		t.Errorf("collect: %v", got.Collect)
	}

	// A channel registers (with no CLAUDE_CONFIG_DIR of its own the agent would
	// look in the wrong home; the registration carries it).
	waitDial(t, "unix", cfg.ChannelSocketPath)
	conn, err := net.Dial("unix", cfg.ChannelSocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = json.NewEncoder(conn).Encode(heartbeat.Register{Session: sid, ClaudeHome: home})

	var next time.Time
	for i := 0; i < 100 && next.IsZero(); i++ {
		time.Sleep(20 * time.Millisecond)
		if n := ask().Heartbeat.GetNextAt(); n != nil {
			next = n.AsTime()
		}
	}
	// Due 50m after the last request. The fixture has no parentUuid chain, so
	// the request is dated from the reply (heartbeat's own tests cover the chain).
	if want := now.Add(49 * time.Minute); next.Sub(want).Abs() > time.Millisecond {
		t.Errorf("next_at = %v, want %v", next, want)
	}
	if !ask().Heartbeat.GetRegistered() {
		t.Error("registered = false after the channel connected")
	}
	// Asked without a home (curl), a registered session is read from the home
	// its channel registered, not the agent's own.
	res, err := client.GetSessionStatus(context.Background(), connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid}))
	if err != nil || res.Msg.Declared.GetLabel() != "lbl" || res.Msg.Heartbeat.GetDeclared() != "on" {
		t.Errorf("no home given: %v %v", res, err)
	}

	// The spool's backlog: a hook event with no center stays.
	if code := collect.Hook(cfg.SocketPath, cfg.SpoolDir, strings.NewReader(`{"x":1}`)); code != 0 {
		t.Fatalf("hook exit %d", code)
	}
	if p := ask().Collect.GetPending(); p != 1 {
		t.Errorf("pending = %d, want 1", p)
	}

	// The channel goes away: the session is no longer registered.
	conn.Close()
	for i := 0; i < 100 && ask().Heartbeat.GetRegistered(); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if ask().Heartbeat.GetRegistered() {
		t.Error("still registered after the channel closed")
	}

	_, err = client.GetSessionStatus(context.Background(), connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: "../../etc"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("bad session id: %v", err)
	}
}

// With concerns off, the answer says so instead of failing.
func TestGetSessionStatusConcernsOff(t *testing.T) {
	res, err := (&Server{ClaudeHome: t.TempDir()}).GetSessionStatus(context.Background(),
		connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.Heartbeat.GetEnabled() || res.Msg.Collect.GetEnabled() {
		t.Errorf("%v", res.Msg)
	}
}

// A heartbeat concern that is configured but not listening (its socket could
// not open) is enabled and not listening; what the session wants still shows.
func TestHeartbeatNotListening(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, "sessions", sid, "heartbeat"), "on\n")
	hb := heartbeat.New(config.Config{Heartbeat: config.Heartbeat{Interval: 50 * time.Minute}}, t.Logf)
	res, err := (&Server{Heartbeat: hb, ClaudeHome: home}).GetSessionStatus(context.Background(),
		connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid, ClaudeHome: home}))
	if err != nil || !res.Msg.Heartbeat.GetEnabled() || res.Msg.Heartbeat.GetListening() || !res.Msg.Heartbeat.GetWanted() {
		t.Errorf("got %v %v, want enabled, not listening, wanted", res, err)
	}
}

// Which home is read: the asked one on the unix side, the agent's own for a
// relative one, and always the agent's own for a remote caller.
func TestClaudeHomeChoice(t *testing.T) {
	own, asked := t.TempDir(), t.TempDir()
	write(t, filepath.Join(own, "sessions", sid, "label"), "own")
	write(t, filepath.Join(asked, "sessions", sid, "label"), "asked")
	for _, c := range []struct {
		remote bool
		home   string
		want   string
	}{{false, asked, "asked"}, {false, "relative/dir", "own"}, {false, "", "own"}, {true, asked, "own"}} {
		res, err := (&Server{ClaudeHome: own, Remote: c.remote}).GetSessionStatus(context.Background(),
			connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid, ClaudeHome: c.home}))
		if err != nil || res.Msg.Declared.GetLabel() != c.want {
			t.Errorf("remote=%v home=%q: label %q (%v), want %q", c.remote, c.home, res.Msg.GetDeclared().GetLabel(), err, c.want)
		}
	}
}

// A spool that cannot be read is reported in collect, not as a failed call.
func TestSpoolErrorKeepsTheAnswer(t *testing.T) {
	work := shortDir(t)
	cfg := config.Config{SpoolDir: filepath.Join(work, "spool")}
	col, err := collect.New(cfg, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	write(t, filepath.Join(home, "sessions", sid, "label"), "kept")
	if err := os.RemoveAll(cfg.SpoolDir); err != nil {
		t.Fatal(err)
	}
	res, err := (&Server{Collect: col, ClaudeHome: home}).GetSessionStatus(context.Background(),
		connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid}))
	if err != nil || res.Msg.Declared.GetLabel() != "kept" || res.Msg.Collect.GetSpoolError() == "" {
		t.Errorf("got %v %v, want the label and a spool_error", res, err)
	}
}

// The lock outlives garbage collection: a second serve must not take the
// socket from under the running one.
func TestSecondServeRefusedAfterGC(t *testing.T) {
	cfg := config.Config{APISocketPath: filepath.Join(shortDir(t), "a.sock")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = New(cfg, &Server{}, t.Logf).Run(ctx) }()
	waitDial(t, "unix", cfg.APISocketPath)
	for i := 0; i < 3; i++ {
		runtime.GC()
	}
	sctx, scancel := context.WithTimeout(context.Background(), time.Second)
	defer scancel()
	if err := New(cfg, &Server{}, t.Logf).run(sctx); err == nil || !strings.Contains(err.Error(), "holds") {
		t.Errorf("second serve: %v, want refused by the lock", err)
	}
}

// An API that could not open tries again, rather than staying dead while
// serve looks healthy: once the other serve lets go, this one comes up.
func TestRunRetriesUntilItOpens(t *testing.T) {
	cfg := config.Config{APISocketPath: filepath.Join(shortDir(t), "a.sock")}
	first, stopFirst := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = New(cfg, &Server{}, t.Logf).Run(first); close(done) }()
	waitDial(t, "unix", cfg.APISocketPath)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	second := New(cfg, &Server{ClaudeHome: t.TempDir()}, t.Logf)
	second.retryAfter = 20 * time.Millisecond
	go func() { _ = second.Run(ctx) }()
	time.Sleep(100 * time.Millisecond) // refused by the lock at least once
	stopFirst()
	<-done

	var err error
	for i := 0; i < 100; i++ {
		if _, err = UnixClient(cfg.APISocketPath).GetSessionStatus(context.Background(),
			connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid})); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("the second serve never took over: %v", err)
}

// The TCP side answers only with the token, and does not open without one.
func TestTCPListener(t *testing.T) {
	free := func() string {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		return ln.Addr().String()
	}

	work := shortDir(t)
	addr := free()
	cfg := config.Config{APISocketPath: filepath.Join(work, "a.sock"), APIListen: addr, HubToken: "tok"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = New(cfg, &Server{ClaudeHome: work}, t.Logf).Run(ctx) }()
	waitDial(t, "tcp", addr)

	req := func(opts ...connect.ClientOption) error {
		c := ccxv1connect.NewAgentServiceClient(http.DefaultClient, "http://"+addr, opts...)
		_, err := c.GetSessionStatus(context.Background(), connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid}))
		return err
	}
	if err := req(); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Errorf("no token: %v", err)
	}
	withToken := connect.WithInterceptors(connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set("Authorization", "Bearer tok")
			return next(ctx, r)
		}
	}))
	if err := req(withToken); err != nil {
		t.Errorf("with token: %v", err)
	}
	// The TCP side ignores claude_home (TestClaudeHomeChoice covers the reads).
	write(t, filepath.Join(work, "evil", "sessions", sid, "label"), "evil")
	c := ccxv1connect.NewAgentServiceClient(http.DefaultClient, "http://"+addr, withToken)
	res, err := c.GetSessionStatus(context.Background(), connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid, ClaudeHome: filepath.Join(work, "evil")}))
	if err != nil || res.Msg.Declared.GetLabel() != "" {
		t.Errorf("claude_home over TCP was honoured: %v %v", res, err)
	}

	// The TCP address is taken: the unix side still answers.
	work3 := shortDir(t)
	cfg3 := config.Config{APISocketPath: filepath.Join(work3, "a.sock"), APIListen: addr, HubToken: "tok"}
	go func() { _ = New(cfg3, &Server{ClaudeHome: work3}, t.Logf).Run(ctx) }()
	waitDial(t, "unix", cfg3.APISocketPath)
	if _, err := UnixClient(cfg3.APISocketPath).GetSessionStatus(context.Background(),
		connect.NewRequest(&ccxv1.GetSessionStatusRequest{SessionId: sid})); err != nil {
		t.Errorf("unix side with the TCP address taken: %v", err)
	}

	// No token configured: the unix side comes up, the TCP side does not.
	work2 := shortDir(t)
	addr2 := free()
	cfg2 := config.Config{APISocketPath: filepath.Join(work2, "a.sock"), APIListen: addr2}
	go func() { _ = New(cfg2, &Server{ClaudeHome: work2}, t.Logf).Run(ctx) }()
	waitDial(t, "unix", cfg2.APISocketPath)
	if c, err := net.Dial("tcp", addr2); err == nil {
		c.Close()
		t.Error("TCP listener opened without a token")
	}
}
