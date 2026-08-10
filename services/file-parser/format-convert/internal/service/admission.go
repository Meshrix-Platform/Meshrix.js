package service

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

var (
	errAdmissionFull    = errors.New("conversion admission queue is full")
	errAdmissionTimeout = errors.New("conversion admission wait timed out")
)

type admission struct {
	slots        chan struct{}
	queueLimit   int64
	waitTimeout  time.Duration
	waitingCount atomic.Int64
}

func newAdmission(concurrency, queueCapacity int, waitTimeout time.Duration) *admission {
	return &admission{
		slots:       make(chan struct{}, concurrency),
		queueLimit:  int64(queueCapacity),
		waitTimeout: waitTimeout,
	}
}

func (gate *admission) acquire(ctx context.Context) (func(), error) {
	select {
	case gate.slots <- struct{}{}:
		return gate.release, nil
	default:
	}

	if !gate.reserveWaiter() {
		return nil, errAdmissionFull
	}
	defer gate.waitingCount.Add(-1)

	timer := time.NewTimer(gate.waitTimeout)
	defer timer.Stop()
	select {
	case gate.slots <- struct{}{}:
		return gate.release, nil
	case <-timer.C:
		return nil, errAdmissionTimeout
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (gate *admission) reserveWaiter() bool {
	for {
		current := gate.waitingCount.Load()
		if current >= gate.queueLimit {
			return false
		}
		if gate.waitingCount.CompareAndSwap(current, current+1) {
			return true
		}
	}
}

func (gate *admission) release() {
	<-gate.slots
}
