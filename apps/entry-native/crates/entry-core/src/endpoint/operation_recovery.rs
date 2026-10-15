//! `operation-recovery.ts` — endpoint operation ledger + recovery answers.
//!
//! Authorize + answer an `operation-query`. A query for another principal's
//! operation is refused as `status_unavailable` rather than leaking
//! existence; an evicted-but-seen id is doubt, never "never submitted".

use std::collections::HashMap;

use serde_json::Value;

use crate::wire::recovery::{create_operation_status, parse_operation_query};

/// `EndpointOperationPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationPhase {
    Received,
    RefusedPreDispatch,
    Dispatched,
    SettledComplete,
    SettledFailed,
    OutcomeUncertain,
    CancelIntent,
}



/// `EndpointOperationRecord`.
#[derive(Debug, Clone)]
pub struct EndpointOperationRecord {
    pub operation_id: String,
    pub principal_ref: String,
    pub generation: u64,
    pub phase: OperationPhase,
    pub permit_id: Option<String>,
    pub result_available: bool,
    pub recorded_at: i64,
    pub updated_at: i64,
}

/// `InMemoryOperationLedger` — bounded records + tombstone watermark.
///
/// Tombstones cover the whole retention window: an evicted record is never
/// reported as never-submitted. If the watermark itself overflows the hard
/// cap, `overflowed()` turns true and every absent-record answer degrades to
/// doubt instead of licensing replay of billed work.
pub struct OperationLedger {
    records: HashMap<String, EndpointOperationRecord>,
    tombstones: HashMap<String, i64>,
    tombstone_overflowed: bool,
    retention_ms: i64,
    max: usize,
}

impl Default for OperationLedger {
    fn default() -> Self {
        Self::new(15 * 60_000, 4_096)
    }
}

impl OperationLedger {
    pub fn new(retention_ms: i64, max_operations: usize) -> Self {
        Self {
            records: HashMap::new(),
            tombstones: HashMap::new(),
            tombstone_overflowed: false,
            retention_ms,
            max: max_operations.clamp(1, 1_000_000),
        }
    }

    fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    pub fn seen(&self, operation_id: &str) -> bool {
        self.records.contains_key(operation_id) || self.tombstones.contains_key(operation_id)
    }

    pub fn overflowed(&self) -> bool {
        self.tombstone_overflowed
    }

    fn evict(&mut self, operation_id: &str, now: i64) {
        self.records.remove(operation_id);
        self.tombstones.insert(operation_id.to_string(), now);
        if self.tombstones.len() > self.max * 2 {
            if let Some(oldest) = self.tombstones.keys().next().cloned() {
                self.tombstones.remove(&oldest);
            }
            self.tombstone_overflowed = true;
        }
    }

    pub fn record(&mut self, record: EndpointOperationRecord) {
        if self.records.len() >= self.max && !self.records.contains_key(&record.operation_id) {
            if let Some(oldest) = self.records.keys().next().cloned() {
                self.evict(&oldest, Self::now());
            }
        }
        self.records.insert(record.operation_id.clone(), record);
    }

    pub fn get(&self, operation_id: &str) -> Option<&EndpointOperationRecord> {
        self.records.get(operation_id)
    }

    fn transition(&mut self, operation_id: &str, phase: OperationPhase, permit_id: Option<String>, result_available: Option<bool>) {
        let now = Self::now();
        if let Some(current) = self.records.get_mut(operation_id) {
            current.phase = phase;
            current.updated_at = now;
            if permit_id.is_some() {
                current.permit_id = permit_id;
            }
            if let Some(available) = result_available {
                current.result_available = available;
            }
        }
    }

    pub fn evict_expired(&mut self, now: i64) -> usize {
        let retention = self.retention_ms;
        let stale: Vec<String> = self
            .records
            .iter()
            .filter(|(_, r)| r.updated_at + retention <= now)
            .map(|(id, _)| id.clone())
            .collect();
        let dropped = stale.len();
        for id in stale {
            self.evict(&id, now);
        }
        self.tombstones.retain(|_, at| *at + retention > now);
        dropped
    }

    pub fn size(&self) -> usize {
        self.records.len()
    }
}

/// Permit state needed to resolve a dispatched operation's wire answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermitState {
    /// "outcome_unknown"
    OutcomeUnknown,
    /// "consumed"
    Consumed,
    /// Any other terminal/unknown permit state.
    Other,
}

/// Authenticated caller context projection used for authorization binding.
#[derive(Debug, Clone)]
pub struct OperationQueryContext {
    /// `context.principal`
    pub principal: String,
}

/// `GatewayOperationRecoveryService`.
pub struct EndpointOperationRecovery {
    pub ledger: OperationLedger,
}

impl Default for EndpointOperationRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl EndpointOperationRecovery {
    pub fn new() -> Self {
        Self { ledger: OperationLedger::default() }
    }

    pub fn mark_received(&mut self, operation_id: &str, principal_ref: &str, generation: u64) {
        let now = OperationLedger::now();
        self.ledger.record(EndpointOperationRecord {
            operation_id: operation_id.to_string(),
            principal_ref: principal_ref.to_string(),
            generation: generation.max(1),
            phase: OperationPhase::Received,
            permit_id: None,
            result_available: false,
            recorded_at: now,
            updated_at: now,
        });
    }

    pub fn mark_refused(&mut self, operation_id: &str) {
        self.ledger.transition(operation_id, OperationPhase::RefusedPreDispatch, None, None);
    }

    pub fn mark_dispatched(&mut self, operation_id: &str, permit_id: &str) {
        self.ledger.transition(
            operation_id,
            OperationPhase::Dispatched,
            Some(permit_id.to_string()),
            None,
        );
    }

    pub fn mark_settled(&mut self, operation_id: &str, complete: bool, result_available: bool) {
        self.ledger.transition(
            operation_id,
            if complete { OperationPhase::SettledComplete } else { OperationPhase::SettledFailed },
            None,
            Some(result_available),
        );
    }

    pub fn mark_uncertain(&mut self, operation_id: &str) {
        self.ledger.transition(operation_id, OperationPhase::OutcomeUncertain, None, None);
    }

    pub fn mark_cancel_intent(&mut self, operation_id: &str) {
        self.ledger.transition(operation_id, OperationPhase::CancelIntent, None, None);
    }

    /// `answerQuery` — authorize against the caller context, then resolve the
    /// honest state. `permit_lookup` supplies the receipt point-query when the
    /// ledger cannot settle on its own (absent or still-dispatched record).
    pub fn answer_query(
        &mut self,
        query: &Value,
        context: &OperationQueryContext,
        permit_lookup: &dyn Fn(&str) -> Option<PermitState>,
    ) -> Option<Value> {
        let parsed = parse_operation_query(query)?;
        self.ledger.evict_expired(OperationLedger::now());
        let record = self.ledger.get(&parsed.operation_id).cloned();

        if let Some(record) = &record {
            if record.principal_ref != context.principal {
                return Some(create_operation_status(
                    &parsed.operation_id,
                    "status_unavailable",
                    None,
                    "not_applicable",
                    parsed.generation,
                ));
            }
            if record.generation > parsed.generation {
                return Some(create_operation_status(
                    &parsed.operation_id,
                    "status_unavailable",
                    None,
                    "not_applicable",
                    record.generation,
                ));
            }
        }
        if record.is_none()
            && (self.ledger.seen(&parsed.operation_id) || self.ledger.overflowed())
        {
            return Some(create_operation_status(
                &parsed.operation_id,
                "dispatched_in_doubt",
                None,
                "not_applicable",
                parsed.generation,
            ));
        }
        let permit = if record.is_none() || record.as_ref().unwrap().phase == OperationPhase::Dispatched {
            permit_lookup(&parsed.operation_id)
        } else {
            None
        };
        let (state, evidence, availability) = resolve_state(record.as_ref(), permit);
        Some(create_operation_status(
            &parsed.operation_id,
            &state,
            evidence.as_deref(),
            &availability,
            record.as_ref().map(|r| r.generation).unwrap_or(parsed.generation),
        ))
    }
}

fn resolve_state(
    record: Option<&EndpointOperationRecord>,
    permit: Option<PermitState>,
) -> (String, Option<String>, String) {
    let na = "not_applicable".to_string();
    let Some(record) = record else {
        return match permit {
            Some(PermitState::OutcomeUnknown) => ("dispatched_in_doubt".into(), None, na),
            Some(_) => ("in_progress".into(), None, na),
            None => ("not_started".into(), Some("local_never_submitted".into()), na),
        };
    };
    match record.phase {
        OperationPhase::Received => ("in_progress".into(), None, na),
        OperationPhase::RefusedPreDispatch => {
            ("not_started".into(), Some("endpoint_refused_pre_dispatch".into()), na)
        }
        OperationPhase::Dispatched => match permit {
            None | Some(PermitState::OutcomeUnknown) => ("dispatched_in_doubt".into(), None, na),
            Some(PermitState::Consumed) => ("in_progress".into(), None, na),
            Some(PermitState::Other) => ("status_unavailable".into(), None, na),
        },
        OperationPhase::OutcomeUncertain => ("dispatched_in_doubt".into(), None, na),
        OperationPhase::SettledComplete => {
            if record.result_available {
                ("completed".into(), None, "available".into())
            } else {
                ("completed_result_unavailable".into(), None, "unavailable".into())
            }
        }
        OperationPhase::SettledFailed => ("failed".into(), None, na),
        OperationPhase::CancelIntent => ("cancel_intent_recorded".into(), None, na),
    }
}
