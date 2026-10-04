// Package config resolves ccx-agent's settings without baking in any personal
// environment. It is the Go port of the TS core's config, cut down to exactly
// what #90 (ccx-agent basic) needs: where to forward, what machine we are, and where
// the socket and spool live. The repodir-side keys (root, mirror, protocol)
// are not ported yet — ccx-agent basic does not touch repodirs.
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
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the resolved ccx-agent configuration. Only the fields ccx-agent basic needs.
type Config struct {
	// HubURL is where ccx-agent forwards. Empty means "no center configured" — ccx-agent
	// still runs and spools; it just has nowhere to drain to yet. The local
	// side never depends on the center existing (scope.md).
	HubURL string

	// HubToken is the center's CCX_CENTER_TOKEN, sent as a Bearer on every call
	// (#158). CCX_HUB_TOKEN, else the file hub-token next to config.toml. Never
	// git config or config.toml: those get shared along with dotfiles.
	HubToken string

	// Machine names this host in the (user, machine, session) key (#92). The
	// default is the hostname, but the default is NOT the single source of
	// truth: hostnames collide (same-named containers, cloned VMs), so it is
	// overridable via CCX_MACHINE / ccx.machine / config. #90 only needs to
	// leave the override open.
	Machine string

	// User names the owning user in the same key. ccx-agent runs as the invoking
	// user (never root, #90), so this is just who that is.
	User string

	// SocketPath is the unix socket hooks write to. Under the user's runtime
	// dir so it is user-owned by construction.
	SocketPath string

	// SpoolDir holds the forward queue and the hook-written fallback.
	SpoolDir string

	// Concerns turns ccx-agent's bundled jobs on and off independently (ADR 0002).
	// ccx-agent is one process, but each concern is a module that a person can enable
	// or disable through the usual ladder. A ccx-agent with every concern off is
	// valid — someone who wants the CLI but none of the daemon's behaviours.
	Concerns Concerns

	// Heartbeat is how the heartbeat concern keeps idle sessions' prompt caches
	// warm (docs/design/heartbeat.md). A session can override Default for
	// itself (`ccx session heartbeat on|off`); the rest applies to all.
	Heartbeat Heartbeat

	// ChannelSocketPath is where each session's `ccx-agent channel` registers
	// with serve. Apart from the hook socket: the hook wire is one frame and an
	// ack, this one stays open for the life of the session.
	ChannelSocketPath string

	// APISocketPath is where serve answers AgentService (kaneo ccx#34) for this
	// host: statusline and the `ccx-agent status` client. Guarded by 0600.
	APISocketPath string

	// APIListen is a TCP address (host:port) where serve also answers
	// AgentService, for agents on other hosts. Empty (the default) is off. It
	// requires APIToken: serve refuses to open it without one.
	APIListen string

	// APIToken is the Bearer the TCP listener requires (kaneo ccx#34). Apart from
	// HubToken on purpose: a caller that only reads an agent must not hold the
	// center's write credential, and the TCP side is plain HTTP. One token is
	// shared by every host (user decision 2026-09-27). CCX_API_TOKEN, else the
	// file api-token next to config.toml, never git config or config.toml.
	APIToken string
	// APITokenErr is why the API token cannot be used. It keeps the TCP
	// listener closed and nothing else: a bad token file for an optional
	// listener must not stop collect or the heartbeat (the same rule as
	// Heartbeat.Err).
	APITokenErr error

	// Transcript is the live transcript's settings (#120,
	// docs/design/live-transcript.md): the store ccx-agent appends a running
	// session's transcript.jsonl to.
	Transcript Transcript
}

// Transcript resolves the same store `ccx transcript` does
// (packages/core/src/config.ts). The store is always the center's own object
// API (#210), so what is left is where in it the object lives.
type Transcript struct {
	// Live turns the live append on. Default ON: without it a session's
	// conversation only reaches the store when it ends, which is the whole
	// problem (#120). It is inert without an http(s) hub, so on-by-default is safe.
	Live bool
	// Bucket and Prefix are where the object is, same defaults as the CLI
	// ("ccx", no prefix).
	Bucket string
	Prefix string
}

// Heartbeat is the heartbeat concern's settings.
type Heartbeat struct {
	// Default decides for a session that has not declared on or off. Off: a
	// heartbeat costs quota whether or not anyone comes back (measured
	// 2026-09-23, read counts on a Max plan), so a session, or the person, opts
	// in with `ccx session heartbeat on` (user decision 2026-09-24).
	Default bool
	// Interval after the last request that a heartbeat is due. 50m: an hour of
	// cache TTL, less generation time and slack.
	Interval time.Duration
	// MaxIdle stops heartbeats for a session nobody has used for this long;
	// 0 is no cap.
	MaxIdle time.Duration
	// Err is why the heartbeat settings could not be used. It turns the concern
	// off and nothing else: a typo here must not take collect down with it, or
	// stop a session's channel from reading the rest of the config.
	Err error
}

// Concerns is the on/off state of each of ccx-agent's jobs (ADR 0002). Collect
// and Heartbeat are built; Carry and Persistence have their toggle here so they
// slot in the same shape when built, and so a reader sees the full set.
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

	// Heartbeat — keep idle sessions' prompt caches warm. Defaults ON: inert
	// until a session loads the ccx channel, which is itself opt-in per session.
	Heartbeat bool
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
	API         struct {
		Listen string `toml:"listen"`
	} `toml:"api"`
	Heartbeat struct {
		Enabled  *bool  `toml:"enabled"`
		Default  *bool  `toml:"default"`
		Interval string `toml:"interval"`
		MaxIdle  string `toml:"maxIdle"`
	} `toml:"heartbeat"`
	// [transcript] is where in the center `ccx transcript` keeps transcripts
	// (bucket, prefix). `live` is the switch that stops reading transcripts per
	// hook, and it exists nowhere else (#120).
	Transcript struct {
		Bucket string `toml:"bucket"`
		Prefix string `toml:"prefix"`
		Live   *bool  `toml:"live"`
	} `toml:"transcript"`
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
	token, err := hubToken(getenv)
	if err != nil {
		return Config{}, err
	}
	apiToken, apiTokenErr := tokenFrom(getenv, "CCX_API_TOKEN", "api-token", "the agent API's token")
	if apiTokenErr == nil && apiToken != "" && apiToken == token {
		// A copy of hub-token would hand the center's write credential to readers.
		apiToken, apiTokenErr = "", errors.New("the API token is the hub token; give the agent API its own (CCX_API_TOKEN or api-token)")
	}

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

	interval, hbErr := duration(pick(getenv("CCX_HEARTBEAT_INTERVAL"), gitcfg("ccx.heartbeatInterval"), file.Heartbeat.Interval), 50*time.Minute)
	if hbErr == nil && interval >= time.Hour {
		// The cache lives an hour. A heartbeat due at or after that finds it gone
		// and is never sent: the setting would silently turn the concern into a no-op.
		hbErr = errors.New("heartbeat: interval " + interval.String() + " is not under the 1h cache TTL")
	}
	maxIdle, err := duration(pick(getenv("CCX_HEARTBEAT_MAX_IDLE"), gitcfg("ccx.heartbeatMaxIdle"), file.Heartbeat.MaxIdle), 12*time.Hour)
	if hbErr == nil {
		hbErr = err
	}

	// The transcript store, resolved exactly as the CLI resolves it
	// (packages/core/src/config.ts) — same defaults, same prefix normalisation.
	// If ccx-agent appended to a different object than `ccx transcript` reads,
	// the conversation would exist twice.
	tBucket := pick(getenv("CCX_TRANSCRIPT_BUCKET"), gitcfg("ccx.transcriptBucket"), file.Transcript.Bucket)
	if tBucket == "" {
		tBucket = "ccx"
	}
	tPrefix := normalizePrefix(pick(getenv("CCX_TRANSCRIPT_PREFIX"), gitcfg("ccx.transcriptPrefix"), file.Transcript.Prefix))

	return Config{
		HubURL:     hub,
		HubToken:   token,
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
			Heartbeat:   hbErr == nil && toggle(getenv, gitcfg, "CCX_HEARTBEAT", "ccx.heartbeat", file.Heartbeat.Enabled, true),
		},
		Heartbeat: Heartbeat{
			Default:  toggle(getenv, gitcfg, "CCX_HEARTBEAT_DEFAULT", "ccx.heartbeatDefault", file.Heartbeat.Default, false),
			Interval: interval,
			MaxIdle:  maxIdle,
			Err:      hbErr,
		},
		ChannelSocketPath: channelSocketPath(getenv),
		APISocketPath:     apiSocketPath(getenv),
		APIListen:         strings.TrimSpace(pick(getenv("CCX_API_LISTEN"), gitcfg("ccx.apiListen"), file.API.Listen)),
		APIToken:          apiToken,
		APITokenErr:       apiTokenErr,
		Transcript: Transcript{
			// git config is being taken out of the resolution (kaneo
			// ccx#24), so a new switch does not start there. Env or the file stops it.
			Live:   fileToggle(getenv, "CCX_TRANSCRIPT_LIVE", file.Transcript.Live, true),
			Bucket: tBucket,
			Prefix: tPrefix,
		},
	}, nil
}

// duration reads a Go duration ("50m"); "off" or "0" is 0. Unlike a toggle, a
// bad value is an error: the value is a number someone chose, and falling
// back to a default would run the heartbeat on a schedule nobody set.
func duration(v string, def time.Duration) (time.Duration, error) {
	switch strings.TrimSpace(v) {
	case "":
		return def, nil
	case "off", "0":
		return 0, nil
	}
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil || d < 0 {
		return 0, errors.New("heartbeat: " + v + ": want a duration like 50m, or off")
	}
	return d, nil
}

// toggle resolves one on/off setting through the usual ladder
// (env → git config → file → default). Every concern's switch and the
// heartbeat default share it, so adding Carry/Persistence wiring later is one
// line each.
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

// fileToggle is toggle without the git step, for a setting git config is not a
// source of. It keeps the same "a typo falls through" rule, so a misspelt env
// value reaches the file instead of resolving to the built-in default.
func fileToggle(getenv func(string) string, envKey string, fileVal *bool, def bool) bool {
	if b, ok := parseBool(getenv(envKey)); ok {
		return b
	}
	if fileVal != nil {
		return *fileVal
	}
	return def
}

// normalizePrefix is the CLI's normalizePrefix: drop a leading `/` and add a
// trailing one, so `a` and `a/` are not two places. Empty stays empty (nothing
// goes in front of the key then).
func normalizePrefix(raw string) string {
	p := strings.TrimLeft(raw, "/")
	if p != "" && !strings.HasSuffix(p, "/") {
		return p + "/"
	}
	return p
}

// IsHTTP is whether the hub URL can be the transcript store: the center's
// object API is HTTP, so only an http(s) scheme qualifies; a nats broker does not.
func IsHTTP(raw string) bool {
	return strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://")
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

// hubToken fails rather than ignoring a token file it cannot use: a silently
// empty token turns into "every event refused" with nothing pointing at why.
func hubToken(getenv func(string) string) (string, error) {
	return tokenFrom(getenv, "CCX_HUB_TOKEN", "hub-token", "the center's token")
}

// tokenFrom is envKey, else the file name next to config.toml, which must not
// be readable by others. Never git config or config.toml: those get shared
// along with dotfiles.
func tokenFrom(getenv func(string) string, envKey, name, holds string) (string, error) {
	if t := strings.TrimSpace(getenv(envKey)); t != "" {
		return t, nil
	}
	p := configPath(getenv)
	if p == "" {
		return "", nil
	}
	path := filepath.Join(filepath.Dir(p), name)
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("%s is readable by other users; chmod 600 it (it holds %s)", path, holds)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
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

// socketPath is CCX_SOCKET, else $XDG_RUNTIME_DIR/ccx/ccx-agent.sock, else
// ~/.ccx/run/ccx-agent.sock. Under a user-owned dir so the socket is user-owned and
// the hook→ccx-agent path is trivially permitted (#90).
func socketPath(getenv func(string) string) string {
	if p := getenv("CCX_SOCKET"); p != "" {
		return p
	}
	if run := getenv("XDG_RUNTIME_DIR"); run != "" {
		return filepath.Join(run, "ccx", "ccx-agent.sock")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ccx", "run", "ccx-agent.sock")
}

// channelSocketPath is CCX_CHANNEL_SOCKET, else ccx-channel.sock next to the
// hook socket's default.
func channelSocketPath(getenv func(string) string) string {
	if p := getenv("CCX_CHANNEL_SOCKET"); p != "" {
		return p
	}
	// Next to wherever the hook socket resolved, CCX_SOCKET included: a short
	// CCX_SOCKET is how a path over the unix-socket limit is fixed, and the
	// channel socket needs the same fix.
	return filepath.Join(filepath.Dir(socketPath(getenv)), "ccx-channel.sock")
}

// APISocket is where serve answers AgentService, resolved from the environment
// alone. `ccx-agent status` runs on every statusline render and needs nothing
// else: the full Load runs git config several times and fails on a bad
// config.toml the socket path does not depend on.
func APISocket() string { return apiSocketPath(os.Getenv) }

// apiSocketPath is CCX_API_SOCKET, else ccx-api.sock next to the hook socket
// (for the same reason as the channel socket).
func apiSocketPath(getenv func(string) string) string {
	if p := getenv("CCX_API_SOCKET"); p != "" {
		return p
	}
	return filepath.Join(filepath.Dir(socketPath(getenv)), "ccx-api.sock")
}

// spoolDir is CCX_SPOOL, else ~/.ccx/spool. Persisted across reboots (unlike
// the socket), because the point of the spool is to survive ccx-agent restarts.
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
