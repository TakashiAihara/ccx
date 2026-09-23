// Command ccx-agent is the resident agent, one process per machine, run as the
// invoking user (never root, #90). It is a modular monolith (ADR 0002): one
// binary, role subcommands, its jobs (collect / carry / persistence) as separate
// internal modules that each toggle on and off in config.
//
//	ccx-agent hook     thin: read a hook payload from stdin, hand it to the running
//	                   ccx-agent over the local socket, exit. Wired into Claude Code hooks.
//	ccx-agent serve    resident: run every enabled concern until stopped.
//	ccx-agent channel  per session: the MCP channel server Claude Code spawns
//	                   over stdio. Keeps the prompt cache warm (docs/design/heartbeat.md).
//
// In #90 only the collect concern is built (hooks → center). Carry (#23) and
// persistence (#20) slot into the same runner when built.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/channel"
	"github.com/TakashiAihara/ccx/apps/agent/internal/collect"
	"github.com/TakashiAihara/ccx/apps/agent/internal/concern"
	"github.com/TakashiAihara/ccx/packages/core/config"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}

	switch args[0] {
	case "hook":
		return cmdHook()
	case "serve":
		return cmdServe()
	case "channel":
		return cmdChannel()
	case "-h", "--help", "help":
		usage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "ccx-agent: unknown command %q\n\n", args[0])
		usage()
		return 2
	}
}

// cmdHook is the thin path. It resolves only the paths it needs and returns
// fast. It never fails the session: collect.Hook always returns 0.
func cmdHook() int {
	cfg, err := config.Load()
	if err != nil {
		// Even a broken config must not fail a session's hook. Fall back to the
		// default spool location so the event is still captured.
		home, herr := os.UserHomeDir()
		if herr != nil {
			// No home either — nowhere sensible to spool. Do not fail the session
			// over it; the socket may still be reachable at its default path.
			return collect.Hook("", os.TempDir()+"/ccx-spool", os.Stdin)
		}
		return collect.Hook("", filepath.Join(home, ".ccx", "spool"), os.Stdin)
	}
	return collect.Hook(cfg.SocketPath, cfg.SpoolDir, os.Stdin)
}

func cmdServe() int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent: config: %v\n", err)
		return 1
	}

	logger := func(format string, a ...any) { log.Printf(format, a...) }

	// Assemble the enabled concerns (ADR 0002). Only collect is built in #90;
	// carry and persistence append here the same way when they exist.
	var concerns []concern.Concern
	if cfg.Concerns.Collect {
		c, err := collect.New(cfg, logger)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ccx-agent: collect: %v\n", err)
			return 1
		}
		concerns = append(concerns, c)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger("ccx-agent serving (machine=%s user=%s hub=%q collect=%v)",
		cfg.Machine, cfg.User, cfg.HubURL, cfg.Concerns.Collect)
	if err := concern.Run(ctx, logger, concerns...); err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent: %v\n", err)
		return 1
	}
	return 0
}

// cmdChannel is the per-session MCP channel server Claude Code spawns over
// stdio. It stands alone: no ccx-agent serve, no center (scope.md, the invariant).
func cmdChannel() int {
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	if sid == "" {
		// The heartbeat's clock is this session's transcript. Without an id there is
		// nothing to keep warm, and saying so beats sitting silent.
		fmt.Fprintln(os.Stderr, "ccx-agent channel: needs CLAUDE_CODE_SESSION_ID; it is meant to be spawned by Claude Code")
		return 2
	}
	interval, err := envDuration("CCX_HEARTBEAT_INTERVAL", 50*time.Minute)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent channel: %v\n", err)
		return 2
	}
	maxIdle, err := envDuration("CCX_HEARTBEAT_MAX_IDLE", 12*time.Hour)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent channel: %v\n", err)
		return 2
	}
	home := os.Getenv("CLAUDE_CONFIG_DIR")
	if home == "" {
		h, _ := os.UserHomeDir()
		home = filepath.Join(h, ".claude")
	}

	srv := channel.NewServer("ccx", "0", os.Stdout)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if interval > 0 {
		hb := &channel.Heartbeat{
			SessionID: sid, ClaudeHome: home, Interval: interval, MaxIdle: maxIdle,
			Push: func() error {
				return srv.Push("heartbeat", map[string]string{"kind": "heartbeat"})
			},
			Log: func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) },
			Now: time.Now,
			Sleep: func(ctx context.Context, d time.Duration) {
				select {
				case <-ctx.Done():
				case <-time.After(d):
				}
			},
		}
		go hb.Run(ctx)
	}
	if err := srv.Serve(os.Stdin); err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent channel: %v\n", err)
		return 1
	}
	return 0
}

// envDuration reads a Go duration; "0" or "off" turns the thing off (0).
func envDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	switch v {
	case "":
		return def, nil
	case "off":
		return 0, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("%s=%q: want a duration like 50m, or off", key, v)
	}
	return d, nil
}

func usage() {
	fmt.Fprint(os.Stderr, `ccx-agent — ccx resident agent

usage:
  ccx-agent serve    run the resident agent (the enabled concerns)
  ccx-agent hook     forward one hook payload from stdin to the running agent
  ccx-agent channel  the per-session MCP channel server (spawned by Claude Code)

ccx-agent runs as your user, never root. See docs for the systemd user unit.
`)
}
