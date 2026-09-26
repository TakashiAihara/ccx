package main

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
)

// This test drives the REAL compiled ccx-agent binary — `ccx-agent serve` and `ccx-agent hook`
// as separate processes, exactly as Claude Code's hooks and a systemd unit run
// them — against the REAL Connect center. It is the one place main.go's wiring,
// signal handling, and the process boundary are exercised. The in-package tests
// cover the logic; this covers that the binary actually does it.
//
// It builds the binary, so it is skipped under -short.

func buildAgent(t *testing.T) string {
	t.Helper()
	// A short output dir: unix socket paths (built below) must fit sun_path
	// (~108 bytes), and t.TempDir() under a deep CI path can be long.
	dir, err := os.MkdirTemp("", "ccx-agent-it")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	bin := filepath.Join(dir, "ccx-agent")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build ccx-agent: %v\n%s", err, out)
	}
	return bin
}

type agentProc struct {
	cmd *exec.Cmd
}

func startServe(t *testing.T, bin string, env []string) *agentProc {
	t.Helper()
	cmd := exec.Command(bin, "serve")
	cmd.Env = env
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start serve: %v", err)
	}
	return &agentProc{cmd: cmd}
}

func (p *agentProc) kill() { _ = p.cmd.Process.Kill(); _, _ = p.cmd.Process.Wait() }

func fireHook(t *testing.T, bin string, env []string, payload string) {
	t.Helper()
	cmd := exec.Command(bin, "hook")
	cmd.Env = env
	cmd.Stdin = strings.NewReader(payload)
	start := time.Now()
	if err := cmd.Run(); err != nil {
		t.Fatalf("hook: %v", err) // hook must always exit 0
	}
	// A hook must never block the session; even the fallback path is fast.
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("hook took %s — it must not block the session", d)
	}
}

func countPB(t *testing.T, spoolDir string) int {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(spoolDir, "*.pb"))
	return len(m)
}

func TestIntegration_RealBinary_AllScenarios(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the real ccx-agent binary")
	}

	bin := buildAgent(t)
	c, url := testcenter.Start()
	t.Cleanup(c.Close)

	work, err := os.MkdirTemp("", "ccx-agent-work")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(work) })
	sock := filepath.Join(work, "s.sock")
	spool := filepath.Join(work, "spool")

	env := append(os.Environ(),
		"CCX_HUB_URL="+url,
		"CCX_SOCKET="+sock,
		"CCX_SPOOL="+spool,
		"CCX_MACHINE=it-host",
	)

	waitCenter := func(want int, within time.Duration) {
		t.Helper()
		deadline := time.Now().Add(within)
		for time.Now().Before(deadline) {
			if len(c.Payloads()) >= want {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("center reached %d events, wanted %d", len(c.Payloads()), want)
	}
	waitSocket := func() {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if conn, err := net.DialTimeout("unix", sock, 200*time.Millisecond); err == nil {
				conn.Close()
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("serve socket never came up")
	}

	// --- scenario 1: happy path.
	serve := startServe(t, bin, env)
	waitSocket()
	fireHook(t, bin, env, `{"hook_event_name":"SessionStart","session_id":"s1"}`)
	fireHook(t, bin, env, `{"hook_event_name":"Stop","session_id":"s1"}`)
	waitCenter(2, 3*time.Second)
	if got := c.Payloads(); got[0] != `{"hook_event_name":"SessionStart","session_id":"s1"}` {
		t.Fatalf("scenario1 order wrong: %v", got)
	}

	// --- scenario 2: center down → spool, then ordered recovery.
	c.SetUnavailable(true)
	for _, p := range []string{`{"n":1}`, `{"n":2}`, `{"n":3}`} {
		fireHook(t, bin, env, p)
	}
	// Give the forward loop a moment; nothing should reach the (down) center.
	time.Sleep(500 * time.Millisecond)
	if n := countPB(t, spool); n < 3 {
		t.Fatalf("expected >=3 spooled while center down, got %d", n)
	}
	baseline := len(c.Payloads())
	c.SetUnavailable(false)
	waitCenter(baseline+3, 5*time.Second)
	tail := c.Payloads()[baseline : baseline+3]
	for i, want := range []string{`{"n":1}`, `{"n":2}`, `{"n":3}`} {
		if tail[i] != want {
			t.Errorf("scenario2 recovery order[%d]: want %q got %q", i, want, tail[i])
		}
	}

	// --- scenario 3: ccx-agent down → hook falls back, drained on restart.
	serve.kill()
	fireHook(t, bin, env, `{"while":"ccx-agent-down"}`) // socket gone → incoming/
	raw, _ := filepath.Glob(filepath.Join(spool, "incoming", "*.raw"))
	if len(raw) != 1 {
		t.Fatalf("expected 1 fallback event in incoming/, got %d", len(raw))
	}
	baseline = len(c.Payloads())
	serve = startServe(t, bin, env)
	waitSocket()
	waitCenter(baseline+1, 4*time.Second)

	// --- scenario 4: SIGKILL with pending spool → at-least-once, no loss.
	c.SetUnavailable(true)
	for _, p := range []string{`{"k":1}`, `{"k":2}`, `{"k":3}`, `{"k":4}`} {
		fireHook(t, bin, env, p)
	}
	time.Sleep(400 * time.Millisecond)
	pend := countPB(t, spool)
	if pend < 4 {
		t.Fatalf("expected >=4 pending before kill, got %d", pend)
	}
	serve.kill() // SIGKILL — no graceful shutdown
	if after := countPB(t, spool); after != pend {
		t.Fatalf("spool changed across SIGKILL: %d → %d (nothing should be lost)", pend, after)
	}

	// Track which of the 4 survive.
	want := map[string]bool{`{"k":1}`: false, `{"k":2}`: false, `{"k":3}`: false, `{"k":4}`: false}
	c.SetUnavailable(false)
	serve = startServe(t, bin, env)
	waitSocket()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, p := range c.Payloads() {
			if _, ok := want[p]; ok {
				want[p] = true
			}
		}
		all := true
		for _, seen := range want {
			all = all && seen
		}
		if all {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	for p, seen := range want {
		if !seen {
			t.Errorf("LOSS: event %q spooled before SIGKILL never arrived", p)
		}
	}
	serve.kill()
}

// `ccx-agent status` against the real serve, and with serve down: nothing on
// stdout and a non-zero exit, so statusline shows nothing rather than a guess.
func TestIntegration_StatusClient(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the real ccx-agent binary")
	}
	bin := buildAgent(t)
	work, err := os.MkdirTemp("", "ccx-agent-st")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(work) })
	home := filepath.Join(work, "claude")
	const sid = "00000000-0000-4000-8000-0000000000aa"
	if err := os.MkdirAll(filepath.Join(home, "sessions", sid), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(home, "sessions", sid, "label"), []byte("it-label\n"), 0o644)
	env := append(os.Environ(),
		"CCX_HUB_URL=", "CCX_SOCKET="+filepath.Join(work, "s.sock"), "CCX_SPOOL="+filepath.Join(work, "spool"),
		"CLAUDE_CONFIG_DIR="+home,
		// Nothing from the developer's setup may point this serve at the real
		// agent's sockets or a port.
		"CCX_API_SOCKET="+filepath.Join(work, "a.sock"), "CCX_CHANNEL_SOCKET="+filepath.Join(work, "c.sock"),
		"CCX_API_LISTEN=", "CCX_CONFIG=/nonexistent", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
	)
	status := func() (string, error) {
		cmd := exec.Command(bin, "status", "--session", sid, "--json")
		cmd.Env = env
		out, err := cmd.Output()
		return string(out), err
	}

	// A malformed id is the caller's mistake (2), told apart from serve down (1).
	bad := exec.Command(bin, "status", "--session", "not-an-id")
	bad.Env = env
	if err := bad.Run(); err == nil || bad.ProcessState.ExitCode() != 2 {
		t.Errorf("malformed id: %v, want exit 2", err)
	}
	var exitErr *exec.ExitError
	if out, err := status(); !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 || out != "" {
		t.Fatalf("serve down: out=%q err=%v, want empty and exit 1", out, err)
	}

	serve := startServe(t, bin, env)
	defer serve.kill()
	var out string
	for i := 0; i < 150; i++ {
		if out, err = status(); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	bad = exec.Command(bin, "status", "--session", "not-an-id")
	bad.Env = env
	if err := bad.Run(); err == nil || bad.ProcessState.ExitCode() != 2 {
		t.Errorf("malformed id with serve up: %v, want exit 2", err)
	}
	// protojson varies its whitespace on purpose; read it as JSON.
	var got struct {
		Declared  struct{ Label string }
		Heartbeat struct{ Enabled, Listening bool }
		Collect   struct {
			Enabled bool
			Pending *int
		}
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil || got.Declared.Label != "it-label" ||
		!got.Heartbeat.Enabled || !got.Collect.Enabled || got.Collect.Pending == nil || *got.Collect.Pending != 0 {
		t.Errorf("status output: %s (%v)", out, err)
	}
}
