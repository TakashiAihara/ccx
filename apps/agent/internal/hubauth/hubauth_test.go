package hubauth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientDoesNotFollowHTTPSToHTTPRedirect(t *testing.T) {
	leaked := make(chan string, 1)
	plain := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		if got == "" {
			got = "(reached without a token)"
		}
		leaked <- got
	}))
	defer plain.Close()
	center := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer center.Close()
	// The production client with only the test certificate trusted, so the
	// redirect policy under test is the shipped one.
	c := Client()
	c.Transport = center.Client().Transport

	req, err := http.NewRequest(http.MethodPost, center.URL+"/ccx.v1.IngestService/Ingest", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret-token")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	select {
	case got := <-leaked:
		t.Fatalf("the http server got a call, Authorization %q", got)
	default:
	}
	if res.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want the 307 returned as is", res.StatusCode)
	}
}
