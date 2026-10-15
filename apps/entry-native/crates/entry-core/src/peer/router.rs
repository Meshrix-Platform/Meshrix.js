//! `application-peer-router.ts` — one profile-level Peer application port
//! over the exact, enrolled `PeerClient` routes. It never searches by peer id
//! or falls back to another route.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use futures_util::future::LocalBoxFuture;

use crate::error::entry_error;
use crate::Result;

use super::application::{
    PeerApplicationAddress, PeerApplicationRouteAuthority, PeerApplicationSendState,
};
use super::application_engine::PeerApplicationPeerPort;
use super::client::{
    PeerClient, PeerDispatchHandler, PeerInboundMessage, PeerInboundOutcome,
};
use super::client_store::StoredOutboxEntry;

/// One enrolled route's exact binding: its `PeerClient` plus the closures
/// that read stored connection authority and presence.
pub struct ApplicationPeerRouteBinding {
    pub tenant_id: String,
    pub route_id: String,
    pub local_device_id: String,
    pub client: Rc<PeerClient>,
    /// `allowsPeer` — exact pairing + account authority check.
    pub allows_peer: Rc<dyn Fn(String) -> LocalBoxFuture<'static, bool>>,
    /// Distinguishes a revoked binding from temporary unavailability.
    pub resolve_peer_authority:
        Option<Rc<dyn Fn(String) -> LocalBoxFuture<'static, PeerApplicationRouteAuthority>>>,
    pub is_reachable: Rc<dyn Fn(String) -> LocalBoxFuture<'static, bool>>,
    /// `subscribe` — optional per-binding inbound hook. When absent the
    /// router subscribes on `client` directly; the personal endpoint binding
    /// routes through its sender-validation dispatch instead.
    pub subscribe: Option<Rc<dyn Fn(PeerDispatchHandler) -> Box<dyn Fn()>>>,
}

fn route_key(
    address: &(impl RouteTuple + ?Sized),
) -> String {
    serde_json::to_string(&[
        address.tenant_id(),
        address.route_id(),
        address.local_device_id(),
    ])
    .unwrap_or_default()
}

trait RouteTuple {
    fn tenant_id(&self) -> &str;
    fn route_id(&self) -> &str;
    fn local_device_id(&self) -> &str;
}

impl RouteTuple for ApplicationPeerRouteBinding {
    fn tenant_id(&self) -> &str {
        &self.tenant_id
    }
    fn route_id(&self) -> &str {
        &self.route_id
    }
    fn local_device_id(&self) -> &str {
        &self.local_device_id
    }
}

impl RouteTuple for PeerApplicationAddress {
    fn tenant_id(&self) -> &str {
        &self.tenant_id
    }
    fn route_id(&self) -> &str {
        &self.route_id
    }
    fn local_device_id(&self) -> &str {
        &self.local_device_id
    }
}

pub type ApplicationPeerAuthorityResolver =
    Rc<dyn Fn(PeerApplicationAddress) -> LocalBoxFuture<'static, PeerApplicationRouteAuthority>>;

type InboundHandler =
    Rc<dyn Fn(PeerApplicationInbound) -> LocalBoxFuture<'static, PeerInboundOutcome>>;

use super::application::PeerApplicationInbound;

struct RegisteredRoute {
    binding: Rc<ApplicationPeerRouteBinding>,
    unsubscribe: Box<dyn Fn()>,
}

struct AuthorityObservation {
    address: PeerApplicationAddress,
    delay_ms: u64,
    task: Option<tokio::task::AbortHandle>,
}

/// `EntryApplicationPeerRouter` — routes application traffic only through the
/// exact enrolled `PeerClient` route.
pub struct EntryApplicationPeerRouter {
    routes: RefCell<HashMap<String, RegisteredRoute>>,
    inbound: RefCell<Vec<InboundHandler>>,
    authority_resolver: Option<ApplicationPeerAuthorityResolver>,
    authority_observers: RefCell<HashMap<String, Rc<RefCell<AuthorityObservation>>>>,
    authority_listeners:
        RefCell<Vec<Rc<dyn Fn(PeerApplicationAddress, PeerApplicationRouteAuthority)>>>,
    /// `resolve_peer_authority` arrives on `&self`; spawned re-polls upgrade
    /// this back to the owning `Rc`.
    self_ref: RefCell<std::rc::Weak<Self>>,
    disposed: Cell<bool>,
}

impl EntryApplicationPeerRouter {
    pub fn new(
        resolve_peer_authority: Option<ApplicationPeerAuthorityResolver>,
    ) -> Rc<Self> {
        let router = Rc::new(Self {
            routes: RefCell::new(HashMap::new()),
            inbound: RefCell::new(Vec::new()),
            authority_resolver: resolve_peer_authority,
            authority_observers: RefCell::new(HashMap::new()),
            authority_listeners: RefCell::new(Vec::new()),
            self_ref: RefCell::new(std::rc::Weak::new()),
            disposed: Cell::new(false),
        });
        *router.self_ref.borrow_mut() = Rc::downgrade(&router);
        router
    }

    /// Register one enrolled route binding. Returns an unregister closure.
    /// Re-registering the same `PeerClient` under the same route is a no-op;
    /// a different client is a hard conflict.
    pub fn register(
        self: &Rc<Self>,
        binding: ApplicationPeerRouteBinding,
    ) -> Result<Box<dyn Fn()>> {
        let key = route_key(&binding);
        let binding = Rc::new(binding);
        {
            let mut routes = self.routes.borrow_mut();
            if let Some(current) = routes.get(&key) {
                if Rc::ptr_eq(&current.binding.client, &binding.client) {
                    let weak = self.self_ref.borrow().clone();
                    let binding2 = binding.clone();
                    return Ok(Box::new(move || {
                        if let Some(this) = weak.upgrade() {
                            this.unregister_binding(&binding2);
                        }
                    }));
                }
                return Err(entry_error(
                    "peer_route_conflict",
                    "A different PeerClient already owns this exact local route.",
                ));
            }
            routes.insert(
                key,
                RegisteredRoute {
                    binding: binding.clone(),
                    unsubscribe: Box::new(|| {}),
                },
            );
        }
        // Subscribe AFTER registering so a dispatch during the subscribe
        // call can already resolve the binding. A binding-supplied
        // `subscribe` hook (personal endpoint) owns both attach and detach.
        let weak = self.self_ref.borrow().clone();
        let dispatch_binding = binding.clone();
        let dispatch_handler: PeerDispatchHandler = Rc::new(move |message| {
            let weak = weak.clone();
            let binding = dispatch_binding.clone();
            let fut: LocalBoxFuture<'static, PeerInboundOutcome> = Box::pin(async move {
                match weak.upgrade() {
                    Some(this) => this.dispatch(&binding, message).await,
                    None => PeerInboundOutcome::Deferred { detail: Vec::new() },
                }
            });
            fut
        });
        let unsubscribe: Box<dyn Fn()> = match &binding.subscribe {
            Some(subscribe) => subscribe(dispatch_handler),
            None => {
                binding.client.on_inbound_message(dispatch_handler);
                let client = binding.client.clone();
                Box::new(move || client.clear_inbound_message_handler())
            }
        };
        if let Some(route) = self.routes.borrow_mut().get_mut(&route_key(&*binding)) {
            if Rc::ptr_eq(&route.binding, &binding) {
                route.unsubscribe = unsubscribe;
            }
        }
        let weak = self.self_ref.borrow().clone();
        Ok(Box::new(move || {
            if let Some(this) = weak.upgrade() {
                this.unregister_binding(&binding);
            }
        }))
    }

    pub fn unregister_binding(&self, binding: &Rc<ApplicationPeerRouteBinding>) {
        let key = route_key(&**binding);
        let current = self.routes.borrow_mut().remove(&key);
        if let Some(current) = current {
            if Rc::ptr_eq(&current.binding, binding) {
                (current.unsubscribe)();
            } else {
                self.routes.borrow_mut().insert(key, current);
            }
        }
    }

    /// The engine registers its inbound dispatcher once.
    pub fn on_inbound_message(&self, handler: InboundHandler) -> Box<dyn Fn()> {
        self.inbound.borrow_mut().push(handler.clone());
        let weak = self.self_ref.borrow().clone();
        Box::new(move || {
            if let Some(this) = weak.upgrade() {
                this.inbound
                    .borrow_mut()
                    .retain(|h| !Rc::ptr_eq(h, &handler));
            }
        })
    }

    pub fn on_authority_resolved(
        &self,
        handler: Rc<dyn Fn(PeerApplicationAddress, PeerApplicationRouteAuthority)>,
    ) -> usize {
        let mut listeners = self.authority_listeners.borrow_mut();
        listeners.push(handler);
        listeners.len()
    }

    pub fn dispose(&self) {
        self.disposed.set(true);
        for (_, observation) in self.authority_observers.borrow_mut().drain() {
            if let Some(task) = observation.borrow_mut().task.take() {
                task.abort();
            }
        }
        self.authority_listeners.borrow_mut().clear();
    }

    async fn query_peer_authority(
        &self,
        address: &PeerApplicationAddress,
    ) -> PeerApplicationRouteAuthority {
        // A registered route's own resolver decides first — the global
        // resolver only covers unbound routes (caller-side decisions for
        // connections without a live binding).
        let binding = self.resolve(address);
        match binding {
            Some(binding) => {
                if let Some(resolve) = &binding.resolve_peer_authority {
                    resolve(address.peer_device_id.clone()).await
                } else if (binding.allows_peer)(address.peer_device_id.clone()).await {
                    PeerApplicationRouteAuthority::Current
                } else {
                    PeerApplicationRouteAuthority::Revoked
                }
            }
            None => {
                if let Some(resolver) = &self.authority_resolver {
                    resolver(address.clone()).await
                } else {
                    PeerApplicationRouteAuthority::Unavailable
                }
            }
        }
    }

    /// `unavailable` authority is re-polled with backoff until it settles —
    /// a temporary account outage must not strand accepted work.
    fn observe_authority(&self, address: PeerApplicationAddress) {
        if self.disposed.get() {
            return;
        }
        let key = serde_json::to_string(&address).unwrap_or_default();
        if self.authority_observers.borrow().contains_key(&key) {
            return;
        }
        let observation = Rc::new(RefCell::new(AuthorityObservation {
            address: address.clone(),
            delay_ms: 1_000,
            task: None,
        }));
        self.authority_observers
            .borrow_mut()
            .insert(key.clone(), observation.clone());
        self.schedule_authority_check(&key, observation);
    }

    fn schedule_authority_check(
        &self,
        key: &str,
        observation: Rc<RefCell<AuthorityObservation>>,
    ) {
        let delay = observation.borrow().delay_ms;
        let Some(this) = self.self_ref.borrow().upgrade() else { return };
        let key = key.to_string();
        let observation2 = observation.clone();
        let handle = tokio::task::spawn_local(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let exists = {
                let observers = this.authority_observers.borrow();
                matches!(
                    observers.get(&key),
                    Some(current) if Rc::ptr_eq(current, &observation2)
                )
            };
            if !exists || this.disposed.get() {
                return;
            }
            let address: PeerApplicationAddress = match serde_json::from_str(&key) {
                Ok(a) => a,
                Err(_) => return,
            };
            let state = this.query_peer_authority(&address).await;
            if this.disposed.get() {
                return;
            }
            if !matches!(
                this.authority_observers.borrow().get(&key),
                Some(current) if Rc::ptr_eq(current, &observation2)
            ) {
                return;
            }
            if state == PeerApplicationRouteAuthority::Unavailable {
                let next_delay = (observation2.borrow().delay_ms * 2).min(30_000);
                observation2.borrow_mut().delay_ms = next_delay;
                this.schedule_authority_check(&key, observation2);
            } else {
                this.settle_authority(&key, state);
            }
        });
        observation.borrow_mut().task = Some(handle.abort_handle());
        std::mem::forget(handle);
    }

    fn settle_authority(&self, key: &str, state: PeerApplicationRouteAuthority) {
        let observation = self.authority_observers.borrow_mut().remove(key);
        let Some(observation) = observation else { return };
        if let Some(task) = observation.borrow_mut().task.take() {
            task.abort();
        }
        let address = observation.borrow().address.clone();
        for listener in self.authority_listeners.borrow().iter() {
            listener(address.clone(), state.clone());
        }
    }

    fn resolve(
        &self,
        address: &PeerApplicationAddress,
    ) -> Option<Rc<ApplicationPeerRouteBinding>> {
        let binding = self.routes.borrow().get(&route_key(address))?.binding.clone();
        if binding.tenant_id == address.tenant_id
            && binding.route_id == address.route_id
            && binding.local_device_id == address.local_device_id
        {
            Some(binding)
        } else {
            None
        }
    }

    async fn dispatch(
        &self,
        binding: &Rc<ApplicationPeerRouteBinding>,
        message: PeerInboundMessage,
    ) -> PeerInboundOutcome {
        let address = PeerApplicationAddress {
            tenant_id: binding.tenant_id.clone(),
            route_id: binding.route_id.clone(),
            local_device_id: binding.local_device_id.clone(),
            peer_device_id: message.sender_device_id.clone(),
        };
        if !(binding.allows_peer)(address.peer_device_id.clone()).await {
            return PeerInboundOutcome::Rejected { detail: Vec::new() };
        }
        let delivery = PeerApplicationInbound { address, message };
        for handler in self.inbound.borrow().iter() {
            return handler(delivery.clone()).await;
        }
        PeerInboundOutcome::Deferred { detail: Vec::new() }
    }
}

impl PeerApplicationPeerPort for EntryApplicationPeerRouter {
    fn resolve_peer_authority<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<PeerApplicationRouteAuthority>> {
        Box::pin(async move {
            let state = self.query_peer_authority(address).await;
            if state == PeerApplicationRouteAuthority::Unavailable {
                self.observe_authority(address.clone());
            } else {
                // A settled authority releases any pending observation.
                let key = serde_json::to_string(address).unwrap_or_default();
                if self.authority_observers.borrow().contains_key(&key) {
                    self.settle_authority(&key, state.clone());
                }
            }
            Ok(state)
        })
    }

    fn is_peer_reachable<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<bool>> {
        Box::pin(async move {
            let binding = self.resolve(address);
            match binding {
                Some(binding) => Ok(
                    (binding.allows_peer)(address.peer_device_id.clone()).await
                        && (binding.is_reachable)(address.peer_device_id.clone()).await,
                ),
                None => Ok(false),
            }
        })
    }

    fn send_message<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
        plaintext: Vec<u8>,
        message_id: String,
    ) -> LocalBoxFuture<'a, Result<StoredOutboxEntry>> {
        Box::pin(async move {
            let binding = self.resolve(address);
            let Some(binding) = binding else {
                return Err(entry_error(
                    "peer_route_unavailable",
                    "The exact paired route is no longer available.",
                ));
            };
            if !(binding.allows_peer)(address.peer_device_id.clone()).await {
                return Err(entry_error(
                    "peer_route_unavailable",
                    "The exact paired route is no longer available.",
                ));
            }
            binding
                .client
                .send_message(&address.peer_device_id, &plaintext, Some(message_id))
                .await
        })
    }

    fn get_send_state<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
        message_id: &'a str,
    ) -> LocalBoxFuture<'a, Result<Option<PeerApplicationSendState>>> {
        Box::pin(async move {
            let binding = self.resolve(address);
            let Some(binding) = binding else { return Ok(None) };
            if !(binding.allows_peer)(address.peer_device_id.clone()).await {
                return Ok(None);
            }
            let entry = binding
                .client
                .outbox
                .entry(message_id, &address.peer_device_id)?;
            Ok(entry
                .filter(|e| e.identity.recipient_device_id == address.peer_device_id)
                .map(|e| e.state))
        })
    }

    fn set_inbound_handler(&self, handler: InboundHandler) {
        self.inbound.borrow_mut().push(handler);
    }

    fn retry_pending_inbound<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if let Some(binding) = self.resolve(address) {
                binding.client.retry_pending_dispatch().await?;
            }
            Ok(())
        })
    }
}
