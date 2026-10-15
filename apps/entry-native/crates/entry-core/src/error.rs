//! Typed entry errors. `code` values are identical to the TypeScript
//! `entryError` codes so diagnostics stay compatible across implementations.

use std::fmt;

/// Honest side-effect outcomes — the same vocabulary `product-service.ts` and
/// the pairing session use to report what actually happened.
pub mod effect_outcome {
    /// Nothing was written.
    pub const NOT_ATTEMPTED: &str = "not_attempted";
    /// The write definitely completed before the failure.
    pub const COMPLETED: &str = "completed";
    /// The write may or may not have landed; never blind-retry this state.
    pub const UNKNOWN: &str = "unknown";
    /// No write was needed.
    pub const NOT_REQUIRED: &str = "not_required";
}

#[derive(Debug, Clone)]
pub struct EntryError {
    pub code: String,
    pub message: String,
    pub effect: Option<String>,
    pub source: Option<Box<EntryError>>,
}

impl EntryError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            effect: None,
            source: None,
        }
    }

    pub fn with_effect(mut self, effect: &str) -> Self {
        self.effect = Some(effect.to_string());
        self
    }

    pub fn caused_by(mut self, source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        let src = source.into();
        self.source = Some(Box::new(EntryError::new("cause", src.to_string())));
        self
    }

    /// True for codes callers must not blindly retry (uncertain effects).
    pub fn outcome_uncertain(&self) -> bool {
        self.effect.as_deref() == Some(effect_outcome::UNKNOWN)
    }
}

impl fmt::Display for EntryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.effect {
            Some(effect) => write!(f, "[{}; effect={}] {}", self.code, effect, self.message),
            None => write!(f, "[{}] {}", self.code, self.message),
        }
    }
}

impl std::error::Error for EntryError {}

pub type Result<T> = std::result::Result<T, EntryError>;

pub fn entry_error(code: impl Into<String>, message: impl Into<String>) -> EntryError {
    EntryError::new(code, message)
}

impl From<serde_json::Error> for EntryError {
    fn from(e: serde_json::Error) -> Self {
        entry_error("serialization_invalid", format!("JSON processing failed: {e}"))
    }
}

impl From<std::io::Error> for EntryError {
    fn from(e: std::io::Error) -> Self {
        entry_error("io_error", format!("I/O failed: {e}"))
    }
}
