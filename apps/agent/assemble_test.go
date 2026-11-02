package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/ccx/packages/core/config"
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

// Without a machine or a user name serve keeps running: only collect (and what
// rides on it) is off, the heartbeat and the API stay, and the startup line
// says collect=false (#126, #257).
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
// on, a missing user name builds neither the live transcript nor resume, while
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
	for _, gone := range []string{"collect", "livetranscript", "resume"} {
		if has(names, gone) {
			t.Errorf("no user: concerns %v: %s is built without an origin", names, gone)
		}
	}
	if !has(names, "api") || !has(names, "heartbeat") {
		t.Errorf("no user: concerns %v: want the heartbeat and the API", names)
	}

	names, _ = runAssemble(t, withHub(assembleConfig(t, "box", "alice")))
	for _, want := range []string{"livetranscript", "resume"} {
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
