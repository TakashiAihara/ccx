package livetranscript

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

type handler struct {
	ccxv1connect.UnimplementedTranscriptServiceHandler
	got  *ccxv1.AppendRequest
	auth string
	size uint64
	err  error
}

func (h *handler) Append(_ context.Context, req *connect.Request[ccxv1.AppendRequest]) (*connect.Response[ccxv1.AppendResponse], error) {
	h.got = req.Msg
	h.auth = req.Header().Get("Authorization")
	if h.err != nil {
		return nil, h.err
	}
	return connect.NewResponse(&ccxv1.AppendResponse{Size: h.size}), nil
}

func serve(t *testing.T, h *handler) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(ccxv1connect.NewTranscriptServiceHandler(h))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestClientSendsWhereAndWhoseTranscript(t *testing.T) {
	h := &handler{size: 12}
	c := NewClient(serve(t, h), "tok", &ccxv1.Origin{Machine: "m1", User: "dev"}, "ccx", "lead/")

	size, err := c.Append(context.Background(), sid, 4, []byte("abcdefgh\n"), []byte("abc\n"))
	if err != nil || size != 12 {
		t.Fatalf("Append = %d, %v; want 12, nil", size, err)
	}
	g := h.got
	if g.GetSessionId() != sid || g.GetOffset() != 4 || string(g.GetData()) != "abcdefgh\n" ||
		g.GetBucket() != "ccx" || g.GetPrefix() != "lead/" || string(g.GetExpectedTail()) != "abc\n" ||
		g.GetOrigin().GetMachine() != "m1" || g.GetOrigin().GetUser() != "dev" {
		t.Fatalf("request = %v", g)
	}
	if h.auth != "Bearer tok" {
		t.Fatalf("Authorization = %q, want the hub token", h.auth)
	}
}

func TestClientTurnsARefusalIntoMismatchWithTheCentersSize(t *testing.T) {
	refusal := connect.NewError(connect.CodeFailedPrecondition, errors.New("offset 0 != size 40"))
	if d, err := connect.NewErrorDetail(&ccxv1.AppendResponse{Size: 40}); err == nil {
		refusal.AddDetail(d)
	} else {
		t.Fatal(err)
	}
	c := NewClient(serve(t, &handler{err: refusal}), "", &ccxv1.Origin{Machine: "m1", User: "dev"}, "ccx", "")

	_, err := c.Append(context.Background(), sid, 0, []byte("x\n"), nil)
	var m *Mismatch
	if !errors.As(err, &m) || m.Size != 40 {
		t.Fatalf("err = %v, want *Mismatch{Size: 40}", err)
	}
}

func TestClientDoesNotMistakeOtherErrorsForMismatch(t *testing.T) {
	for _, e := range []error{
		connect.NewError(connect.CodeUnavailable, errors.New("down")),
		connect.NewError(connect.CodeInvalidArgument, errors.New("bad key")),
		// a FailedPrecondition without the size detail is not a usable refusal
		connect.NewError(connect.CodeFailedPrecondition, errors.New("no detail")),
	} {
		c := NewClient(serve(t, &handler{err: e}), "", &ccxv1.Origin{Machine: "m1", User: "dev"}, "ccx", "")
		_, err := c.Append(context.Background(), sid, 0, []byte("x\n"), nil)
		var m *Mismatch
		if err == nil || errors.As(err, &m) {
			t.Fatalf("%v came back as %v", e, err)
		}
	}
}

func TestClientSortsRefusalsThatRetryingCannotFix(t *testing.T) {
	cases := []struct {
		code   connect.Code
		global bool
	}{
		{connect.CodeUnimplemented, true},
		{connect.CodeUnauthenticated, true},
		{connect.CodePermissionDenied, true},
		{connect.CodeInvalidArgument, true},
		{connect.CodeDataLoss, false},
	}
	for _, tc := range cases {
		c := NewClient(serve(t, &handler{err: connect.NewError(tc.code, errors.New("no"))}), "", &ccxv1.Origin{Machine: "m1", User: "dev"}, "ccx", "")
		_, err := c.Append(context.Background(), sid, 0, []byte("x\n"), nil)
		var p *Permanent
		if !errors.As(err, &p) || p.Global != tc.global {
			t.Fatalf("%v came back as %#v, want *Permanent{Global: %v}", tc.code, err, tc.global)
		}
	}
	// a center that is down is not permanent
	c := NewClient(serve(t, &handler{err: connect.NewError(connect.CodeUnavailable, errors.New("down"))}), "", &ccxv1.Origin{Machine: "m1", User: "dev"}, "ccx", "")
	_, err := c.Append(context.Background(), sid, 0, []byte("x\n"), nil)
	var p *Permanent
	if errors.As(err, &p) {
		t.Fatalf("Unavailable came back as permanent: %v", err)
	}
}
