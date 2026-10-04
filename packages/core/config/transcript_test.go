package config

import (
	"os"
	"path/filepath"
	"testing"
)

// The live transcript (#120, docs/design/live-transcript.md) appends to the
// store's transcript.jsonl through the center, so the agent has to resolve the
// same store the CLI does (packages/core/src/config.ts). The store is always
// the center (#210).

func withFile(t *testing.T, toml string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(p, []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func loadT(t *testing.T, e map[string]string, git func(string) string) Config {
	t.Helper()
	if _, ok := e["CCX_CONFIG"]; !ok {
		e["CCX_CONFIG"] = filepath.Join(t.TempDir(), "absent.toml")
	}
	c, err := load(env(e), git, fixedHost("h"))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestTranscript_DefaultsToTheCenterWithLiveOn(t *testing.T) {
	c := loadT(t, map[string]string{"CCX_HUB_URL": "http://center:8791"}, noGit)
	tr := c.Transcript
	if !tr.Live || tr.Bucket != "ccx" || tr.Prefix != "" {
		t.Fatalf("Transcript = %+v, want live on, bucket ccx, no prefix", tr)
	}
}

func TestIsHTTP_OnlyAnHTTPHubHasAnObjectAPI(t *testing.T) {
	for _, u := range []string{"http://center:8791", "https://center"} {
		if !IsHTTP(u) {
			t.Errorf("IsHTTP(%q) = false", u)
		}
	}
	for _, u := range []string{"", "nats://broker:4222"} {
		if IsHTTP(u) {
			t.Errorf("IsHTTP(%q) = true: nothing to append to", u)
		}
	}
}

func TestTranscript_LiveCanBeTurnedOff(t *testing.T) {
	hub := "http://center:8791"
	if tr := loadT(t, map[string]string{"CCX_HUB_URL": hub, "CCX_TRANSCRIPT_LIVE": "off"}, noGit).Transcript; tr.Live {
		t.Fatalf("env off: %+v", tr)
	}
	p := withFile(t, "[transcript]\nlive = false\n")
	if tr := loadT(t, map[string]string{"CCX_HUB_URL": hub, "CCX_CONFIG": p}, noGit).Transcript; tr.Live {
		t.Fatalf("file off: %+v", tr)
	}
	// env beats the file
	if tr := loadT(t, map[string]string{"CCX_HUB_URL": hub, "CCX_CONFIG": p, "CCX_TRANSCRIPT_LIVE": "on"}, noGit).Transcript; !tr.Live {
		t.Fatalf("env on over file off: %+v", tr)
	}
}

func TestTranscript_LiveHasNoGitConfigKey(t *testing.T) {
	// git config is being taken out of the resolution (kaneo ccx#24); a new key
	// does not start there.
	git := func(k string) string {
		if k == "ccx.transcriptLive" {
			return "off"
		}
		return ""
	}
	if tr := loadT(t, map[string]string{"CCX_HUB_URL": "http://center:8791"}, git).Transcript; !tr.Live {
		t.Fatalf("git config turned live off: %+v", tr)
	}
}

func TestTranscript_BucketAndPrefixResolveLikeTheCLI(t *testing.T) {
	p := withFile(t, "[transcript]\nbucket = \"file-bucket\"\nprefix = \"/lead/ing\"\n")
	tr := loadT(t, map[string]string{"CCX_HUB_URL": "http://center:8791", "CCX_CONFIG": p}, noGit).Transcript
	if tr.Bucket != "file-bucket" || tr.Prefix != "lead/ing/" {
		t.Fatalf("Transcript = %+v, want bucket file-bucket, prefix lead/ing/", tr)
	}

	git := func(k string) string {
		if k == "ccx.transcriptBucket" {
			return "git-bucket"
		}
		return ""
	}
	tr = loadT(t, map[string]string{"CCX_HUB_URL": "http://center:8791", "CCX_CONFIG": p, "CCX_TRANSCRIPT_PREFIX": "p"}, git).Transcript
	if tr.Bucket != "git-bucket" || tr.Prefix != "p/" {
		t.Fatalf("Transcript = %+v, want git's bucket and env's prefix", tr)
	}
}
