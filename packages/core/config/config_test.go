package config

import (
	"os"
	"path/filepath"
	"testing"
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
	// scope.md: it must run with no configuration. Empty hub is fine — ccxd
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
	if want := "/run/user/1000/ccx/ccxd.sock"; c.SocketPath != want {
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
