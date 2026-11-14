package message

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"syscall"
	"time"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/hubauth"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// Center is the center's MessageRelayService (#138). The methods are the Connect
// client's own, so the client can be handed in as it is.
type Center interface {
	PutMessage(context.Context, *connect.Request[ccxv1.PutMessageRequest]) (*connect.Response[ccxv1.PutMessageResponse], error)
	GetMessage(context.Context, *connect.Request[ccxv1.GetMessageRequest]) (*connect.Response[ccxv1.GetMessageResponse], error)
	ClaimMessage(context.Context, *connect.Request[ccxv1.ClaimMessageRequest]) (*connect.Response[ccxv1.ClaimMessageResponse], error)
	ReportMessage(context.Context, *connect.Request[ccxv1.ReportMessageRequest]) (*connect.Response[ccxv1.ReportMessageResponse], error)
}

// callTimeout bounds one call to the center, as resume's does: a center that
// accepts the connection and never answers must not hold the claim loop forever.
const callTimeout = 30 * time.Second

type timedCenter struct {
	c ccxv1connect.MessageRelayServiceClient
}

// NewCenter points the relay at the center.
func NewCenter(hubURL, token string) Center {
	return timedCenter{ccxv1connect.NewMessageRelayServiceClient(http.DefaultClient, hubURL, hubauth.Options(token)...)}
}

func (t timedCenter) PutMessage(ctx context.Context, r *connect.Request[ccxv1.PutMessageRequest]) (*connect.Response[ccxv1.PutMessageResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return t.c.PutMessage(ctx, r)
}

func (t timedCenter) GetMessage(ctx context.Context, r *connect.Request[ccxv1.GetMessageRequest]) (*connect.Response[ccxv1.GetMessageResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return t.c.GetMessage(ctx, r)
}

func (t timedCenter) ClaimMessage(ctx context.Context, r *connect.Request[ccxv1.ClaimMessageRequest]) (*connect.Response[ccxv1.ClaimMessageResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return t.c.ClaimMessage(ctx, r)
}

func (t timedCenter) ReportMessage(ctx context.Context, r *connect.Request[ccxv1.ReportMessageRequest]) (*connect.Response[ccxv1.ReportMessageResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return t.c.ReportMessage(ctx, r)
}

// Relay carries messages between machines through the center (#138). As a
// sender it puts a message for another machine and streams the acks the other
// side reports; as a receiver it claims the messages put for this machine,
// delivers each as a local send and reports the acks.
type Relay struct {
	Center Center
	// Machine and User are this agent's origin: the center hands it the messages
	// put for them.
	Machine, User string
	// Deliver sends one claimed message here (Service.deliver).
	Deliver func(ctx context.Context, m *ccxv1.SendRequest, emit func(*ccxv1.SendResponse) error) error
	// Poll is how often the sender reads the acks back; Claim how often the
	// receiver asks for messages when not woken.
	Poll, Claim time.Duration
	Log         func(string, ...any)

	wake chan struct{}
}

// NewRelay takes the defaults: the acks read back every 250 ms, the center asked
// every 5 s (resume's poll), with a wake from the center in between.
func NewRelay(c Center, machine, user string) *Relay {
	return &Relay{Center: c, Machine: machine, User: user, Poll: 250 * time.Millisecond, Claim: 5 * time.Second, wake: make(chan struct{}, 1)}
}

func (r *Relay) Name() string { return "message-relay" }

// Wake makes the receiver claim now. The center wakes the agent when it puts a
// message for it; a missed wake waits for the next poll.
func (r *Relay) Wake() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// markNotTyped marks err as coming before anything was typed (NotTypedKey).
func markNotTyped(err error) error {
	ce := new(connect.Error)
	if !errors.As(err, &ce) {
		ce = connect.NewError(connect.CodeUnknown, err)
	}
	ce.Meta().Set(NotTypedKey, "1")
	return ce
}

// putNeverStored is a put failure that says the center stored nothing: it
// answered with a refusal, or the connection was never made. Any other failure
// (a timeout, a dropped answer) may come after the row was stored, and that row
// can still be claimed and typed.
func putNeverStored(err error) bool {
	switch connect.CodeOf(err) {
	case connect.CodeInvalidArgument, connect.CodeUnauthenticated, connect.CodePermissionDenied, connect.CodeUnimplemented, connect.CodeResourceExhausted:
		return true
	}
	return errors.Is(err, syscall.ECONNREFUSED)
}

// Send puts m for m's machine and user and hands each ack the other side
// reports to emit. It ends with the other side's error, carrying NotTypedKey
// when that side typed nothing, or when no agent there claimed it in time.
func (r *Relay) Send(ctx context.Context, m *ccxv1.SendRequest, emit func(*ccxv1.SendResponse) error) error {
	where := m.GetMachine() + "/" + m.GetUser()
	if err := Validate(Request{Target: m.GetTarget(), Sender: m.GetSender(), Summary: m.GetSummary(), Body: m.GetBody(), Mode: m.GetMode()}); err != nil {
		return markNotTyped(err)
	}
	put, err := r.Center.PutMessage(ctx, connect.NewRequest(&ccxv1.PutMessageRequest{Request: m}))
	if err != nil {
		err = connect.NewError(connect.CodeOf(err), fmt.Errorf("center, putting the message for %s: %w", where, err))
		if putNeverStored(err) {
			return markNotTyped(err)
		}
		return err
	}
	id := put.Msg.GetMessage().GetId()

	emitted := 0
	tick := time.NewTicker(r.Poll)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return connect.NewError(connect.CodeDeadlineExceeded, fmt.Errorf("gave up waiting for %s to report message %s: %w", where, id, ctx.Err()))
		case <-tick.C:
		}
		got, err := r.Center.GetMessage(ctx, connect.NewRequest(&ccxv1.GetMessageRequest{Id: id}))
		if err != nil {
			// The message is stored; a failed read says nothing about it. Keep
			// reading until the caller gives up.
			continue
		}
		msg := got.Msg.GetMessage()
		for _, a := range msg.GetAcks()[min(emitted, len(msg.GetAcks())):] {
			if err := emit(a); err != nil {
				return err
			}
			emitted++
		}
		switch {
		case msg.GetExpired():
			return markNotTyped(connect.NewError(connect.CodeUnavailable, fmt.Errorf("no ccx-agent for %s took the message within 30 s (is it running and pointed at this center?)", where)))
		case msg.GetFinishedAt() == nil:
			continue
		case msg.GetErrorCode() == 0:
			return nil
		}
		ce := connect.NewError(connect.Code(msg.GetErrorCode()), fmt.Errorf("%s: %s", where, msg.GetErrorMessage()))
		if msg.GetNotTyped() {
			return markNotTyped(ce)
		}
		return ce
	}
}

// Run is the receiver: it claims the messages put for this machine and user,
// one at a time, until the context ends.
func (r *Relay) Run(ctx context.Context) error {
	tick := time.NewTicker(r.Claim)
	defer tick.Stop()
	for {
		for r.claimOne(ctx) {
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		case <-r.wake:
		}
	}
}

// claimOne delivers one claimed message and says whether there was one.
func (r *Relay) claimOne(ctx context.Context) bool {
	got, err := r.Center.ClaimMessage(ctx, connect.NewRequest(&ccxv1.ClaimMessageRequest{Machine: r.Machine, User: r.User}))
	if err != nil {
		if ctx.Err() == nil {
			r.log("message relay: claim: %v", err)
		}
		return false
	}
	msg := got.Msg.GetMessage()
	if msg == nil {
		return false
	}

	var acks []*ccxv1.SendResponse
	report := func(rep *ccxv1.ReportMessageRequest) error {
		rep.Id, rep.ClaimToken, rep.Acks = msg.GetId(), msg.GetClaimToken(), acks
		_, err := r.Center.ReportMessage(ctx, connect.NewRequest(rep))
		return err
	}
	err = r.Deliver(ctx, msg.GetRequest(), func(a *ccxv1.SendResponse) error {
		acks = append(acks, a)
		if err := report(&ccxv1.ReportMessageRequest{}); err != nil {
			// The final report carries every ack again.
			r.log("message relay: report an ack of %s: %v", msg.GetId(), err)
		}
		return nil
	})

	final := &ccxv1.ReportMessageRequest{Finished: true}
	if err != nil {
		ce := new(connect.Error)
		final.ErrorCode = int32(connect.CodeUnknown)
		final.ErrorMessage = err.Error()
		if errors.As(err, &ce) {
			final.ErrorCode, final.ErrorMessage = int32(ce.Code()), ce.Message()
			final.NotTyped = ce.Meta().Get(NotTypedKey) != ""
		}
	}
	// The sender waits on this one, so a failed report is tried again a few times.
	for try := 0; try < 3; try++ {
		if err = report(final); err == nil || connect.CodeOf(err) == connect.CodeFailedPrecondition || ctx.Err() != nil {
			break
		}
		_ = sleep(ctx, time.Second)
	}
	if err != nil {
		r.log("message relay: report the end of %s: %v", msg.GetId(), err)
	}
	return true
}

func (r *Relay) log(format string, a ...any) {
	if r.Log != nil {
		r.Log(format, a...)
	}
}
