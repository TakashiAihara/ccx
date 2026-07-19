// Package config resolves ccxd's settings without baking in any personal
// environment. It is the Go port of the TS core's config, cut down to exactly
// what #90 (ccxd basic) needs: where to forward, what machine we are, and where
// the socket and spool live. The repodir-side keys (root, mirror, protocol)
// are not ported yet — ccxd basic does not touch repodirs.
//
// Resolution order mirrors the TS core (which follows ghq):
//
//  1. environment variable   CCX_HUB_URL / CCX_MACHINE / ...
//  2. git config             ccx.hubUrl / ccx.machine / ...
//  3. config file            ~/.config/ccx/config.toml
//  4. built-in default
//
// Env wins so a shell rc can switch it per-invocation; git config sits under it
// so the setting lives in git's own system. None of it is required to run.
package config

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// Config is the resolved ccxd configuration. Only the fields ccxd basic needs.
type Config struct {
	// HubURL is where ccxd forwards. Empty means "no center configured" — ccxd
	// still runs and spools; it just has nowhere to drain to yet. The local
	// side never depends on the center existing (scope.md).
	HubURL string

	// Machine names this host in the (user, machine, session) key (#92). The
	// default is the hostname, but the default is NOT the single source of
	// truth: hostnames collide (same-named containers, cloned VMs), so it is
	// overridable via CCX_MACHINE / ccx.machine / config. #90 only needs to
	// leave the override open.
	Machine string

	// User names the owning user in the same key. ccxd runs as the invoking
	// user (never root, #90), so this is just who that is.
	User string

	// SocketPath is the unix socket hooks write to. Under the user's runtime
	// dir so it is user-owned by construction.
	SocketPath string

	// SpoolDir holds the forward queue and the hook-written fallback.
	SpoolDir string

	// Concerns turns ccxd's bundled jobs on and off independently (ADR 0002).
	// ccxd is one process, but each concern is a module that a person can enable
	// or disable through the usual ladder. A ccxd with every concern off is
	// valid — someone who wants the CLI but none of the daemon's behaviours.
	Concerns Concerns
}

// Concerns is the on/off state of each of ccxd's three jobs (ADR 0002). Only
// Collect is implemented in #90; Carry and Persistence have their toggle here so
// they slot in the same shape when built, and so a reader sees the full set.
type Concerns struct {
	// Collect — hooks → center. Defaults ON: it is inert without a center
	// configured (it forwards nowhere), so on-by-default is harmless.
	Collect bool

	// Carry — broker → session. Defaults OFF: inert until a broker and a
	// channel-enabled session exist (#23, not built yet).
	Carry bool

	// Persistence — keep a `desired: running` session alive. Defaults OFF,
	// opt-in: it is the only *active* verb (it spawns/restarts, START), so it is
	// never on by surprise — the same stance as the worker gate and
	// `desired: running` itself (#20, not built yet).
	Persistence bool
}

// fileShape is the subset of ~/.config/ccx/config.toml this port reads.
type fileShape struct {
	Machine string `toml:"machine"`
	Hub     struct {
		URL string `toml:"url"`
	} `toml:"hub"`
	// *bool so "unset in file" is distinguishable from "set to false".
	Collect     struct{ Enabled *bool } `toml:"collect"`
	Carry       struct{ Enabled *bool } `toml:"carry"`
	Persistence struct{ Enabled *bool } `toml:"persistence"`
}

// Load resolves the config from the real environment.
func Load() (Config, error) {
	return load(os.Getenv, gitConfig, os.Hostname)
}

// load is the testable core: every external input is injected.
func load(
	getenv func(string) string,
	gitcfg func(key string) string,
	hostname func() (string, error),
) (Config, error) {
	var file fileShape
	if p := configPath(getenv); p != "" {
		b, err := os.ReadFile(p)
		switch {
		case err == nil:
			// A malformed config file is worth surfacing, not swallowing —
			// it means a setting the user thinks is applied is not.
			if _, err := toml.Decode(string(b), &file); err != nil {
				return Config{}, err
			}
		case errors.Is(err, os.ErrNotExist):
			// No config file at all is fine — everything is optional.
		default:
			// The file exists but could not be read (permissions, I/O). Same
			// reasoning as a parse error: a setting the user believes is applied
			// is silently not. Surface it rather than swallow it.
			return Config{}, err
		}
	}

	hub := pick(getenv("CCX_HUB_URL"), gitcfg("ccx.hubUrl"), file.Hub.URL)

	machine := pick(getenv("CCX_MACHINE"), gitcfg("ccx.machine"), file.Machine)
	if machine == "" {
		// Default only — still overridable above. Never let this be the sole
		// truth of the machine identity (#92 keys on it).
		if h, err := hostname(); err == nil {
			machine = h
		}
	}

	uname := ""
	if u, err := user.Current(); err == nil {
		uname = u.Username
	}

	return Config{
		HubURL:     hub,
		Machine:    machine,
		User:       uname,
		SocketPath: socketPath(getenv),
		SpoolDir:   spoolDir(getenv),
		Concerns: Concerns{
			// Defaults per ADR 0002: passive concerns may default on, the one
			// active concern (persistence) is opt-in.
			Collect:     toggle(getenv, gitcfg, "CCX_COLLECT", "ccx.collect", file.Collect.Enabled, true),
			Carry:       toggle(getenv, gitcfg, "CCX_CARRY", "ccx.carry", file.Carry.Enabled, false),
			Persistence: toggle(getenv, gitcfg, "CCX_PERSISTENCE", "ccx.persistence", file.Persistence.Enabled, false),
		},
	}, nil
}

// toggle resolves one concern's enabled flag through the usual ladder
// (env → git config → file → default). It is the single shape all three
// concerns share, so adding Carry/Persistence wiring later is one line each.
func toggle(getenv func(string) string, gitcfg func(string) string, envKey, gitKey string, fileVal *bool, def bool) bool {
	// An unparsable value at one level is treated as "not set here" and falls
	// through to the next source — a typo in CCX_COLLECT must not silently
	// override a deliberate `ccx.collect=false` in git config. That is the whole
	// point of "a typo should not flip a concern": it should be ignored, not
	// resolved to the built-in default while a real lower source is discarded.
	if b, ok := parseBool(getenv(envKey)); ok {
		return b
	}
	if b, ok := parseBool(gitcfg(gitKey)); ok {
		return b
	}
	if fileVal != nil {
		return *fileVal
	}
	return def
}

// parseBool reads the common truthy/falsey spellings. ok is false for an empty
// or unrecognised value, so the caller can fall through to the next source
// rather than treating a typo as a deliberate setting.
func parseBool(v string) (value, ok bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "on", "yes":
		return true, true
	case "0", "false", "off", "no":
		return false, true
	default:
		return false, false
	}
}

// pick returns the first non-empty value, in precedence order.
func pick(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// configPath is CCX_CONFIG, else $XDG_CONFIG_HOME/ccx/config.toml, else
// ~/.config/ccx/config.toml.
func configPath(getenv func(string) string) string {
	if p := getenv("CCX_CONFIG"); p != "" {
		return p
	}
	xdg := getenv("XDG_CONFIG_HOME")
	if xdg == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		xdg = filepath.Join(home, ".config")
	}
	return filepath.Join(xdg, "ccx", "config.toml")
}

// socketPath is CCX_SOCKET, else $XDG_RUNTIME_DIR/ccx/ccxd.sock, else
// ~/.ccx/run/ccxd.sock. Under a user-owned dir so the socket is user-owned and
// the hook→ccxd path is trivially permitted (#90).
func socketPath(getenv func(string) string) string {
	if p := getenv("CCX_SOCKET"); p != "" {
		return p
	}
	if run := getenv("XDG_RUNTIME_DIR"); run != "" {
		return filepath.Join(run, "ccx", "ccxd.sock")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ccx", "run", "ccxd.sock")
}

// spoolDir is CCX_SPOOL, else ~/.ccx/spool. Persisted across reboots (unlike
// the socket), because the point of the spool is to survive ccxd restarts.
func spoolDir(getenv func(string) string) string {
	if p := getenv("CCX_SPOOL"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ccx", "spool")
}

// gitConfig returns `git config --get <key>`, or "" if unset or git is absent.
func gitConfig(key string) string {
	out, err := exec.Command("git", "config", "--get", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
