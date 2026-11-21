package message

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"
)

// The sender_meta keys (#346): what the sending CLI or tool fills in, and meta_<key> for what its caller adds.
// They are channel attributes as they are, so a key is lower case and cannot be one ccx-agent sets itself
// (from_machine, from_user, msg_id).
const (
	MetaRepo      = "from_repo"
	MetaBranch    = "from_branch"
	MetaCwd       = "from_cwd"
	MetaSession   = "from_session"
	MetaLabel     = "from_label"
	MetaRole      = "from_role"
	MetaInReplyTo = "in_reply_to"
	MetaUserKey   = "meta_"
)

// MaxMetaValue / MaxMetaTotal / MaxMetaKeys bound sender_meta, so it stays a line, not a second body.
const (
	MaxMetaValue = 256
	MaxMetaTotal = 2048
	MaxMetaKeys  = 32
)

var metaKey = regexp.MustCompile(`^(from_(repo|branch|cwd|session|label|role)|in_reply_to|meta_[a-z0-9_]{1,32})$`)

// ValidateMeta refuses a sender_meta that cannot be shown as it is: an unknown key, a value that is not one
// line without control characters, or more than the bounds.
func ValidateMeta(m map[string]string) error {
	if len(m) > MaxMetaKeys {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sender_meta has %d keys, over %d", len(m), MaxMetaKeys))
	}
	total := 0
	for k, v := range m {
		if !metaKey.MatchString(k) {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sender_meta key %q is not one of from_repo, from_branch, from_cwd, from_session, from_label, from_role, in_reply_to, or meta_ and 1 to 32 of a-z 0-9 _", k))
		}
		if !MetaValueOK(v) {
			return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sender_meta %s must be one non-empty line of at most %d bytes without control characters", k, MaxMetaValue))
		}
		total += len(k) + len(v)
	}
	if total > MaxMetaTotal {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("sender_meta is over 2048 bytes"))
	}
	return nil
}

// MetaValueOK is whether v can go in sender_meta. The sending side drops a value it found on its own (a cwd
// over the limit, a label with a newline) rather than refuse the send.
func MetaValueOK(v string) bool {
	return utf8.ValidString(v) && len(v) <= MaxMetaValue && oneLine.MatchString(v)
}

// metaParts is sender_meta as Devin reads it in the line under the body, in a fixed order. The cwd is left
// out: a long path would bury the rest, and a Claude Code receiver still gets it as an attribute.
func metaParts(m map[string]string) []string {
	var parts []string
	switch repo, branch := m[MetaRepo], m[MetaBranch]; {
	case repo != "" && branch != "":
		parts = append(parts, "repo "+repo+"@"+branch)
	case repo != "":
		parts = append(parts, "repo "+repo)
	case branch != "":
		parts = append(parts, "branch "+branch)
	}
	for _, p := range []struct{ key, word string }{{MetaSession, "session"}, {MetaLabel, "label"}, {MetaRole, "role"}, {MetaInReplyTo, "in reply to"}} {
		if v := m[p.key]; v != "" {
			parts = append(parts, p.word+" "+v)
		}
	}
	var own []string
	for k := range m {
		if strings.HasPrefix(k, MetaUserKey) {
			own = append(own, k)
		}
	}
	slices.Sort(own)
	for _, k := range own {
		parts = append(parts, strings.TrimPrefix(k, MetaUserKey)+"="+m[k])
	}
	return parts
}
