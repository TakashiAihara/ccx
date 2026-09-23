package channel

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestServe(t *testing.T) {
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"ping"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/list"}`,
	}, "\n") + "\n"
	var out bytes.Buffer
	s := NewServer("ccx", "0", &out)
	if err := s.Serve(strings.NewReader(in)); err != nil {
		t.Fatal(err)
	}
	if err := s.Push("heartbeat", map[string]string{"kind": "heartbeat"}); err != nil {
		t.Fatal(err)
	}

	var msgs []map[string]any
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("not JSON: %s", sc.Text())
		}
		msgs = append(msgs, m)
	}
	if len(msgs) != 4 {
		t.Fatalf("got %d messages, want 4 (no answer to a notification): %v", len(msgs), msgs)
	}
	init := msgs[0]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" {
		t.Errorf("protocolVersion = %v, want the client's echoed", init["protocolVersion"])
	}
	exp := init["capabilities"].(map[string]any)["experimental"].(map[string]any)
	if _, ok := exp["claude/channel"]; !ok {
		t.Error("claude/channel capability missing: the session would never register the channel")
	}
	if msgs[1]["result"] == nil {
		t.Error("ping unanswered")
	}
	if msgs[2]["error"] == nil {
		t.Error("unknown method answered as if it existed")
	}
	if msgs[3]["method"] != "notifications/claude/channel" {
		t.Errorf("push = %v", msgs[3])
	}
	params := msgs[3]["params"].(map[string]any)
	meta, _ := params["meta"].(map[string]any)
	if params["content"] != "heartbeat" || meta["kind"] != "heartbeat" {
		t.Errorf("push params = %v, want content and meta.kind", params)
	}
	// The session keeps a heartbeat turn short only because it is told to.
	if !strings.Contains(init["instructions"].(string), `kind="heartbeat"`) {
		t.Errorf("instructions do not say what to do with a heartbeat: %v", init["instructions"])
	}
	select {
	case <-s.Ready():
	default:
		t.Error("Ready not closed after notifications/initialized")
	}
}

func TestNotReadyBeforeInitialized(t *testing.T) {
	s := NewServer("ccx", "0", &bytes.Buffer{})
	_ = s.Serve(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n" +
		`{"jsonrpc":"2.0","method":"notifications/cancelled"}` + "\n"))
	select {
	case <-s.Ready():
		t.Error("Ready before the client said initialized")
	default:
	}
}
