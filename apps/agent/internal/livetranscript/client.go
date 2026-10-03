package livetranscript

import (
	"context"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	"github.com/TakashiAihara/ccx/apps/agent/internal/hubauth"
	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
	"github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1/ccxv1connect"
)

// Client appends through the center's TranscriptService. It is the only place
// live sync speaks the wire, so the Appender's promise (refuse with the size, or
// answer with the new size) is kept in one place.
type Client struct {
	svc    ccxv1connect.TranscriptServiceClient
	origin *ccxv1.Origin
	bucket string
	prefix string
}

// NewClient points at the center, which is the store live sync can append to
// (S3 has no append — config decides that before this is built). origin and the
// bucket / prefix are the same values the CLI's push uses, so the object this
// grows is the one `ccx transcript` reads.
func NewClient(hubURL, token string, origin *ccxv1.Origin, bucket, prefix string) *Client {
	return &Client{
		svc:    ccxv1connect.NewTranscriptServiceClient(http.DefaultClient, hubURL, hubauth.Options(token)...),
		origin: origin,
		bucket: bucket,
		prefix: prefix,
	}
}

// Append sends one chunk. A refusal (FAILED_PRECONDITION carrying the center's
// size) comes back as *Mismatch so the caller continues from that size instead of
// treating it as an outage.
func (c *Client) Append(ctx context.Context, session string, offset uint64, data, tail []byte) (uint64, error) {
	res, err := c.svc.Append(ctx, connect.NewRequest(&ccxv1.AppendRequest{
		Origin:       c.origin,
		SessionId:    session,
		Offset:       offset,
		Data:         data,
		Bucket:       c.bucket,
		Prefix:       c.prefix,
		ExpectedTail: tail,
	}))
	if err != nil {
		return 0, refusal(err)
	}
	return res.Msg.GetSize(), nil
}

// refusal sorts what the center answered:
//   - a FailedPrecondition carrying an AppendResponse is *Mismatch (continue from
//     its size); one without the size says nothing about where to continue, so it
//     stays an error to retry
//   - Unimplemented (a center older than TranscriptService), Unauthenticated and
//     PermissionDenied (the token) are the same for every session: *Permanent
//     with Global, so live sync stops instead of re-sending every 5s forever
//   - InvalidArgument: the center refuses the key or the data. Every part of the
//     key but the session id (machine, user, bucket, prefix) is the same for every
//     session, and the id is checked before a session exists. The data refusal
//     (not ending in a newline) is per request, but this agent never sends such
//     data; if a bug ever did, stopping every session is the loud way to find it.
//     So *Permanent with Global too
//   - DataLoss: the object is not a prefix of this session's local file (another
//     copy was put in its place): *Permanent for this session; push fixes it
//   - anything else (down, timeout, internal) is transient
func refusal(err error) error {
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		return err
	}
	switch cerr.Code() {
	case connect.CodeUnimplemented, connect.CodeUnauthenticated, connect.CodePermissionDenied, connect.CodeInvalidArgument:
		return &Permanent{Err: err, Global: true}
	case connect.CodeDataLoss:
		return &Permanent{Err: err}
	case connect.CodeFailedPrecondition:
	default:
		return err
	}
	for _, d := range cerr.Details() {
		if v, verr := d.Value(); verr == nil {
			if res, ok := v.(*ccxv1.AppendResponse); ok {
				return &Mismatch{Size: res.GetSize()}
			}
		}
	}
	return err
}
