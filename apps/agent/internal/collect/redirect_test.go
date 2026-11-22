package collect

import (
	"context"
	"testing"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// A center that redirects must not get the token carried to the redirect's target (#306).
func TestCenterCallDoesNotFollowRedirect(t *testing.T) {
	r := testcenter.StartRedirector()
	defer r.Close()

	err := NewForwarder(r.URL, "tok").Forward(context.Background(), &ccxv1.Event{})
	if r.Asked() == 0 {
		t.Fatalf("the center got no call (err %v)", err)
	}
	if r.Hits() != 0 {
		t.Fatalf("redirect followed: %d call(s) reached the target", r.Hits())
	}
}
