//! Inner request channel — port of `createInnerRequestChannel`.
//!
//! Newline-delimited JSON-RPC over the pinned mutual-TLS stream. Dispatch
//! evidence is honest: a request whose bytes provably never entered the
//! channel settles `entry_never_dispatched` (not_started); one written to the
//! stream and then lost settles `entry_inner_lost` (unknown).

use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::error::{entry_error, EntryError, Result};
use crate::wire::common::is_plain_object;

pub const INNER_LINE_MAX_BYTES: usize = 1024 * 1024;
pub const DEFAULT_MAX_PENDING_REQUESTS: usize = 256;
const TICK: Duration = Duration::from_millis(50);

fn request_key(id: &Value) -> Option<String> {
    match id {
        Value::String(s) => Some(format!("string:{s}")),
        Value::Number(n) => Some(format!("number:{n}")),
        _ => None,
    }
}

struct PendingRequest {
    dispatched: bool,
    reply: oneshot::Sender<Result<Value>>,
    deadline: Option<Instant>,
}

struct Submit {
    message: Value,
    reply: oneshot::Sender<Result<Value>>,
    request_timeout: Option<Duration>,
}

/// Live channel handle — a cloneable sender into the channel task.
#[derive(Clone)]
pub struct InnerChannelHandle {
    /// Correlation id allocated by the owning session; channel-lost events
    /// carry it so a superseded channel never tears down the live one.
    pub id: u64,
    tx: mpsc::UnboundedSender<Submit>,
    closed: Arc<Mutex<Option<EntryError>>>,
    max_line_bytes: usize,
    request_timeout: Option<Duration>,
    pending_count: Arc<Mutex<usize>>,
}

impl InnerChannelHandle {
    pub fn is_closed(&self) -> bool {
        self.closed.lock().unwrap().is_some()
    }

    pub fn pending_count(&self) -> usize {
        *self.pending_count.lock().unwrap()
    }

    pub async fn request(&self, message: Value) -> Result<Value> {
        if let Some(error) = self.closed.lock().unwrap().clone() {
            return Err(error);
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        if request_key(&id).is_none() {
            return Err(entry_error(
                "entry_request_invalid",
                "An inner-channel request requires a string or number id.",
            ));
        }
        let encoded = format!("{}\n", serde_json::to_string(&message).map_err(|e| {
            entry_error("entry_request_invalid", format!("Inner request does not serialize: {e}"))
        })?);
        if encoded.len() > self.max_line_bytes {
            return Err(entry_error(
                "entry_request_oversize",
                "The request exceeds the inner-channel line budget.",
            ));
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Submit { message, reply: reply_tx, request_timeout: self.request_timeout })
            .map_err(|_| {
                entry_error("entry_channel_closed", "The inner channel is not established.")
                    .with_effect("not_started")
            })?;
        match reply_rx.await {
            Ok(result) => result,
            Err(_) => Err(entry_error("entry_inner_closed", "The inner channel closed.")),
        }
    }

    pub fn close(&self, code: &str) {
        let mut closed = self.closed.lock().unwrap();
        if closed.is_none() {
            *closed = Some(entry_error(code, "The inner channel was closed."));
        }
        let _ = self.tx.send(Submit {
            message: Value::Null,
            reply: oneshot::channel().0,
            request_timeout: None,
        });
    }
}

struct PendingState {
    map: HashMap<String, PendingRequest>,
    /// Submission order; the channel is request/response, not pipelined —
    /// order matters only for eviction fairness.
    order: VecDeque<String>,
}

/// Spawn the channel task over a TLS stream. `on_lost` fires once when the
/// channel dies from a socket or protocol failure.
pub fn spawn_inner_channel<S>(
    stream: S,
    id: u64,
    max_pending: usize,
    max_line_bytes: usize,
    request_timeout: Option<Duration>,
    on_lost: Box<dyn FnOnce(EntryError) + Send>,
) -> InnerChannelHandle
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (tx, rx) = mpsc::unbounded_channel::<Submit>();
    let closed = Arc::new(Mutex::new(None::<EntryError>));
    let pending_count = Arc::new(Mutex::new(0usize));
    let handle = InnerChannelHandle {
        id,
        tx,
        closed: closed.clone(),
        max_line_bytes: max_line_bytes.max(256),
        request_timeout,
        pending_count: pending_count.clone(),
    };
    let inner_closed = closed.clone();
    let inner_pending_count = pending_count.clone();
    tokio::spawn(async move {
        channel_task(
            stream,
            rx,
            max_pending.max(1),
            max_line_bytes.max(256),
            inner_closed,
            inner_pending_count,
            on_lost,
        )
        .await;
    });
    handle
}

async fn channel_task<S>(
    stream: S,
    mut rx: mpsc::UnboundedReceiver<Submit>,
    max_pending: usize,
    max_line_bytes: usize,
    closed: Arc<Mutex<Option<EntryError>>>,
    pending_count: Arc<Mutex<usize>>,
    on_lost: Box<dyn FnOnce(EntryError) + Send>,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut state = PendingState { map: HashMap::new(), order: VecDeque::new() };
    let mut fail_cause: Option<EntryError> = None;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut line = Vec::with_capacity(16 * 1024);

    loop {
        tokio::select! {
            submit = rx.recv() => {
                match submit {
                    None => break,
                    Some(submit) => {
                        if submit.message.is_null() {
                            break; // close() sentinel
                        }
                        let id = submit.message.get("id").cloned().unwrap_or(Value::Null);
                        let Some(key) = request_key(&id) else {
                            let _ = submit.reply.send(Err(entry_error("entry_request_invalid", "An inner-channel request requires a string or number id.")));
                            continue;
                        };
                        if state.map.contains_key(&key) {
                            let _ = submit.reply.send(Err(entry_error("entry_request_duplicate", "A request with this id is already in flight.")));
                            continue;
                        }
                        if state.map.len() >= max_pending {
                            let _ = submit.reply.send(Err(entry_error("entry_backpressure", "The inner-channel pending window is full; retry when it drains.").with_effect("not_started")));
                            continue;
                        }
                        let encoded = format!("{}\n", serde_json::to_string(&submit.message).unwrap_or_else(|_| "null".into()));
                        if encoded.len() > max_line_bytes {
                            let _ = submit.reply.send(Err(entry_error("entry_request_oversize", "The request exceeds the inner-channel line budget.").with_effect("not_started")));
                            continue;
                        }
                        let deadline = submit.request_timeout.map(|t| Instant::now() + t);
                        match writer.write_all(encoded.as_bytes()).await {
                            Ok(()) => {
                                // Drain the TLS record into the relay frame
                                // queue — once write()+flush() return, the
                                // bytes entered the channel: the honest
                                // dispatch boundary.
                                if let Err(_e) = writer.flush().await {
                                    let _ = submit.reply.send(Err(entry_error("entry_inner_lost", "The request could not be fully written to the inner channel; the operation status is unknown.").with_effect("unknown")));
                                    continue;
                                }
                                state.order.push_back(key.clone());
                                state.map.insert(key, PendingRequest { dispatched: true, reply: submit.reply, deadline });
                                *pending_count.lock().unwrap() = state.map.len();
                            }
                            Err(e) => {
                                if e.kind() == io::ErrorKind::WriteZero {
                                    let _ = submit.reply.send(Err(entry_error("entry_never_dispatched", "The request never reached the relay transport; the operation was not started.").with_effect("not_started")));
                                } else {
                                    let _ = submit.reply.send(Err(entry_error("entry_inner_lost", "The request could not be fully written to the inner channel; the operation status is unknown.").with_effect("unknown")));
                                }
                            }
                        }
                    }
                }
            }
            read = reader.read_until(b'\n', &mut line) => {
                match read {
                    Ok(0) => { fail_cause = Some(entry_error("entry_inner_closed", "The inner channel closed.")); break; }
                    Ok(n) => {
                        if n > max_line_bytes {
                            fail_cause = Some(entry_error("entry_inner_protocol", "The endpoint exceeded the inner-channel line budget."));
                            break;
                        }
                        let raw = std::mem::take(&mut line);
                        let payload = &raw[..raw.len().saturating_sub(1)];
                        if !payload.is_empty() {
                            if let Err(e) = accept_line(payload, &mut state) {
                                fail_cause = Some(e);
                                break;
                            }
                            *pending_count.lock().unwrap() = state.map.len();
                        }
                    }
                    Err(e) => { fail_cause = Some(entry_error("entry_inner_socket", format!("The inner channel socket failed: {e}"))); break; }
                }
            }
            _ = tick.tick() => {
                let now = Instant::now();
                let expired: Vec<String> = state.map.iter()
                    .filter(|(_, p)| p.deadline.is_some_and(|d| d <= now))
                    .map(|(k, _)| k.clone())
                    .collect();
                for key in expired {
                    if let Some(pending) = state.map.remove(&key) {
                        state.order.retain(|k| k != &key);
                        let _ = pending.reply.send(Err(entry_error("entry_request_timeout", "The endpoint did not answer within the request budget; the operation status is unknown.").with_effect("unknown")));
                    }
                }
                *pending_count.lock().unwrap() = state.map.len();
            }
        }
    }

    let cause = fail_cause.unwrap_or_else(|| entry_error("entry_channel_closed", "The inner channel was closed."));
    *closed.lock().unwrap() = Some(cause.clone());
    for (_, pending) in state.map.drain() {
        let error = if pending.dispatched {
            entry_error("entry_inner_lost", "The inner channel was lost after the request was dispatched; the operation status is unknown.")
                .with_effect("unknown")
        } else {
            entry_error("entry_never_dispatched", "The request never reached the relay transport; the operation was not started.")
                .with_effect("not_started")
        };
        let _ = pending.reply.send(Err(error));
    }
    *pending_count.lock().unwrap() = 0;
    on_lost(cause);
}

fn accept_line(line: &[u8], state: &mut PendingState) -> std::result::Result<(), EntryError> {
    let value: Value = serde_json::from_slice(line).map_err(|_| {
        entry_error("entry_inner_protocol", "The endpoint returned a malformed inner-channel line.")
    })?;
    // The response envelope is exactly {id, outcome}; anything else poisons
    // correlation and tears the channel down.
    let keys: Vec<&str> = value.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
    if !is_plain_object(&value) || keys.len() != 2 || !keys.contains(&"id") || !keys.contains(&"outcome") {
        return Err(entry_error(
            "entry_inner_protocol",
            "The endpoint returned a malformed inner-channel response envelope.",
        ));
    }
    let id = value.get("id").unwrap().clone();
    let Some(key) = request_key(&id) else { return Ok(()) };
    if let Some(pending) = state.map.remove(&key) {
        state.order.retain(|k| k != &key);
        let _ = pending.reply.send(Ok(value.get("outcome").cloned().unwrap_or(Value::Null)));
    }
    // Unknown or already-settled id — dropped, never replayed.
    Ok(())
}
