// Command ccxd is the resident agent, one process per machine, run as the
// invoking user (never root, #90). It is a modular monolith (ADR 0002): one
// binary, role subcommands, its jobs (collect / carry / persistence) as separate
// internal modules that each toggle on and off in config.
//
//	ccxd hook     thin: read a hook payload from stdin, hand it to the running
//	              ccxd over the local socket, exit. Wired into Claude Code hooks.
//	ccxd serve    resident: run every enabled concern until stopped.
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
	"syscall"

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
	case "-h", "--help", "help":
		usage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "ccxd: unknown command %q\n\n", args[0])
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
		home, _ := os.UserHomeDir()
		return collect.Hook("", home+"/.ccx/spool", os.Stdin)
	}
	return collect.Hook(cfg.SocketPath, cfg.SpoolDir, os.Stdin)
}

func cmdServe() int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccxd: config: %v\n", err)
		return 1
	}

	logger := func(format string, a ...any) { log.Printf(format, a...) }

	// Assemble the enabled concerns (ADR 0002). Only collect is built in #90;
	// carry and persistence append here the same way when they exist.
	var concerns []concern.Concern
	if cfg.Concerns.Collect {
		c, err := collect.New(cfg, logger)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ccxd: collect: %v\n", err)
			return 1
		}
		concerns = append(concerns, c)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger("ccxd serving (machine=%s user=%s hub=%q collect=%v)",
		cfg.Machine, cfg.User, cfg.HubURL, cfg.Concerns.Collect)
	if err := concern.Run(ctx, logger, concerns...); err != nil {
		fmt.Fprintf(os.Stderr, "ccxd: %v\n", err)
		return 1
	}
	return 0
}

func usage() {
	fmt.Fprint(os.Stderr, `ccxd — ccx resident agent

usage:
  ccxd serve    run the resident agent (the enabled concerns)
  ccxd hook     forward one hook payload from stdin to the running agent

ccxd runs as your user, never root. See docs for the systemd user unit.
`)
}
