package message

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

var sampleMeta = map[string]string{
	"from_repo": "octo/repo", "from_branch": "feat/x", "from_cwd": "/work/repo", "from_session": "quick-kitten",
	"from_label": "review", "from_role": "impl", "in_reply_to": "m0", "meta_task": "kaneo ccx#75", "meta_a": "1",
}

func TestClaudeSeesTheSendersMetaAsAttributes(t *testing.T) {
	home, _ := newTranscript(t, "")
	ch := &fakeChannels{home: home, registered: true}
	svc := &Service{Claude: testClaude(ch)}
	in := &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b", SenderMeta: sampleMeta}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	for k, v := range sampleMeta {
		if ch.pushed[0].Meta[k] != v {
			t.Fatalf("%s: meta %v", k, ch.pushed[0].Meta)
		}
	}
}

func TestDevinReadsTheSendersMetaInTheLineUnderTheBodyWithoutTheCwd(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: panesWith("working")})
	svc := &Service{Devin: d}
	in := &ccxv1.SendRequest{Target: "excited-giraffe", Sender: "c1", Summary: "s", Body: "hello", Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER, SenderMachine: "d1", SenderUser: "root", SenderMeta: sampleMeta}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	var id string
	for k := range svc.book().ids {
		id = k
	}
	out := hook(t, d, userPrompt("excited-giraffe", "p1", "next"))
	want := fmt.Sprintf(`hello\n(ccx: from d1/root, repo octo/repo@feat/x, session quick-kitten, label review, role impl, in reply to m0, a=1, task=kaneo ccx#75, reply: ccx msg send --reply %s`, id)
	if !strings.Contains(out, want) || strings.Contains(out, "/work/repo") {
		t.Fatalf("hook output %s, want it to hold %s", out, want)
	}
}

func TestDevinReadsTheMetaEvenFromAnAgentThatGaveNoOrigin(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: panesWith("working")})
	svc := &Service{Devin: d}
	in := &ccxv1.SendRequest{Target: "excited-giraffe", Sender: "c1", Summary: "s", Body: "hello", Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER, SenderMeta: map[string]string{"from_branch": "main"}}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	if out := hook(t, d, userPrompt("excited-giraffe", "p1", "next")); !strings.Contains(out, `hello\n(ccx: branch main)`) {
		t.Fatalf("hook output %s", out)
	}
}

func TestAReplyGoesToTheSessionTheSenderNamedNotItsLabel(t *testing.T) {
	home, _ := newTranscript(t, "")
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", FinishedAt: timestamppb.Now()}}}
	ch := &fakeChannels{home: home, registered: true}
	svc := &Service{Claude: testClaude(ch), Machine: "d1", User: "root", Relay: testRelay(f)}
	in := &ccxv1.SendRequest{Target: claudeID, Sender: "a-made-up-label", Summary: "s", Body: "b", SenderMachine: "WIN-TAKASHI", SenderUser: "admin", SenderMeta: map[string]string{"from_session": "quick-kitten"}}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	if err := svc.send(context.Background(), &ccxv1.SendRequest{ReplyTo: ch.pushed[0].Meta["msg_id"], Sender: claudeID, Summary: "re", Body: "ok"}, discard); err != nil {
		t.Fatal(err)
	}
	if len(f.puts) != 1 || f.puts[0].GetTarget() != "quick-kitten" {
		t.Fatalf("puts %v", f.puts)
	}
}

func TestASendWithMetaItCouldNotShowIsNotSent(t *testing.T) {
	long := strings.Repeat("x", MaxMetaValue+1)
	many := map[string]string{}
	for i := range MaxMetaKeys + 1 {
		many[fmt.Sprintf("meta_k%d", i)] = "v"
	}
	big := map[string]string{}
	for i := range 9 {
		big[fmt.Sprintf("meta_k%d", i)] = strings.Repeat("v", MaxMetaValue)
	}
	for name, m := range map[string]map[string]string{
		"unknown key": {"from_machine": "x"}, "upper case": {"meta_Task": "x"}, "newline": {"meta_a": "a\nb"},
		"empty": {"meta_a": ""}, "too long": {"meta_a": long}, "too many": many, "too big": big,
	} {
		svc := &Service{Machine: "d1", User: "root"}
		err := svc.send(context.Background(), &ccxv1.SendRequest{Target: "t", Sender: "a", Summary: "s", Body: "b", SenderMeta: m}, discard)
		if connect.CodeOf(err) != connect.CodeInvalidArgument || !notTyped(err) {
			t.Fatalf("%s: err %v", name, err)
		}
	}
	// At the limits it goes.
	if err := ValidateMeta(map[string]string{"meta_" + strings.Repeat("k", 32): strings.Repeat("v", MaxMetaValue)}); err != nil {
		t.Fatal(err)
	}
}

func TestMetaACenterPutCouldForgeIsNotShown(t *testing.T) {
	home, _ := newTranscript(t, "")
	ch := &fakeChannels{home: home, registered: true}
	svc := &Service{Claude: testClaude(ch)}
	in := &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b", SenderMeta: map[string]string{"from_repo": "ok", "msg_id": "forged"}}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	if ch.pushed[0].Meta["msg_id"] == "forged" || ch.pushed[0].Meta["from_repo"] != "" {
		t.Fatalf("meta %v", ch.pushed[0].Meta)
	}
}
