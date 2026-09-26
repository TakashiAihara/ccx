package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// noGit stands in for a machine with nothing in git config.
func noGit(string) string { return "" }

func fixedHost(name string) func() (string, error) {
	return func() (string, error) { return name, nil }
}

// env builds a getenv from a map, so a test states exactly what is set and
// nothing leaks in from the real environment.
func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestPrecedence_EnvBeatsGitBeatsFileBeatsDefault(t *testing.T) {
	// File on disk sets one value; git overrides it; env overrides git.
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(cfgPath, []byte(`
machine = "from-file"
[hub]
url = "http://file-hub"
`), 0o644); err != nil {
		t.Fatal(err)
	}

	git := func(key string) string {
		if key == "ccx.hubUrl" {
			return "http://git-hub"
		}
		return ""
	}

	c, err := load(env(map[string]string{
		"CCX_CONFIG":  cfgPath,
		"CCX_MACHINE": "from-env",
		// hubUrl not in env → should fall to git ("http://git-hub")
	}), git, fixedHost("the-host"))
	if err != nil {
		t.Fatal(err)
	}

	if c.Machine != "from-env" {
		t.Errorf("machine: env should win, got %q", c.Machine)
	}
	if c.HubURL != "http://git-hub" {
		t.Errorf("hubURL: git should beat file, got %q", c.HubURL)
	}
}

func TestMachine_DefaultsToHostname_ButIsOverridable(t *testing.T) {
	// No override anywhere → hostname is the default.
	c, err := load(env(nil), noGit, fixedHost("default-host"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Machine != "default-host" {
		t.Errorf("machine should default to hostname, got %q", c.Machine)
	}

	// The whole point of #92's note: the default must not be the only truth.
	c2, err := load(env(map[string]string{"CCX_MACHINE": "chosen"}), noGit, fixedHost("default-host"))
	if err != nil {
		t.Fatal(err)
	}
	if c2.Machine != "chosen" {
		t.Errorf("machine override should win over hostname, got %q", c2.Machine)
	}
}

func TestNoConfigAtAll_StillResolves(t *testing.T) {
	// scope.md: it must run with no configuration. Empty hub is fine — ccx-agent
	// spools and simply has nowhere to drain to.
	c, err := load(env(map[string]string{"CCX_CONFIG": "/nonexistent/x.toml"}), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.HubURL != "" {
		t.Errorf("hubURL should be empty with no config, got %q", c.HubURL)
	}
	if c.Machine != "h" {
		t.Errorf("machine should still resolve, got %q", c.Machine)
	}
	if c.SocketPath == "" || c.SpoolDir == "" {
		t.Errorf("socket/spool paths must always resolve: sock=%q spool=%q", c.SocketPath, c.SpoolDir)
	}
}

func TestSocketPath_PrefersRuntimeDir(t *testing.T) {
	c, err := load(env(map[string]string{"XDG_RUNTIME_DIR": "/run/user/1000"}), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "/run/user/1000/ccx/ccx-agent.sock"; c.SocketPath != want {
		t.Errorf("socket path: want %q, got %q", want, c.SocketPath)
	}
}

func TestMalformedConfig_IsSurfaced(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(cfgPath, []byte("this is = = not toml ="), 0o644); err != nil {
		t.Fatal(err)
	}
	// A broken config the user believes is applied must fail loudly, not be
	// silently ignored (a setting-not-applied looks identical to success).
	if _, err := load(env(map[string]string{"CCX_CONFIG": cfgPath}), noGit, fixedHost("h")); err == nil {
		t.Error("malformed config should return an error, not be swallowed")
	}
}

func TestConcernToggles_Defaults(t *testing.T) {
	// ADR 0002 defaults: collect on, carry off, persistence off (opt-in).
	c, err := load(env(nil), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Concerns.Collect {
		t.Error("collect should default ON")
	}
	if c.Concerns.Carry {
		t.Error("carry should default OFF")
	}
	if c.Concerns.Persistence {
		t.Error("persistence should default OFF (opt-in — the only active verb)")
	}
}

func TestConcernToggles_EnvOverrides(t *testing.T) {
	c, err := load(env(map[string]string{
		"CCX_COLLECT":     "off",
		"CCX_PERSISTENCE": "on",
	}), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Concerns.Collect {
		t.Error("CCX_COLLECT=off should disable collect")
	}
	if !c.Concerns.Persistence {
		t.Error("CCX_PERSISTENCE=on should enable persistence")
	}
}

func TestConcernToggles_FileFalseBeatsDefaultOn(t *testing.T) {
	dir := t.TempDir()
	p := dir + "/c.toml"
	if err := os.WriteFile(p, []byte("[collect]\nenabled = false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := load(env(map[string]string{"CCX_CONFIG": p}), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Concerns.Collect {
		t.Error("[collect] enabled=false in file should turn collect off despite the on default")
	}
}

// An unparsable value at one level must NOT resolve to the default — it must
// fall through to the next real source (the fix for the review's Medium#4).
func TestConcernToggles_UnparsableEnvFallsThroughToGit(t *testing.T) {
	git := func(key string) string {
		if key == "ccx.collect" {
			return "false" // deliberately off in git
		}
		return ""
	}
	// A typo in the env var must not silently flip collect back to its "on"
	// default and discard the deliberate git-config false.
	c, err := load(env(map[string]string{"CCX_COLLECT": "treu"}), git, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Concerns.Collect {
		t.Error("unparsable CCX_COLLECT must fall through to ccx.collect=false, not the default")
	}
}

// A config path that exists but cannot be read as a file (here: it is a
// directory; a permission-denied file is the same branch) must surface an error,
// not be silently ignored — a setting the user believes is applied is otherwise
// silently dropped. Fix for the CodeRabbit review's config finding.
func TestConfigFile_UnreadableIsSurfaced(t *testing.T) {
	dir := t.TempDir()
	// Point CCX_CONFIG at a directory: os.ReadFile returns a non-nil error that
	// is NOT os.ErrNotExist, so it must be surfaced, not swallowed.
	if _, err := load(env(map[string]string{"CCX_CONFIG": dir}), noGit, fixedHost("h")); err == nil {
		t.Error("an existing-but-unreadable config path should surface an error, not be swallowed")
	}
}

func TestHeartbeat_DefaultsAndFile(t *testing.T) {
	c, err := load(env(map[string]string{"CCX_CONFIG": "/nonexistent/x.toml"}), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Concerns.Heartbeat || c.Heartbeat.Default || c.Heartbeat.Interval != 50*time.Minute || c.Heartbeat.MaxIdle != 12*time.Hour {
		t.Errorf("defaults = %+v / %v", c.Heartbeat, c.Concerns.Heartbeat)
	}

	p := filepath.Join(t.TempDir(), "config.toml")
	_ = os.WriteFile(p, []byte("[heartbeat]\nenabled = false\ndefault = true\ninterval = \"40m\"\nmaxIdle = \"off\"\n"), 0o644)
	c, err = load(env(map[string]string{"CCX_CONFIG": p, "CCX_HEARTBEAT_INTERVAL": "45m"}), noGit, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Concerns.Heartbeat || !c.Heartbeat.Default || c.Heartbeat.Interval != 45*time.Minute || c.Heartbeat.MaxIdle != 0 {
		t.Errorf("file + env = %+v / %v, want off, default on from the file, env's 45m, no cap", c.Heartbeat, c.Concerns.Heartbeat)
	}

	// A duration typed wrong, or one the cache does not outlive, turns the
	// heartbeat off with a reason, not silently to a default. Everything else in
	// the config still loads: collect keeps running.
	for k, v := range map[string]string{"CCX_HEARTBEAT_INTERVAL": "50 minutes", "CCX_HEARTBEAT_MAX_IDLE": "forever"} {
		c, err := load(env(map[string]string{"CCX_CONFIG": "/nonexistent/x.toml", k: v, "CCX_MACHINE": "m"}), noGit, fixedHost("h"))
		if err != nil || c.Concerns.Heartbeat || c.Heartbeat.Err == nil || !c.Concerns.Collect || c.Machine != "m" {
			t.Errorf("%s=%s: err=%v heartbeat=%v reason=%v collect=%v", k, v, err, c.Concerns.Heartbeat, c.Heartbeat.Err, c.Concerns.Collect)
		}
	}
	c, _ = load(env(map[string]string{"CCX_CONFIG": "/nonexistent/x.toml", "CCX_HEARTBEAT_INTERVAL": "1h"}), noGit, fixedHost("h"))
	if c.Concerns.Heartbeat || c.Heartbeat.Err == nil {
		t.Errorf("interval of 1h: heartbeat=%v reason=%v, want off with a reason", c.Concerns.Heartbeat, c.Heartbeat.Err)
	}
}

func TestChannelSocket_NextToTheHookSocket(t *testing.T) {
	c, _ := load(env(map[string]string{"XDG_RUNTIME_DIR": "/run/user/1000"}), noGit, fixedHost("h"))
	if c.ChannelSocketPath != "/run/user/1000/ccx/ccx-channel.sock" {
		t.Errorf("channel socket = %q", c.ChannelSocketPath)
	}
	c, _ = load(env(map[string]string{"XDG_RUNTIME_DIR": "/run/user/1000", "CCX_SOCKET": "/s/hook.sock"}), noGit, fixedHost("h"))
	if c.ChannelSocketPath != "/s/ccx-channel.sock" {
		t.Errorf("with CCX_SOCKET = %q, want next to it", c.ChannelSocketPath)
	}
	c, _ = load(env(map[string]string{"CCX_CHANNEL_SOCKET": "/x/ch.sock"}), noGit, fixedHost("h"))
	if c.ChannelSocketPath != "/x/ch.sock" {
		t.Errorf("override = %q", c.ChannelSocketPath)
	}
}

func TestAPI_SocketAndListen(t *testing.T) {
	c, _ := load(env(map[string]string{"XDG_RUNTIME_DIR": "/run/user/1000", "CCX_CONFIG": "/nonexistent"}), noGit, fixedHost("h"))
	if c.APISocketPath != "/run/user/1000/ccx/ccx-api.sock" || c.APIListen != "" {
		t.Errorf("defaults: socket %q listen %q, want next to the hook socket and off", c.APISocketPath, c.APIListen)
	}
	c, _ = load(env(map[string]string{"CCX_SOCKET": "/s/hook.sock", "CCX_CONFIG": "/nonexistent"}), noGit, fixedHost("h"))
	if c.APISocketPath != "/s/ccx-api.sock" {
		t.Errorf("with CCX_SOCKET = %q, want next to it", c.APISocketPath)
	}

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	_ = os.WriteFile(cfgPath, []byte("[api]\nlisten = \"0.0.0.0:8792\"\n"), 0o644)
	git := func(k string) string {
		if k == "ccx.apiListen" {
			return "0.0.0.0:1"
		}
		return ""
	}
	c, _ = load(env(map[string]string{"CCX_CONFIG": cfgPath, "CCX_API_SOCKET": "/x/a.sock"}), noGit, fixedHost("h"))
	if c.APIListen != "0.0.0.0:8792" || c.APISocketPath != "/x/a.sock" {
		t.Errorf("file: listen %q socket %q", c.APIListen, c.APISocketPath)
	}
	c, _ = load(env(map[string]string{"CCX_CONFIG": cfgPath}), git, fixedHost("h"))
	if c.APIListen != "0.0.0.0:1" {
		t.Errorf("git should beat file: %q", c.APIListen)
	}
	c, _ = load(env(map[string]string{"CCX_CONFIG": cfgPath, "CCX_API_LISTEN": "127.0.0.1:2"}), git, fixedHost("h"))
	if c.APIListen != "127.0.0.1:2" {
		t.Errorf("env should beat git: %q", c.APIListen)
	}
}

// The token comes from CCX_HUB_TOKEN, else the hub-token file next to
// config.toml, and never from git config (git config travels with dotfiles).
func TestHubToken_EnvThenFile_NeverGit(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")
	git := func(key string) string { return "from-git" }

	c, err := load(env(map[string]string{"CCX_CONFIG": cfgPath}), git, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	if c.HubToken != "" {
		t.Errorf("no env, no file: want empty, got %q", c.HubToken)
	}

	if err := os.WriteFile(filepath.Join(dir, "hub-token"), []byte("from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, _ = load(env(map[string]string{"CCX_CONFIG": cfgPath}), git, fixedHost("h"))
	if c.HubToken != "from-file" {
		t.Errorf("file: want trimmed from-file, got %q", c.HubToken)
	}

	c, _ = load(env(map[string]string{"CCX_CONFIG": cfgPath, "CCX_HUB_TOKEN": " from-env "}), git, fixedHost("h"))
	if c.HubToken != "from-env" {
		t.Errorf("env should beat file, got %q", c.HubToken)
	}
}

// A token file other users can read is refused, not used and not ignored.
func TestHubToken_RefusesOtherReadableFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hub-token"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := load(env(map[string]string{"CCX_CONFIG": filepath.Join(dir, "config.toml")}), noGit, fixedHost("h")); err == nil {
		t.Fatal("a 0644 hub-token must fail the load")
	}
}
