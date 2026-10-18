package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/TakashiAihara/ccx/packages/core/config"
)

// advertisedAPIURL decides what the running list tells the center (#261, D-12):
// the configured url, but only when the TCP side it names will actually open
// (a listen address and a usable API token). Otherwise nothing, with the reason.
func TestAdvertisedAPIURL(t *testing.T) {
	ok := config.Config{APIURL: "http://10.0.0.5:8792", APIListen: "0.0.0.0:8792", APIToken: "tok-tok-tok-tok-tok"}
	if url, why := advertisedAPIURL(ok); url != "http://10.0.0.5:8792" || why != "" {
		t.Errorf("all set: %q %q", url, why)
	}
	for name, c := range map[string]config.Config{
		"no listen":   {APIURL: ok.APIURL, APIToken: ok.APIToken},
		"no token":    {APIURL: ok.APIURL, APIListen: ok.APIListen},
		"token error": {APIURL: ok.APIURL, APIListen: ok.APIListen, APIToken: ok.APIToken, APITokenErr: errors.New("same as the hub token")},
	} {
		url, why := advertisedAPIURL(c)
		if url != "" || !strings.Contains(why, "cannot wake") {
			t.Errorf("%s: url %q why %q, want none with a reason naming that the center cannot wake it", name, url, why)
		}
	}
	if url, why := advertisedAPIURL(config.Config{APIListen: ok.APIListen, APIToken: ok.APIToken}); url != "" || why != "" {
		t.Errorf("no url set: %q %q, want nothing and no complaint", url, why)
	}
}

func TestAdvertisedAPIURLNamesARefusedToken(t *testing.T) {
	_, why := advertisedAPIURL(config.Config{APIURL: "http://10.0.0.5:8792", APIListen: "0.0.0.0:8792", APITokenErr: errors.New("x")})
	if !strings.Contains(why, "token error") {
		t.Errorf("why %q, want the refused token named rather than read as a missing one", why)
	}
}
