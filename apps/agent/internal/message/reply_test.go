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
	if len(f.puts) != 1 || f.puts[0].GetTarget() != "quick-kitten" || f.puts[0].GetMachine() != "WIN-TAKASHI" || f.puts[0].GetUser() != "admin" || f.puts[0].GetReplyTo() != "" {
		t.Fatalf("reply put %v (reply_to is spent once it names the target)", f.puts)
	}
}

func TestAnIDThatWasNeverTypedIsForgottenAndHalfAnOriginIsNotBooked(t *testing.T) {
	home, _ := newTranscript(t, "")
	ch := &fakeChannels{home: home, registered: true}
	svc := &Service{Devin: newDevin(&fakeHerdr{panes: devinPanes}), Claude: testClaude(ch)}

	err := svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: "no-such-devin", Sender: "a", Summary: "s", Body: "b", SenderMachine: "m", SenderUser: "u"}, discard)
	if !notTyped(err) || len(svc.book().ids) != 0 || len(svc.book().order) != 0 {
		t.Fatalf("err %v, booked %v", err, svc.book().ids)
	}

	if err := svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b", SenderMachine: "m"}, discard); err != nil {
		t.Fatal(err)
	}
	if _, ok := ch.pushed[0].Meta[MetaFromMachine]; ok || len(svc.book().ids) != 0 {
		t.Fatalf("meta %v, booked %v", ch.pushed[0].Meta, svc.book().ids)
	}
}

func TestARefusedSendDoesNotPushOutAnIDThatWasDelivered(t *testing.T) {
	svc := &Service{Devin: newDevin(&fakeHerdr{panes: devinPanes})}
	for i := range replyMax {
		svc.book().add(fmt.Sprint("id", i), replyTo{Sender: "x", Machine: "m", User: "u"})
	}
	err := svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: "no-such-devin", Sender: "a", Summary: "s", Body: "b", SenderMachine: "m", SenderUser: "u"}, discard)
	if !notTyped(err) {
		t.Fatalf("err %v", err)
	}
	if _, ok := svc.book().get("id0"); !ok || len(svc.book().ids) != replyMax {
		t.Fatalf("the oldest delivered id was pushed out by a refused send (%d ids)", len(svc.book().ids))
	}
}

func TestADeliveredSendMakesRoomByDroppingTheOldestID(t *testing.T) {
	home, _ := newTranscript(t, "")
	svc := &Service{Devin: newDevin(&fakeHerdr{panes: devinPanes}), Claude: testClaude(&fakeChannels{home: home, registered: true})}
	for i := range replyMax {
		svc.book().add(fmt.Sprint("id", i), replyTo{Sender: "x", Machine: "m", User: "u"})
	}
	if err := svc.Deliver(context.Background(), &ccxv1.SendRequest{Target: claudeID, Sender: "a", Summary: "s", Body: "b", SenderMachine: "m", SenderUser: "u"}, discard); err != nil {
		t.Fatal(err)
	}
	if _, ok := svc.book().get("id0"); ok || len(svc.book().ids) != replyMax {
		t.Fatalf("kept %d ids, id0 still there: %v", len(svc.book().ids), ok)
	}
}

func TestTheReplyBookRemovesAnIDFromBothItsMapAndItsOrder(t *testing.T) {
	b := newReplyBook(time.Now)
	for _, id := range []string{"a", "b", "c"} {
		b.add(id, replyTo{Sender: id})
	}
	b.remove("b")
	b.remove("none")
	if _, ok := b.get("b"); ok || len(b.ids) != 2 || fmt.Sprint(b.order) != "[a c]" {
		t.Fatalf("ids %v order %v", b.ids, b.order)
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
	want := fmt.Sprintf(`ccx: c1: s\nhello\n(ccx: from d1/root, reply: ccx msg send --reply %s --summary \"...\" \"...\")`, id)
	if id == "" || !strings.Contains(out, want) {
		t.Fatalf("hook output %s, want it to hold %s", out, want)
	}
}

func TestTheReplyLineIsNotCountedAsTheBody(t *testing.T) {
	d := newDevin(&fakeHerdr{panes: panesWith("working")})
	svc := &Service{Devin: d}
	from := func(body string) *ccxv1.SendRequest {
		return &ccxv1.SendRequest{Target: "excited-giraffe", Sender: "c1", Summary: "s", Body: body, Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER, SenderMachine: "d1", SenderUser: "root"}
	}

	err := svc.Deliver(context.Background(), from(""), discard)
	if connect.CodeOf(err) != connect.CodeInvalidArgument || !notTyped(err) || !strings.Contains(err.Error(), "body is empty") {
		t.Fatalf("empty body: %v", err)
	}

	full := strings.Repeat("x", MaxBody)
	if err := svc.Deliver(context.Background(), from(full), discard); err != nil {
		t.Fatalf("a body at the limit: %v", err)
	}
	out := hook(t, d, userPrompt("excited-giraffe", "p1", "next"))
	if !strings.Contains(out, full[:100]) || !strings.Contains(out, `(ccx: from d1/root, reply: ccx msg send --reply `) {
		t.Fatalf("hook output lacks the body or the reply line (%d bytes)", len(out))
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
		b.trim()
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

func TestTheReplyLineIsTypedUnderTheBody(t *testing.T) {
	f := &fakeHerdr{panes: devinPanes, screens: []string{emptyBox}, history: "❭ ccx: claude-a1b2c3d4: review 3\nline 1\n", status: []string{"idle", "working"}}
	r := req(ccxv1.DeliveryMode_DELIVERY_MODE_UNSPECIFIED)
	r.ReplyLine = "(ccx: from d1/root, reply: ...)"
	if _, err := send(newDevin(f), r); err != nil {
		t.Fatal(err)
	}
	if p := f.prompted(); p == nil || p[3] != "ccx: claude-a1b2c3d4: review 3\nline 1\nline 2\n(ccx: from d1/root, reply: ...)" {
		t.Fatalf("prompt = %q", p)
	}
}

func TestALaterMessageTakenAfterDaysCanStillBeRepliedTo(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	d := newDevin(&fakeHerdr{panes: panesWith("working")})
	svc := &Service{Devin: d, replies: newReplyBook(func() time.Time { return now })}
	in := &ccxv1.SendRequest{Target: "excited-giraffe", Sender: "c1", Summary: "s", Body: "hello", Mode: ccxv1.DeliveryMode_DELIVERY_MODE_LATER, SenderMachine: "d1", SenderUser: "root"}
	if err := svc.Deliver(context.Background(), in, discard); err != nil {
		t.Fatal(err)
	}
	var id string
	for k := range svc.book().ids {
		id = k
	}

	// Taken eight days later: the id the turn reads is good for seven days from then.
	now = now.Add(8 * 24 * time.Hour)
	_ = hook(t, d, userPrompt("excited-giraffe", "p1", "next"))
	now = now.Add(6 * 24 * time.Hour)
	if to, ok := svc.book().get(id); !ok || to.Sender != "c1" || to.Machine != "d1" {
		t.Fatalf("the id a turn took eight days in was gone six days later: %v %v", to, ok)
	}
}

func TestBookingAnIDAgainMovesItToTheBack(t *testing.T) {
	b := newReplyBook(time.Now)
	for _, id := range []string{"a", "b", "c"} {
		b.add(id, replyTo{Sender: id})
	}
	b.add("a", replyTo{Sender: "a"})
	if fmt.Sprint(b.order) != "[b c a]" || len(b.ids) != 3 {
		t.Fatalf("order %v ids %d", b.order, len(b.ids))
	}
}
