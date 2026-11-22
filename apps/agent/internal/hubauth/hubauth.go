// Package hubauth attaches the center's shared token to ccx-agent's Connect
// calls (#158). One place, so collect and carry cannot drift apart on how they
// authenticate.
package hubauth

import (
	"context"
	"net/http"

	"connectrpc.com/connect"
)

// Options returns the client options for a center that wants token. An empty
// token adds nothing: the center without CCX_CENTER_TOKEN is open, and a
// header with an empty Bearer would only be refused by one that is not.
func Options(token string) []connect.ClientOption {
	if token == "" {
		return nil
	}
	return []connect.ClientOption{connect.WithInterceptors(bearer(token))}
}

func bearer(token string) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			req.Header().Set("Authorization", "Bearer "+token)
			return next(ctx, req)
		}
	}
}

// Client returns the HTTP client every ccx-agent call to the center goes
// through. It follows no redirect: Go keeps Authorization on a redirect to the
// same hostname or a subdomain of it whatever the scheme and port, so an https
// center answering with a redirect to http would get the token sent in cleartext
// (#306). The center's RPCs never redirect, so a 3xx is returned as is and the
// call fails instead. A fresh client each time, so no caller can loosen the
// policy for the others.
func Client() *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}
