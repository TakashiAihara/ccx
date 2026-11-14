package message

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// fakeCenter stands in for the center's MessageRelayService. Each read hands out
// the next of gets (the last one repeats); claims are handed out in order.
type fakeCenter struct {
	mu      sync.Mutex
	putErr  error
	puts    []*ccxv1.SendRequest
	gets    []*ccxv1.RelayedMessage
	getErrs []error
	claims  []*ccxv1.RelayedMessage
	reports []*ccxv1.ReportMessageRequest
	// reportErrs are answered to the reports in turn; past the end, nil.
	reportErrs []error
}

func (f *fakeCenter) PutMessage(_ context.Context, r *connect.Request[ccxv1.PutMessageRequest]) (*connect.Response[ccxv1.PutMessageResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putErr != nil {
		return nil, f.putErr
	}
	f.puts = append(f.puts, r.Msg.GetRequest())
	return connect.NewResponse(&ccxv1.PutMessageResponse{Message: &ccxv1.RelayedMessage{Id: "m1"}}), nil
}

func (f *fakeCenter) GetMessage(_ context.Context, r *connect.Request[ccxv1.GetMessageRequest]) (*connect.Response[ccxv1.GetMessageResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Msg.GetId() != "m1" {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("read a message that was not put"))
	}
	if len(f.getErrs) > 0 {
		err := f.getErrs[0]
		f.getErrs = f.getErrs[1:]
		return nil, err
	}
	m := f.gets[0]
	if len(f.gets) > 1 {
		f.gets = f.gets[1:]
	}
	return connect.NewResponse(&ccxv1.GetMessageResponse{Message: m}), nil
}

func (f *fakeCenter) ClaimMessage(_ context.Context, r *connect.Request[ccxv1.ClaimMessageRequest]) (*connect.Response[ccxv1.ClaimMessageResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Msg.GetMachine() != "m2" || r.Msg.GetUser() != "dev" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("claimed as %s/%s", r.Msg.GetMachine(), r.Msg.GetUser()))
	}
	if len(f.claims) == 0 {
		return connect.NewResponse(&ccxv1.ClaimMessageResponse{}), nil
	}
	m := f.claims[0]
	f.claims = f.claims[1:]
	return connect.NewResponse(&ccxv1.ClaimMessageResponse{Message: m}), nil
}

func (f *fakeCenter) ReportMessage(_ context.Context, r *connect.Request[ccxv1.ReportMessageRequest]) (*connect.Response[ccxv1.ReportMessageResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// A copy: the relay goes on appending to the slice it reported.
	rep := proto.Clone(r.Msg).(*ccxv1.ReportMessageRequest)
	f.reports = append(f.reports, rep)
	if len(f.reportErrs) > 0 {
		err := f.reportErrs[0]
		f.reportErrs = f.reportErrs[1:]
		return nil, err
	}
	return connect.NewResponse(&ccxv1.ReportMessageResponse{}), nil
}

func testRelay(c Center) *Relay {
	r := NewRelay(c, "m2", "dev")
	r.Poll, r.Claim = time.Millisecond, time.Hour
	return r
}

func remoteReq() *ccxv1.SendRequest {
	return &ccxv1.SendRequest{Target: "devin-x", Sender: "me", Summary: "review", Body: "body", Mode: ccxv1.DeliveryMode_DELIVERY_MODE_URGENT, Machine: "m2", User: "dev"}
}

func ack(s ccxv1.SendResponse_State, detail string) *ccxv1.SendResponse {
	return &ccxv1.SendResponse{State: s, Detail: detail}
}

func collectSend(r *Relay, ctx context.Context, m *ccxv1.SendRequest) ([]*ccxv1.SendResponse, error) {
	var got []*ccxv1.SendResponse
	err := r.Send(ctx, m, func(a *ccxv1.SendResponse) error {
		got = append(got, a)
		return nil
	})
	return got, err
}

func TestRelaySendStreamsEachAckOnceAndEndsWithTheReceiversResult(t *testing.T) {
	sent, working := ack(ccxv1.SendResponse_STATE_SENT, "pane w1:p1"), ack(ccxv1.SendResponse_STATE_WORKING, "")
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{
		{Id: "m1"},
		{Id: "m1", ClaimedAt: timestamppb.Now(), Acks: []*ccxv1.SendResponse{sent}},
		{Id: "m1", ClaimedAt: timestamppb.Now(), Acks: []*ccxv1.SendResponse{sent}},
		{Id: "m1", ClaimedAt: timestamppb.Now(), FinishedAt: timestamppb.Now(), Acks: []*ccxv1.SendResponse{sent, working}},
	}}
	got, err := collectSend(testRelay(f), context.Background(), remoteReq())
	if err != nil || len(got) != 2 || got[0].GetDetail() != "pane w1:p1" || got[1].GetState() != ccxv1.SendResponse_STATE_WORKING {
		t.Fatalf("acks %v, err %v", got, err)
	}
	if len(f.puts) != 1 || f.puts[0].GetBody() != "body" || f.puts[0].GetMachine() != "m2" {
		t.Fatalf("put %v", f.puts)
	}
}

func TestRelaySendKeepsTheReceiversCodeAndNotTypedMark(t *testing.T) {
	for _, tc := range []struct {
		name     string
		notTyped bool
	}{{"refused before typing", true}, {"failed after typing", false}} {
		f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", FinishedAt: timestamppb.Now(), ErrorCode: int32(connect.CodeFailedPrecondition), ErrorMessage: "devin-x has text in its input box", NotTyped: tc.notTyped}}}
		_, err := collectSend(testRelay(f), context.Background(), remoteReq())
		if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "m2/dev: devin-x has text in its input box") || notTyped(err) != tc.notTyped {
			t.Errorf("%s: err %v, marked %v", tc.name, err, notTyped(err))
		}
	}
}

func TestRelaySendSaysNotSentWhenNoAgentClaimedIt(t *testing.T) {
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1"}, {Id: "m1", Expired: true}}}
	_, err := collectSend(testRelay(f), context.Background(), remoteReq())
	if connect.CodeOf(err) != connect.CodeUnavailable || !notTyped(err) || !strings.Contains(err.Error(), "no ccx-agent for m2/dev took the message") {
		t.Fatalf("err %v, marked %v", err, notTyped(err))
	}
}

func TestRelaySendRefusesABadMessageWithoutPuttingIt(t *testing.T) {
	f := &fakeCenter{}
	m := remoteReq()
	m.Body = "a\x1bb"
	_, err := collectSend(testRelay(f), context.Background(), m)
	if connect.CodeOf(err) != connect.CodeInvalidArgument || !notTyped(err) || len(f.puts) != 0 {
		t.Fatalf("err %v, marked %v, puts %d", err, notTyped(err), len(f.puts))
	}
}

func TestRelaySendSaysNotSentOnlyWhenThePutStoredNothing(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		notTyped bool
	}{
		{"refused by the center", connect.NewError(connect.CodeUnauthenticated, errors.New("bad token")), true},
		{"connection refused", connect.NewError(connect.CodeUnavailable, fmt.Errorf("dial: %w", syscall.ECONNREFUSED)), true},
		{"timed out", connect.NewError(connect.CodeDeadlineExceeded, errors.New("deadline")), false},
		{"answer lost", connect.NewError(connect.CodeUnavailable, errors.New("connection reset")), false},
	} {
		_, err := collectSend(testRelay(&fakeCenter{putErr: tc.err}), context.Background(), remoteReq())
		if err == nil || notTyped(err) != tc.notTyped || !strings.Contains(err.Error(), "putting the message for m2/dev") {
			t.Errorf("%s: err %v, marked %v", tc.name, err, notTyped(err))
		}
	}
}

func TestRelaySendReadsPastAFailedRead(t *testing.T) {
	f := &fakeCenter{getErrs: []error{connect.NewError(connect.CodeUnavailable, errors.New("blip"))}, gets: []*ccxv1.RelayedMessage{{Id: "m1", FinishedAt: timestamppb.Now()}}}
	if _, err := collectSend(testRelay(f), context.Background(), remoteReq()); err != nil {
		t.Fatalf("err %v", err)
	}
}

func TestRelaySendGivingUpIsNotNotSent(t *testing.T) {
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", ClaimedAt: timestamppb.Now()}}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := collectSend(testRelay(f), ctx, remoteReq())
	if connect.CodeOf(err) != connect.CodeDeadlineExceeded || notTyped(err) {
		t.Fatalf("err %v, marked %v", err, notTyped(err))
	}
}

func TestRelayReceiverDeliversAndReportsEachAckThenTheEnd(t *testing.T) {
	f := &fakeCenter{claims: []*ccxv1.RelayedMessage{{Id: "m1", ClaimToken: "tok", Request: remoteReq()}}}
	r := testRelay(f)
	var delivered []*ccxv1.SendRequest
	r.Deliver = func(_ context.Context, m *ccxv1.SendRequest, emit func(*ccxv1.SendResponse) error) error {
		delivered = append(delivered, m)
		_ = emit(ack(ccxv1.SendResponse_STATE_SENT, "pane"))
		_ = emit(ack(ccxv1.SendResponse_STATE_WORKING, ""))
		return nil
	}
	if !r.claimOne(context.Background()) || r.claimOne(context.Background()) {
		t.Fatal("claimOne should deliver the one message, then find none")
	}
	if len(delivered) != 1 || delivered[0].GetTarget() != "devin-x" {
		t.Fatalf("delivered %v", delivered)
	}
	if len(f.reports) != 3 {
		t.Fatalf("reports %v", f.reports)
	}
	for i, want := range []struct {
		acks     int
		finished bool
	}{{1, false}, {2, false}, {2, true}} {
		rep := f.reports[i]
		if rep.GetId() != "m1" || rep.GetClaimToken() != "tok" || len(rep.GetAcks()) != want.acks || rep.GetFinished() != want.finished || rep.GetErrorCode() != 0 {
			t.Errorf("report %d = %v", i, rep)
		}
	}
}

func TestRelayReceiverReportsTheDeliveryError(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		code     connect.Code
		msg      string
		notTyped bool
	}{
		{"refused before typing", markNotTyped(connect.NewError(connect.CodeNotFound, errors.New("no devin-x"))), connect.CodeNotFound, "no devin-x", true},
		{"failed after typing", connect.NewError(connect.CodeUnknown, errors.New("prompt broke")), connect.CodeUnknown, "prompt broke", false},
		{"plain error", errors.New("odd"), connect.CodeUnknown, "odd", false},
	} {
		f := &fakeCenter{claims: []*ccxv1.RelayedMessage{{Id: "m1", ClaimToken: "tok", Request: remoteReq()}}}
		r := testRelay(f)
		r.Deliver = func(context.Context, *ccxv1.SendRequest, func(*ccxv1.SendResponse) error) error { return tc.err }
		r.claimOne(context.Background())
		end := f.reports[len(f.reports)-1]
		if !end.GetFinished() || connect.Code(end.GetErrorCode()) != tc.code || end.GetErrorMessage() != tc.msg || end.GetNotTyped() != tc.notTyped {
			t.Errorf("%s: end report %v", tc.name, end)
		}
	}
}

func TestRelayReceiverRetriesTheEndReportButNotARefusedOne(t *testing.T) {
	unavailable := connect.NewError(connect.CodeUnavailable, errors.New("blip"))
	for _, tc := range []struct {
		name  string
		errs  []error
		tries int
	}{
		{"retried after a blip", []error{unavailable}, 2},
		{"gives up after three", []error{unavailable, unavailable, unavailable, unavailable}, 3},
		{"refused is final", []error{connect.NewError(connect.CodeFailedPrecondition, errors.New("finished"))}, 1},
	} {
		f := &fakeCenter{claims: []*ccxv1.RelayedMessage{{Id: "m1", ClaimToken: "tok", Request: remoteReq()}}, reportErrs: tc.errs}
		r := testRelay(f)
		r.Deliver = func(context.Context, *ccxv1.SendRequest, func(*ccxv1.SendResponse) error) error { return nil }
		start := time.Now()
		r.claimOne(context.Background())
		if len(f.reports) != tc.tries {
			t.Errorf("%s: %d reports, want %d (%v)", tc.name, len(f.reports), tc.tries, time.Since(start))
		}
	}
}

func TestRelayRunClaimsWhenWoken(t *testing.T) {
	f := &fakeCenter{}
	r := testRelay(f)
	done := make(chan *ccxv1.SendRequest, 1)
	r.Deliver = func(_ context.Context, m *ccxv1.SendRequest, _ func(*ccxv1.SendResponse) error) error {
		done <- m
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = r.Run(ctx) }()
	// Let Run find nothing first and settle on its hour-long tick.
	time.Sleep(50 * time.Millisecond)
	f.mu.Lock()
	f.claims = []*ccxv1.RelayedMessage{{Id: "m1", ClaimToken: "tok", Request: remoteReq()}}
	f.mu.Unlock()
	r.Wake()
	select {
	case m := <-done:
		if m.GetTarget() != "devin-x" {
			t.Fatalf("delivered %v", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Wake did not make Run claim")
	}
}

// The Connect stream needs a live handler, so this calls route, the part of Send
// that picks the way.
func TestServiceSendsHereForItsOwnMachineAndThroughTheCenterOtherwise(t *testing.T) {
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", FinishedAt: timestamppb.Now()}}}
	var local []string
	svc := &Service{Machine: "m1", User: "dev"}
	svc.Relay = testRelay(f)
	route := func(machine, user string) error {
		m := remoteReq()
		m.Machine, m.User = machine, user
		return svc.route(context.Background(), m, func(*ccxv1.SendResponse) error { return nil }, func(_ context.Context, m *ccxv1.SendRequest, _ func(*ccxv1.SendResponse) error) error {
			local = append(local, m.GetMachine()+"/"+m.GetUser())
			return nil
		})
	}
	for _, mu := range [][2]string{{"", ""}, {"m1", ""}, {"", "dev"}, {"m1", "dev"}} {
		if err := route(mu[0], mu[1]); err != nil {
			t.Fatalf("%v: %v", mu, err)
		}
	}
	if len(local) != 4 || len(f.puts) != 0 {
		t.Fatalf("local %v, puts %v", local, f.puts)
	}
	for _, mu := range [][2]string{{"m2", ""}, {"", "other"}} {
		if err := route(mu[0], mu[1]); err != nil {
			t.Fatalf("%v: %v", mu, err)
		}
	}
	if len(f.puts) != 2 || f.puts[0].GetMachine() != "m2" || f.puts[0].GetUser() != "dev" || f.puts[1].GetMachine() != "m1" || f.puts[1].GetUser() != "other" {
		t.Fatalf("puts %v (the missing half is this agent's own)", f.puts)
	}

	svc.Relay = nil
	err := route("m2", "dev")
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !notTyped(err) || !strings.Contains(err.Error(), "no http(s) center") {
		t.Fatalf("err %v", err)
	}
}

func TestRelaySendStopsWhenTheSenderStreamBreaks(t *testing.T) {
	f := &fakeCenter{gets: []*ccxv1.RelayedMessage{{Id: "m1", Acks: []*ccxv1.SendResponse{ack(ccxv1.SendResponse_STATE_SENT, "")}}}}
	broken := errors.New("stream closed")
	err := testRelay(f).Send(context.Background(), remoteReq(), func(*ccxv1.SendResponse) error { return broken })
	if !errors.Is(err, broken) {
		t.Fatalf("err %v", err)
	}
}

func TestRelayRunDeliversEveryQueuedMessageOnOneWake(t *testing.T) {
	f := &fakeCenter{}
	r := testRelay(f)
	done := make(chan string, 3)
	r.Deliver = func(_ context.Context, m *ccxv1.SendRequest, _ func(*ccxv1.SendResponse) error) error {
		done <- m.GetBody()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = r.Run(ctx) }()
	time.Sleep(50 * time.Millisecond)
	f.mu.Lock()
	for _, b := range []string{"a", "b", "c"} {
		m := remoteReq()
		m.Body = b
		f.claims = append(f.claims, &ccxv1.RelayedMessage{Id: "m-" + b, ClaimToken: "tok", Request: m})
	}
	f.mu.Unlock()
	r.Wake()
	var got []string
	for len(got) < 3 {
		select {
		case b := <-done:
			got = append(got, b)
		case <-time.After(2 * time.Second):
			t.Fatalf("delivered only %v after one wake", got)
		}
	}
}
