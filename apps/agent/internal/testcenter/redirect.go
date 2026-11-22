package testcenter

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
)

// Redirector stands in for a center that answers every call with a 307 to
// another server (#306). Hits counts the calls that reached the other server: a
// client that follows the redirect carries the center token there.
type Redirector struct {
	URL    string
	hits   atomic.Int32
	asked  atomic.Int32
	center *httptest.Server
	target *httptest.Server
}

// StartRedirector brings up the redirecting center and the server it points at.
func StartRedirector() *Redirector {
	r := &Redirector{}
	r.target = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		r.hits.Add(1)
	}))
	r.center = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.asked.Add(1)
		http.Redirect(w, req, r.target.URL+req.URL.Path, http.StatusTemporaryRedirect)
	}))
	r.URL = r.center.URL
	return r
}

// Asked is the number of calls the redirecting center got, so a test can tell
// a client that never called from one that did not follow.
func (r *Redirector) Asked() int { return int(r.asked.Load()) }

// Hits is the number of calls that followed the redirect.
func (r *Redirector) Hits() int { return int(r.hits.Load()) }

// Close shuts both servers down.
func (r *Redirector) Close() {
	r.center.Close()
	r.target.Close()
}
