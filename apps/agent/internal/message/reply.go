package message

import (
	"slices"
	"sync"
	"time"
)

// replyTo is who a delivered message came from: what a reply to its msg_id is sent to (#334).
type replyTo struct {
	Sender, Machine, User string
	at                    time.Time
	// pending: booked before it is typed (a reply can come while a --wait still holds the send), not yet known to
	// have reached the receiver. It does not count toward replyMax, so a send that fails cannot push one out.
	pending bool
}

// replyBook remembers the msg_ids this agent delivered, so `ccx msg send --reply <msg_id>` can be sent back
// without the receiver spelling out the sender's name and machine.
//
// shortcut: kept in memory, so a restarted agent forgets them and refuses such a reply; keep them on disk if
// that turns out to bite.
type replyBook struct {
	mu    sync.Mutex
	ids   map[string]replyTo
	order []string
	now   func() time.Time
}

// replyKeep / replyMax bound how long and how many ids are remembered.
const (
	replyKeep = 7 * 24 * time.Hour
	replyMax  = 1000
)

func newReplyBook(now func() time.Time) *replyBook {
	return &replyBook{ids: map[string]replyTo{}, now: now}
}

// add books id as pending, dropping nothing; confirm or remove settles it.
func (b *replyBook) add(id string, to replyTo) {
	b.mu.Lock()
	defer b.mu.Unlock()
	to.at, to.pending = b.now(), true
	// Booked again (a later message a turn took), it goes to the back as the newest.
	if i := slices.Index(b.order, id); i >= 0 {
		b.order = slices.Delete(b.order, i, i+1)
	}
	b.order = append(b.order, id)
	b.ids[id] = to
}

// confirm marks id as having reached the receiver, then drops the oldest such ids past replyMax. Pending ones
// are neither counted nor dropped.
func (b *replyBook) confirm(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	to, ok := b.ids[id]
	if !ok {
		return
	}
	to.pending = false
	b.ids[id] = to
	n := 0
	for _, o := range b.order {
		if !b.ids[o].pending {
			n++
		}
	}
	b.order = slices.DeleteFunc(b.order, func(o string) bool {
		if n <= replyMax || b.ids[o].pending {
			return false
		}
		delete(b.ids, o)
		n--
		return true
	})
}

func (b *replyBook) get(id string) (replyTo, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	to, ok := b.ids[id]
	if !ok || b.now().Sub(to.at) > replyKeep {
		return replyTo{}, false
	}
	return to, true
}

func (b *replyBook) remove(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.ids[id]; !ok {
		return
	}
	delete(b.ids, id)
	for i, o := range b.order {
		if o == id {
			b.order = append(b.order[:i], b.order[i+1:]...)
			break
		}
	}
}
