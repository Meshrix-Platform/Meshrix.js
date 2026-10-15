//! Inner pinned-TLS channel for the private endpoint — port of
//! `inner-channel.ts` + the relay-frame duplex pump.
//!
//! The relay only forwards opaque frame payloads; those payloads are TLS
//! records terminated here. The channel is authenticated by the peer SPKI
//! pin, never by CA trust and never by a relay-selected identifier.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

/// Byte-stream duplex over relay frames — the sync `RelayFrameDuplex`.
/// Inbound payloads feed the queue; TLS writes produce outbound payload bytes
/// the owner drains into `session.send_payload`.
pub struct FrameDuplex {
    shared: Arc<DuplexShared>,
    outbound: std::sync::mpsc::SyncSender<Vec<u8>>,
    /// Wakes the owner's event loop so newly queued outbound records are
    /// drained promptly instead of waiting for the next inbound relay tick.
    wake: Option<tokio::sync::mpsc::UnboundedSender<()>>,
}

struct DuplexShared {
    state: Mutex<DuplexState>,
    readable: Condvar,
}

struct DuplexState {
    inbound: VecDeque<u8>,
    closed: bool,
    /// Buffered-byte bound mirroring `maxBufferedBytes`.
    max_buffered: usize,
}

/// Handle the session layer feeds frames into and closes.
#[derive(Clone)]
pub struct FrameDuplexHandle {
    shared: Arc<DuplexShared>,
}

impl FrameDuplexHandle {
    /// `feed` — returns false when the buffer is full or closed; the session
    /// driver treats false as "not deliverable yet" and withholds the ack.
    pub fn feed(&self, payload: &[u8]) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        if state.closed || state.inbound.len() + payload.len() > state.max_buffered {
            return false;
        }
        state.inbound.extend(payload.iter().copied());
        drop(state);
        self.shared.readable.notify_all();
        true
    }

    pub fn close(&self) {
        self.shared.state.lock().unwrap().closed = true;
        self.shared.readable.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.shared.state.lock().unwrap().closed
    }
}

/// Create the (duplex, handle, outbound-drain) triple. The owner drains
/// `outbound` into `session.send_payload`; `wake` notifies the owner's event
/// loop whenever the channel thread queues a record.
pub fn frame_duplex(
    max_buffered: usize,
    wake: Option<tokio::sync::mpsc::UnboundedSender<()>>,
) -> (FrameDuplex, FrameDuplexHandle, std::sync::mpsc::Receiver<Vec<u8>>) {
    let (outbound_tx, outbound_rx) = std::sync::mpsc::sync_channel(256);
    let shared = Arc::new(DuplexShared {
        state: Mutex::new(DuplexState {
            inbound: VecDeque::new(),
            closed: false,
            max_buffered: max_buffered.max(4096),
        }),
        readable: Condvar::new(),
    });
    (
        FrameDuplex { shared: shared.clone(), outbound: outbound_tx, wake },
        FrameDuplexHandle { shared },
        outbound_rx,
    )
}

impl Read for FrameDuplex {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut state = self.shared.state.lock().unwrap();
        loop {
            if !state.inbound.is_empty() {
                let n = state.inbound.len().min(buf.len());
                for b in buf.iter_mut().take(n) {
                    *b = state.inbound.pop_front().unwrap();
                }
                return Ok(n);
            }
            if state.closed {
                return Ok(0);
            }
            state = self
                .shared
                .readable
                .wait_timeout(state, std::time::Duration::from_secs(30))
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "duplex lock poisoned"))?
                .0;
        }
    }
}

impl Write for FrameDuplex {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.shared.state.lock().unwrap().closed {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "relay frame stream closed"));
        }
        self.outbound
            .send(buf.to_vec())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "relay frame sink closed"))?;
        if let Some(wake) = &self.wake {
            let _ = wake.send(());
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
