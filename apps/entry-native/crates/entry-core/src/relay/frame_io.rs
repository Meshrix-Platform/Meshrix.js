//! Relay-frame ↔ TLS-record bridge — port of `createRelayFrameDuplex`.
//!
//! `FrameIo` implements AsyncRead+AsyncWrite for rustls: writes produce TLS
//! records queued on a bounded channel that the session actor drains into
//! relay frames; inbound relay payloads are pushed by the actor through
//! `FrameIoHandle::feed` once the session driver accepted them.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;
use tokio_util::sync::PollSender;

use crate::b64::b64u_decode;
use crate::wire::session::limits;

struct Shared {
    inbound: VecDeque<u8>,
    inbound_bytes: usize,
    closed: bool,
    read_waker: Option<Waker>,
}

/// Actor-side handle: push inbound relay payloads and observe closure.
#[derive(Clone)]
pub struct FrameIoHandle {
    shared: Arc<Mutex<Shared>>,
    max_buffered: usize,
}

impl FrameIoHandle {
    /// Push an inbound base64url payload; false when the bounded buffer is
    /// full or the stream is closed — the session driver then withholds the
    /// frame ack and re-delivers after the channel rebuilds.
    pub fn feed(&self, payload_base64url: &str) -> bool {
        let Ok(bytes) = b64u_decode(payload_base64url, self.max_buffered + 4096) else {
            return false;
        };
        let mut shared = self.shared.lock().unwrap();
        if shared.closed {
            return false;
        }
        if shared.inbound_bytes + bytes.len() > self.max_buffered {
            return false;
        }
        shared.inbound_bytes += bytes.len();
        shared.inbound.extend(bytes);
        if let Some(waker) = shared.read_waker.take() {
            waker.wake();
        }
        true
    }

    pub fn close(&self) {
        let mut shared = self.shared.lock().unwrap();
        shared.closed = true;
        if let Some(waker) = shared.read_waker.take() {
            waker.wake();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.shared.lock().unwrap().closed
    }
}

/// TLS-side stream: rustls reads pushed relay payloads and writes records
/// that the actor drains into outbound relay frames.
pub struct FrameIo {
    shared: Arc<Mutex<Shared>>,
    outbound: PollSender<Vec<u8>>,
}

/// Create the (io, handle, outbound-drain) triple. `outbound` receives raw
/// TLS record bytes — one send per AsyncWrite call — the actor encodes them
/// as base64url frame payloads.
pub fn frame_io(max_buffered: usize, outbound_capacity: usize) -> (FrameIo, FrameIoHandle, mpsc::Receiver<Vec<u8>>) {
    let shared = Arc::new(Mutex::new(Shared {
        inbound: VecDeque::new(),
        inbound_bytes: 0,
        closed: false,
        read_waker: None,
    }));
    let (outbound_tx, outbound_rx) = mpsc::channel(outbound_capacity.max(8));
    (
        FrameIo { shared: shared.clone(), outbound: PollSender::new(outbound_tx) },
        FrameIoHandle { shared, max_buffered },
        outbound_rx,
    )
}

pub fn frame_io_default() -> (FrameIo, FrameIoHandle, mpsc::Receiver<Vec<u8>>) {
    frame_io(limits::MAX_OUTSTANDING_BYTES as usize, 256)
}

impl AsyncRead for FrameIo {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let mut shared = self.shared.lock().unwrap();
        if shared.inbound_bytes > 0 {
            let n = shared.inbound_bytes.min(buf.remaining());
            let mut tmp = vec![0u8; n];
            for b in tmp.iter_mut() {
                *b = shared.inbound.pop_front().unwrap();
            }
            shared.inbound_bytes -= n;
            buf.put_slice(&tmp);
            return Poll::Ready(Ok(()));
        }
        if shared.closed {
            return Poll::Ready(Ok(())); // EOF
        }
        shared.read_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl AsyncWrite for FrameIo {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        if this.shared.lock().unwrap().closed {
            return Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "relay frame stream closed")));
        }
        match this.outbound.poll_reserve(cx) {
            Poll::Ready(Ok(())) => {
                let n = buf.len();
                match this.outbound.send_item(buf.to_vec()) {
                    Ok(()) => Poll::Ready(Ok(n)),
                    Err(_) => Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "relay frame sink closed"))),
                }
            }
            Poll::Ready(Err(_)) => Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "relay frame sink closed"))),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        // The relay frame boundary is the flush boundary: every write already
        // produced a queued frame.
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.shared.lock().unwrap().closed = true;
        Poll::Ready(Ok(()))
    }
}
