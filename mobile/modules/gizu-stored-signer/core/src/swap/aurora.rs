//! C's confidential side: quote checks, ERC-191 intent validation, ownership proof and signature encoding.
use super::evm::{self, RawSignature};
use super::pins::*;
use crate::SignerError;
use alloy_primitives::{Address, U256, keccak256};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn iso_millis(s: &str) -> Result<u64, SignerError> {
    let b = s.as_bytes();
    let num = |range: std::ops::Range<usize>| -> Result<u64, SignerError> {
        let part = s.get(range).ok_or(SignerError::InvalidInput)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return Err(SignerError::InvalidInput);
        }
        part.parse().map_err(|_| SignerError::InvalidInput)
    };
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || *b.last().unwrap() != b'Z'
    {
        return Err(SignerError::InvalidInput);
    }
    let (year, month, day, hour, minute, second) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    let millis = match b.len() {
        20 => 0,
        24 if b[19] == b'.' => num(20..23)?,
        _ => return Err(SignerError::InvalidInput),
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
        || year < 1970
    {
        return Err(SignerError::InvalidInput);
    }
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok(days as u64 * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

pub fn iso_string(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rem = ms % 86_400_000;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1_000 % 60,
        rem % 1_000
    )
}

pub fn encode_signature(sig: &RawSignature) -> String {
    let mut bytes = [0u8; 65];
    bytes[..32].copy_from_slice(&sig.r);
    bytes[32..64].copy_from_slice(&sig.s);
    bytes[64] = sig.y_parity;
    format!("secp256k1:{}", bs58::encode(bytes).into_string())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRequest {
    pub dry: bool,
    pub swap_type: String,
    pub deposit_type: String,
    pub recipient_type: String,
    pub recipient: String,
    pub refund_type: String,
    pub refund_to: String,
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount: String,
    pub slippage_tolerance: u32,
    pub confidentiality: String,
}

impl QuoteRequest {
    pub fn funding(confidential: Address, source: Address, asset: &str, amount: U256) -> Self {
        Self::funding_to_private(confidential, source, asset, asset, amount)
    }
    pub fn funding_to_private(
        confidential: Address,
        source: Address,
        origin_asset: &str,
        private_asset: &str,
        amount: U256,
    ) -> Self {
        Self::new(
            "ORIGIN_CHAIN",
            "CONFIDENTIAL_INTENTS",
            format!("{confidential:#x}"),
            "ORIGIN_CHAIN",
            source.to_checksum(None),
            origin_asset,
            private_asset,
            amount,
        )
    }
    pub fn payout(
        confidential: Address,
        recipient: Address,
        private_asset: &str,
        destination_asset: &str,
        amount: U256,
    ) -> Self {
        Self::new(
            "CONFIDENTIAL_INTENTS",
            "DESTINATION_CHAIN",
            recipient.to_checksum(None),
            "CONFIDENTIAL_INTENTS",
            format!("{confidential:#x}"),
            private_asset,
            destination_asset,
            amount,
        )
    }
    pub fn sell_in(
        confidential: Address,
        holder: Address,
        usdg_asset: &str,
        private_asset: &str,
        amount: U256,
    ) -> Self {
        Self::new(
            "ORIGIN_CHAIN",
            "CONFIDENTIAL_INTENTS",
            format!("{confidential:#x}"),
            "ORIGIN_CHAIN",
            holder.to_checksum(None),
            usdg_asset,
            private_asset,
            amount,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn new(
        deposit_type: &str,
        recipient_type: &str,
        recipient: String,
        refund_type: &str,
        refund_to: String,
        origin: &str,
        destination: &str,
        amount: U256,
    ) -> Self {
        Self {
            dry: false,
            swap_type: "EXACT_INPUT".into(),
            deposit_type: deposit_type.into(),
            recipient_type: recipient_type.into(),
            recipient,
            refund_type: refund_type.into(),
            refund_to,
            origin_asset: origin.into(),
            destination_asset: destination.into(),
            amount: amount.to_string(),
            slippage_tolerance: QUOTE_SLIPPAGE_BPS,
            confidentiality: "advanced".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub deposit_address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deposit_memo: Option<String>,
    pub amount_in: U256,
    pub amount_out: U256,
    pub min_amount_out: U256,
    pub deadline_ms: u64,
}

/// Research `assertQuote`: every request field echoed unchanged, a signed quote, advanced confidentiality, not expired.
pub fn check_quote(
    request: &QuoteRequest,
    response: &serde_json::Value,
    now_ms: u64,
) -> Result<Quote, SignerError> {
    let echoed = response
        .get("quoteRequest")
        .ok_or(SignerError::InvalidInput)?;
    let expected = serde_json::to_value(request).map_err(|_| SignerError::InvalidInput)?;
    for field in [
        "swapType",
        "depositType",
        "recipientType",
        "recipient",
        "refundType",
        "refundTo",
        "originAsset",
        "destinationAsset",
        "confidentiality",
        "amount",
    ] {
        let got = echoed.get(field).map(|v| {
            v.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string())
        });
        let want = expected[field].as_str().unwrap_or_default();
        if got.is_none_or(|g| !g.eq_ignore_ascii_case(want)) {
            return Err(SignerError::InvalidInput);
        }
    }
    if response
        .get("signature")
        .and_then(|s| s.as_str())
        .is_none_or(str::is_empty)
    {
        return Err(SignerError::InvalidInput);
    }
    let q = response.get("quote").ok_or(SignerError::InvalidInput)?;
    let text = |name: &str| {
        q.get(name)
            .and_then(|v| v.as_str())
            .ok_or(SignerError::InvalidInput)
    };
    let deposit_address = text("depositAddress")?.to_string();
    if deposit_address.is_empty() || deposit_address.len() > 128 {
        return Err(SignerError::InvalidInput);
    }
    let quote = Quote {
        deposit_address,
        deposit_memo: q
            .get("depositMemo")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        amount_in: evm::decimal(text("amountIn")?)?,
        amount_out: evm::decimal(text("amountOut")?)?,
        min_amount_out: evm::decimal(text("minAmountOut")?)?,
        // `quote.deadline` keeps the address open for days, but refunds start at the request
        // deadline (15 minutes by default), so the earlier of the two bounds the swap.
        deadline_ms: match echoed.get("deadline").and_then(|v| v.as_str()) {
            Some(swap) => iso_millis(text("deadline")?)?.min(iso_millis(swap)?),
            None => iso_millis(text("deadline")?)?,
        },
    };
    if quote.deadline_ms <= now_ms
        || quote.min_amount_out > quote.amount_out
        || quote.min_amount_out.is_zero()
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(quote)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntentMessage {
    signer_id: String,
    verifying_contract: String,
    deadline: String,
    nonce: String,
    intents: Vec<TransferIntent>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferIntent {
    intent: String,
    receiver_id: String,
    tokens: BTreeMap<String, String>,
}

pub fn private_token_id(intent_payload: &str, asset_id: &str) -> Result<String, SignerError> {
    let message: IntentMessage =
        serde_json::from_str(intent_payload).map_err(|_| SignerError::InvalidInput)?;
    let transfer = message.intents.first().ok_or(SignerError::InvalidInput)?;
    let (token, _) = transfer
        .tokens
        .iter()
        .next()
        .ok_or(SignerError::InvalidInput)?;
    let shard = token
        .strip_prefix("imt:")
        .and_then(|rest| rest.strip_suffix(asset_id))
        .and_then(|rest| rest.strip_suffix(':'))
        .ok_or(SignerError::InvalidInput)?;
    if shard.len() != 64
        || !shard
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(token.clone())
}

/// Research `validatePreparedIntent`: exactly one transfer of the approved token and amount from C to the quote's deposit.
pub fn check_intent(
    intent: &serde_json::Value,
    signer: Address,
    deposit_address: &str,
    token_id: &str,
    amount: U256,
    now_ms: u64,
) -> Result<String, SignerError> {
    if intent.get("standard").and_then(|v| v.as_str()) != Some("erc191") {
        return Err(SignerError::InvalidInput);
    }
    let payload = intent
        .get("payload")
        .and_then(|v| v.as_str())
        .ok_or(SignerError::InvalidInput)?;
    if payload.len() > 8_000 {
        return Err(SignerError::InvalidInput);
    }
    let message: IntentMessage =
        serde_json::from_str(payload).map_err(|_| SignerError::InvalidInput)?;
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(&message.nonce)
        .map_err(|_| SignerError::InvalidInput)?;
    let deadline = iso_millis(&message.deadline)?;
    if !message
        .signer_id
        .eq_ignore_ascii_case(&format!("{signer:#x}"))
        || message.verifying_contract != CONFIDENTIAL_CONTRACT
        || nonce.len() != 32
        || deadline <= now_ms
        || deadline > now_ms + 7 * OPERATION_MS
        || message.intents.len() != 1
    {
        return Err(SignerError::InvalidInput);
    }
    let transfer = &message.intents[0];
    if transfer.intent != "transfer"
        || !transfer.receiver_id.eq_ignore_ascii_case(deposit_address)
        || transfer.tokens.len() != 1
    {
        return Err(SignerError::InvalidInput);
    }
    if transfer
        .tokens
        .get(token_id)
        .and_then(|v| evm::decimal(v).ok())
        != Some(amount)
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(payload.to_string())
}

#[derive(Serialize)]
struct AuthPayload<'a> {
    signer_id: String,
    verifying_contract: &'a str,
    deadline: String,
    nonce: String,
    intents: [(); 0],
}

/// Research `buildAuthPayload`: a 5-minute ownership proof for `intents.near` with a versioned timestamped nonce.
pub fn auth_payload(
    account: Address,
    salt_hex: &str,
    started_ms: u64,
    random: [u8; 7],
) -> Result<String, SignerError> {
    let salt = evm::hex_bytes(&format!("0x{salt_hex}"))?;
    if salt.len() != 4 {
        return Err(SignerError::InvalidInput);
    }
    let deadline = started_ms + 5 * 60_000;
    let mut nonce = [0u8; 32];
    nonce[..5].copy_from_slice(&[0x56, 0x28, 0xf6, 0xc6, 0x00]);
    nonce[5..9].copy_from_slice(&salt);
    nonce[9..17].copy_from_slice(&(deadline * 1_000_000).to_le_bytes());
    nonce[17..25].copy_from_slice(&(started_ms * 1_000_000).to_le_bytes());
    nonce[25..].copy_from_slice(&random);
    serde_json::to_string(&AuthPayload {
        signer_id: format!("{account:#x}"),
        verifying_contract: AUTH_VERIFYING_CONTRACT,
        deadline: iso_string(deadline),
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        intents: [],
    })
    .map_err(|_| SignerError::InvalidInput)
}

/// Seven nonce bytes bound to C's key and the moment, so no RNG crosses the FFI.
pub fn auth_random(secret: &[u8], started_ms: u64, counter: u64) -> [u8; 7] {
    let mut buf = secret.to_vec();
    buf.extend_from_slice(&started_ms.to_be_bytes());
    buf.extend_from_slice(&counter.to_be_bytes());
    let digest = keccak256(&buf);
    buf.iter_mut().for_each(|b| *b = 0);
    let mut out = [0u8; 7];
    out.copy_from_slice(&digest[..7]);
    out
}

pub fn private_available(
    balances: &serde_json::Value,
    asset_id: &str,
) -> Result<U256, SignerError> {
    let list = balances
        .get("balances")
        .and_then(|b| b.as_array())
        .ok_or(SignerError::InvalidInput)?;
    let matches: Vec<_> = list
        .iter()
        .filter(|b| {
            b.get("source").and_then(|v| v.as_str()) == Some("private")
                && b.get("tokenId").and_then(|v| v.as_str()) == Some(asset_id)
        })
        .collect();
    // An account that holds nothing lists no private entry; two entries are ambiguous.
    match matches.as_slice() {
        [] => Ok(U256::ZERO),
        [only] => evm::decimal(
            only.get("available")
                .and_then(|v| v.as_str())
                .ok_or(SignerError::InvalidInput)?,
        ),
        _ => Err(SignerError::InvalidInput),
    }
}

/// 30/30/40 without exceeding the total.
pub fn split(total: U256) -> [U256; 3] {
    let [a, b, c]: [U256; 3] = split_weighted(total, &[3, 3, 4])
        .try_into()
        .expect("three weights");
    [a, b, c]
}

/// One floor(total * weight / sum) portion per weight; the last takes the remainder, so the
/// portions always add up to exactly `total`. Weights must be non-empty and positive.
pub fn split_weighted(total: U256, weights: &[u32]) -> Vec<U256> {
    let sum: u64 = weights.iter().map(|w| u64::from(*w)).sum();
    let mut out = Vec::with_capacity(weights.len());
    let mut used = U256::ZERO;
    for (i, w) in weights.iter().enumerate() {
        let part = if i + 1 == weights.len() {
            total - used
        } else {
            total * U256::from(*w) / U256::from(sum)
        };
        used += part;
        out.push(part);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weighted_split_adds_up_exactly_and_keeps_the_legacy_three_way_split() {
        for total in [1u64, 7, 99, 1_000_001, 2_459_372, u64::MAX] {
            let total = U256::from(total);
            let legacy = split(total);
            assert_eq!(legacy.to_vec(), split_weighted(total, &[3, 3, 4]));
            assert_eq!(legacy[0], total * U256::from(3) / U256::from(10));
            for weights in [
                vec![1u32],
                vec![1, 1],
                vec![3, 7],
                vec![13, 29, 58],
                vec![1, 2, 3, 4],
                vec![17, 1, 1, 23, 58],
            ] {
                let parts = split_weighted(total, &weights);
                assert_eq!(parts.len(), weights.len());
                assert_eq!(parts.iter().fold(U256::ZERO, |a, b| a + *b), total);
            }
        }
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/research-mainnet.json")).unwrap()
    }
    const SIGNED_AT: u64 = 1_790_700_000_000;

    #[test]
    fn iso_time_round_trips() {
        let ms = iso_millis("2026-09-29T22:48:16.356Z").unwrap();
        assert_eq!(iso_string(ms), "2026-09-29T22:48:16.356Z");
        assert_eq!(
            iso_millis("2026-09-25T12:00:00Z").unwrap(),
            1_790_337_600_000
        );
        for bad in [
            "2026-13-01T00:00:00Z",
            "2026-09-25 12:00:00Z",
            "2026-09-25T12:00:00+03:00",
        ] {
            assert!(iso_millis(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn builds_the_research_ownership_proof() {
        let account = evm::addr("0xAbCdEf0000000000000000000000000000001234").unwrap();
        let payload = auth_payload(
            account,
            "252812b3",
            iso_millis("2026-09-25T12:00:00.000Z").unwrap(),
            [1, 2, 3, 4, 5, 6, 7],
        )
        .unwrap();
        assert_eq!(
            payload,
            r#"{"signer_id":"0xabcdef0000000000000000000000000000001234","verifying_contract":"intents.near","deadline":"2026-09-25T12:05:00.000Z","nonce":"Vij2xgAlKBKzADhrndWO2BgAgAbEj47YGAECAwQFBgc=","intents":[]}"#
        );
    }

    #[test]
    fn splits_30_30_40_without_exceeding_the_budget() {
        assert_eq!(
            split(U256::from(9_875_001u64)),
            [
                U256::from(2_962_500u64),
                U256::from(2_962_500u64),
                U256::from(3_950_001u64)
            ]
        );
    }

    #[test]
    fn accepts_the_research_payout_intent_and_its_signer() {
        let f = fixture();
        let p = &f["payout"];
        let confidential = evm::addr(f["confidential"].as_str().unwrap()).unwrap();
        let token = f["privateTokenId"].as_str().unwrap();
        let payload = p["signedData"]["payload"].as_str().unwrap();
        assert_eq!(
            private_token_id(payload, f["assets"]["source"].as_str().unwrap()).unwrap(),
            token
        );
        let intent = serde_json::json!({"standard": "erc191", "payload": payload});
        let deposit = p["depositAddress"].as_str().unwrap();
        let amount = evm::decimal(p["sourceAtoms"].as_str().unwrap()).unwrap();
        check_intent(&intent, confidential, deposit, token, amount, SIGNED_AT).unwrap();
        for (d, a, now) in [
            ("other", amount, SIGNED_AT),
            (deposit, amount + U256::from(1), SIGNED_AT),
            (deposit, amount, 1_800_000_000_000),
        ] {
            assert!(check_intent(&intent, confidential, d, token, a, now).is_err());
        }
        assert!(check_intent(&intent, Address::ZERO, deposit, token, amount, SIGNED_AT).is_err());
        let raw = bs58::decode(
            p["signedData"]["signature"]
                .as_str()
                .unwrap()
                .strip_prefix("secp256k1:")
                .unwrap(),
        )
        .into_vec()
        .unwrap();
        let (r, s) = (
            raw[..32].try_into().unwrap(),
            raw[32..64].try_into().unwrap(),
        );
        assert_eq!(
            evm::recover(evm::personal_hash(payload.as_bytes()), &r, &s, raw[64]).unwrap(),
            confidential
        );
        assert_eq!(
            encode_signature(&RawSignature {
                r,
                s,
                y_parity: raw[64]
            }),
            p["signedData"]["signature"].as_str().unwrap()
        );
    }

    #[test]
    fn rejects_intents_with_extra_actions() {
        let f = fixture();
        let payload = f["payout"]["signedData"]["payload"]
            .as_str()
            .unwrap()
            .replacen(
                "\"intents\":[",
                "\"intents\":[{\"intent\":\"transfer\",\"receiver_id\":\"x\",\"tokens\":{}},",
                1,
            );
        let intent = serde_json::json!({"standard": "erc191", "payload": payload});
        let confidential = evm::addr(f["confidential"].as_str().unwrap()).unwrap();
        assert!(
            check_intent(
                &intent,
                confidential,
                f["payout"]["depositAddress"].as_str().unwrap(),
                f["privateTokenId"].as_str().unwrap(),
                U256::from(358_739u64),
                SIGNED_AT
            )
            .is_err()
        );
        let memo = f["payout"]["signedData"]["payload"]
            .as_str()
            .unwrap()
            .replacen(
                "\"intent\":\"transfer\"",
                "\"intent\":\"transfer\",\"msg\":\"call\"",
                1,
            );
        assert!(
            check_intent(
                &serde_json::json!({"standard": "erc191", "payload": memo}),
                confidential,
                f["payout"]["depositAddress"].as_str().unwrap(),
                f["privateTokenId"].as_str().unwrap(),
                U256::from(358_739u64),
                SIGNED_AT
            )
            .is_err()
        );
    }

    #[test]
    fn quote_must_echo_the_request_and_stay_confidential() {
        let f = fixture();
        let request: QuoteRequest = serde_json::from_value(f["payout"]["request"].clone()).unwrap();
        let mut response = serde_json::json!({
            "quoteRequest": f["payout"]["quoteRequest"],
            "signature": "sig",
            "quote": {"depositAddress": f["payout"]["depositAddress"], "amountIn": "358739", "amountOut": "206883", "minAmountOut": "206000", "deadline": "2026-10-02T22:45:38.868Z"},
        });
        response["quoteRequest"]["deadline"] = serde_json::json!("2026-09-29T22:45:38.868Z");
        let quote = check_quote(&request, &response, SIGNED_AT).unwrap();
        assert_eq!(quote.amount_out, U256::from(206_883u64));
        assert_eq!(
            quote.deadline_ms,
            iso_millis("2026-09-29T22:45:38.868Z").unwrap(),
            "the refund deadline, not the address lifetime, bounds the quote"
        );
        let mut lapsed = response.clone();
        lapsed["quoteRequest"]["deadline"] = serde_json::json!("2026-09-26T22:45:38.868Z");
        assert!(
            check_quote(&request, &lapsed, SIGNED_AT).is_err(),
            "a quote past its refund deadline is refused"
        );
        let mut changed = response.clone();
        changed["quoteRequest"]["recipient"] =
            serde_json::json!("0x0000000000000000000000000000000000000001");
        assert!(check_quote(&request, &changed, SIGNED_AT).is_err());
        let mut public = request.clone();
        public.confidentiality = "none".into();
        assert!(check_quote(&public, &response, SIGNED_AT).is_err());
        assert!(check_quote(&request, &response, 1_800_000_000_000).is_err());
    }

    #[test]
    fn selects_the_private_balance_by_asset() {
        let id = "nep245:v2_1.omni.hot.tg:143_test";
        let balances = serde_json::json!({"balances": [
            {"tokenId": id, "available": "1000000", "source": "public"},
            {"tokenId": id, "available": "98009", "source": "private"},
            {"tokenId": format!("imt:shard:{id}"), "available": "9999999", "source": "private"},
        ]});
        assert_eq!(
            private_available(&balances, id).unwrap(),
            U256::from(98_009u64)
        );
        assert_eq!(
            private_available(&serde_json::json!({"balances": []}), id).unwrap(),
            U256::ZERO,
            "an emptied account lists nothing"
        );
        let twice = serde_json::json!({"balances": [
            {"tokenId": id, "available": "1", "source": "private"},
            {"tokenId": id, "available": "2", "source": "private"},
        ]});
        assert!(private_available(&twice, id).is_err());
    }
}
