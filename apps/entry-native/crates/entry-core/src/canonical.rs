//! Canonical JSON — byte-identical to `@meshrix/contracts/serialization/canonical-json`.
//! Used by every signed transcript and content digest; key order is the
//! JS `Object.keys` sort order on escaped key strings, matching `Array.sort()`.

use serde_json::{Map, Value};

/// Serialize a JSON value with recursively sorted object keys, no whitespace.
/// Numbers pass through `serde_json`'s formatting, which matches
/// `JSON.stringify` for all finite integers and the fraction encodings the
/// wire contracts actually use (integers, strings, booleans, null, arrays).
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::with_capacity(256);
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // JS `JSON.stringify` and serde_json agree for the integer /
            // short-fraction domain the contracts use.
            out.push_str(&n.to_string());
        }
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()));
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            // JS sorts keys by UTF-16 code units; serde_json gives UTF-8.
            // For the ASCII identifiers the contracts use these agree; use
            // UTF-16 ordering anyway to be exact.
            keys.sort_by(|a, b| {
                let av: Vec<u16> = a.encode_utf16().collect();
                let bv: Vec<u16> = b.encode_utf16().collect();
                av.cmp(&bv)
            });
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
    }
}

/// Convenience: canonical JSON of a serializable Rust value.
pub fn canonical_json_of<T: serde::Serialize>(value: &T) -> crate::Result<String> {
    let v = serde_json::to_value(value)?;
    Ok(canonical_json(&v))
}

/// Build a `serde_json::Map` whose iteration order follows canonical key order.
/// serde_json preserves insertion order by default (with `preserve_order`),
/// so callers constructing wire objects should insert keys in sorted order.
pub fn sorted_map(pairs: impl IntoIterator<Item = (impl Into<String>, Value)>) -> Map<String, Value> {
    let mut items: Vec<(String, Value)> = pairs.into_iter().map(|(k, v)| (k.into(), v)).collect();
    items.sort_by(|a, b| {
        let av: Vec<u16> = a.0.encode_utf16().collect();
        let bv: Vec<u16> = b.0.encode_utf16().collect();
        av.cmp(&bv)
    });
    items.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_keys_recursively() {
        let v = json!({"b":1,"a":{"d":2,"c":3},"z":[{"y":1,"x":2}]});
        assert_eq!(canonical_json(&v), r#"{"a":{"c":3,"d":2},"b":1,"z":[{"x":2,"y":1}]}"#);
    }

    #[test]
    fn primitives() {
        assert_eq!(canonical_json(&json!(null)), "null");
        assert_eq!(canonical_json(&json!(true)), "true");
        assert_eq!(canonical_json(&json!(42)), "42");
        assert_eq!(canonical_json(&json!("a\"b")), r#""a\"b""#);
    }
}
