// Command ccx-agent is the resident agent, one process per machine, run as the
// invoking user (never root, #90). It is a modular monolith (ADR 0002): one
// binary, role subcommands, its jobs (collect / carry / persistence) as separate
// internal modules that each toggle on and off in config.
//
//	ccx-agent hook     thin: read a hook payload from stdin, hand it to the running
//	                   ccx-agent over the local socket, exit. Wired into Claude Code hooks.
//	ccx-agent serve    resident: run every enabled concern until stopped.
//	ccx-agent channel  per session: the MCP channel server Claude Code spawns
//	                   over stdio. Pushes what serve sends it (docs/design/heartbeat.md).
//	ccx-agent status   ask the running serve about one session (AgentService).
//
// In #90 only the collect concern is built (hooks → center). Carry (#23) and
// persistence (#20) slot into the same runner when built.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/TakashiAihara/ccx/apps/agent/internal/api"
	"github.com/TakashiAihara/ccx/apps/agent/internal/channel"
	"github.com/TakashiAihara/ccx/apps/agent/internal/collect"
	"github.com/TakashiAihara/ccx/apps/agent/internal/concern"
	"github.com/TakashiAihara/ccx/apps/agent/internal/heartbeat"
	"github.com/TakashiAihara/ccx/packages/core/config"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// version is stamped by the release (-ldflags "-X main.version=...") with the same
// version as the ccx CLI in that release: both come from one tag of one repo.
var version = "0.0.0-dev"

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
	case "status":
		return cmdStatus(args[1:])
	case "version", "--version":
		fmt.Println(version)
		return 0
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
	srv := &api.Server{ClaudeHome: claudeHome()}
	if cfg.Concerns.Collect {
		c, err := collect.New(cfg, logger)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ccx-agent: collect: %v\n", err)
			return 1
		}
		concerns = append(concerns, c)
		srv.Collect = c
	}
	if cfg.Heartbeat.Err != nil {
		logger("heartbeat off: %v", cfg.Heartbeat.Err)
	}
	if cfg.Concerns.Heartbeat && cfg.Heartbeat.Interval > 0 {
		h := heartbeat.New(cfg, logger)
		concerns = append(concerns, h)
		srv.Heartbeat = h
	}
	// Not a toggle: the API only reads, and it is how a person sees the rest.
	concerns = append(concerns, api.New(cfg, srv, logger))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger("ccx-agent serving (machine=%s user=%s hub=%q collect=%v heartbeat=%v interval=%v default=%v)",
		cfg.Machine, cfg.User, cfg.HubURL, cfg.Concerns.Collect,
		cfg.Concerns.Heartbeat, cfg.Heartbeat.Interval, cfg.Heartbeat.Default)
	if err := concern.Run(ctx, logger, concerns...); err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent: %v\n", err)
		return 1
	}
	return 0
}

// cmdChannel is the per-session MCP channel server Claude Code spawns over
// stdio. It pushes what ccx-agent serve sends for this session; the deciding
// (when a heartbeat is due) happens in serve. With serve down it still serves
// MCP and keeps retrying: a channel must never fail the session.
func cmdChannel() int {
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	if sid == "" {
		// serve addresses a session by this id. Without one there is nothing to
		// register, and saying so beats sitting silent.
		fmt.Fprintln(os.Stderr, "ccx-agent channel: needs CLAUDE_CODE_SESSION_ID; it is meant to be spawned by Claude Code")
		return 2
	}
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }

	// No signal handling: Serve blocks on stdin, so a caught SIGTERM would leave
	// the process up. Default termination is what a stdio child wants.
	srv := channel.NewServer("ccx", "0", os.Stdout)
	go func() {
		<-srv.Ready()
		// A broken config must not take the session's MCP server down, and fixing
		// it must not need a session restart: read it again until it loads.
		for said := false; ; time.Sleep(time.Minute) {
			cfg, err := config.Load()
			if err == nil {
				channel.Relay(context.Background(), cfg.ChannelSocketPath, sid, os.Getenv("CLAUDE_CONFIG_DIR"), srv, logf)
				return
			}
			if !said {
				logf("ccx-agent channel: config: %v; not relaying until it loads", err)
				said = true
			}
		}
	}()
	if err := srv.Serve(os.Stdin); err != nil {
		logf("ccx-agent channel: %v", err)
		return 1
	}
	return 0
}

// cmdStatus asks the running serve. With serve down it prints nothing on
// stdout and exits 1: statusline shows nothing rather than a stale value read
// some other way.
func cmdStatus(args []string) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	sid := fs.String("session", "", "Claude Code session id")
	// Accepted and ignored: JSON is the only output. Callers (statusline) spell
	// the format they rely on, so a later human-readable default does not break them.
	fs.Bool("json", false, "print JSON (currently the only output; accepted so callers can say so)")
	timeout := fs.Duration("timeout", 500*time.Millisecond, "give up after this long")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	// Checked here, not left to serve: a caller's mistake must read the same
	// (exit 2) whether or not serve is up.
	if !api.ValidSessionID(*sid) {
		fmt.Fprintf(os.Stderr, "ccx-agent status: --session %q is not a Claude Code session id\n", *sid)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	res, err := api.UnixClient(config.APISocket()).GetSessionStatus(ctx, connect.NewRequest(&ccxv1.GetSessionStatusRequest{
		SessionId: *sid, ClaudeHome: os.Getenv("CLAUDE_CONFIG_DIR"),
	}))
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent status: %v\n", err)
		return 1
	}
	b, err := protojson.MarshalOptions{EmitUnpopulated: true}.Marshal(res.Msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ccx-agent status: %v\n", err)
		return 1
	}
	fmt.Println(string(b))
	return 0
}

func claudeHome() string {
	if h := os.Getenv("CLAUDE_CONFIG_DIR"); h != "" {
		return h
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".claude")
}

func usage() {
	fmt.Fprint(os.Stderr, `ccx-agent — ccx resident agent

usage:
  ccx-agent serve    run the resident agent (the enabled concerns)
  ccx-agent hook     forward one hook payload from stdin to the running agent
  ccx-agent channel  the per-session MCP channel server (spawned by Claude Code)
  ccx-agent status --session <id> [--json]
                     ask the running serve about one session; prints JSON
  ccx-agent version  print the version

ccx-agent runs as your user, never root. See docs for the systemd user unit.
`)
}
