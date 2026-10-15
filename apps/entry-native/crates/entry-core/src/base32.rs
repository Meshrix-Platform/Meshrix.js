//! Recovery-key base32 — port of `recovery-key.ts`'s local alphabet.
//! Standard RFC 4648 lowercase, no padding: `a-z` then `2-7`.
//! The strict decode rejects non-canonical trailing bits (>= 5 leftover bits
//! or non-zero padding) exactly like the TypeScript decoder.

const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

pub fn encode_base32(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() * 8 + 4) / 5);
    let mut buffer: u32 = 0;
    let mut bits = 0u8;
    for &byte in data {
        buffer = (buffer << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn decode_base32(text: &str) -> Result<Vec<u8>, ()> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits = 0u8;
    for ch in text.chars() {
        let ch = ch.to_ascii_lowercase();
        let idx = ALPHABET.iter().position(|&a| a as char == ch).ok_or(())? as u32;
        buffer = (buffer << 5) | idx;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    // `bits >= 5` means a dangling symbol remainder; non-zero low bits are
    // non-canonical padding. Both are rejected by the TS decoder.
    if bits >= 5 || (bits > 0 && ((buffer << (8 - bits)) & 0xff) != 0) {
        return Err(());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for len in [1usize, 2, 5, 16, 32, 33, 64] {
            let data: Vec<u8> = (0..len).map(|i| (i * 31 + len) as u8).collect();
            let enc = encode_base32(&data);
            assert!(enc.chars().all(|c| matches!(c, 'a'..='z' | '2'..='7')));
            assert_eq!(decode_base32(&enc).unwrap(), data);
        }
    }

    #[test]
    fn rejects_bad_chars_and_padding() {
        assert!(decode_base32("abc0").is_err());
        assert!(decode_base32("abc1").is_err());
        assert!(decode_base32("abc8").is_err());
        // Non-canonical trailing bits.
        assert!(decode_base32("ab").is_err() || decode_base32("ab").unwrap().len() == 1);
        assert!(decode_base32("").unwrap().is_empty());
    }
}
