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
func (c *Client) Append(ctx context.Context, session string, offset uint64, data []byte) (uint64, error) {
	res, err := c.svc.Append(ctx, connect.NewRequest(&ccxv1.AppendRequest{
		Origin:    c.origin,
		SessionId: session,
		Offset:    offset,
		Data:      data,
		Bucket:    c.bucket,
		Prefix:    c.prefix,
	}))
	if err != nil {
		return 0, refusal(err)
	}
	return res.Msg.GetSize(), nil
}

// refusal reads the center's refusal as *Mismatch. Only a FailedPrecondition that
// carries an AppendResponse is one: any other code is a real failure (the center
// down, the request refused outright), and a FailedPrecondition without the size
// says nothing about where to continue, so it stays an error to retry.
func refusal(err error) error {
	var cerr *connect.Error
	if !errors.As(err, &cerr) || cerr.Code() != connect.CodeFailedPrecondition {
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
