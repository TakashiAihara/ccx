package channel

import (
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

func metaOff() bool { return false }

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// repoAndHome is a checkout of o/r on feat/x, and a Claude Code home where sid declared label and role.
func repoAndHome(t *testing.T, label string) (string, string) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "feat/x")
	gitIn(t, repo, "remote", "add", "origin", "github.com:octo/repo.git")
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", sid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, v := range map[string]string{"label": label, "role": "impl\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return repo, home
}

func TestAutoMetaSaysTheSessionCwdRepoBranchLabelRoleAndTheMessageItAnswers(t *testing.T) {
	repo, home := repoAndHome(t, "reviewing #346\n")
	got := autoMeta(sid, home, repo, "m1")
	want := map[string]string{
		"from_session": sid, "from_cwd": repo, "from_repo": "octo/repo", "from_branch": "feat/x",
		"from_label": "reviewing #346", "from_role": "impl", "in_reply_to": "m1",
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestAutoMetaLeavesOutWhatItCannotFindOrShow(t *testing.T) {
	repo, home := repoAndHome(t, "two\nlines")
	gitIn(t, repo, "remote", "set-url", "origin", "https://example.com/team/tool")
	got := autoMeta(sid, home, repo, "")
	if got["from_repo"] != "team/tool" {
		t.Fatalf("repo from an https URL without .git: %v", got)
	}
	for _, k := range []string{"from_label", "in_reply_to"} {
		if _, ok := got[k]; ok {
			t.Fatalf("%s should be left out: %v", k, got)
		}
	}

	// Outside git: no repo and no branch, the rest still there.
	plain := t.TempDir()
	got = autoMeta(sid, home, plain, "")
	_, repoThere := got["from_repo"]
	_, branchThere := got["from_branch"]
	if repoThere || branchThere || got["from_cwd"] != plain || got["from_role"] != "impl" {
		t.Fatalf("outside git: %v", got)
	}
}

func TestSendToolAddsThisSessionsMetaUnlessTurnedOffAndAlwaysTheCallersOwn(t *testing.T) {
	repo, home := repoAndHome(t, "L")
	t.Chdir(repo)
	on := func() bool { return true }
	for _, tc := range []struct {
		name   string
		metaOn func() bool
		args   string
		auto   bool
	}{
		{"on", on, `{"target":"t","body":"b","summary":"s","meta":{"task":"kaneo ccx#75"}}`, true},
		{"no_meta", on, `{"target":"t","body":"b","summary":"s","no_meta":true,"meta":{"task":"kaneo ccx#75"}}`, false},
		{"config off", metaOff, `{"target":"t","body":"b","summary":"s","meta":{"task":"kaneo ccx#75"}}`, false},
	} {
		f := &fakeMessages{acks: []*ccxv1.SendResponse{{State: ccxv1.SendResponse_STATE_SENT}}}
		if text, isErr := call(t, SendTool(sid, home, tc.metaOn, messagesClient(t, f)), tc.args); isErr {
			t.Fatalf("%s: %s", tc.name, text)
		}
		m := f.got.GetSenderMeta()
		if m["meta_task"] != "kaneo ccx#75" {
			t.Fatalf("%s: the caller's own meta is always sent: %v", tc.name, m)
		}
		if !tc.auto && !maps.Equal(m, map[string]string{"meta_task": "kaneo ccx#75"}) {
			t.Fatalf("%s: only the caller's own meta, got %v", tc.name, m)
		}
		if tc.auto && (m["from_session"] != sid || m["from_repo"] != "octo/repo" || m["from_branch"] != "feat/x" || m["from_label"] != "L" || m["from_role"] != "impl" || m["from_cwd"] == "") {
			t.Fatalf("%s: meta %v", tc.name, m)
		}
	}
}

func TestAutoMetaGivesNoBranchOnADetachedCheckout(t *testing.T) {
	repo, home := repoAndHome(t, "L")
	gitIn(t, repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "c")
	gitIn(t, repo, "checkout", "-q", "--detach")
	if b, ok := autoMeta(sid, home, repo, "")["from_branch"]; ok {
		t.Fatalf("branch %q on a detached checkout", b)
	}
}

func TestRepoOfReadsOnlyThePathSoNoCredentialsLeak(t *testing.T) {
	for url, want := range map[string]string{
		"https://github.com/octo/repo.git":              "octo/repo",
		"https://user:secret@git.example/repo.git":      "",
		"https://user:secret@git.example/octo/repo.git": "octo/repo",
		"ssh://git@host:2222/octo/repo.git":             "octo/repo",
		"ssh://git@host/repo.git":                       "",
		"git@host:octo/repo.git":                        "octo/repo",
		"host:repo.git":                                 "",
		"https://gitlab.example/group/sub/repo/":        "sub/repo",
		"/srv/git/team/tool.git":                        "team/tool",
		"":                                              "",
	} {
		if got := repoOf(url); got != want {
			t.Errorf("repoOf(%q) = %q, want %q", url, got, want)
		}
	}
}
