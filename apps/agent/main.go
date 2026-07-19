// Command ccxd is the resident agent, one process per machine, run as the
// invoking user (never root, #90).
//
// In #90 it does exactly one thing: collect hook data and carry it to the
// center. It has two subcommands —
//
//	ccxd hook     thin: read a hook payload from stdin, hand it to the running
//	              ccxd over the local socket, exit. Wired into Claude Code hooks.
//	ccxd serve    resident: own the socket, spool what arrives, forward it to
//	              the center, retry on outage, lose nothing across restarts.
//
// Everything else ccxd will eventually do — observe repodirs, start sessions,
// deliver channels, threshold warnings — sits on top of this and is out of
// scope here (#7, #20, #23, #83).
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/TakashiAihara/ccx/packages/core/config"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
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

// cmdHook is the thin path. It resolves only the two paths it needs (socket to
// write to, incoming dir to fall back to) and returns fast. It never fails the
// session: runHook always returns 0.
func cmdHook() int {
	cfg, err := config.Load()
	if err != nil {
		// Even a broken config must not fail a session's hook. Fall back to the
		// default incoming location so the event is still captured.
		home, _ := os.UserHomeDir()
		return runHook("", incomingPath(home+"/.ccx/spool"), os.Stdin)
	}
	return runHook(cfg.SocketPath, incomingPath(cfg.SpoolDir), os.Stdin)
}

func cmdServe() int {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccxd: config: %v\n", err)
		return 1
	}

	logger := func(format string, a ...any) { log.Printf(format, a...) }

	origin := &ccxv1.Origin{Machine: cfg.Machine, User: cfg.User}
	spool, err := OpenSpool(cfg.SpoolDir, origin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccxd: spool: %v\n", err)
		return 1
	}

	forwarder := NewForwarder(cfg.HubURL)
	srv := NewServer(cfg.SocketPath, spool, forwarder, logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger("ccxd serving on %s (machine=%s user=%s hub=%q)",
		cfg.SocketPath, cfg.Machine, cfg.User, cfg.HubURL)
	if err := srv.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "ccxd: %v\n", err)
		return 1
	}
	return 0
}

func usage() {
	fmt.Fprint(os.Stderr, `ccxd — ccx resident agent

usage:
  ccxd serve    run the resident agent (socket + spool + forward)
  ccxd hook     forward one hook payload from stdin to the running agent

ccxd runs as your user, never root. See docs for the systemd user unit.
`)
}
