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
	if _, err := c.Ingest(context.Background(), connect.NewRequest(&ccxv1.IngestRequest{})); err == nil {
		t.Fatal("Ingest succeeded against a center that only redirects")
	}
	if _, err := c.ClaimResume(context.Background(), connect.NewRequest(&ccxv1.ClaimResumeRequest{})); err == nil {
		t.Fatal("ClaimResume succeeded against a center that only redirects")
	}
	if r.Hits() != 0 {
		t.Fatalf("redirect followed: %d call(s) reached the target", r.Hits())
	}
}
