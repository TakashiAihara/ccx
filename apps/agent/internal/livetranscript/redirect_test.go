package livetranscript

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

	_, err := NewClient(r.URL, "tok", &ccxv1.Origin{}, "b", "p").Append(context.Background(), "s", 0, []byte("x"), nil)
	if err == nil {
		t.Fatal("call succeeded against a center that only redirects")
	}
	if r.Hits() != 0 {
		t.Fatalf("redirect followed: %d call(s) reached the target", r.Hits())
	}
}
