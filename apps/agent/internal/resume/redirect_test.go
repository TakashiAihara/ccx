package resume

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// A center that redirects must not get the token carried to the redirect's target (#306).
func TestCenterCallDoesNotFollowRedirect(t *testing.T) {
	r := testcenter.StartRedirector()
	defer r.Close()

	c := NewCenter(r.URL, "tok")
	_, _ = c.Ingest(context.Background(), connect.NewRequest(&ccxv1.IngestRequest{}))
	_, _ = c.ClaimResume(context.Background(), connect.NewRequest(&ccxv1.ClaimResumeRequest{}))
	if r.Asked() != 2 {
		t.Fatalf("the center got %d call(s), want 2", r.Asked())
	}
	if r.Hits() != 0 {
		t.Fatalf("redirect followed: %d call(s) reached the target", r.Hits())
	}
}
