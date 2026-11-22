package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/collect"
	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	"github.com/TakashiAihara/ccx/packages/core/config"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// assembleConfig is a Config with collect and the heartbeat on and no hub, so
// neither the live transcript nor resume is built and nothing reaches out.
func assembleConfig(t *testing.T, machine, user string) config.Config {
	dir := t.TempDir()
	return config.Config{
		Machine:           machine,
		User:              user,
		SocketPath:        filepath.Join(dir, "hook.sock"),
		SpoolDir:          filepath.Join(dir, "spool"),
		ChannelSocketPath: filepath.Join(dir, "channel.sock"),
		APISocketPath:     filepath.Join(dir, "api.sock"),
		Concerns:          config.Concerns{Collect: true, Heartbeat: true},
		Heartbeat:         config.Heartbeat{Interval: 50 * time.Minute},
	}
}

func runAssemble(t *testing.T, cfg config.Config) (names []string, logs string) {
	var b strings.Builder
	logger := func(f string, a ...any) { fmt.Fprintf(&b, f+"\n", a...) }
	concerns, err := assemble(cfg, logger)
	if err != nil {
		t.Fatalf("assemble: %v (a missing origin must turn collect off, not stop serve)", err)
	}
	for _, c := range concerns {
		names = append(names, c.Name())
	}
	return names, b.String()
}

func has(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// startupLine is the "ccx-agent serving (...)" line, or "" when none was logged.
func startupLine(logs string) string {
	for _, l := range strings.Split(logs, "\n") {
		if strings.HasPrefix(l, "ccx-agent serving (") {
			return l
		}
	}
	return ""
}

// Without a machine or a user name assemble still builds the heartbeat and the
// API for serve to run: only collect (and what rides on it) is off, and the
// startup line says collect=false (#126, #257).
func TestAssembleWithoutOriginTurnsOnlyCollectOff(t *testing.T) {
	for name, cfg := range map[string]config.Config{
		"no user":    assembleConfig(t, "box", ""),
		"no machine": assembleConfig(t, "", "alice"),
	} {
		t.Run(name, func(t *testing.T) {
			names, logs := runAssemble(t, cfg)
			if has(names, "collect") {
				t.Errorf("concerns %v: collect is built without an origin", names)
			}
			for _, want := range []string{"heartbeat", "api"} {
				if !has(names, want) {
					t.Errorf("concerns %v: %s is missing; only collect should be off", names, want)
				}
			}
			if !strings.Contains(logs, "collect off (and the live transcript with it): no ") {
				t.Errorf("logs %q: want the reason collect is off", logs)
			}
			line := startupLine(logs)
			if !strings.Contains(line, " collect=false ") || !strings.Contains(line, " heartbeat=true ") {
				t.Errorf("startup line %q: want collect=false and heartbeat=true", line)
			}
		})
	}
}

// The control: with both names the same Config builds collect and says so, so
// the test above is not passing because collect never gets built here.
func TestAssembleWithOriginBuildsCollect(t *testing.T) {
	names, logs := runAssemble(t, assembleConfig(t, "box", "alice"))
	for _, want := range []string{"collect", "heartbeat", "api"} {
		if !has(names, want) {
			t.Errorf("concerns %v: %s is missing", names, want)
		}
	}
	if strings.Contains(logs, "collect off") {
		t.Errorf("logs %q: collect reported off with both names set", logs)
	}
	if line := startupLine(logs); !strings.Contains(line, " collect=true ") {
		t.Errorf("startup line %q: want collect=true", line)
	}
}

// What rides on collect goes with it: with an http hub and the live transcript
// on, a missing user name builds neither the live transcript, resume nor the
// message relay (which the center keys by machine and user too), while
// the same Config with both names builds both. Nothing is run, so the
// unreachable hub is never dialled and the stub ccx never executed.
func TestAssembleWithoutOriginDropsWhatRidesOnCollect(t *testing.T) {
	// Resume is built only when it finds a ccx CLI to resume with.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ccx"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)

	withHub := func(cfg config.Config) config.Config {
		cfg.HubURL = "http://127.0.0.1:1"
		cfg.Transcript.Live = true
		return cfg
	}

	names, _ := runAssemble(t, withHub(assembleConfig(t, "box", "")))
	for _, gone := range []string{"collect", "livetranscript", "resume", "message-relay"} {
		if has(names, gone) {
			t.Errorf("no user: concerns %v: %s is built without an origin", names, gone)
		}
	}
	if !has(names, "api") || !has(names, "heartbeat") {
		t.Errorf("no user: concerns %v: want the heartbeat and the API", names)
	}

	names, _ = runAssemble(t, withHub(assembleConfig(t, "box", "alice")))
	for _, want := range []string{"livetranscript", "resume", "message-relay"} {
		if !has(names, want) {
			t.Errorf("both names: concerns %v: want %s, or the check above sees nothing", names, want)
		}
	}
}

// Collect turned off in config is not a missing origin: no reason is logged,
// and the heartbeat and the API still run.
func TestAssembleCollectOffInConfigSaysNothing(t *testing.T) {
	cfg := assembleConfig(t, "", "")
	cfg.Concerns.Collect = false
	names, logs := runAssemble(t, cfg)
	if has(names, "collect") || !has(names, "api") || !has(names, "heartbeat") {
		t.Errorf("concerns %v: want the heartbeat and the API without collect", names)
	}
	if strings.Contains(logs, "collect off") {
		t.Errorf("logs %q: collect was turned off in config, not for a missing origin", logs)
	}
	if line := startupLine(logs); !strings.Contains(line, " collect=false ") {
		t.Errorf("startup line %q: want collect=false", line)
	}
}

// Reaping runs inside the heartbeat concern: with it off the setting does
// nothing, and the log says so rather than leaving reap=on silently idle.
func TestAssembleSaysReapingNeedsTheHeartbeat(t *testing.T) {
	for name, tc := range map[string]struct {
		heartbeat bool
		interval  time.Duration
		say       bool
	}{
		"heartbeat concern off":   {heartbeat: false, interval: 50 * time.Minute, say: true},
		"heartbeat interval is 0": {heartbeat: true, interval: 0, say: true},
		"heartbeat concern is on": {heartbeat: true, interval: 50 * time.Minute, say: false},
	} {
		t.Run(name, func(t *testing.T) {
			cfg := assembleConfig(t, "box", "alice")
			cfg.Concerns.Heartbeat, cfg.Heartbeat.Interval = tc.heartbeat, tc.interval
			cfg.Reap = config.Reap{Enabled: true, Interval: time.Minute}
			_, logs := runAssemble(t, cfg)
			got := strings.Contains(logs, "reap on but the heartbeat concern is off: nothing will be reaped")
			if got != tc.say {
				t.Errorf("logs %q: said=%v, want %v", logs, got, tc.say)
			}
		})
	}

	cfg := assembleConfig(t, "box", "alice")
	cfg.Concerns.Heartbeat = false
	_, logs := runAssemble(t, cfg)
	if strings.Contains(logs, "reap on but") {
		t.Errorf("logs %q: said reap was on when it is off", logs)
	}
}

// The reaper hands each stop to collect's spool when collect is on, and has
// nowhere to hand it otherwise.
func TestAssembleWiresTheReapRecordToCollect(t *testing.T) {
	for name, collectOn := range map[string]bool{"collect on": true, "collect off": false} {
		t.Run(name, func(t *testing.T) {
			cfg := assembleConfig(t, "box", "alice")
			cfg.Concerns.Collect = collectOn
			concerns, err := assemble(cfg, func(string, ...any) {})
			if err != nil {
				t.Fatal(err)
			}
			var h *heartbeat.Concern
			for _, c := range concerns {
				if hc, ok := c.(*heartbeat.Concern); ok {
					h = hc
				}
			}
			if h == nil {
				t.Fatal("no heartbeat concern built")
			}
			if !collectOn {
				if h.Record != nil {
					t.Error("Record is set with collect off")
				}
				return
			}
			if h.Record == nil {
				t.Fatal("Record is not set with collect on")
			}
			const payload = `{"session_id":"s","reaped":{"pid":7}}`
			if err := h.Record([]byte(payload)); err != nil {
				t.Fatal(err)
			}
			spool, err := collect.OpenSpool(cfg.SpoolDir, &ccxv1.Origin{Machine: "box", User: "alice"})
			if err != nil {
				t.Fatal(err)
			}
			e, err := spool.Oldest()
			if err != nil || e == nil {
				t.Fatalf("nothing was spooled: %v, %v", e, err)
			}
			if e.Event.GetProducer() != ccxv1.Producer_PRODUCER_CCX_AGENT_REAPED || string(e.Event.GetPayload()) != payload {
				t.Errorf("spooled event = producer %v payload %q, want CCX_AGENT_REAPED and the payload as given", e.Event.GetProducer(), e.Event.GetPayload())
			}
		})
	}
}

func TestAssembleLogsWhyReapingIsOff(t *testing.T) {
	cfg := assembleConfig(t, "box", "alice")
	cfg.Reap = config.Reap{Err: fmt.Errorf("reap: interval soon: want a duration")}
	_, logs := runAssemble(t, cfg)
	if !strings.Contains(logs, "reap off: reap: interval soon: want a duration\n") {
		t.Errorf("logs %q: want the reason reaping is off", logs)
	}
}

// A session is expired only once keepalive has let go of it (maxIdle); with no
// cap that never happens, and serve says so once at startup.
func TestAssembleSaysReapingNeedsAHeartbeatMaxIdle(t *testing.T) {
	for name, tc := range map[string]struct {
		reap    bool
		maxIdle time.Duration
		say     bool
	}{
		"reap on, maxIdle off":  {reap: true, maxIdle: 0, say: true},
		"reap on, maxIdle set":  {reap: true, maxIdle: 12 * time.Hour},
		"reap off, maxIdle off": {reap: false, maxIdle: 0},
	} {
		t.Run(name, func(t *testing.T) {
			cfg := assembleConfig(t, "box", "alice")
			cfg.Heartbeat.MaxIdle = tc.maxIdle
			cfg.Reap = config.Reap{Enabled: tc.reap, Interval: time.Minute}
			_, logs := runAssemble(t, cfg)
			got := strings.Count(logs, "reap on but the heartbeat maxIdle is off: nothing will be reaped\n")
			if want := map[bool]int{true: 1, false: 0}[tc.say]; got != want {
				t.Errorf("logs %q: said %d times, want %d", logs, got, want)
			}
		})
	}
}
