package message

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

func discard(*ccxv1.SendResponse) error { return nil }

func TestASendIsStampedWithThisAgentsMachineAndUserWhateverTheCallerSaid(t *testing.T) {
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", FinishedAt: timestamppb.Now()}}}
	svc := &Service{Machine: "d1", User: "root", Relay: testRelay(f)}
	m := remoteReq()
	m.SenderMachine, m.SenderUser = "forged", "nobody"
	if err := svc.send(context.Background(), m, discard); err != nil {
		t.Fatal(err)
	}
	if len(f.puts) != 1 || f.puts[0].GetSenderMachine() != "d1" || f.puts[0].GetSenderUser() != "root" {
		t.Fatalf("puts %v", f.puts)
	}
}

func TestClaudeSeesWhereAMessageCameFromAndAReplyToItsMsgIDGoesBackThere(t *testing.T) {
	home, _ := newTranscript(t, "")
	ch := &fakeChannels{home: home, registered: true}
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", FinishedAt: timestamppb.Now()}}}
	svc := &Service{Devin: newDevin(&fakeHerdr{panes: devinPanes}), Claude: testClaude(ch), Machine: "d1", User: "root", Relay: testRelay(f)}

	in := &ccxv1.SendRequest{Target: claudeID, Sender: "quick-kitten", Summary: "s", Body: "b", SenderMachine: "WIN-TAKASHI", SenderUser: "admin"}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	meta := ch.pushed[0].Meta
	if meta[MetaFromMachine] != "WIN-TAKASHI" || meta[MetaFromUser] != "admin" || meta["msg_id"] == "" || ch.pushed[0].Content != "b" {
		t.Fatalf("pushed %+v", ch.pushed[0])
	}

	reply := &ccxv1.SendRequest{ReplyTo: meta["msg_id"], Sender: claudeID, Summary: "re", Body: "ok"}
	if err := svc.send(context.Background(), reply, discard); err != nil {
		t.Fatal(err)
	}
	if len(f.puts) != 1 || f.puts[0].GetTarget() != "quick-kitten" || f.puts[0].GetMachine() != "WIN-TAKASHI" || f.puts[0].GetUser() != "admin" {
		t.Fatalf("reply put %v", f.puts)
	}
}

func TestDevinGetsALastLineSayingWhereItCameFromAndHowToReply(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: panesWith("working")})
	svc := &Service{Devin: d}
	in := &ccxv1.SendRequest{Target: "excited-giraffe", Sender: "c1", Summary: "s", Body: "hello", Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER, SenderMachine: "d1", SenderUser: "root"}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	var id string
	for k := range svc.book().ids {
		id = k
	}
	out := hook(t, d, userPrompt("excited-giraffe", "p1", "next"))
	want := fmt.Sprintf(`ccx: c1: s\nhello\n(ccx: from d1/root, reply: ccx msg send --reply %s \"...\")`, id)
	if id == "" || !strings.Contains(out, want) {
		t.Fatalf("hook output %s, want it to hold %s", out, want)
	}
}

func TestAMessageFromAnOlderAgentShowsNoOriginAndCannotBeRepliedTo(t *testing.T) {
	home, _ := newTranscript(t, "")
	ch := &fakeChannels{home: home, registered: true}
	d := newDevin(&fakeHerdr{panes: panesWith("working")})
	svc := &Service{Devin: d, Claude: testClaude(ch)}
	_ = svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b"}, discard)
	_ = svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: "excited-giraffe", Sender: "a", Summary: "s", Body: "hello", Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER}, discard)

	if _, ok := ch.pushed[0].Meta[MetaFromMachine]; ok {
		t.Fatalf("meta %v", ch.pushed[0].Meta)
	}
	if out := hook(t, d, userPrompt("excited-giraffe", "p1", "next")); !strings.Contains(out, `hello`) || strings.Contains(out, "(ccx: from") {
		t.Fatalf("hook output %s", out)
	}
	if len(svc.book().ids) != 0 {
		t.Fatalf("booked %v", svc.book().ids)
	}
}

func TestAReplyToNamesOnlyAnIDThisAgentDeliveredAndNothingElse(t *testing.T) {
	svc := &Service{Machine: "d1", User: "root"}
	svc.book().add("known", replyTo{Sender: "x", Machine: "m", User: "u"})

	err := svc.send(context.Background(), &ccxv1.SendRequest{ReplyTo: "unknown", Sender: "a", Summary: "s", Body: "b"}, discard)
	if connect.CodeOf(err) != connect.CodeNotFound || !notTyped(err) || !strings.Contains(err.Error(), "no message with msg_id unknown") {
		t.Fatalf("unknown id: %v", err)
	}
	for _, m := range []*ccxv1.SendRequest{
		{ReplyTo: "known", Target: "t", Sender: "a", Summary: "s", Body: "b"},
		{ReplyTo: "known", Machine: "m", Sender: "a", Summary: "s", Body: "b"},
		{ReplyTo: "known", User: "u", Sender: "a", Summary: "s", Body: "b"},
	} {
		err := svc.send(context.Background(), m, discard)
		if connect.CodeOf(err) != connect.CodeInvalidArgument || !notTyped(err) || !strings.Contains(err.Error(), "takes the place of target") {
			t.Fatalf("%v: %v", m, err)
		}
	}
}

func TestTheReplyBookForgetsAfterSevenDaysAndKeepsTheLatestThousand(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	b := newReplyBook(func() time.Time { return now })
	b.add("a", replyTo{Sender: "x"})
	now = now.Add(7*24*time.Hour - time.Second)
	if _, ok := b.get("a"); !ok {
		t.Fatal("forgot before 7 days")
	}
	now = now.Add(2 * time.Second)
	if _, ok := b.get("a"); ok {
		t.Fatal("kept past 7 days")
	}

	for i := range 1001 {
		b.add(fmt.Sprint("id", i), replyTo{Sender: "x"})
	}
	if _, ok := b.get("id0"); ok {
		t.Fatal("kept more than 1000")
	}
	if _, ok := b.get("id1"); !ok {
		t.Fatal("dropped one of the latest 1000")
	}
	if len(b.ids) != 1000 || len(b.order) != 1000 {
		t.Fatalf("ids %d order %d", len(b.ids), len(b.order))
	}
}
