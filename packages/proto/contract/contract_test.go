package contract_test

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"

	ccxv1 "github.com/TakashiAihara/ccx/packages/proto/gen/go/ccx/v1"
)

// payload は ccxd にとって意味を持たない列であり、往復して 1 バイトも変わってはならない。
//
// この性質が要るのは、center が後から生バイトを読み直せることに設計が乗っているから
// (パーサの誤りを後から直せる、という前提)。運ぶ途中で正規化されたら前提が崩れる。
func TestPayloadSurvivesVerbatim(t *testing.T) {
	cases := map[string][]byte{
		"claude code hook json": []byte(`{"session_id":"01K9","hook_event_name":"Stop","cwd":"/tmp/x"}`),

		// bytes であって string ではないことの根拠。ccxd は UTF-8 として妥当かどうかの
		// 判断すらしない。string にすると proto の実装がここで弾く。
		"invalid utf-8": {0xff, 0xfe, 0x00, 0x80},

		// hook が何も書かなかった場合。空も事実として運ぶ。
		"empty": {},
	}

	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			wire, err := proto.Marshal(&ccxv1.Event{Payload: payload})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var got ccxv1.Event
			if err := proto.Unmarshal(wire, &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if !bytes.Equal(got.GetPayload(), payload) {
				t.Errorf("payload changed in transit:\n want %q\n  got %q", payload, got.GetPayload())
			}
		})
	}
}
