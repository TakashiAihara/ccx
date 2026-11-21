package channel

import (
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/TakashiAihara/ccx/apps/agent/internal/declared"
	"github.com/TakashiAihara/ccx/apps/agent/internal/message"
)

// originRepo is owner/repo at the end of a remote URL (https, ssh or scp form).
var originRepo = regexp.MustCompile(`([^/:]+/[^/]+?)(\.git)?/?$`)

// autoMeta is what a send from this session says about itself (#346): its session id, cwd, the git repo and
// branch there, its declared label and role, and the msg_id it answers. A value it cannot find or show is
// left out.
func autoMeta(sessionID, home, cwd, replyTo string) map[string]string {
	m := map[string]string{message.MetaSession: sessionID, message.MetaCwd: cwd, message.MetaInReplyTo: replyTo}
	if url := gitOut(cwd, "remote", "get-url", "origin"); url != "" {
		if g := originRepo.FindStringSubmatch(url); g != nil {
			m[message.MetaRepo] = g[1]
		}
	}
	// Nothing on a detached checkout; a branch with no commit yet still has its name.
	m[message.MetaBranch] = gitOut(cwd, "symbolic-ref", "--short", "-q", "HEAD")
	dir := filepath.Join(home, "sessions", sessionID)
	m[message.MetaLabel] = declared.Text(filepath.Join(dir, "label"))
	m[message.MetaRole] = declared.Text(filepath.Join(dir, "role"))
	for k, v := range m {
		if v == "" || !message.MetaValueOK(v) {
			delete(m, k)
		}
	}
	return m
}

// gitOut is git's trimmed output in dir, or "" when git is missing, fails, or takes over 2 s.
func gitOut(dir string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

