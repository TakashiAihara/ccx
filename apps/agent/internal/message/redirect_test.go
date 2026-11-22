package message

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/testcenter"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// A center that redirects must not get the call, and so the token, carried to
// the redirect's target (#306). hubauth's own test checks the header itself.
func TestCenterCallDoesNotFollowRedirect(t *testing.T) {
	r := testcenter.StartRedirector()
	defer r.Close()

	_, err := NewCenter(r.URL, "tok").PutMessage(context.Background(), connect.NewRequest(&ccxv1.PutMessageRequest{}))
	if r.Asked() == 0 {
		t.Fatalf("the center got no call (err %v)", err)
	}
	if r.Hits() != 0 {
		t.Fatalf("redirect followed: %d call(s) reached the target", r.Hits())
	}
}
