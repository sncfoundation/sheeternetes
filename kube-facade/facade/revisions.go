package facade

import (
	"context"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/sncfoundation/sheeternetes/internal/sheetapi"
)

// RevisionSource lists the Sheet's Drive version history.
type RevisionSource interface {
	Revisions(ctx context.Context) ([]sheetapi.Revision, error)
}

// Revisions derives resourceVersions from Google Sheets version history:
//
//	resourceVersion = <latest Drive revision id> * 1000 + <changes seen since>
//
// Google cuts a new revision per batch of edits, not per edit, so the facade
// counts the content changes it observes inside one revision. The number only
// ever grows as long as revision ids do (they are increasing integers for Sheets).
// If the history cannot be read (no Drive advanced service), it falls back to
// counting content changes.
type Revisions struct {
	Source RevisionSource
	TTL    time.Duration // how long a revision listing is reused

	mu        sync.Mutex
	fetched   time.Time
	rev       int64
	hash      string
	k         int64
	fallback  counter
	warned    bool
	lastValue int64
}

// Version implements Versioner.
func (r *Revisions) Version(ctx context.Context, hash string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rev == 0 || time.Since(r.fetched) >= r.TTL {
		revs, err := r.Source.Revisions(ctx)
		id := int64(0)
		if err == nil && len(revs) > 0 {
			id, err = strconv.ParseInt(revs[len(revs)-1].ID, 10, 64)
		}
		if err != nil || id == 0 {
			if !r.warned {
				log.Printf("revision history unavailable (%v); resourceVersion falls back to a change counter", err)
				r.warned = true
			}
			return r.fallback.Version(ctx, hash)
		}
		r.fetched = time.Now()
		if id != r.rev {
			r.rev, r.k, r.hash = id, 0, hash
		}
	}
	if hash != r.hash {
		r.hash, r.k = hash, r.k+1
	}
	v := r.rev*1000 + min(r.k, 999)
	if v < r.lastValue { // never go backwards, even if Drive reorders
		v = r.lastValue
	}
	r.lastValue = v
	return strconv.FormatInt(v, 10), nil
}
