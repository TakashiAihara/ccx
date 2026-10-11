package testsock

import (
	"strings"
	"testing"
)

func TestPathIsShortWhateverTMPDIR(t *testing.T) {
	t.Setenv("TMPDIR", "/tmp/"+strings.Repeat("x", 120))
	p := Path(t, "ccx-agent.sock")
	if !strings.HasPrefix(p, "/tmp/ccx-t") || len(p) >= 104 {
		t.Fatalf("socket path %q (%d bytes) is not short", p, len(p))
	}
}
