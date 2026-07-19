// Package concern is the seam that makes ccxd a modular monolith (ADR 0002).
//
// ccxd is one process, but its three jobs — collect (hooks → center), carry
// (broker → session), and persistence (keep a session alive) — are each a module
// behind this interface. The interface does double duty: it is where a concern
// is turned on or off in config, and it is the line a concern would be extracted
// along if it ever earns its own process (independent scale, different
// privilege, or a different failure cadence — none true today, so none split).
//
// Only collect is implemented in #90. Carry and persistence slot in here the
// same way when built.
package concern

import (
	"context"
	"errors"
	"sync"
)

// A Concern is one of ccxd's bundled jobs. Run blocks until ctx is cancelled (or
// the concern hits a fatal error). Concerns implement this structurally; they do
// not import this package, so the dependency points one way — main wires
// concerns together; a concern never knows about the runner.
type Concern interface {
	Name() string
	Run(ctx context.Context) error
}

// Run starts every concern concurrently and blocks until ctx is cancelled or one
// of them returns an error. This is the whole "one process, several modules"
// mechanism: separate modules, one lifecycle. If any concern errors, ctx is
// cancelled so the rest wind down too — ccxd lives and dies as one process
// (ADR 0002).
func Run(ctx context.Context, log func(string, ...any), concerns ...Concern) error {
	if len(concerns) == 0 {
		log("no concern is enabled — ccxd is idle (all concerns off)")
		<-ctx.Done()
		return nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	errs := make([]error, len(concerns))
	for i, c := range concerns {
		wg.Add(1)
		go func(i int, c Concern) {
			defer wg.Done()
			log("concern %q started", c.Name())
			if err := c.Run(ctx); err != nil && ctx.Err() == nil {
				errs[i] = err
				log("concern %q failed: %v", c.Name(), err)
				cancel() // one failing concern winds the process down
			}
		}(i, c)
	}
	wg.Wait()
	return errors.Join(errs...)
}
