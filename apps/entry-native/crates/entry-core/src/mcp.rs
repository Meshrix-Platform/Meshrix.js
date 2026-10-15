//! Local MCP face — port of `mcp-face.ts` + `stdio.ts`.
//!
//! Speaks standard newline JSON-RPC MCP on the local side and forwards the
//! negotiated work surface through the inner channel to the endpoint's
//! dispatch wire shape. `initialize`, `ping` and notifications are served
//! locally; forwarded methods never fabricate success — unreachable answers
//! `endpoint_unreachable` (not_started), dispatched-then-lost answers
//! `operation_status_unknown` (unknown).

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::error::{EntryError, Result};
use crate::wire::common::is_plain_object;

pub const ENTRY_STDIO_MAX_LINE_BYTES: usize = 1024 * 1024;
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];

fn latest_protocol_version() -> &'static str {
    SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.len() - 1]
}

fn forwarded_method(local: &str) -> Option<&'static str> {
    match local {
        "tools/call" => Some("tools/call"),
        "resources/read" => Some("resources/read"),
        "prompts/get" => Some("prompts/get"),
        "prompts/complete" => Some("prompts/complete"),
        // Standard MCP completion → the endpoint's prompts/complete mapping.
        "completion/complete" => Some("prompts/complete"),
        "tools/list" => Some("tools/list"),
        "resources/list" => Some("resources/list"),
        "prompts/list" => Some("prompts/list"),
        _ => None,
    }
}

fn catalog_kind(local: &str) -> Option<(&'static str, &'static str)> {
    match local {
        "tools/list" => Some(("tool", "tools")),
        "resources/list" => Some(("resource", "resources")),
        "prompts/list" => Some(("prompt", "prompts")),
        _ => None,
    }
}

fn rpc_error(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error.as_object_mut().unwrap().insert("data".into(), data);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn is_gateway_outcome(value: &Value) -> bool {
    if !is_plain_object(value) {
        return false;
    }
    match value.get("kind").and_then(|k| k.as_str()) {
        Some("complete") => value.as_object().unwrap().contains_key("value"),
        Some("input_required") => true,
        Some("negotiated_extension") => value.get("extension").and_then(|v| v.as_str()).is_some(),
        Some("failure") => {
            value.get("code").and_then(|v| v.as_str()).is_some()
                && value.get("message").and_then(|v| v.as_str()).is_some()
                && value.get("status").and_then(|v| v.as_i64()).is_some()
                && value.get("effectOutcome").and_then(|v| v.as_str()).is_some()
        }
        _ => false,
    }
}

fn project_catalog_item(item: &Value, kind: &str) -> Value {
    let meta = item.get("metadata").cloned().unwrap_or(Value::Null);
    match kind {
        "tool" => json!({
            "name": item.get("publicName").cloned().unwrap_or(Value::Null),
            "description": item.get("description").cloned().unwrap_or(Value::Null),
            "inputSchema": item.get("inputSchema").cloned().unwrap_or(Value::Null),
            "outputSchema": item.get("outputSchema").cloned().unwrap_or(Value::Null),
            "annotations": item.get("annotations").cloned().unwrap_or(Value::Null),
            "title": meta.get("title").cloned().unwrap_or(Value::Null),
            "_meta": meta,
        }),
        "prompt" => json!({
            "name": item.get("publicName").cloned().unwrap_or(Value::Null),
            "description": item.get("description").cloned().unwrap_or(Value::Null),
            "arguments": meta.get("arguments").cloned().unwrap_or(Value::Null),
            "_meta": meta,
        }),
        _ => json!({
            "uri": item.get("publicUri").cloned().unwrap_or(Value::Null),
            "name": item.get("publicName").cloned().unwrap_or(Value::Null),
            "description": item.get("description").cloned().unwrap_or(Value::Null),
            "_meta": meta,
        }),
    }
}

/// `tools/call` results are tool-result envelopes, not bare values — a
/// business value that is already a tool result passes through; anything
/// else is wrapped so standard clients read content/structuredContent.
fn complete_tool_result(outcome: &Value) -> Value {
    let value = outcome.get("value").cloned().unwrap_or(Value::Null);
    let mut tool_result = if is_plain_object(&value)
        && (value.get("content").and_then(|c| c.as_array()).is_some()
            || value.as_object().unwrap().contains_key("structuredContent"))
    {
        let mut v = value.clone();
        if v.get("content").and_then(|c| c.as_array()).is_none() {
            v.as_object_mut().unwrap().insert("content".into(), json!([]));
        }
        v
    } else {
        json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".into()) }],
            "structuredContent": value,
        })
    };
    let obj = tool_result.as_object_mut().unwrap();
    let mut result = Map::new();
    result.insert("resultType".into(), "complete".into());
    result.append(obj);
    for key in ["isError", "requestState"] {
        if let Some(v) = outcome.get(key) {
            result.insert(key.into(), v.clone());
        }
    }
    if let Some(effect) = outcome.get("effectOutcome") {
        let mut meta = result
            .get("_meta")
            .and_then(|m| m.as_object().cloned())
            .unwrap_or_default();
        meta.insert("io.meshrix/effect-outcome".into(), effect.clone());
        result.insert("_meta".into(), Value::Object(meta));
    }
    Value::Object(result)
}

fn project_outcome_result(outcome: &Value, method: &str) -> Value {
    let kind = outcome.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if let Some((catalog, key)) = catalog_kind(method) {
        if kind == "complete" {
            if let Some(items) = outcome.get("value").and_then(|v| v.get("items")).and_then(|i| i.as_array()) {
                let projected: Vec<Value> = items
                    .iter()
                    .filter(|item| item.get("kind").and_then(|k| k.as_str()) == Some(catalog))
                    .map(|item| project_catalog_item(item, catalog))
                    .collect();
                let mut result = json!({ "resultType": "complete", key: projected });
                if let Some(cursor) = outcome.get("value").and_then(|v| v.get("nextCursor")) {
                    result.as_object_mut().unwrap().insert("nextCursor".into(), cursor.clone());
                }
                return result;
            }
        }
    }
    match kind {
        "complete" if method == "resources/read" || method == "prompts/get" => {
            let value = outcome.get("value").cloned().unwrap_or(Value::Null);
            if is_plain_object(&value)
                && (value.get("contents").and_then(|c| c.as_array()).is_some()
                    || value.get("messages").and_then(|m| m.as_array()).is_some())
            {
                let mut result = value;
                result.as_object_mut().unwrap().insert("resultType".into(), "complete".into());
                return result;
            }
        }
        "complete" if method == "tools/call" => return complete_tool_result(outcome),
        "complete" => {
            let value = outcome.get("value").cloned().unwrap_or(Value::Null);
            if is_plain_object(&value) {
                let mut result = value;
                result.as_object_mut().unwrap().insert("resultType".into(), "complete".into());
                return result;
            }
            return json!({ "resultType": "complete", "value": value });
        }
        "input_required" => {
            let mut result = json!({ "resultType": "input_required" });
            let obj = result.as_object_mut().unwrap();
            for key in ["inputRequests", "requestState"] {
                if let Some(v) = outcome.get(key) {
                    obj.insert(key.into(), v.clone());
                }
            }
            return result;
        }
        _ => {
            let mut result = json!({
                "resultType": outcome.get("extension").cloned().unwrap_or(Value::Null),
                "value": outcome.get("value").cloned().unwrap_or(Value::Null),
            });
            if let Some(state) = outcome.get("requestState") {
                result.as_object_mut().unwrap().insert("requestState".into(), state.clone());
            }
            return result;
        }
    }
    let value = outcome.get("value").cloned().unwrap_or(Value::Null);
    if is_plain_object(&value) {
        let mut result = value;
        result.as_object_mut().unwrap().insert("resultType".into(), "complete".into());
        result
    } else {
        json!({ "resultType": "complete", "value": value })
    }
}

fn project_outcome_failure(id: &Value, outcome: &Value) -> Value {
    let status = outcome.get("status").and_then(|v| v.as_i64()).unwrap_or(500);
    let code = match status {
        401 => -32001,
        403 => -32003,
        404 => -32004,
        _ => -32000,
    };
    let outcome_code = outcome.get("code").and_then(|v| v.as_str()).unwrap_or("unknown");
    let peer_code = if outcome.get("origin").and_then(|v| v.as_str()) == Some("peer")
        && outcome_code == "upstream_jsonrpc_error"
    {
        outcome
            .get("details")
            .and_then(|d| d.get("errorCode"))
            .and_then(|c| c.as_i64())
            .unwrap_or(code)
    } else {
        code
    };
    let mut data = json!({
        "code": outcome_code,
        "effectOutcome": outcome.get("effectOutcome").cloned().unwrap_or(Value::Null),
    });
    if let Some(receipt) = outcome.get("details").and_then(|d| d.get("receiptId")).and_then(|r| r.as_str()) {
        data.as_object_mut().unwrap().insert("receiptId".into(), receipt.into());
    }
    rpc_error(
        id,
        peer_code,
        outcome.get("message").and_then(|v| v.as_str()).unwrap_or("The operation failed."),
        Some(data),
    )
}

fn operation_id_for(body: &Value) -> String {
    body.get("params")
        .and_then(|p| p.get("operationKey"))
        .and_then(|k| k.as_str())
        .map(String::from)
        .unwrap_or_else(|| match body.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => "unknown".into(),
        })
}

/// Map a thrown channel/transport failure onto honest effect evidence.
fn project_dispatch_error(id: &Value, error: &EntryError, operation_id: &str) -> Value {
    if error.effect.as_deref() == Some(crate::error::effect_outcome::NOT_REQUIRED)
        || error.effect.as_deref() == Some("not_started")
    {
        return rpc_error(
            id,
            -32000,
            "The private endpoint is unreachable; the request was not dispatched.",
            Some(json!({
                "code": "endpoint_unreachable",
                "cause": error.code,
                "effectOutcome": "not_started",
                "operationId": operation_id,
            })),
        );
    }
    // Dispatched (or indeterminate) then lost — honest doubt, never a retried
    // duplicate and never a fabricated success.
    rpc_error(
        id,
        -32000,
        "The request outcome is unknown; query the operation status before retrying.",
        Some(json!({
            "code": "operation_status_unknown",
            "cause": error.code,
            "effectOutcome": "unknown",
            "operationId": operation_id,
        })),
    )
}

/// The session surface the bridge needs — implemented by `EntrySession`.
pub trait McpSession: Send + Sync {
    fn accepts_new_work(&self) -> bool;
    fn request(
        &self,
        message: Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
}

#[derive(Clone)]
pub struct EntryMcpBridge<S: McpSession> {
    session: S,
    server_info: Value,
    capabilities: Value,
}

impl<S: McpSession> EntryMcpBridge<S> {
    pub fn new(session: S, server_info: Option<Value>, capabilities: Option<Value>) -> Self {
        let mut info = json!({ "name": "meshrix-entry", "version": env!("CARGO_PKG_VERSION") });
        if let Some(extra) = server_info.and_then(|v| v.as_object().cloned()) {
            info.as_object_mut().unwrap().extend(extra);
        }
        let mut caps = json!({ "tools": {}, "resources": {}, "prompts": {}, "completions": {} });
        if let Some(extra) = capabilities.and_then(|v| v.as_object().cloned()) {
            caps.as_object_mut().unwrap().extend(extra);
        }
        Self { session, server_info: info, capabilities: caps }
    }

    /// Handle one decoded JSON-RPC body; `None` means notification — no
    /// response.
    pub async fn handle(&self, body: &Value) -> Option<Value> {
        if body.is_array() {
            return Some(rpc_error(
                &Value::Null,
                -32600,
                "Batch JSON-RPC requests are not supported on this endpoint.",
                None,
            ));
        }
        if !is_plain_object(body)
            || body.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0")
            || body.get("method").and_then(|v| v.as_str()).is_none()
        {
            return Some(rpc_error(&Value::Null, -32600, "Invalid JSON-RPC request.", None));
        }
        let method = body.get("method").and_then(|v| v.as_str()).unwrap();
        // Notifications (no id) are acknowledged silently — they never
        // execute the forwarded work surface.
        let Some(id) = body.get("id") else { return None };
        if id.is_null() && !body.as_object().unwrap().contains_key("id") {
            return None;
        }

        if method == "initialize" {
            let requested = body
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let negotiated = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                latest_protocol_version()
            };
            return Some(rpc_result(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": self.capabilities,
                    "serverInfo": self.server_info,
                }),
            ));
        }
        if method == "ping" {
            return Some(rpc_result(id, json!({})));
        }

        let Some(wire_method) = forwarded_method(method) else {
            return Some(rpc_error(id, -32601, &format!("Method not found: {method}"), None));
        };
        if !self.session.accepts_new_work() {
            return Some(rpc_error(
                id,
                -32000,
                "The private endpoint is unreachable; new work is not queued.",
                Some(json!({
                    "code": "endpoint_unreachable",
                    "effectOutcome": "not_started",
                    "operationId": operation_id_for(body),
                })),
            ));
        }
        let mut wire_request = body.clone();
        wire_request
            .as_object_mut()
            .unwrap()
            .insert("method".into(), wire_method.into());
        let outcome = match self.session.request(wire_request).await {
            Ok(o) => o,
            Err(e) => return Some(project_dispatch_error(id, &e, &operation_id_for(body))),
        };
        if outcome.is_null() {
            return Some(rpc_error(
                id,
                -32601,
                &format!("Method not found at the endpoint: {method}"),
                None,
            ));
        }
        if !is_gateway_outcome(&outcome) {
            return Some(rpc_error(
                id,
                -32000,
                "The endpoint returned an unparseable outcome; the operation status is unknown.",
                Some(json!({
                    "code": "operation_status_unknown",
                    "effectOutcome": "unknown",
                    "operationId": operation_id_for(body),
                })),
            ));
        }
        if outcome.get("kind").and_then(|k| k.as_str()) == Some("failure") {
            return Some(project_outcome_failure(id, &outcome));
        }
        Some(rpc_result(id, project_outcome_result(&outcome, method)))
    }
}

/// Newline-framed MCP over stdio: one JSON-RPC request per stdin line, one
/// response per stdout line, nothing else on stdout. Over-budget lines and
/// unparseable JSON are refused with a JSON-RPC error, not a stream failure.
pub async fn serve_entry_mcp_stdio<H, F>(input: tokio::io::Stdin, output: &mut tokio::io::Stdout, handle: H) -> Result<()>
where
    H: Fn(Value) -> F,
    F: std::future::Future<Output = Option<Value>>,
{
    let mut lines = BufReader::new(input).lines();
    let mut line = String::new();
    while let Ok(Some(_)) = lines.next_line().await.map(|l| l.map(|v| { line = v; })) {
        if line.trim().is_empty() {
            continue;
        }
        let reply: Option<Value> = if line.len() > ENTRY_STDIO_MAX_LINE_BYTES {
            Some(rpc_error(&Value::Null, -32600, "The request exceeds the byte budget.", None))
        } else {
            match serde_json::from_str::<Value>(&line) {
                Err(_) => Some(rpc_error(&Value::Null, -32700, "Parse error.", None)),
                Ok(body) => match handle(body).await {
                    value => value,
                },
            }
        };
        let Some(reply) = reply else { continue };
        let mut text = serde_json::to_string(&reply)?;
        text.push('\n');
        output.write_all(text.as_bytes()).await?;
        output.flush().await?;
    }
    Ok(())
}

impl McpSession for std::sync::Arc<super::relay::EntrySession> {
    fn accepts_new_work(&self) -> bool {
        self.as_ref().accepts_new_work()
    }
    async fn request(&self, message: Value) -> Result<Value> {
        super::relay::EntrySession::request(self.as_ref(), message).await
    }
}

impl McpSession for super::relay::EntrySession {
    fn accepts_new_work(&self) -> bool {
        self.accepts_new_work()
    }
    async fn request(&self, message: Value) -> Result<Value> {
        super::relay::EntrySession::request(self, message).await
    }
}

/* ------------------------- managed config snippet ------------------------ */

/// `managedMcpConfigPath` — the app-owned MCP config file inside dataDir.
pub fn managed_mcp_config_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("mcp").join("meshrix-entry.mcp.json")
}

/// `buildMcpStdioSnippet` — standard `mcpServers` JSON for the stdio face.
pub fn build_mcp_stdio_snippet(server_name: &str, command: &str, args: &[&str]) -> String {
    let args: Vec<Value> = if args.is_empty() {
        vec![json!("--mcp-stdio")]
    } else {
        args.iter().map(|a| json!(a)).collect()
    };
    let body = json!({
        "mcpServers": {
            server_name: {
                "command": command,
                "args": args,
            }
        }
    });
    serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".to_string())
}

/// `writeManagedMcpConfig` — writes ONLY inside the app's owned data dir;
/// the file is created `0o600` under a `0o700` directory.
pub fn write_managed_mcp_config(file_path: &std::path::Path, snippet: &str) -> Result<()> {
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    std::fs::write(file_path, format!("{snippet}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
