//! Sans-IO swap state machine. The platform only moves HTTP bytes, persists `export_state` before every
//! request, and shows the native review; every provider payload is validated here before any signature.
use super::aurora::{self, Quote, QuoteRequest};
use super::evm;
use super::funding::{self, FundingChain, UnsignedAuthorization, UserOperation};
use super::fusion::{self, ApprovedOrder, LimitOrder, Permit};
use super::pins::*;
use crate::SignerError;
use crate::roles::{
    CONFIDENTIAL_ACCOUNT, FIRST_RECIPIENT, FUNDING_ACCOUNT, derive_key, seed_from_entropy,
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

const STATE_VERSION: u32 = 1;
const PRICE_TOLERANCE_BPS: u64 = 300;
const MAX_FUNDING_ATTEMPTS: u8 = 4;
const MAX_FUSION_ATTEMPTS: u8 = 3;
const MAX_ORDER_REQUOTES: u8 = 3;
/// Recovery reads USDG for at most this many recent recipient indices in one RPC batch.
const MAX_RECOVERY_SCAN: u32 = 60;
const MAX_TRANSIENT_FAILURES: u32 = 20;
const POLL_MS: u64 = 5_000;
/// A deposit is only sent while its quote has this long left: Aurora refunds a swap it has not
/// settled by the request deadline, and a Monad credit took about three minutes on mainnet.
const QUOTE_MARGIN_MS: u64 = 10 * 60_000;
const RESUBMIT_AFTER_POLLS: u32 = 36;
const PROBE_RECIPIENT: Address =
    alloy_primitives::address!("0x000000000000000000000000000000000000dEaD");

#[derive(uniffi::Enum, Debug, PartialEq, Eq)]
pub enum SwapStep {
    /// Perform exactly this request, then call `on_response` with the same id.
    Request {
        id: u64,
        method: String,
        url: String,
        body: Option<String>,
    },
    Wait {
        millis: u64,
    },
    /// Show this text in the native review; `approve` only after a passkey assertion.
    Review {
        text: String,
    },
    /// The 15-minute authorization lapsed; a new passkey unlock is required for the same plan.
    Unlock,
    Finished,
    Paused {
        code: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "step", rename_all = "camelCase")]
enum Step {
    Assets,
    SourceChain {
        execute: bool,
    },
    TargetChain,
    FundingProbe,
    FundingQuote {
        attempt: u8,
    },
    FundingPrepare {
        attempt: u8,
        execute: bool,
    },
    PayoutEstimate {
        index: usize,
    },
    FusionEstimate,
    Review,
    FundingSign,
    FundingSubmit,
    FundingReceipt {
        polls: u32,
        resubmitted: bool,
    },
    Credit,
    AuthSalt,
    Authenticate {
        salt: String,
    },
    Balances,
    PrivateHistoryProbe,
    PrivateCredit {
        index: usize,
    },
    PayoutQuote {
        index: usize,
    },
    PayoutIntent {
        index: usize,
    },
    PayoutSubmit {
        index: usize,
    },
    PayoutStatus {
        index: usize,
        polls: u32,
        resubmitted: bool,
    },
    PayoutBalance {
        index: usize,
    },
    FusionBalance {
        index: usize,
    },
    FusionPreview {
        index: usize,
    },
    FusionPermit {
        index: usize,
    },
    FusionOrder {
        index: usize,
    },
    FusionSign {
        index: usize,
    },
    FusionSubmit {
        index: usize,
    },
    FusionStatus {
        index: usize,
    },
    FusionReceipts {
        index: usize,
    },
    FusionAfter {
        index: usize,
    },
    Holdings,
    RecoveryScan,
    SellQuote {
        index: usize,
    },
    Done,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completion_target: Option<String>,
    #[serde(default = "legacy_source_index")]
    source_index: u32,
    target: Address,
    #[serde(default)]
    amount_atoms: Option<String>,
    recipient_indices: Vec<u32>,
    #[serde(default)]
    holder_indices: Option<Vec<u32>>,
    /// Relative payout weights, one per recipient. Absent: 3/3/4 for three wallets, else equal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    weights: Option<Vec<u32>>,
    /// Sell only: random bytes (hex) the engine turns into the return-wallet count and shares once
    /// the sale is priced. A sell without them is an older plan that pays each holder's proceeds
    /// to the return wallet in the same position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legs_random: Option<String>,
    /// Recovery only: recipient indices below this (the registry's next index) are scanned.
    #[serde(default)]
    scan_to: Option<u32>,
}

fn legacy_source_index() -> u32 {
    FUNDING_ACCOUNT
}

/// Most payout legs one operation may run: signatures, review length and fees all grow with it.
pub(crate) const MAX_LEGS: usize = 5;
const MAX_PRIVATE_HOLDERS: usize = 8192 - FIRST_RECIPIENT as usize;
const HOLDINGS_READ_SIZE: usize = 20; // balanceOf + ETH balance: at most 40 RPC calls.

const MAX_WEIGHT_SUM: u64 = 10_000;

fn leg_weights(plan: &Plan) -> Vec<u32> {
    match &plan.weights {
        Some(weights) => weights.clone(),
        None if plan.recipient_indices.len() == 3 => vec![3, 3, 4],
        None => vec![1; plan.recipient_indices.len()],
    }
}

/// Fusion ("insufficient amount") or Aurora's bridge ("Amount is too low for bridge, try at
/// least N") refuse a sale for being too small. Nothing is signed before either answer.
fn is_dust_rejection(value: &Value) -> bool {
    value
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|m| {
            let m = m.to_lowercase();
            m.contains("insufficient amount") || m.contains("amount is too low")
        })
}

fn count_word(n: usize) -> String {
    ["zero", "one", "two", "three", "four", "five"]
        .get(n)
        .map_or_else(|| n.to_string(), |w| (*w).to_string())
}

/// "30/30/40": each weight as a whole percentage of the total, the last taking the remainder.
fn percent_split(weights: &[u32]) -> String {
    let sum: u64 = weights.iter().map(|w| u64::from(*w)).sum();
    let mut left = 100u64;
    let mut parts = Vec::new();
    for (i, w) in weights.iter().enumerate() {
        let part = if i + 1 == weights.len() {
            left
        } else {
            u64::from(*w) * 100 / sum
        };
        left -= part;
        parts.push(part.to_string());
    }
    parts.join("/")
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Payout {
    portion: U256,
    request: Option<QuoteRequest>,
    quote: Option<Quote>,
    signed: Option<Value>,
    intent_hash: Option<String>,
    delivered: U256,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Order {
    attempts: u8,
    before_usdg: U256,
    before_target: U256,
    amount: U256,
    min_out: U256,
    permit_deadline: u64,
    permit: Option<String>,
    order: Option<LimitOrder>,
    extension: Option<String>,
    quote_id: Option<String>,
    order_hash: Option<B256>,
    signature: Option<String>,
    expiration: u64,
    fills: Vec<(String, U256)>,
    swapped: U256,
    received: U256,
    received_total: U256,
    complete: bool,
    #[serde(default)]
    inbound: Option<Quote>,
    /// Fresh previews taken because an unsigned draft fell below the approved minimum.
    #[serde(default)]
    requotes: u8,
    /// A sale Fusion refuses as too small: nothing is signed for it and the other wallets go on.
    #[serde(default)]
    dust: bool,
    /// The Aurora deposit request for this sale. Older sells kept it on the payout of the same
    /// position, which only works while holders and payouts pair one to one.
    #[serde(default)]
    inbound_request: Option<QuoteRequest>,
    #[serde(default)]
    inbound_quoted_ms: u64,
    #[serde(default)]
    sold_total: U256,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaleInbound {
    order_index: usize,
    request: QuoteRequest,
    quote: Quote,
    input: U256,
    transaction_hashes: Vec<B256>,
    quoted_ms: u64,
    retry: bool,
    exhausted: bool,
    credited: U256,
}

/// Immutable economics shown by native review, independent of later preparation/quote refreshes.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FundingReviewLimits {
    version: u32,
    operation_id: String,
    identity_digest: B256,
    maximum_source_debit: U256,
    maximum_gas_fee: U256,
    minimum_principal: U256,
    minimum_private_credit: U256,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Data {
    source_asset: String,
    destination_asset: String,
    target_symbol: String,
    target_decimals: u8,
    source_balance: U256,
    budget: U256,
    code: String,
    transaction_count: u64,
    allowance: U256,
    funding_amount: U256,
    funding_fee: U256,
    #[serde(default)]
    review_limits: Option<FundingReviewLimits>,
    #[serde(default)]
    funding_review_changed: bool,
    funding_request: Option<QuoteRequest>,
    funding_quote: Option<Quote>,
    prepared: Option<(UserOperation, Option<UnsignedAuthorization>)>,
    signed_operation: Option<(B256, Value)>,
    estimates: Vec<(U256, U256)>,
    rate_amount: U256,
    rate_end: U256,
    access_token: Option<String>,
    credit_basis: Option<String>,
    available: U256,
    private_token_id: Option<String>,
    payouts: Vec<Payout>,
    orders: Vec<Order>,
    /// Cursor for bounded balance reads. Historical journals start at the first holder.
    #[serde(default)]
    holdings_cursor: usize,
    /// Pooled sell: expected USDG from all sales, used to size the payouts before review.
    #[serde(default)]
    sale_estimate: U256,
    #[serde(default)]
    leg: usize,
    #[serde(default)]
    sale_inbounds: Vec<SaleInbound>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Machine {
    version: u32,
    id: String,
    plan: Plan,
    source: Address,
    confidential: Address,
    recipients: Vec<Address>,
    #[serde(default)]
    holders: Vec<Address>,
    created_ms: u64,
    approved_ms: Option<u64>,
    session_until_ms: u64,
    step: Step,
    reapproval: Option<String>,
    resubmits: u32,
    paused: Option<String>,
    cancelled: bool,
    next_id: u64,
    pending: Option<u64>,
    failures: u32,
    wait_until_ms: u64,
    data: Data,
}

struct Engine {
    m: Machine,
    gateway: String,
    seed: Option<Zeroizing<[u8; 64]>>,
}

enum Outcome {
    Ok(Value),
    Transient,
    Rejected(u16, Value),
}

fn provider_code(value: &Value) -> Option<&str> {
    value.get("code").and_then(Value::as_str).filter(|code| {
        !code.is_empty()
            && code.len() <= 64
            && code
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    })
}

fn outcome(status: u16, body: &str) -> Outcome {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let deterministic =
        value.get("retryable") == Some(&Value::Bool(false)) && provider_code(&value).is_some();
    if status == 0 || status == 429 || (status >= 500 && !deterministic) {
        return Outcome::Transient;
    }
    if (200..300).contains(&status) {
        Outcome::Ok(value)
    } else {
        Outcome::Rejected(status, value)
    }
}

fn gateway_base(url: &str) -> Result<String, SignerError> {
    let trimmed = url.trim_end_matches('/');
    let local = ["http://127.0.0.1:", "http://localhost:", "http://10.0.2.2:"]
        .iter()
        .any(|p| trimmed.starts_with(p));
    if trimmed.len() > 200
        || !(trimmed.starts_with("https://") || local)
        || trimmed.contains('?')
        || trimmed.contains('#')
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(trimmed.to_string())
}

fn usdc(v: U256) -> String {
    units(v, 6)
}
fn units(v: U256, decimals: u8) -> String {
    let scale = U256::from(10u64).pow(U256::from(decimals));
    let frac = (v % scale).to_string();
    format!(
        "{}.{}{}",
        v / scale,
        "0".repeat(decimals as usize - frac.len().min(decimals as usize)),
        frac
    )
}

fn call_data(signature: &str, args: &[Address]) -> String {
    evm::encode_call(
        signature,
        &args
            .iter()
            .map(|a| evm::word_address(*a))
            .collect::<Vec<_>>(),
    )
}

fn rpc_result(batch: &Value, id: u64) -> Result<&Value, SignerError> {
    batch
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_u64) == Some(id))
        })
        .and_then(|item| item.get("result"))
        .ok_or(SignerError::InvalidInput)
}
fn rpc_uint(batch: &Value, id: u64) -> Result<U256, SignerError> {
    let s = rpc_result(batch, id)?
        .as_str()
        .ok_or(SignerError::InvalidInput)?;
    if s == "0x" {
        return Ok(U256::ZERO);
    }
    let bytes = evm::hex_bytes(s)?;
    if bytes.len() > 32 {
        return Err(SignerError::InvalidInput);
    }
    Ok(U256::from_be_slice(&bytes))
}
fn rpc_quantity(batch: &Value, id: u64) -> Result<U256, SignerError> {
    evm::quantity(
        rpc_result(batch, id)?
            .as_str()
            .ok_or(SignerError::InvalidInput)?,
    )
}
fn abi_string(batch: &Value, id: u64) -> Result<String, SignerError> {
    let bytes = evm::hex_bytes(
        rpc_result(batch, id)?
            .as_str()
            .ok_or(SignerError::InvalidInput)?,
    )?;
    let reader = evm::AbiReader::new(&bytes);
    let text = reader.bytes(reader.usize(0)?)?;
    if text.len() > 32 {
        return Err(SignerError::InvalidInput);
    }
    String::from_utf8(text.to_vec()).map_err(|_| SignerError::InvalidInput)
}

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, SignerError> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or(SignerError::InvalidInput)
}

impl Engine {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.gateway)
    }
    fn request(&mut self, method: &str, url: String, body: Option<Value>) -> SwapStep {
        self.m.next_id += 1;
        self.m.pending = Some(self.m.next_id);
        SwapStep::Request {
            id: self.m.next_id,
            method: method.into(),
            url,
            body: body.map(|b| b.to_string()),
        }
    }
    fn get(&mut self, path: &str) -> SwapStep {
        let url = self.url(path);
        self.request("GET", url, None)
    }
    fn post(&mut self, path: &str, body: Value) -> SwapStep {
        let url = self.url(path);
        self.request("POST", url, Some(body))
    }
    fn rpc(&mut self, chain: &str, calls: Vec<(&str, Value)>) -> SwapStep {
        let batch: Vec<Value> = calls.into_iter().enumerate().map(|(i, (method, params))| json!({"jsonrpc": "2.0", "id": i, "method": method, "params": params})).collect();
        let url = if chain == "monad" {
            MONAD_RPC
        } else {
            ROBINHOOD_RPC
        };
        self.request("POST", url.into(), Some(Value::Array(batch)))
    }
    fn eth_call(to: Address, data: String) -> Value {
        json!([{"to": to.to_checksum(None), "data": data}, "latest"])
    }

    fn key(&self, index: u32) -> Result<bip32::XPrv, SignerError> {
        derive_key(self.seed.as_ref().ok_or(SignerError::InvalidInput)?, index)
    }
    // Completed groups must remain recoverable after a long interruption. A fresh native
    // unlock still renews only the existing 15-minute session for this immutable sale.
    fn operation_expired(&self, now: u64) -> bool {
        now >= self.m.created_ms + OPERATION_MS
            && !(self.private_sell() && self.m.approved_ms.is_some())
    }
    fn can_sign(&mut self, now: u64) -> bool {
        if now >= self.m.session_until_ms {
            self.seed = None;
        }
        self.seed.is_some() && self.m.approved_ms.is_some() && !self.operation_expired(now)
    }
    fn pause(&mut self, code: &str) -> SwapStep {
        self.m.paused = Some(code.into());
        SwapStep::Paused { code: code.into() }
    }
    fn go(&mut self, step: Step) {
        self.m.step = step;
        self.m.failures = 0;
    }
    fn wait(&mut self, now: u64, millis: u64) {
        self.m.wait_until_ms = now + millis;
    }
    /// Number of payout/order legs this operation runs (3 for every plan created before it varied).
    fn legs(&self) -> usize {
        self.m.plan.recipient_indices.len()
    }
    fn is_last_leg(&self, index: usize) -> bool {
        index + 1 == self.legs()
    }
    /// The private USDC split into one portion per leg, summing exactly to `total`.
    fn portions(&self, total: U256) -> Vec<U256> {
        aurora::split_weighted(total, &leg_weights(&self.m.plan))
    }
    fn recipient_index(&self, i: usize) -> u32 {
        self.m.plan.recipient_indices[i]
    }
    /// Everything that sells held tokens through Fusion.
    fn sell(&self) -> bool {
        self.m.plan.kind == "confidentialSell"
    }
    /// A sell that pools every holder's proceeds in C and then splits them over randomly sized
    /// payouts, as a buy does. Older sells pay each holder's proceeds straight through.
    fn private_sell(&self) -> bool {
        self.m.plan.kind == "confidentialSell"
            && self.m.plan.completion_target.as_deref() == Some("confidential")
    }
    fn pooled_sell(&self) -> bool {
        self.m.plan.kind == "confidentialSell" && self.m.plan.legs_random.is_some()
    }
    /// Number of token sales (holder wallets) for a sell, or of buy orders otherwise.
    fn sales(&self) -> usize {
        if self.sell() {
            self.m.holders.len()
        } else {
            self.legs()
        }
    }
    /// Where a sale's USDG is delivered: the Aurora deposit address.
    fn sale_receiver(&self, index: usize) -> Result<Address, SignerError> {
        evm::addr(
            &self.m.data.orders[index]
                .inbound
                .as_ref()
                .ok_or(SignerError::InvalidInput)?
                .deposit_address,
        )
    }
    /// A buy that spends the private balance C already holds and sends nothing from Monad.
    fn payout_only(&self) -> bool {
        self.m.plan.kind == "confidentialPayout"
    }
    /// Temporary recovery: finish Fusion buys for recipient wallets an earlier operation left
    /// holding USDG. Nothing moves on Monad or from the confidential balance.
    fn recovery(&self) -> bool {
        self.m.plan.kind == "confidentialRecovery"
    }
    fn recovery_range(&self) -> Result<std::ops::Range<u32>, SignerError> {
        let end = self.m.plan.scan_to.ok_or(SignerError::InvalidInput)?;
        let start = FIRST_RECIPIENT.max(end.saturating_sub(MAX_RECOVERY_SCAN));
        if end < start + self.legs() as u32 {
            return Err(SignerError::InvalidInput);
        }
        Ok(start..end)
    }
    /// The private USDC the three payouts split: the funding quote's credit, or C's balance.
    fn payout_base(&self) -> Result<U256, SignerError> {
        if self.payout_only() {
            return Ok(self.m.data.available);
        }
        Ok(self
            .m
            .data
            .funding_quote
            .as_ref()
            .ok_or(SignerError::InvalidInput)?
            .amount_out)
    }
    fn holder(&self, i: usize) -> Address {
        if self.sell() {
            self.m.holders[i]
        } else {
            self.m.recipients[i]
        }
    }
    fn signer_index(&self, i: usize) -> u32 {
        if self.sell() {
            self.m
                .plan
                .holder_indices
                .as_ref()
                .map_or_else(|| self.recipient_index(i), |h| h[i])
        } else {
            self.recipient_index(i)
        }
    }
    fn next_sell_index(&self, from: usize) -> Option<usize> {
        (from..self.sales()).find(|&i| {
            let o = &self.m.data.orders[i];
            !o.amount.is_zero() && !o.complete && !o.dust
        })
    }

    fn next(&mut self, now: u64) -> Result<SwapStep, SignerError> {
        if self.m.cancelled {
            return Ok(SwapStep::Paused {
                code: "CANCELLED".into(),
            });
        }
        if let Some(code) = &self.m.paused {
            return Ok(SwapStep::Paused { code: code.clone() });
        }
        if self.m.pending.take().is_some() {
            // The last response never arrived (crash or lost reply): reads are reissued,
            // submissions go to their status lookup instead of being repeated.
            self.lost_submit();
        }
        if now < self.m.wait_until_ms {
            return Ok(SwapStep::Wait {
                millis: self.m.wait_until_ms - now,
            });
        }
        if let Some(text) = &self.m.reapproval {
            return Ok(SwapStep::Review { text: text.clone() });
        }
        let d = self.m.data.clone();
        let step = match self.m.step.clone() {
            Step::Assets => self.get("/v1/swap/aurora/tokens"),
            Step::SourceChain { .. } => {
                let (src, pm) = (self.m.source, PIMLICO_ERC20_PAYMASTER);
                self.rpc("monad", vec![
                    ("eth_chainId", json!([])),
                    ("eth_call", Self::eth_call(MONAD_USDC, call_data("balanceOf(address)", &[src]))),
                    ("eth_getCode", json!([src.to_checksum(None), "latest"])),
                    ("eth_getTransactionCount", json!([src.to_checksum(None), "latest"])),
                    ("eth_call", Self::eth_call(MONAD_USDC, call_data("allowance(address,address)", &[src, pm]))),
                ])
            }
            Step::TargetChain => {
                let t = self.m.plan.target;
                self.rpc("robinhood", vec![
                    ("eth_chainId", json!([])),
                    ("eth_call", Self::eth_call(t, evm::encode_call("symbol()", &[]))),
                    ("eth_call", Self::eth_call(t, evm::encode_call("decimals()", &[]))),
                ])
            }
            Step::Holdings => {
                let t = self.m.plan.target;
                let mut calls = Vec::new();
                let start = self.m.data.holdings_cursor;
                let end = (start + HOLDINGS_READ_SIZE).min(self.sales());
                for i in start..end {
                    let h = self.m.holders[i];
                    calls.push(("eth_call", Self::eth_call(t, call_data("balanceOf(address)", &[h]))));
                    calls.push(("eth_getBalance", json!([h.to_checksum(None), "latest"])));
                }
                self.rpc("robinhood", calls)
            }
            Step::RecoveryScan => {
                if self.seed.is_none() {
                    return Ok(SwapStep::Unlock);
                }
                let mut calls = Vec::new();
                for i in self.recovery_range()? {
                    let a = evm::key_address(&self.key(i)?);
                    calls.push(("eth_call", Self::eth_call(ROBINHOOD_USDG, call_data("balanceOf(address)", &[a]))));
                }
                self.rpc("robinhood", calls)
            }
            Step::FundingProbe => self.post("/v1/swap/monad/prepare-funding", json!({"owner": self.m.source.to_checksum(None), "recipient": PROBE_RECIPIENT.to_checksum(None), "amount": "1"})),
            Step::FundingQuote { .. } => {
                let request = QuoteRequest::funding(self.m.confidential, self.m.source, &d.source_asset, d.funding_amount);
                self.m.data.funding_request = Some(request.clone());
                self.post("/v1/swap/aurora/quote", serde_json::to_value(request).map_err(|_| SignerError::InvalidInput)?)
            }
            Step::FundingPrepare { .. } => {
                let quote = d.funding_quote.as_ref().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/monad/prepare-funding", json!({"owner": self.m.source.to_checksum(None), "recipient": quote.deposit_address, "amount": d.funding_amount.to_string()}))
            }
            Step::PayoutEstimate { index } => {
                let portion = self.portions(self.payout_base()?)[index];
                let request = QuoteRequest::payout(self.m.confidential, self.m.recipients[index], &d.source_asset, &d.destination_asset, portion);
                self.post("/v1/swap/aurora/quote", serde_json::to_value(request).map_err(|_| SignerError::InvalidInput)?)
            }
            Step::FusionEstimate => {
                if self.sell() {
                    let index = self.next_sell_index(0).unwrap_or(0);
                    let amount = d.orders[index].amount;
                    self.m.data.rate_amount = amount;
                    self.post("/v1/swap/fusion/preview", json!({"wallet": self.holder(index).to_checksum(None), "srcToken": self.m.plan.target.to_checksum(None), "dstToken": format!("{ROBINHOOD_USDG:#x}"), "amount": amount.to_string(), "preset": "fast"}))
                } else {
                    let total = d.estimates.iter().fold(U256::ZERO, |sum, (_, min)| sum + *min);
                    self.m.data.rate_amount = total;
                    self.post("/v1/swap/fusion/preview", json!({"wallet": self.m.recipients[0].to_checksum(None), "dstToken": self.m.plan.target.to_checksum(None), "amount": total.to_string(), "preset": "fast"}))
                }
            }
            Step::Review => {
                if self.m.approved_ms.is_some() {
                    self.m.data.prepared = None;
                    if self.sell() {
                        let index = self.next_sell_index(0).ok_or(SignerError::InvalidInput)?;
                        self.go(Step::FusionPreview { index });
                    } else if self.payout_only() {
                        // Read C again so the payouts split the balance held at approval.
                        self.go(Step::AuthSalt);
                    } else if self.recovery() {
                        // Each wallet's balance is read again before its order.
                        self.go(Step::FusionBalance { index: 0 });
                    } else {
                        // Re-read the chain and re-prepare so the signed UserOperation is fresh.
                        self.go(Step::SourceChain { execute: true });
                    }
                    return self.next(now);
                }
                return Ok(SwapStep::Review { text: self.review() });
            }
            Step::FundingSign => {
                if d.signed_operation.is_some() {
                    // A saved signature is immutable; reconcile it instead of preparing/signing again.
                    self.go(Step::FundingReceipt { polls: 0, resubmitted: false });
                    return self.next(now);
                }
                if !self.within_funding_review()? {
                    self.request_funding_review();
                    return self.next(now);
                }
                if let Some(op) = d.prepared.as_ref().map(|p| &p.0)
                    && funding::readiness_code(op, now / 1000)?.is_some()
                {
                    self.m.data.prepared = None;
                    self.go(Step::SourceChain { execute: true });
                    return self.next(now);
                }
                if d.funding_quote.as_ref().is_none_or(|q| q.deadline_ms <= now + QUOTE_MARGIN_MS) {
                    self.go(Step::FundingQuote { attempt: 0 });
                    return self.next(now);
                }
                if d.prepared.is_none() {
                    self.go(Step::SourceChain { execute: true });
                    return self.next(now);
                }
                if !self.can_sign(now) {
                    return Ok(self.unlock_or_expire(now));
                }
                match self.sign_funding(now) {
                    Ok(()) => {}
                    Err(SignerError::Expired) => {
                        // Paymaster validity lapsed while locked: re-read the chain and prepare again.
                        self.m.data.prepared = None;
                        self.go(Step::SourceChain { execute: true });
                        return self.next(now);
                    }
                    Err(_) => return Ok(self.pause("REJECTED_fundingSign")),
                }
                self.go(Step::FundingSubmit);
                return self.next(now);
            }
            Step::FundingSubmit => {
                let (_, rpc) = d.signed_operation.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/monad/submit", json!({"userOperation": rpc}))
            }
            Step::FundingReceipt { .. } => {
                let (hash, _) = d.signed_operation.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/monad/receipt", json!({"userOperationHash": format!("{hash:#x}")}))
            }
            Step::Credit => {
                let quote = d.funding_quote.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/aurora/status", status_body(&quote))
            }
            Step::AuthSalt => self.get("/v1/swap/aurora/auth-salt"),
            Step::Authenticate { salt } => {
                // Planning a payout reads C's balance before approval. The ownership proof carries
                // no intents, so it cannot move funds; spending intents still need the approval.
                let planning = (self.payout_only() || self.private_sell()) && self.m.approved_ms.is_none() && self.seed.is_some();
                if !planning && !self.can_sign(now) {
                    return Ok(self.unlock_or_expire(now));
                }
                let key = self.key(CONFIDENTIAL_ACCOUNT)?;
                let secret = Zeroizing::new(key.private_key().to_bytes().to_vec());
                let payload = aurora::auth_payload(self.m.confidential, &salt, now, aurora::auth_random(&secret, now, self.m.next_id))?;
                let sig = evm::sign(&key, evm::personal_hash(payload.as_bytes()))?;
                self.post("/v1/swap/aurora/authenticate", json!({"payload": payload, "signature": aurora::encode_signature(&sig)}))
            }
            Step::PrivateHistoryProbe => {
                let token = d.access_token.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/aurora/history", json!({"accessToken":token,"depositAddress":format!("{:#x}",self.m.confidential)}))
            }
            Step::PrivateCredit { index } => {
                let inbound = d.sale_inbounds.get(index).ok_or(SignerError::InvalidInput)?;
                let token = d.access_token.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/aurora/history", json!({"accessToken": token, "depositAddress": inbound.quote.deposit_address}))
            }
            Step::Balances => {
                let token = d.access_token.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/aurora/balances", json!({"accessToken": token}))
            }
            Step::PayoutQuote { index } => {
                if self.sell() {
                    // A pooled sell splits C's whole balance by the shares; an older one pays out
                    // the single holder's credit.
                    let portion = if self.pooled_sell() { self.portions(d.available)[index] } else { d.available };
                    let request = QuoteRequest::payout(self.m.confidential, self.m.recipients[index], &d.source_asset, &d.source_asset, portion);
                    self.m.data.payouts[index].portion = portion;
                    self.m.data.payouts[index].request = Some(request.clone());
                    self.post("/v1/swap/aurora/quote", serde_json::to_value(request).map_err(|_| SignerError::InvalidInput)?)
                } else {
                    let portion = self.portions(d.available)[index];
                    let request = QuoteRequest::payout(self.m.confidential, self.m.recipients[index], &d.source_asset, &d.destination_asset, portion);
                    self.m.data.payouts[index].portion = portion;
                    self.m.data.payouts[index].request = Some(request.clone());
                    self.post("/v1/swap/aurora/quote", serde_json::to_value(request).map_err(|_| SignerError::InvalidInput)?)
                }
            }
            Step::PayoutIntent { index } => {
                if !self.can_sign(now) {
                    return Ok(self.unlock_or_expire(now));
                }
                let quote = d.payouts[index].quote.clone().ok_or(SignerError::InvalidInput)?;
                if quote.deadline_ms <= now + QUOTE_MARGIN_MS {
                    self.go(Step::PayoutQuote { index });
                    return self.next(now);
                }
                self.post("/v1/swap/aurora/generate-intent", json!({"signerId": format!("{:#x}", self.m.confidential), "depositAddress": quote.deposit_address}))
            }
            Step::PayoutSubmit { index } => {
                let signed = d.payouts[index].signed.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/aurora/submit-intent", json!({"signedData": signed}))
            }
            Step::PayoutStatus { index, .. } => {
                let quote = d.payouts[index].quote.clone().ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/aurora/status", status_body(&quote))
            }
            Step::PayoutBalance { index } => {
                if self.sell() {
                    let a = self.m.recipients[index];
                    self.rpc("monad", vec![("eth_call", Self::eth_call(MONAD_USDC, call_data("balanceOf(address)", &[a])))])
                } else {
                    let a = self.m.recipients[index];
                    self.rpc("robinhood", vec![
                        ("eth_call", Self::eth_call(ROBINHOOD_USDG, call_data("balanceOf(address)", &[a]))),
                    ])
                }
            }
            Step::FusionBalance { index } | Step::FusionAfter { index } => {
                let a = self.holder(index);
                self.rpc("robinhood", vec![
                    ("eth_call", Self::eth_call(ROBINHOOD_USDG, call_data("balanceOf(address)", &[a]))),
                    ("eth_call", Self::eth_call(self.m.plan.target, call_data("balanceOf(address)", &[a]))),
                    ("eth_getBalance", json!([a.to_checksum(None), "latest"])),
                ])
            }
            Step::FusionPreview { index } => {
                let amount = d.orders[index].amount;
                if self.sell() {
                    self.post("/v1/swap/fusion/preview", json!({"wallet": self.holder(index).to_checksum(None), "srcToken": self.m.plan.target.to_checksum(None), "dstToken": format!("{ROBINHOOD_USDG:#x}"), "amount": amount.to_string(), "preset": "fast"}))
                } else {
                    self.post("/v1/swap/fusion/preview", json!({"wallet": self.m.recipients[index].to_checksum(None), "dstToken": self.m.plan.target.to_checksum(None), "amount": amount.to_string(), "preset": "fast"}))
                }
            }
            Step::SellQuote { index } => {
                let amount = d.orders[index].min_out;
                let request = QuoteRequest::sell_in(self.m.confidential, self.holder(index), &d.destination_asset, &d.source_asset, amount);
                self.m.data.orders[index].inbound_request = Some(request.clone());
                self.m.data.orders[index].inbound_quoted_ms = now;
                self.post("/v1/swap/aurora/quote", serde_json::to_value(request).map_err(|_| SignerError::InvalidInput)?)
            }
            Step::FusionPermit { index } => {
                if !self.can_sign(now) {
                    return Ok(self.unlock_or_expire(now));
                }
                if self.sell() {
                    self.post("/v1/swap/fusion/permit-context", json!({"owner": self.holder(index).to_checksum(None), "token": self.m.plan.target.to_checksum(None)}))
                } else {
                    self.post("/v1/swap/fusion/permit-context", json!({"owner": self.m.recipients[index].to_checksum(None)}))
                }
            }
            Step::FusionOrder { index } => {
                let o = &d.orders[index];
                if self.sell() {
                    self.post("/v1/swap/fusion/order", json!({"wallet": self.holder(index).to_checksum(None), "srcToken": self.m.plan.target.to_checksum(None), "dstToken": format!("{ROBINHOOD_USDG:#x}"), "receiver": self.sale_receiver(index)?.to_checksum(None), "amount": o.amount.to_string(), "permit": o.permit.clone().ok_or(SignerError::InvalidInput)?, "preset": "fast"}))
                } else {
                    self.post("/v1/swap/fusion/order", json!({"wallet": self.m.recipients[index].to_checksum(None), "dstToken": self.m.plan.target.to_checksum(None), "amount": o.amount.to_string(), "permit": o.permit.clone().ok_or(SignerError::InvalidInput)?, "preset": "fast"}))
                }
            }
            Step::FusionSign { index } => {
                if !self.can_sign(now) {
                    return Ok(self.unlock_or_expire(now));
                }
                let o = &d.orders[index];
                if now / 1000 + 60 >= o.expiration {
                    self.go(if self.sell() { Step::FusionPreview { index } } else { Step::FusionBalance { index } });
                    return self.next(now);
                }
                let hash = o.order_hash.ok_or(SignerError::InvalidInput)?;
                let sig = evm::sign(&self.key(self.signer_index(index))?, hash)?;
                self.m.data.orders[index].signature = Some(sig.rsv_hex());
                self.go(Step::FusionSubmit { index });
                return self.next(now);
            }
            Step::FusionSubmit { index } => {
                let o = &d.orders[index];
                self.post("/v1/swap/fusion/submit", json!({"order": o.order, "signature": o.signature, "quoteId": o.quote_id, "extension": o.extension}))
            }
            Step::FusionStatus { index } => {
                let hash = d.orders[index].order_hash.ok_or(SignerError::InvalidInput)?;
                self.post("/v1/swap/fusion/status", json!({"orderHash": format!("{hash:#x}")}))
            }
            Step::FusionReceipts { index } => {
                let calls = d.orders[index].fills.iter().map(|(tx, _)| ("eth_getTransactionReceipt", json!([tx]))).collect::<Vec<_>>();
                if calls.is_empty() {
                    self.go(Step::FusionAfter { index });
                    return self.next(now);
                }
                self.rpc("robinhood", calls)
            }
            Step::Done => return Ok(SwapStep::Finished),
        };
        Ok(step)
    }

    fn unlock_or_expire(&mut self, now: u64) -> SwapStep {
        if self.operation_expired(now) {
            return self.pause("OPERATION_EXPIRED");
        }
        SwapStep::Unlock
    }

    fn funding_identity(&self) -> Result<B256, SignerError> {
        let bytes = serde_json::to_vec(&(
            "gizu-swap-funding-review-v1",
            &self.m.id,
            &self.m.plan,
            self.m.source,
            self.m.confidential,
            &self.m.recipients,
            self.m.data.budget,
        ))
        .map_err(|_| SignerError::InvalidInput)?;
        Ok(keccak256(bytes))
    }

    fn funding_review_limits(&self) -> Result<FundingReviewLimits, SignerError> {
        let d = &self.m.data;
        let quote = d.funding_quote.as_ref().ok_or(SignerError::InvalidInput)?;
        Ok(FundingReviewLimits {
            version: 1,
            operation_id: self.m.id.clone(),
            identity_digest: self.funding_identity()?,
            maximum_source_debit: d
                .funding_amount
                .checked_add(d.funding_fee)
                .ok_or(SignerError::InvalidInput)?,
            maximum_gas_fee: d.funding_fee,
            minimum_principal: d.funding_amount,
            minimum_private_credit: quote.min_amount_out,
        })
    }

    fn within_funding_review(&self) -> Result<bool, SignerError> {
        let Some(reviewed) = &self.m.data.review_limits else {
            return Ok(false);
        };
        let fresh = self.funding_review_limits()?;
        Ok(reviewed.version == 1
            && reviewed.operation_id == fresh.operation_id
            && reviewed.identity_digest == fresh.identity_digest
            && fresh.maximum_source_debit <= reviewed.maximum_source_debit
            && fresh.maximum_gas_fee <= reviewed.maximum_gas_fee
            && fresh.minimum_principal >= reviewed.minimum_principal
            && fresh.minimum_private_credit >= reviewed.minimum_private_credit)
    }

    fn request_funding_review(&mut self) {
        self.m.approved_ms = None;
        self.m.data.review_limits = None;
        self.m.data.funding_review_changed = true;
        self.go(Step::PayoutEstimate { index: 0 });
    }

    fn sign_funding(&mut self, now: u64) -> Result<(), SignerError> {
        let (op, authorization) = self
            .m
            .data
            .prepared
            .clone()
            .ok_or(SignerError::InvalidInput)?;
        let quote = self
            .m
            .data
            .funding_quote
            .clone()
            .ok_or(SignerError::InvalidInput)?;
        let chain = self.chain()?;
        let checked = funding::check_funding(
            &op,
            authorization.as_ref(),
            self.m.source,
            evm::addr(&quote.deposit_address)?,
            self.m.data.funding_amount,
            self.m.data.budget,
            &chain,
            now / 1000,
        )?;
        if !self.within_funding_review()? {
            return Err(SignerError::InvalidInput);
        }
        let key = self.key(self.m.plan.source_index)?;
        if evm::key_address(&key) != self.m.source {
            return Err(SignerError::CryptoFailed);
        }
        let signature = evm::sign(&key, checked.hash)?;
        let auth_signature = match &authorization {
            Some(a) => Some(evm::sign(
                &key,
                evm::authorization_hash(a.chain_id, a.address, a.nonce),
            )?),
            None => None,
        };
        let rpc = funding::rpc_operation(
            &op,
            &signature,
            authorization.as_ref().zip(auth_signature.as_ref()),
        );
        self.m.data.signed_operation = Some((checked.hash, rpc));
        self.m.data.funding_fee = checked.fee_cap;
        Ok(())
    }

    fn chain(&self) -> Result<FundingChain, SignerError> {
        Ok(FundingChain {
            code: evm::hex_bytes(&self.m.data.code)?,
            transaction_count: self.m.data.transaction_count,
            paymaster_allowance: self.m.data.allowance,
        })
    }

    fn respond(&mut self, id: u64, status: u16, body: &str, now: u64) -> Result<(), SignerError> {
        if self.m.pending != Some(id) {
            return Err(SignerError::InvalidInput);
        }
        self.m.pending = None;
        if self.m.step == Step::PrivateHistoryProbe && !(200..300).contains(&status) {
            self.m.paused = Some("PRIVATE_CREDIT_UNAVAILABLE".into());
            return Ok(());
        }
        let result = outcome(status, body);
        if let Outcome::Transient = result {
            let submit = matches!(
                self.m.step,
                Step::FundingSubmit | Step::PayoutSubmit { .. } | Step::FusionSubmit { .. }
            );
            if submit {
                // Outcome unknown: look it up, never sign again.
                self.lost_submit();
                self.wait(now, POLL_MS);
                return Ok(());
            }
            self.m.failures += 1;
            if self.m.failures > MAX_TRANSIENT_FAILURES {
                self.m.paused = Some("NETWORK_UNAVAILABLE".into());
            }
            self.wait(now, POLL_MS * u64::from(self.m.failures.min(6)));
            return Ok(());
        }
        match self.handle(result, now) {
            Ok(()) => Ok(()),
            Err(SignerError::Expired) => {
                self.m.paused = Some("QUOTE_EXPIRED".into());
                Ok(())
            }
            Err(error) => {
                self.m.paused = Some(format!("REJECTED_{}", step_name(&self.m.step)));
                Err(error)
            }
        }
    }

    fn handle(&mut self, result: Outcome, now: u64) -> Result<(), SignerError> {
        let step = self.m.step.clone();
        let (value, rejected) = match result {
            Outcome::Ok(v) => (v, None),
            Outcome::Rejected(code, v) => (v, Some(code)),
            Outcome::Transient => unreachable!(),
        };
        match (step, rejected) {
            (Step::Assets, None) => {
                let tokens = value
                    .get("tokens")
                    .and_then(Value::as_array)
                    .ok_or(SignerError::InvalidInput)?;
                let find = |chain: &str, contract: Address| -> Result<String, SignerError> {
                    let matches: Vec<_> = tokens
                        .iter()
                        .filter(|t| {
                            t.get("blockchain").and_then(Value::as_str) == Some(chain)
                                && t.get("contractAddress")
                                    .and_then(Value::as_str)
                                    .and_then(|c| evm::addr(c).ok())
                                    == Some(contract)
                        })
                        .collect();
                    match matches.as_slice() {
                        [t] if t.get("decimals").and_then(Value::as_u64)
                            == Some(u64::from(USDC_DECIMALS)) =>
                        {
                            Ok(text(t, "assetId")?.to_string())
                        }
                        _ => Err(SignerError::InvalidInput),
                    }
                };
                self.m.data.source_asset = find("monad", MONAD_USDC)?;
                self.m.data.destination_asset = find("hood", ROBINHOOD_USDG)?;
                self.go(Step::TargetChain);
            }
            (Step::TargetChain, None) => {
                if rpc_quantity(&value, 0)? != U256::from(ROBINHOOD_CHAIN_ID) {
                    return Err(SignerError::InvalidInput);
                }
                let decimals = rpc_uint(&value, 2)?;
                if decimals > U256::from(36) || self.m.plan.target == ROBINHOOD_USDG {
                    return Err(SignerError::InvalidInput);
                }
                self.m.data.target_symbol = abi_string(&value, 1)?;
                self.m.data.target_decimals = decimals.to::<u8>();
                self.go(if self.private_sell() {
                    Step::AuthSalt
                } else if self.sell() {
                    Step::Holdings
                } else if self.payout_only() {
                    Step::AuthSalt
                } else if self.recovery() {
                    Step::RecoveryScan
                } else {
                    Step::SourceChain { execute: false }
                });
            }
            (Step::RecoveryScan, None) => {
                let range = self.recovery_range()?;
                let (mut held, mut empty) = (Vec::new(), Vec::new());
                for (id, i) in range.enumerate() {
                    let usdg = rpc_uint(&value, id as u64)?;
                    if usdg.is_zero() {
                        empty.push(i)
                    } else {
                        held.push((i, usdg))
                    }
                }
                if held.is_empty() {
                    self.m.paused = Some("NOTHING_TO_RECOVER".into());
                    return Ok(());
                }
                // Up to one run of `legs` wallets; empty indices fill the remaining slots and are skipped.
                let legs = self.legs();
                held.truncate(legs);
                let mut slots = held.clone();
                slots.extend(empty.into_iter().map(|i| (i, U256::ZERO)));
                slots.truncate(legs);
                if slots.len() != legs {
                    return Err(SignerError::InvalidInput);
                }
                self.m.data.estimates.clear();
                for (slot, (i, usdg)) in slots.iter().enumerate() {
                    self.m.plan.recipient_indices[slot] = *i;
                    self.m.recipients[slot] = evm::key_address(&self.key(*i)?);
                    self.m.data.orders[slot].amount = *usdg;
                    self.m.data.estimates.push((*usdg, *usdg));
                }
                self.go(Step::FusionEstimate);
            }
            (Step::Holdings, None) => {
                let start = self.m.data.holdings_cursor;
                let end = (start + HOLDINGS_READ_SIZE).min(self.sales());
                let rows = value.as_array().ok_or(SignerError::InvalidInput)?;
                let count = (end - start) * 2;
                let mut ids = std::collections::HashSet::new();
                if rows.len() != count
                    || rows.iter().any(|row| {
                        row.get("id")
                            .and_then(Value::as_u64)
                            .is_none_or(|id| id >= count as u64 || !ids.insert(id))
                    })
                {
                    return Err(SignerError::InvalidInput);
                }
                // ERC-20 balanceOf returns exactly one ABI word. An empty/truncated response
                // must never become a zero balance and remove a funded wallet from the plan.
                let observations = (start..end)
                    .map(|i| {
                        let id = ((i - start) * 2) as u64;
                        let encoded = rpc_result(&value, id)?
                            .as_str()
                            .ok_or(SignerError::InvalidInput)?;
                        let amount =
                            evm::decimal(&crate::decode_portfolio_balance(encoded.into())?)?;
                        Ok((amount, rpc_quantity(&value, id + 1)?))
                    })
                    .collect::<Result<Vec<_>, SignerError>>()?;
                for (i, (amount, eth)) in (start..end).zip(observations) {
                    if !eth.is_zero() && (!self.private_sell() || !amount.is_zero()) {
                        self.m.paused = Some(format!("HOLDER_{}_HOLDS_ETH", i + 1));
                        return Ok(());
                    }
                    self.m.data.orders[i].amount = amount;
                    self.m.data.orders[i].before_target = amount;
                }
                self.m.data.holdings_cursor = end;
                if end < self.sales() {
                    self.go(Step::Holdings);
                    return Ok(());
                }
                self.m.data.holdings_cursor = 0;
                if !self.m.data.orders.iter().any(|o| !o.amount.is_zero()) {
                    self.m.paused = Some("NO_HOLDINGS".into());
                    return Ok(());
                }
                if self.private_sell() {
                    // Drop empty accounts before review; never allocate payout records for a
                    // private sale. The remaining plan is frozen before native approval.
                    let live: Vec<usize> = (0..self.sales())
                        .filter(|i| !self.m.data.orders[*i].amount.is_zero())
                        .collect();
                    let indices = self
                        .m
                        .plan
                        .holder_indices
                        .as_ref()
                        .ok_or(SignerError::InvalidInput)?;
                    let held: Vec<u32> = live.iter().map(|i| indices[*i]).collect();
                    self.m.plan.holder_indices = Some(held.clone());
                    self.m.plan.recipient_indices = held;
                    self.m.holders = live.iter().map(|i| self.m.holders[*i]).collect();
                    self.m.recipients = self.m.holders.clone();
                    self.m.data.orders = live
                        .iter()
                        .map(|i| self.m.data.orders[*i].clone())
                        .collect();
                    self.m.data.payouts.clear();
                }
                self.go(Step::FusionEstimate);
            }
            (Step::SourceChain { execute }, None) => {
                if rpc_quantity(&value, 0)? != U256::from(MONAD_CHAIN_ID) {
                    return Err(SignerError::InvalidInput);
                }
                let balance = rpc_uint(&value, 1)?;
                self.m.data.code = rpc_result(&value, 2)?
                    .as_str()
                    .ok_or(SignerError::InvalidInput)?
                    .to_string();
                self.m.data.transaction_count = rpc_quantity(&value, 3)?
                    .try_into()
                    .map_err(|_| SignerError::InvalidInput)?;
                self.m.data.allowance = rpc_uint(&value, 4)?;
                if execute {
                    if balance < self.m.data.budget {
                        self.m.paused = Some("SOURCE_BALANCE_CHANGED".into());
                        return Ok(());
                    }
                    self.go(Step::FundingPrepare {
                        attempt: 0,
                        execute: true,
                    });
                } else {
                    let requested = match &self.m.plan.amount_atoms {
                        Some(a) => evm::decimal(a)?,
                        None => U256::from(MAX_SOURCE_ATOMS),
                    };
                    self.m.data.source_balance = balance;
                    if self.m.plan.amount_atoms.is_some() && requested > balance {
                        self.m.paused = Some("INSUFFICIENT_SOURCE_BALANCE".into());
                        return Ok(());
                    }
                    self.m.data.budget = balance.min(requested).min(U256::from(MAX_SOURCE_ATOMS));
                    if self.m.data.budget.is_zero() {
                        self.m.paused = Some("AWAITING_DEPOSIT".into());
                        return Ok(());
                    }
                    self.go(Step::FundingProbe);
                }
            }
            (Step::FundingProbe, None) => {
                let op: UserOperation = serde_json::from_value(value["userOperation"].clone())
                    .map_err(|_| SignerError::InvalidInput)?;
                if let Some(code) = funding::readiness_code(&op, now / 1000)? {
                    self.m.paused = Some(code.into());
                    return Ok(());
                }
                let fee = funding::fee_cap(&op, now / 1000)?;
                if fee >= self.m.data.budget {
                    self.m.paused = Some("FEE_EXCEEDS_BUDGET".into());
                    return Ok(());
                }
                self.m.data.funding_fee = fee;
                self.m.data.funding_amount = self.m.data.budget - fee;
                self.go(Step::FundingQuote { attempt: 0 });
            }
            (Step::FundingQuote { attempt }, None) => {
                let request = self
                    .m
                    .data
                    .funding_request
                    .clone()
                    .ok_or(SignerError::InvalidInput)?;
                let quote = aurora::check_quote(&request, &value, now)?;
                if quote.amount_in != self.m.data.funding_amount
                    || quote.amount_out > U256::from(MAX_SOURCE_ATOMS)
                {
                    return Err(SignerError::InvalidInput);
                }
                evm::addr(&quote.deposit_address)?;
                self.m.data.funding_quote = Some(quote);
                self.m.data.prepared = None;
                self.go(Step::FundingPrepare {
                    attempt,
                    execute: self.m.approved_ms.is_some(),
                });
            }
            (Step::FundingPrepare { attempt, execute }, None) => {
                let op: UserOperation = serde_json::from_value(value["userOperation"].clone())
                    .map_err(|_| SignerError::InvalidInput)?;
                let authorization: Option<UnsignedAuthorization> =
                    serde_json::from_value(value["authorization"].clone())
                        .map_err(|_| SignerError::InvalidInput)?;
                if let Some(code) = funding::readiness_code(&op, now / 1000)? {
                    self.m.paused = Some(code.into());
                    return Ok(());
                }
                let fee = funding::fee_cap(&op, now / 1000)?;
                let room = self
                    .m
                    .data
                    .budget
                    .checked_sub(self.m.data.funding_amount)
                    .ok_or(SignerError::InvalidInput)?;
                if fee > room {
                    // Gas price moved up. Reserve headroom and requote inside the same budget.
                    // A lower or equal fee still pays the quoted amount, so it does not requote.
                    if attempt + 1 >= MAX_FUNDING_ATTEMPTS {
                        self.m.paused = Some("FEE_UNSTABLE".into());
                        return Ok(());
                    }
                    let reserved = fee.saturating_add(fee / U256::from(4));
                    let next = self
                        .m
                        .data
                        .budget
                        .checked_sub(reserved)
                        .filter(|n| !n.is_zero())
                        .ok_or(SignerError::InvalidInput)?;
                    self.m.data.funding_amount = next;
                    self.go(Step::FundingQuote {
                        attempt: attempt + 1,
                    });
                    return Ok(());
                }
                let deposit = evm::addr(
                    &self
                        .m
                        .data
                        .funding_quote
                        .as_ref()
                        .ok_or(SignerError::InvalidInput)?
                        .deposit_address,
                )?;
                if let Some(code) = funding::approval_code(&op, fee, &self.chain()?)? {
                    self.m.paused = Some(code.into());
                    return Ok(());
                }
                let checked = funding::check_funding(
                    &op,
                    authorization.as_ref(),
                    self.m.source,
                    deposit,
                    self.m.data.funding_amount,
                    self.m.data.budget,
                    &self.chain()?,
                    now / 1000,
                )?;
                self.m.data.funding_fee = checked.fee_cap;
                self.m.data.prepared = Some((op, authorization));
                if execute && !self.within_funding_review()? {
                    self.request_funding_review();
                    return Ok(());
                }
                self.go(if execute {
                    Step::FundingSign
                } else {
                    Step::PayoutEstimate { index: 0 }
                });
            }
            (Step::PayoutEstimate { index }, None) => {
                let portion = self.portions(self.payout_base()?)[index];
                let request = QuoteRequest::payout(
                    self.m.confidential,
                    self.m.recipients[index],
                    &self.m.data.source_asset,
                    &self.m.data.destination_asset,
                    portion,
                );
                let quote = aurora::check_quote(&request, &value, now)?;
                if quote.amount_in > portion {
                    return Err(SignerError::InvalidInput);
                }
                self.m.data.estimates.truncate(index);
                self.m.data.estimates.push((portion, quote.min_amount_out));
                self.go(if self.is_last_leg(index) {
                    Step::FusionEstimate
                } else {
                    Step::PayoutEstimate { index: index + 1 }
                });
            }
            (Step::FusionEstimate, None) => {
                let end = evm::decimal(text(&value, "auctionEndAmount")?)?;
                if value["liquidity"]["passes"] != json!(true) || end.is_zero() {
                    self.m.paused = Some("TARGET_ILLIQUID".into());
                    return Ok(());
                }
                self.m.data.rate_end = end;
                if self.pooled_sell() && self.m.plan.weights.is_none() {
                    self.choose_returns()?;
                }
                self.go(Step::Review);
            }
            (Step::FundingSubmit, None) => {
                let (hash, _) = self
                    .m
                    .data
                    .signed_operation
                    .clone()
                    .ok_or(SignerError::InvalidInput)?;
                if !text(&value, "userOperationHash")?.eq_ignore_ascii_case(&format!("{hash:#x}")) {
                    return Err(SignerError::InvalidInput);
                }
                self.go(Step::FundingReceipt {
                    polls: 0,
                    resubmitted: false,
                });
                self.wait(now, POLL_MS);
            }
            (Step::FundingSubmit, Some(_)) => {
                self.go(Step::FundingReceipt {
                    polls: 0,
                    resubmitted: false,
                });
                self.wait(now, POLL_MS);
            }
            (Step::FundingReceipt { polls, resubmitted }, None) => {
                if value["found"] == json!(true) {
                    if value["success"] != json!(true) {
                        self.m.paused = Some("FUNDING_REVERTED".into());
                        return Ok(());
                    }
                    self.go(Step::Credit);
                } else if polls >= RESUBMIT_AFTER_POLLS && self.m.resubmits < 3 {
                    // Same signed bytes, same userOpHash: a rebroadcast, never a second signature.
                    self.m.resubmits += 1;
                    self.m.step = Step::FundingSubmit;
                } else {
                    self.m.step = Step::FundingReceipt {
                        polls: polls + 1,
                        resubmitted,
                    };
                }
                self.wait(now, POLL_MS);
            }
            (Step::Credit, None) => match text(&value, "status")? {
                // A pooled sell banks each sale and moves on; payouts start after the last one.
                "SUCCESS" if self.private_sell() => self.go(Step::AuthSalt),
                "SUCCESS" if self.pooled_sell() => {
                    let leg = self.m.data.leg;
                    self.m.data.orders[leg].complete = true;
                    self.after_order(leg);
                }
                "SUCCESS" => self.go(Step::AuthSalt),
                "REFUNDED" | "FAILED" if self.private_sell() => {
                    self.m.paused = Some(format!("SALE_CREDIT_{}", text(&value, "status")?));
                }
                "REFUNDED" | "FAILED" => {
                    self.m.paused = Some(format!("FUNDING_{}", text(&value, "status")?))
                }
                _ => self.wait(now, POLL_MS * 2),
            },
            (Step::AuthSalt, None) => {
                let salt = text(&value, "salt")?.to_string();
                self.go(Step::Authenticate { salt });
            }
            (Step::Authenticate { .. }, None) => {
                self.m.data.access_token = Some(text(&value, "accessToken")?.to_string());
                self.go(if self.private_sell() && self.m.approved_ms.is_none() {
                    Step::PrivateHistoryProbe
                } else if self.private_sell() {
                    Step::PrivateCredit {
                        index: self
                            .m
                            .data
                            .sale_inbounds
                            .len()
                            .checked_sub(1)
                            .ok_or(SignerError::InvalidInput)?,
                    }
                } else {
                    Step::Balances
                });
            }
            (Step::Authenticate { .. }, Some(401)) | (Step::PrivateCredit { .. }, Some(401))
                if self.private_sell() =>
            {
                self.m.data.access_token = None;
                self.go(Step::AuthSalt);
                self.m.paused = Some("PRIVATE_CREDIT_AUTH_REQUIRED".into());
            }
            (Step::Authenticate { .. }, Some(401)) | (Step::Balances, Some(401))
                if self.payout_only() =>
            {
                // Without a confirmed balance there is nothing to split.
                self.m.paused = Some("PRIVATE_BALANCE_UNAVAILABLE".into());
            }
            (Step::Authenticate { .. }, Some(401)) | (Step::Balances, Some(401)) => {
                // Research fallback: a route-confirmed credit uses the quote's guaranteed minimum.
                let minimum = self
                    .m
                    .data
                    .funding_quote
                    .as_ref()
                    .ok_or(SignerError::InvalidInput)?
                    .min_amount_out;
                self.credit(minimum, "route_success_minimum")?;
            }
            (Step::PrivateHistoryProbe, None) => {
                if value
                    .get("items")
                    .and_then(Value::as_array)
                    .is_none_or(|rows| rows.len() > 100 || rows.iter().any(|row| !row.is_object()))
                {
                    return Err(SignerError::InvalidInput);
                }
                self.m.data.access_token = None;
                self.go(Step::Holdings);
            }
            (Step::PrivateCredit { index }, None) => {
                let inbound = self
                    .m
                    .data
                    .sale_inbounds
                    .get(index)
                    .ok_or(SignerError::InvalidInput)?
                    .clone();
                let Some(credited) = self.sale_credit(&inbound, &value, now)? else {
                    self.wait(now, POLL_MS * 2);
                    return Ok(());
                };
                self.m.data.sale_inbounds[index].credited = credited;
                self.m.data.available =
                    self.m
                        .data
                        .sale_inbounds
                        .iter()
                        .try_fold(U256::ZERO, |sum, row| {
                            sum.checked_add(row.credited)
                                .ok_or(SignerError::InvalidInput)
                        })?;
                self.m.data.credit_basis = Some("authenticated_operation_history".into());
                self.m.data.access_token = None;
                if inbound.exhausted {
                    self.m.paused = Some(format!("FUSION_{}_UNFILLED", inbound.order_index + 1));
                } else if inbound.retry {
                    self.go(Step::FusionPreview {
                        index: inbound.order_index,
                    });
                } else {
                    self.m.data.orders[inbound.order_index].complete = true;
                    self.after_order(inbound.order_index);
                }
            }
            (Step::Balances, None) => {
                let available = aurora::private_available(&value, &self.m.data.source_asset)?;
                if !self.payout_only() {
                    self.credit(available, "authenticated_balance")?;
                    return Ok(());
                }
                let available = available.min(U256::from(MAX_SOURCE_ATOMS));
                if available.is_zero() {
                    self.m.paused = Some("NO_PRIVATE_BALANCE".into());
                    return Ok(());
                }
                if self.m.approved_ms.is_none() {
                    self.m.data.available = available;
                    self.m.data.access_token = None;
                    self.go(Step::PayoutEstimate { index: 0 });
                    return Ok(());
                }
                self.credit(available, "authenticated_balance")?;
            }
            (Step::PayoutQuote { index }, None) => {
                let request = self.m.data.payouts[index]
                    .request
                    .clone()
                    .ok_or(SignerError::InvalidInput)?;
                let quote = aurora::check_quote(&request, &value, now)?;
                let portion = self.m.data.payouts[index].portion;
                if quote.amount_in > portion {
                    return Err(SignerError::InvalidInput);
                }
                self.m.data.payouts[index].quote = Some(quote.clone());
                if self.sell() {
                    self.go(Step::PayoutIntent { index });
                    return Ok(());
                }
                let (planned_portion, planned_min) = self
                    .m
                    .data
                    .estimates
                    .get(index)
                    .copied()
                    .ok_or(SignerError::InvalidInput)?;
                let floor = portion * planned_min * U256::from(10_000 - PRICE_TOLERANCE_BPS)
                    / U256::from(10_000);
                if quote.min_amount_out * planned_portion < floor {
                    self.m.reapproval = Some(self.requote_text(&format!(
                        "Payout {} now guarantees at least {} USDG for {} USDC.",
                        index + 1,
                        usdc(quote.min_amount_out),
                        usdc(portion)
                    )));
                    return Ok(());
                }
                self.go(Step::PayoutIntent { index });
            }
            (Step::PayoutIntent { index }, None) => {
                if !self.can_sign(now) {
                    return Ok(());
                }
                let intent = value
                    .get("intent")
                    .cloned()
                    .ok_or(SignerError::InvalidInput)?;
                let quote = self.m.data.payouts[index]
                    .quote
                    .clone()
                    .ok_or(SignerError::InvalidInput)?;
                let payload = text(&intent, "payload")?;
                let token = aurora::private_token_id(payload, &self.m.data.source_asset)?;
                if self
                    .m
                    .data
                    .private_token_id
                    .as_ref()
                    .is_some_and(|t| *t != token)
                {
                    return Err(SignerError::InvalidInput);
                }
                let portion = self.m.data.payouts[index].portion;
                let quoted = quote.amount_in;
                if quoted.is_zero() || quoted > portion {
                    return Err(SignerError::InvalidInput);
                }
                let payload = aurora::check_intent(
                    &intent,
                    self.m.confidential,
                    &quote.deposit_address,
                    &token,
                    portion,
                    now,
                )
                .or_else(|_| {
                    aurora::check_intent(
                        &intent,
                        self.m.confidential,
                        &quote.deposit_address,
                        &token,
                        quoted,
                        now,
                    )
                })?;
                let key = self.key(CONFIDENTIAL_ACCOUNT)?;
                let sig = evm::sign(&key, evm::personal_hash(payload.as_bytes()))?;
                self.m.data.private_token_id = Some(token);
                self.m.data.payouts[index].signed = Some(
                    json!({"standard": "erc191", "payload": payload, "signature": aurora::encode_signature(&sig)}),
                );
                self.go(Step::PayoutSubmit { index });
            }
            (Step::PayoutSubmit { index }, reject) => {
                if reject.is_none() {
                    self.m.data.payouts[index].intent_hash =
                        Some(text(&value, "intentHash")?.to_string());
                }
                if self.sell() && !self.pooled_sell() {
                    self.go(Step::PayoutStatus {
                        index,
                        polls: 0,
                        resubmitted: false,
                    });
                } else {
                    self.go(if self.is_last_leg(index) {
                        Step::PayoutStatus {
                            index: 0,
                            polls: 0,
                            resubmitted: false,
                        }
                    } else {
                        Step::PayoutQuote { index: index + 1 }
                    });
                }
            }
            (
                Step::PayoutStatus {
                    index,
                    polls,
                    resubmitted,
                },
                None,
            ) => match text(&value, "status")? {
                "SUCCESS" => self.go(Step::PayoutBalance { index }),
                "REFUNDED" | "FAILED" => {
                    self.m.paused =
                        Some(format!("PAYOUT_{}_{}", index + 1, text(&value, "status")?))
                }
                "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT"
                    if polls >= RESUBMIT_AFTER_POLLS
                        && (resubmitted || self.m.data.payouts[index].intent_hash.is_none())
                        && self.m.resubmits < 3 =>
                {
                    self.m.resubmits += 1;
                    self.m.step = Step::PayoutSubmit { index };
                }
                _ => {
                    self.m.step = Step::PayoutStatus {
                        index,
                        polls: polls + 1,
                        resubmitted,
                    };
                    self.wait(now, POLL_MS * 2);
                }
            },
            (Step::PayoutBalance { index }, None) => {
                if self.sell() {
                    let usdc_out = rpc_uint(&value, 0)?;
                    let min = self.m.data.payouts[index]
                        .quote
                        .as_ref()
                        .ok_or(SignerError::InvalidInput)?
                        .min_amount_out;
                    if usdc_out < min {
                        self.wait(now, POLL_MS);
                        return Ok(());
                    }
                    self.m.data.payouts[index].delivered = usdc_out;
                    if self.pooled_sell() {
                        self.go(if self.is_last_leg(index) {
                            Step::Done
                        } else {
                            Step::PayoutStatus {
                                index: index + 1,
                                polls: 0,
                                resubmitted: false,
                            }
                        });
                        return Ok(());
                    }
                    self.m.data.orders[index].complete = true;
                    self.m.data.orders[index].received_total = usdc_out;
                    self.after_order(index);
                    return Ok(());
                }
                let usdg = rpc_uint(&value, 0)?;
                let min = self.m.data.payouts[index]
                    .quote
                    .as_ref()
                    .ok_or(SignerError::InvalidInput)?
                    .min_amount_out;
                if usdg < min {
                    self.wait(now, POLL_MS);
                    return Ok(());
                }
                self.m.data.payouts[index].delivered = usdg;
                self.go(if self.is_last_leg(index) {
                    Step::FusionBalance { index: 0 }
                } else {
                    Step::PayoutStatus {
                        index: index + 1,
                        polls: 0,
                        resubmitted: false,
                    }
                });
            }
            (Step::FusionBalance { index }, None) => {
                let (usdg, target, eth) = (
                    rpc_uint(&value, 0)?,
                    rpc_uint(&value, 1)?,
                    rpc_quantity(&value, 2)?,
                );
                if !eth.is_zero() {
                    self.m.paused = Some(format!("RECIPIENT_{}_HOLDS_ETH", index + 1));
                    return Ok(());
                }
                let o = &mut self.m.data.orders[index];
                if usdg.is_zero() {
                    o.complete = true;
                    self.after_order(index);
                    return Ok(());
                }
                o.before_usdg = usdg;
                o.before_target = target;
                o.amount = usdg;
                self.go(Step::FusionPreview { index });
            }
            (Step::FusionPreview { index }, None) => {
                let end = evm::decimal(text(&value, "auctionEndAmount")?)?;
                if value["liquidity"]["passes"] != json!(true) {
                    self.m.paused = Some("TARGET_ILLIQUID".into());
                    return Ok(());
                }
                let min_out = fusion::minimum_out(end);
                let amount = self.m.data.orders[index].amount;
                self.m.data.orders[index].min_out = min_out;
                if self.sell() {
                    if min_out.is_zero() {
                        self.m.paused = Some("TARGET_ILLIQUID".into());
                        return Ok(());
                    }
                    self.m.data.leg = index;
                    self.go(Step::SellQuote { index });
                    return Ok(());
                }
                let floor =
                    amount * self.m.data.rate_end * U256::from(10_000 - PRICE_TOLERANCE_BPS)
                        / U256::from(10_000);
                if min_out * self.m.data.rate_amount < floor {
                    self.m.reapproval = Some(self.requote_text(&format!(
                        "Order {} now returns at least {} {} for {} USDG.",
                        index + 1,
                        units(min_out, self.m.data.target_decimals),
                        self.m.data.target_symbol,
                        usdc(amount)
                    )));
                    return Ok(());
                }
                self.go(Step::FusionPermit { index });
            }
            (Step::SellQuote { index }, None) => {
                // A state saved before the request moved to the order still has it on the payout.
                let request = self.m.data.orders[index]
                    .inbound_request
                    .clone()
                    .or_else(|| {
                        self.m
                            .data
                            .payouts
                            .get(index)
                            .and_then(|p| p.request.clone())
                    })
                    .ok_or(SignerError::InvalidInput)?;
                let quote = aurora::check_quote(&request, &value, now)?;
                let expected = self.m.data.orders[index].min_out;
                if quote.amount_in > expected {
                    return Err(SignerError::InvalidInput);
                }
                self.m.data.orders[index].inbound = Some(quote.clone());
                self.m.data.funding_quote = Some(quote);
                self.go(Step::FusionPermit { index });
            }
            (Step::FusionPermit { index }, None) => {
                if !self.can_sign(now) {
                    return Ok(());
                }
                let deadline = now / 1000 + PERMIT_LIFETIME_SECS;
                let permit = Permit {
                    name: text(&value, "name")?.to_string(),
                    version: text(&value, "version")?.to_string(),
                    token: if self.sell() {
                        self.m.plan.target
                    } else {
                        ROBINHOOD_USDG
                    },
                    owner: self.holder(index),
                    value: self.m.data.orders[index].amount,
                    nonce: evm::decimal(text(&value, "nonce")?)?,
                    deadline,
                };
                let key = self.key(self.signer_index(index))?;
                let sig = evm::sign(&key, permit.digest()?)?;
                let o = &mut self.m.data.orders[index];
                o.permit = Some(alloy_primitives::hex::encode_prefixed(permit.encode(&sig)));
                o.permit_deadline = deadline;
                self.go(Step::FusionOrder { index });
            }
            (Step::FusionOrder { index }, None) => {
                let order: LimitOrder = serde_json::from_value(value["order"].clone())
                    .map_err(|_| SignerError::InvalidInput)?;
                let extension = text(&value, "extension")?.to_string();
                let o = self.m.data.orders[index].clone();
                let deposit = if self.sell() {
                    self.sale_receiver(index)?
                } else {
                    Address::ZERO
                };
                let approved = ApprovedOrder {
                    maker: self.holder(index),
                    target: if self.sell() {
                        ROBINHOOD_USDG
                    } else {
                        self.m.plan.target
                    },
                    amount: o.amount,
                    min_out: o.min_out,
                    permit: evm::hex_bytes(o.permit.as_deref().ok_or(SignerError::InvalidInput)?)?,
                    permit_deadline: o.permit_deadline,
                    maker_asset: if self.sell() {
                        self.m.plan.target
                    } else {
                        ROBINHOOD_USDG
                    },
                    receiver: deposit,
                };
                let checked =
                    match fusion::check_order_detail(&order, &extension, &approved, now / 1000) {
                        Ok(checked) => checked,
                        // Nothing is signed yet: a price move below the minimum, or a permit too close to
                        // its deadline after a pause, earns a fresh preview and permit.
                        Err(fusion::OrderReject::BelowMinimum | fusion::OrderReject::Expiry)
                            if self.m.data.orders[index].requotes < MAX_ORDER_REQUOTES =>
                        {
                            self.m.data.orders[index].requotes += 1;
                            self.go(Step::FusionPreview { index });
                            return Ok(());
                        }
                        Err(reason) => {
                            self.m.paused =
                                Some(format!("FUSION_{}_ORDER_{}", index + 1, reason.code()));
                            return Ok(());
                        }
                    };
                if !text(&value, "orderHash")?.eq_ignore_ascii_case(&format!("{:#x}", checked.hash))
                {
                    self.m.paused = Some(format!("FUSION_{}_ORDER_HASH", index + 1));
                    return Ok(());
                }
                let o = &mut self.m.data.orders[index];
                o.order = Some(order);
                o.extension = Some(extension);
                o.quote_id = Some(text(&value, "quoteId")?.to_string());
                o.order_hash = Some(checked.hash);
                o.expiration = checked.expiration;
                o.fills.clear();
                self.go(Step::FusionSign { index });
            }
            (Step::FusionSubmit { index }, _) => {
                self.go(Step::FusionStatus { index });
                self.wait(now, POLL_MS);
            }
            (Step::FusionStatus { index }, None) => {
                let status = text(&value, "status")?.to_string();
                let fills = value
                    .get("fills")
                    .and_then(Value::as_array)
                    .ok_or(SignerError::InvalidInput)?;
                self.m.data.orders[index].fills = fills
                    .iter()
                    .map(|f| {
                        Ok((
                            text(f, "txHash")?.to_string(),
                            evm::decimal(text(f, "filledMakerAmount")?)?,
                        ))
                    })
                    .collect::<Result<_, SignerError>>()?;
                match status.as_str() {
                    "filled" => self.go(Step::FusionReceipts { index }),
                    "expired" | "cancelled" | "not-accepted" | "not_accepted" => {
                        self.go(Step::FusionReceipts { index })
                    }
                    _ if now / 1000 > self.m.data.orders[index].expiration + 60 => {
                        self.go(Step::FusionReceipts { index })
                    }
                    _ => self.wait(now, POLL_MS),
                }
            }
            (Step::FusionStatus { index }, Some(404)) => {
                if now / 1000 > self.m.data.orders[index].expiration + 60 {
                    self.go(Step::FusionReceipts { index });
                } else {
                    self.wait(now, POLL_MS);
                }
            }
            (Step::FusionReceipts { index }, None) => {
                let maker = self.holder(index);
                let dest = if self.sell() {
                    self.sale_receiver(index)?
                } else {
                    maker
                };
                let from_token = if self.sell() {
                    self.m.plan.target
                } else {
                    ROBINHOOD_USDG
                };
                let to_token = if self.sell() {
                    ROBINHOOD_USDG
                } else {
                    self.m.plan.target
                };
                let topic = keccak256("Transfer(address,address,uint256)");
                let mut swapped = U256::ZERO;
                let mut received = U256::ZERO;
                let mut seen = std::collections::HashSet::new();
                for i in 0..self.m.data.orders[index].fills.len() {
                    let expected_hash: B256 = self.m.data.orders[index].fills[i]
                        .0
                        .parse()
                        .map_err(|_| SignerError::InvalidInput)?;
                    if self.private_sell()
                        && (expected_hash.is_zero() || !seen.insert(expected_hash))
                    {
                        return Err(SignerError::InvalidInput);
                    }
                    let receipt = rpc_result(&value, i as u64)?;
                    if receipt.get("status").and_then(Value::as_str) != Some("0x1") {
                        self.m.paused = Some(format!("FUSION_{}_FILL_REVERTED", index + 1));
                        return Ok(());
                    }
                    if self.private_sell()
                        && (text(receipt, "transactionHash")?.parse::<B256>().ok()
                            != Some(expected_hash)
                            || text(receipt, "blockHash")?
                                .parse::<B256>()
                                .ok()
                                .is_none_or(|h| h.is_zero())
                            || evm::quantity(text(receipt, "blockNumber")?)?.is_zero())
                    {
                        return Err(SignerError::InvalidInput);
                    }
                    let before_swapped = swapped;
                    let before_received = received;
                    for log in receipt
                        .get("logs")
                        .and_then(Value::as_array)
                        .ok_or(SignerError::InvalidInput)?
                    {
                        let topics: Vec<B256> = log
                            .get("topics")
                            .and_then(Value::as_array)
                            .ok_or(SignerError::InvalidInput)?
                            .iter()
                            .filter_map(|t| t.as_str()?.parse().ok())
                            .collect();
                        if topics.len() != 3 || topics[0] != topic {
                            continue;
                        }
                        let emitter = evm::addr(text(log, "address")?)?;
                        let amount = U256::from_be_slice(&evm::hex_bytes(text(log, "data")?)?);
                        let from = Address::from_slice(&topics[1][12..]);
                        let to = Address::from_slice(&topics[2][12..]);
                        if emitter == from_token && from == maker {
                            swapped += amount;
                        }
                        if emitter == to_token && to == dest {
                            received += amount;
                        }
                    }
                    if self.private_sell()
                        && (swapped - before_swapped != self.m.data.orders[index].fills[i].1
                            || received == before_received)
                    {
                        return Err(SignerError::InvalidInput);
                    }
                }
                let filled = self.m.data.orders[index]
                    .fills
                    .iter()
                    .fold(U256::ZERO, |sum, (_, v)| sum + *v);
                if swapped != filled {
                    self.m.paused = Some(format!("FUSION_{}_UNRECONCILED", index + 1));
                    return Ok(());
                }
                let o = &mut self.m.data.orders[index];
                o.swapped = swapped;
                o.received = received;
                self.go(Step::FusionAfter { index });
            }
            (Step::FusionAfter { index }, None) => {
                let (usdg, target, eth) = (
                    rpc_uint(&value, 0)?,
                    rpc_uint(&value, 1)?,
                    rpc_quantity(&value, 2)?,
                );
                let o = self.m.data.orders[index].clone();
                if self.sell() {
                    let filled_all = o.swapped == o.amount;
                    if !eth.is_zero()
                        || target.checked_add(o.swapped) != Some(o.before_target)
                        || (if self.private_sell() {
                            o.swapped.is_zero()
                                || o.received
                                    .checked_mul(o.amount)
                                    .ok_or(SignerError::InvalidInput)?
                                    < o.min_out
                                        .checked_mul(o.swapped)
                                        .ok_or(SignerError::InvalidInput)?
                        } else {
                            o.received < o.min_out
                        })
                    {
                        self.m.paused = Some(format!("FUSION_{}_UNRECONCILED", index + 1));
                        return Ok(());
                    }
                    if self.private_sell() {
                        let quote = o.inbound.clone().ok_or(SignerError::InvalidInput)?;
                        let request = o.inbound_request.clone().ok_or(SignerError::InvalidInput)?;
                        let transaction_hashes = o
                            .fills
                            .iter()
                            .map(|(hash, _)| {
                                hash.parse::<B256>().map_err(|_| SignerError::InvalidInput)
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        if self.m.data.sale_inbounds.iter().any(|row| {
                            row.quote
                                .deposit_address
                                .eq_ignore_ascii_case(&quote.deposit_address)
                                || row
                                    .transaction_hashes
                                    .iter()
                                    .any(|hash| transaction_hashes.contains(hash))
                        }) {
                            return Err(SignerError::InvalidInput);
                        }
                        self.m.data.sale_inbounds.push(SaleInbound {
                            order_index: index,
                            request,
                            quote: quote.clone(),
                            input: o.received,
                            transaction_hashes,
                            quoted_ms: o.inbound_quoted_ms,
                            retry: !filled_all,
                            exhausted: !filled_all && o.attempts + 1 >= MAX_FUSION_ATTEMPTS,
                            credited: U256::ZERO,
                        });
                        let row = &mut self.m.data.orders[index];
                        row.received_total = row
                            .received_total
                            .checked_add(o.received)
                            .ok_or(SignerError::InvalidInput)?;
                        row.sold_total = row
                            .sold_total
                            .checked_add(o.swapped)
                            .ok_or(SignerError::InvalidInput)?;
                        if !filled_all {
                            row.attempts += 1;
                            row.amount = target;
                            row.before_target = target;
                        }
                        self.m.data.funding_quote = Some(quote);
                        self.m.data.leg = index;
                        self.go(Step::Credit);
                        return Ok(());
                    }
                    if !filled_all {
                        if o.attempts + 1 >= MAX_FUSION_ATTEMPTS {
                            self.m.paused = Some(format!("FUSION_{}_UNFILLED", index + 1));
                        } else {
                            self.m.data.orders[index].attempts += 1;
                            self.m.data.orders[index].amount = target;
                            self.m.data.orders[index].before_target = target;
                            self.go(Step::FusionPreview { index });
                        }
                        return Ok(());
                    }
                    let inbound = o.inbound.clone().ok_or(SignerError::InvalidInput)?;
                    self.m.data.funding_quote = Some(inbound);
                    self.m.data.orders[index].received_total += o.received;
                    self.m.data.leg = index;
                    self.go(Step::Credit);
                    return Ok(());
                }
                let filled_all = o.swapped == o.amount;
                if !eth.is_zero()
                    || o.before_usdg.checked_sub(o.swapped) != Some(usdg)
                    || target < o.before_target
                    || target - o.before_target != o.received
                    || (filled_all && o.received < o.min_out)
                {
                    self.m.paused = Some(format!("FUSION_{}_UNRECONCILED", index + 1));
                    return Ok(());
                }
                let order = &mut self.m.data.orders[index];
                order.received_total += o.received;
                if usdg.is_zero() {
                    order.complete = true;
                    self.after_order(index);
                } else if order.attempts + 1 >= MAX_FUSION_ATTEMPTS {
                    self.m.paused = Some(format!("FUSION_{}_UNFILLED", index + 1));
                } else {
                    order.attempts += 1;
                    self.go(Step::FusionBalance { index });
                }
            }
            (
                Step::Assets | Step::TargetChain | Step::SourceChain { .. } | Step::Holdings,
                Some(_),
            ) => self.m.paused = Some("PLANNING_UNAVAILABLE".into()),
            (Step::FundingProbe | Step::FundingPrepare { .. }, Some(_)) => {
                self.m.paused = Some(
                    provider_code(&value)
                        .unwrap_or("FUNDING_UNAVAILABLE")
                        .into(),
                )
            }
            // Fusion refuses very small orders and Aurora's bridge refuses very small deposits.
            // A sale skips such a wallet before anything is signed, so one leftover cent never
            // traps the rest of a holder group.
            (Step::FusionPreview { index } | Step::SellQuote { index }, Some(_))
                if self.sell() && is_dust_rejection(&value) =>
            {
                self.skip_leg(index)
            }
            (
                Step::FundingQuote { .. }
                | Step::PayoutEstimate { .. }
                | Step::PayoutQuote { .. }
                | Step::SellQuote { .. },
                Some(_),
            ) => self.m.paused = Some("QUOTE_REJECTED".into()),
            (Step::FusionEstimate, Some(_)) if self.sell() && is_dust_rejection(&value) => {
                if let Some(i) = self.next_sell_index(0) {
                    self.m.data.orders[i].dust = true;
                }
                if self.next_sell_index(0).is_some() {
                    self.go(Step::FusionEstimate);
                } else {
                    self.m.paused = Some("NOTHING_SELLABLE".into());
                }
            }
            (
                Step::FusionEstimate
                | Step::FusionPreview { .. }
                | Step::FusionOrder { .. }
                | Step::FusionPermit { .. },
                Some(_),
            ) => self.m.paused = Some("FUSION_UNAVAILABLE".into()),
            (_, Some(code)) => self.m.paused = Some(format!("PROVIDER_{code}")),
            _ => return Err(SignerError::InvalidInput),
        }
        Ok(())
    }

    fn sale_credit(
        &self,
        inbound: &SaleInbound,
        value: &Value,
        now: u64,
    ) -> Result<Option<U256>, SignerError> {
        let items = value
            .get("items")
            .and_then(Value::as_array)
            .filter(|rows| rows.len() <= 100)
            .ok_or(SignerError::InvalidInput)?;
        let matches = items
            .iter()
            .filter(|row| {
                row.get("depositAddress")
                    .and_then(Value::as_str)
                    .is_some_and(|address| {
                        address.eq_ignore_ascii_case(&inbound.quote.deposit_address)
                    })
            })
            .collect::<Vec<_>>();
        let row = match matches.as_slice() {
            [] => return Ok(None),
            [row] => *row,
            _ => return Err(SignerError::InvalidInput),
        };
        let same = |name: &str, expected: &str| {
            text(row, name)
                .map(|v| v.eq_ignore_ascii_case(expected))
                .unwrap_or(false)
        };
        if !same("status", "SUCCESS")
            || !same("depositType", "ORIGIN_CHAIN")
            || !same("recipientType", "CONFIDENTIAL_INTENTS")
            || !same("refundType", "ORIGIN_CHAIN")
            || !same("originAsset", &inbound.request.origin_asset)
            || !same("destinationAsset", &self.m.data.source_asset)
            || !same("recipient", &format!("{:#x}", self.m.confidential))
            || !same("refundTo", &inbound.request.refund_to)
            || row.get("depositMemo").is_some_and(|v| !v.is_null())
            || inbound.quote.deposit_memo.is_some()
        {
            return Err(SignerError::InvalidInput);
        }
        let created = aurora::iso_millis(text(row, "createdAt")?)?;
        if inbound.quoted_ms < self.m.created_ms
            || created.saturating_add(5_000) < inbound.quoted_ms
            || created > now.saturating_add(5_000)
            || created > inbound.quote.deadline_ms
        {
            return Err(SignerError::InvalidInput);
        }
        let formatted = |name: &str| -> Result<U256, SignerError> {
            let value = text(row, name)?;
            let parts = value.split('.').collect::<Vec<_>>();
            if parts.is_empty()
                || parts.len() > 2
                || parts[0].is_empty()
                || !parts[0].bytes().all(|c| c.is_ascii_digit())
                || (parts[0].len() > 1 && parts[0].starts_with('0'))
            {
                return Err(SignerError::InvalidInput);
            }
            let fraction = parts.get(1).copied().unwrap_or("");
            if fraction.len() > 6
                || !fraction.bytes().all(|c| c.is_ascii_digit())
                || (parts.len() == 2 && fraction.is_empty())
            {
                return Err(SignerError::InvalidInput);
            }
            let atoms = format!("{}{}{}", parts[0], fraction, "0".repeat(6 - fraction.len()));
            let canonical = atoms.trim_start_matches('0');
            evm::decimal(if canonical.is_empty() { "0" } else { canonical })
        };
        let input = formatted("amountInFormatted")?;
        let output = formatted("amountOutFormatted")?;
        let minimum = inbound
            .quote
            .min_amount_out
            .checked_mul(inbound.input)
            .ok_or(SignerError::InvalidInput)?
            .div_ceil(inbound.quote.amount_in);
        if input != inbound.input
            || output.is_zero()
            || output < minimum
            || output > U256::from(MAX_SOURCE_ATOMS)
        {
            return Err(SignerError::InvalidInput);
        }
        let transactions = row
            .get("quoteTransactions")
            .and_then(Value::as_array)
            .filter(|rows| rows.len() == inbound.transaction_hashes.len())
            .ok_or(SignerError::InvalidInput)?;
        let mut seen = std::collections::HashSet::new();
        for tx in transactions {
            let hash = text(tx, "txHash")?
                .parse::<B256>()
                .map_err(|_| SignerError::InvalidInput)?;
            if hash.is_zero()
                || !seen.insert(hash)
                || !inbound.transaction_hashes.contains(&hash)
                || evm::addr(text(tx, "sender")?)?.is_zero()
            {
                return Err(SignerError::InvalidInput);
            }
        }
        Ok(Some(output))
    }

    fn credit(&mut self, available: U256, basis: &str) -> Result<(), SignerError> {
        if available.is_zero() || available > U256::from(MAX_SOURCE_ATOMS) {
            return Err(SignerError::InvalidInput);
        }
        self.m.data.available = available;
        self.m.data.credit_basis = Some(basis.into());
        self.m.data.access_token = None;
        self.go(Step::PayoutQuote {
            index: if self.sell() && !self.pooled_sell() {
                self.m.data.leg
            } else {
                0
            },
        });
        Ok(())
    }

    /// Pooled sell: size the payouts from the priced sale, as a buy does from its budget, and drop
    /// the reserved return wallets that are not needed. Runs once, before review.
    fn choose_returns(&mut self) -> Result<(), SignerError> {
        let d = &self.m.data;
        let tokens = (0..self.sales())
            .filter(|i| !d.orders[*i].dust)
            .fold(U256::ZERO, |sum, i| sum + d.orders[i].amount);
        let estimate = if d.rate_amount.is_zero() {
            U256::ZERO
        } else {
            fusion::minimum_out(d.rate_end) * tokens / d.rate_amount
        };
        let random = alloy_primitives::hex::decode(
            self.m
                .plan
                .legs_random
                .as_deref()
                .ok_or(SignerError::InvalidInput)?,
        )
        .map_err(|_| SignerError::InvalidInput)?;
        let budget: u64 = estimate.min(U256::from(u64::MAX)).to();
        let choice = super::legs::choose_for_budget(budget, &random, self.legs() as u32)?;
        let count = choice.count as usize;
        self.m.data.sale_estimate = estimate;
        self.m.plan.recipient_indices.truncate(count);
        self.m.recipients.truncate(count);
        self.m.data.payouts.truncate(count);
        self.m.plan.weights = Some(choice.weights);
        Ok(())
    }

    /// Leaves a wallet that is too small to sell and goes on with the others. When nothing at all
    /// sold, stops with a clear reason instead of reporting an empty sale as complete.
    fn skip_leg(&mut self, index: usize) {
        self.m.data.orders[index].dust = true;
        if self.next_sell_index(index + 1).is_none()
            && !self.m.data.orders.iter().any(|o| o.complete)
        {
            self.m.paused = Some("NOTHING_SELLABLE".into());
            return;
        }
        self.after_order(index);
    }

    fn after_order(&mut self, index: usize) {
        if self.sell() {
            match self.next_sell_index(index + 1) {
                Some(next) => self.go(Step::FusionPreview { index: next }),
                // Every sale is banked in C: read the pooled balance and pay it out.
                None if self.pooled_sell() && !self.private_sell() => self.go(Step::AuthSalt),
                None => self.go(Step::Done),
            }
        } else {
            self.go(if self.is_last_leg(index) {
                Step::Done
            } else {
                Step::FusionBalance { index: index + 1 }
            });
        }
    }

    fn lost_submit(&mut self) {
        self.m.step = match self.m.step.clone() {
            Step::FundingSubmit => Step::FundingReceipt {
                polls: 0,
                resubmitted: true,
            },
            Step::PayoutSubmit { index } => Step::PayoutStatus {
                index,
                polls: 0,
                resubmitted: true,
            },
            Step::FusionSubmit { index } => Step::FusionStatus { index },
            other => other,
        };
    }

    fn requote_text(&self, change: &str) -> String {
        format!(
            "QUOTE CHANGED OUTSIDE THE APPROVED LIMITS\n\n{change}\n\nApprove to continue with this quote, or cancel. Funds already moved stay where they are: see Swap status."
        )
    }

    fn review(&self) -> String {
        if self.pooled_sell() {
            return self.review_pooled_sell();
        }
        if self.sell() {
            return self.review_sell();
        }
        if self.recovery() {
            return self.review_recovery();
        }
        let d = &self.m.data;
        let q = d.funding_quote.as_ref();
        let mut out = if self.payout_only() {
            format!(
                "CONFIDENTIAL BUY FROM PRIVATE BALANCE · MAINNET\nConfidential balance → Robinhood USDG → {sym}\nNothing is sent from Monad: this spends USDC that C already holds.\n\nTarget {sym} ({dec} decimals)\nContract {target}\n\nConfidential balance C {c}\nUsed now {available} USDC (up to 10 USDC per operation)\n",
                sym = d.target_symbol,
                dec = d.target_decimals,
                target = self.m.plan.target.to_checksum(None),
                c = self.m.confidential.to_checksum(None),
                available = usdc(d.available),
            )
        } else {
            format!(
                "CONFIDENTIAL SWAP · MAINNET\nMonad USDC → confidential balance → Robinhood USDG → {sym}\n\nTarget {sym} ({dec} decimals)\nContract {target}\n\nFunding wallet F {f}\nF USDC balance {bal}\nUsed now {amount} USDC + gas at most {fee} USDC (paid in USDC)\nConfidential balance C {c}\nExpected private credit {out} USDC (at least {min})\n",
                sym = d.target_symbol,
                dec = d.target_decimals,
                target = self.m.plan.target.to_checksum(None),
                f = self.m.source.to_checksum(None),
                bal = usdc(d.source_balance),
                amount = usdc(d.funding_amount),
                fee = usdc(d.funding_fee),
                c = self.m.confidential.to_checksum(None),
                out = q.map(|q| usdc(q.amount_out)).unwrap_or_default(),
                min = q.map(|q| usdc(q.min_amount_out)).unwrap_or_default(),
            )
        };
        if d.funding_review_changed {
            out.insert_str(0, "FUNDING ECONOMICS CHANGED\nReview the current gas maximum, principal and minimum private credit before approving.\n\n");
        }
        for (i, (portion, min)) in d.estimates.iter().enumerate() {
            out.push_str(&format!("\nPayout {} of {} ({}) to fresh wallet A{} {}\n  {} USDC → at least {} USDG, then sold for {} via 1inch Fusion\n", i + 1, self.legs(), percent_split(&leg_weights(&self.m.plan)), i + 1, self.m.recipients[i].to_checksum(None), usdc(*portion), usdc(*min), d.target_symbol));
        }
        out.push_str(&format!(
            "\nFusion limit: at least {} {} per {} USDG, 1% slippage, prices may move up to 3% before the app asks again.\n\nPRIVACY: F's deposit and the Ai stock balances are public on chain. One app gateway key and the timing of these steps can let the gateway operator link F with A1–A{legs}.\n\nOne approval authorizes up to {signatures} signatures for 15 minutes, bound to these limits. After 15 minutes you unlock again for this same plan. The operation expires in 24 hours. Steps are sequential and cannot be undone once submitted.",
            units(fusion::minimum_out(d.rate_end), d.target_decimals),
            d.target_symbol,
            usdc(d.rate_amount),
            legs = self.legs(),
            // Funding, private-balance proof, then a payout intent, permit and order per wallet.
            signatures = 3 * self.legs() + 3,
        ));
        out
    }

    fn review_recovery(&self) -> String {
        let d = &self.m.data;
        let mut out = format!(
            "FINISH UNFINISHED BUYS · MAINNET\nRobinhood USDG already in your wallets → {sym} via 1inch Fusion\nNothing is sent from Monad or from the confidential balance.\n\nTarget {sym} ({dec} decimals)\nContract {target}\n",
            sym = d.target_symbol,
            dec = d.target_decimals,
            target = self.m.plan.target.to_checksum(None),
        );
        for (slot, o) in d
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| !o.amount.is_zero())
        {
            out.push_str(&format!(
                "\nWallet {}\n  {} USDG → {}\n",
                self.m.recipients[slot].to_checksum(None),
                usdc(o.amount),
                d.target_symbol
            ));
        }
        out.push_str(&format!(
            "\nFusion limit: at least {} {} per {} USDG, 1% slippage, prices may move up to 3% before the app asks again.\n\nPRIVACY: These wallets and their stock balances are public on chain.\n\nOne approval authorizes a permit and an order per wallet for 15 minutes. After 15 minutes you unlock again for this same plan. Steps cannot be undone once submitted.",
            units(fusion::minimum_out(d.rate_end), d.target_decimals),
            d.target_symbol,
            usdc(d.rate_amount),
        ));
        out
    }

    /// Wallets Fusion already refused as too small, so the user sees what stays behind.
    fn skipped_note(&self) -> String {
        let d = &self.m.data;
        let skipped: Vec<String> = (0..self.sales())
            .filter(|i| d.orders[*i].dust)
            .map(|i| {
                format!(
                    "  {} ({} {})\n",
                    self.m.holders[i].to_checksum(None),
                    units(d.orders[i].amount, d.target_decimals),
                    d.target_symbol
                )
            })
            .collect();
        if skipped.is_empty() {
            String::new()
        } else {
            format!(
                "\nTOO SMALL TO SELL, LEFT IN PLACE (Fusion refuses orders this small):\n{}",
                skipped.concat()
            )
        }
    }

    fn review_pooled_sell(&self) -> String {
        let d = &self.m.data;
        let active: Vec<usize> = (0..self.sales())
            .filter(|i| !d.orders[*i].amount.is_zero() && !d.orders[*i].dust)
            .collect();
        let mut out = format!(
            "CONFIDENTIAL SELL · MAINNET\n{sym} → USDG (Fusion) → confidential balance → {count} new Monad USDC wallets\n\nSelling {sym} ({dec} decimals)\nContract {target}\nConfidential balance C {c}\n",
            sym = d.target_symbol,
            dec = d.target_decimals,
            target = self.m.plan.target.to_checksum(None),
            c = self.m.confidential.to_checksum(None),
            count = count_word(self.legs()),
        );
        for i in &active {
            out.push_str(&format!(
                "\nWallet {holder}\n  {amount} {sym} sells for USDG into the confidential balance\n",
                holder = self.m.holders[*i].to_checksum(None),
                amount = units(d.orders[*i].amount, d.target_decimals),
                sym = d.target_symbol,
            ));
        }
        out.push_str(&format!(
            "\nAll sales are pooled in C, then paid out as Monad USDC.\nExpected about {} USDC in total, before payout fees.\n",
            usdc(d.sale_estimate)
        ));
        let split = percent_split(&leg_weights(&self.m.plan));
        for (i, share) in self.portions(d.sale_estimate).iter().enumerate() {
            out.push_str(&format!(
                "\nPayout {} of {} ({}) to fresh wallet R{} {}\n  about {} USDC on Monad\n",
                i + 1,
                self.legs(),
                split,
                i + 1,
                self.m.recipients[i].to_checksum(None),
                usdc(*share),
            ));
        }
        out.push_str(&self.skipped_note());
        out.push_str(&format!("\nPRIVACY: The old Ai stock wallets stay public. Proceeds are pooled and split across {} fresh wallets that are never reused, so a sale cannot be matched to one payout. One app gateway key can still time-link the steps.\n\nOne approval authorizes the Fusion permits, orders and confidential payouts for 15 minutes. After 15 minutes you unlock again for this same plan. The operation expires in 24 hours. Steps cannot be undone once submitted.", count_word(self.legs())));
        out
    }

    fn review_sell(&self) -> String {
        if self.private_sell() {
            let d = &self.m.data;
            let mut out = format!(
                "CONFIDENTIAL SELL · MAINNET\n{} → USDG (Fusion) → stop at verified private USDC credit\nConfidential account {}\nNo public receiving wallets or public payouts are created.\n",
                d.target_symbol,
                self.m.confidential.to_checksum(None)
            );
            for i in 0..self.sales() {
                if !d.orders[i].amount.is_zero() && !d.orders[i].dust {
                    out.push_str(&format!(
                        "\nSell {} {} from {}\n",
                        units(d.orders[i].amount, d.target_decimals),
                        d.target_symbol,
                        self.holder(i).to_checksum(None)
                    ));
                }
            }
            out.push_str(&self.skipped_note());
            out.push_str("\nEach inbound credit requires authenticated operation history matching the verified Fusion transfers. Private USDC remains in Gizu until you separately choose Withdraw from Gizu. One approval covers these sale steps for 15 minutes; submitted steps cannot be undone.");
            return out;
        }
        let d = &self.m.data;
        // A holder group may include wallets with nothing to sell; only real legs are shown.
        let active: Vec<usize> = (0..self.sales())
            .filter(|i| !d.orders[*i].amount.is_zero() && !d.orders[*i].dust)
            .collect();
        let mut out = format!(
            "CONFIDENTIAL SELL · MAINNET\n{sym} → USDG (Fusion) → confidential balance → {count} new Monad USDC wallets\n\nSelling {sym} ({dec} decimals)\nContract {target}\nConfidential balance C {c}\n",
            sym = d.target_symbol,
            dec = d.target_decimals,
            target = self.m.plan.target.to_checksum(None),
            c = self.m.confidential.to_checksum(None),
            count = count_word(active.len()),
        );
        for (shown, i) in active.iter().enumerate() {
            out.push_str(&format!(
                "\nLeg {} of {}\n  Hold {sym} in {holder}\n  {amount} {sym} sells for USDG into Aurora, then pays Monad USDC to new wallet {ret}\n",
                shown + 1,
                active.len(),
                sym = d.target_symbol,
                holder = self.m.holders[*i].to_checksum(None),
                amount = units(d.orders[*i].amount, d.target_decimals),
                ret = self.m.recipients[*i].to_checksum(None),
            ));
        }
        out.push_str(&self.skipped_note());
        out.push_str(&format!("\nPRIVACY: The old Ai stock wallets stay public. Proceeds go to {} fresh indices that are never reused. One app gateway key can still time-link the legs.\n\nOne approval authorizes the Fusion permits, orders and confidential payouts for 15 minutes. After 15 minutes you unlock again for this same plan. The operation expires in 24 hours. Steps cannot be undone once submitted.", count_word(active.len())));
        out
    }

    fn public_status(&self) -> Value {
        let d = &self.m.data;
        let phase = if self.m.cancelled {
            "CANCELLED"
        } else if self.m.paused.is_some() {
            "PAUSED"
        } else if self.m.reapproval.is_some() {
            "REVIEW"
        } else {
            match self.m.step {
                Step::Assets
                | Step::PrivateHistoryProbe
                | Step::SourceChain { execute: false }
                | Step::TargetChain
                | Step::Holdings
                | Step::RecoveryScan
                | Step::FundingProbe
                | Step::PayoutEstimate { .. }
                | Step::FusionEstimate => "PLANNING",
                Step::FundingQuote { .. } | Step::FundingPrepare { .. }
                    if self.m.approved_ms.is_none() =>
                {
                    "PLANNING"
                }
                Step::Review if self.m.approved_ms.is_none() => "REVIEW",
                Step::Review
                | Step::SourceChain { .. }
                | Step::FundingQuote { .. }
                | Step::FundingPrepare { .. }
                | Step::FundingSign
                | Step::FundingSubmit
                | Step::FundingReceipt { .. } => "FUNDING",
                Step::AuthSalt | Step::Authenticate { .. } | Step::Balances
                    if self.m.approved_ms.is_none() =>
                {
                    "PLANNING"
                }
                // `Credit` still waits for Aurora; the balance is credited once it succeeds.
                Step::Credit => "FUNDING",
                Step::AuthSalt | Step::Authenticate { .. } | Step::Balances => "CREDITED",
                Step::PayoutQuote { .. }
                | Step::PayoutIntent { .. }
                | Step::PayoutSubmit { .. }
                | Step::PayoutStatus { .. }
                | Step::PayoutBalance { .. } => "PAYOUTS",
                Step::Done => "COMPLETE",
                _ => "FUSION",
            }
        };
        json!({
            "operationId": self.m.id,
            "phase": phase,
            "step": step_name(&self.m.step),
            "pausedCode": self.m.paused,
            "targetSymbol": d.target_symbol,
            "targetDecimals": d.target_decimals,
            "sourceAtoms": d.funding_amount.to_string(),
            "creditedAtoms": d.available.to_string(),
            "payoutsSubmitted": d.payouts.iter().filter(|p| p.signed.is_some()).count(),
            "ordersComplete": d.orders.iter().filter(|o| o.complete).count(),
            "receivedTargetAtoms": d.orders.iter().fold(U256::ZERO, |sum, o| sum + o.received_total).to_string(),
            "direction": if self.sell() { "sell" } else { "buy" },
            "kind": self.m.plan.kind,
            "completionTarget": if self.private_sell() { "confidential" } else { "public" },
            "privateCreditedAtoms": if self.private_sell() { d.available.to_string() } else { "0".into() },
            "soldAtoms": d.orders.iter().fold(U256::ZERO, |sum, row| sum + row.sold_total).to_string(),
            "receivedUsdgAtoms": if self.sell() { d.orders.iter().fold(U256::ZERO, |sum, row| sum + row.received_total).to_string() } else { "0".into() },
            "legs": if self.private_sell() { 0 } else { self.legs() },
            "holders": self.sales(),
            // After approval funds may be in flight: the UI must pause, never cancel, on leave.
            "approved": self.m.approved_ms.is_some(),
            "authorizationUntilMs": self.m.session_until_ms,
            "expiresAtMs": self.m.created_ms + OPERATION_MS,
        })
    }
}

fn status_body(quote: &Quote) -> Value {
    match &quote.deposit_memo {
        Some(memo) => json!({"depositAddress": quote.deposit_address, "depositMemo": memo}),
        None => json!({"depositAddress": quote.deposit_address}),
    }
}

fn step_name(step: &Step) -> String {
    serde_json::to_value(step)
        .ok()
        .and_then(|v| v.get("step").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

#[derive(uniffi::Object)]
pub struct SwapOperation {
    inner: Mutex<Engine>,
}

#[uniffi::export]
impl SwapOperation {
    /// `plan` is buy `{"kind":"confidentialSwap",...}`, sell `{"kind":"confidentialSell","holderIndices":[…],…}`,
    /// or a buy from C's existing private balance `{"kind":"confidentialPayout",...}` (no amount, no Monad funding).
    #[uniffi::constructor]
    pub fn start(
        plan: String,
        entropy: Vec<u8>,
        gateway: String,
        now_ms: u64,
    ) -> Result<Arc<Self>, SignerError> {
        let plan_bytes = plan.len();
        if plan_bytes > 131_072 {
            return Err(SignerError::InvalidInput);
        }
        let plan: Plan = serde_json::from_str(&plan).map_err(|_| SignerError::InvalidInput)?;
        crate::roles::validate_public_source_index(plan.source_index)?;
        if plan.recipient_indices.contains(&plan.source_index) {
            return Err(SignerError::InvalidInput);
        }
        let legs = plan.recipient_indices.len();
        let private_sell = plan.kind == "confidentialSell"
            && plan.completion_target.as_deref() == Some("confidential");
        if !private_sell && plan_bytes > 2048 {
            return Err(SignerError::InvalidInput);
        }
        let max_legs = if private_sell {
            MAX_PRIVATE_HOLDERS
        } else {
            MAX_LEGS
        };
        if legs == 0
            || legs > max_legs
            || (private_sell && plan.recipient_indices.iter().any(|i| *i >= 8192))
        {
            return Err(SignerError::InvalidInput);
        }
        if plan.completion_target.is_some() && !private_sell {
            return Err(SignerError::InvalidInput);
        }
        if private_sell && (plan.legs_random.is_some() || plan.weights.is_some()) {
            return Err(SignerError::InvalidInput);
        }
        let sell = plan.kind == "confidentialSell";
        let payout = plan.kind == "confidentialPayout";
        let recovery = plan.kind == "confidentialRecovery";
        // Only recovery scans, and it scans only indices the registry already allocated.
        if recovery != plan.scan_to.is_some()
            || plan
                .scan_to
                .is_some_and(|end| end < FIRST_RECIPIENT + legs as u32)
        {
            return Err(SignerError::InvalidInput);
        }
        // A new buy may only target a curated deep-liquidity stock. Sell and recovery are not
        // limited, so a holding or a half-finished buy stays completable after a token is delisted.
        if (plan.kind == "confidentialSwap" || payout) && !is_buy_target(plan.target) {
            return Err(SignerError::InvalidInput);
        }
        if (plan.kind != "confidentialSwap" && !sell && !payout && !recovery)
            || plan.recipient_indices.iter().any(|i| *i < FIRST_RECIPIENT)
            || plan
                .recipient_indices
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != legs
        {
            return Err(SignerError::InvalidInput);
        }
        // Only a sell carries payout randomness, as exactly 32 bytes of hex.
        let pooled = plan.legs_random.is_some();
        if pooled
            && (plan.kind != "confidentialSell"
                || plan
                    .legs_random
                    .as_deref()
                    .is_none_or(|r| r.len() != 64 || !r.bytes().all(|b| b.is_ascii_hexdigit())))
        {
            return Err(SignerError::InvalidInput);
        }
        if let Some(weights) = &plan.weights {
            // A sell pays each return wallet its own holder's proceeds, so shares do not apply;
            // refusing them is better than showing a split the plan would never follow.
            if sell {
                return Err(SignerError::InvalidInput);
            }
            // One positive weight per leg; the sum is bounded so portions stay meaningful.
            if weights.len() != legs
                || weights.contains(&0)
                || weights.iter().map(|w| u64::from(*w)).sum::<u64>() > MAX_WEIGHT_SUM
            {
                return Err(SignerError::InvalidInput);
            }
        }
        let holders = if sell {
            let held = plan
                .holder_indices
                .clone()
                .ok_or(SignerError::InvalidInput)?;
            // A pooled sell sizes its payouts later from up to `legs` reserved wallets; an older
            // sell pairs each holder with the return wallet of the same position.
            if held.is_empty()
                || held.len() > max_legs
                || (!pooled && held.len() != legs)
                || held.iter().any(|i| *i < FIRST_RECIPIENT)
            {
                return Err(SignerError::InvalidInput);
            }
            if private_sell {
                // No public payouts: internal slots name exactly the existing holders.
                if plan.recipient_indices != held {
                    return Err(SignerError::InvalidInput);
                }
            } else {
                let used: std::collections::HashSet<&u32> =
                    held.iter().chain(plan.recipient_indices.iter()).collect();
                if used.len() != held.len() + legs {
                    return Err(SignerError::InvalidInput);
                }
            }
            Some(held)
        } else if plan.holder_indices.is_some() {
            return Err(SignerError::InvalidInput);
        } else {
            None
        };
        if let Some(amount) = &plan.amount_atoms {
            if sell || payout || recovery {
                return Err(SignerError::InvalidInput);
            }
            let v = evm::decimal(amount)?;
            if v.is_zero() || v > U256::from(MAX_SOURCE_ATOMS) {
                return Err(SignerError::InvalidInput);
            }
        }
        let seed = seed_from_entropy(entropy)?;
        let at = |i| derive_key(&seed, i).map(|k| evm::key_address(&k));
        let holder_addrs = match holders {
            Some(held) => held.iter().map(|i| at(*i)).collect::<Result<Vec<_>, _>>()?,
            None => vec![Address::ZERO; legs],
        };
        // One order per holder for a sell, per recipient otherwise.
        let sales = holder_addrs.len();
        let recipient_addrs = plan
            .recipient_indices
            .iter()
            .map(|i| at(*i))
            .collect::<Result<Vec<_>, _>>()?;
        let machine = Machine {
            version: STATE_VERSION,
            id: format!(
                "{:#x}",
                keccak256(format!(
                    "{}:{}:{:?}:{}",
                    now_ms,
                    at(plan.source_index)?,
                    plan.recipient_indices,
                    plan.kind
                ))
            ),
            source: at(plan.source_index)?,
            confidential: at(CONFIDENTIAL_ACCOUNT)?,
            recipients: recipient_addrs,
            holders: holder_addrs,
            plan,
            created_ms: now_ms,
            approved_ms: None,
            session_until_ms: now_ms + SESSION_MS,
            step: Step::Assets,
            reapproval: None,
            resubmits: 0,
            paused: None,
            cancelled: false,
            next_id: 0,
            pending: None,
            failures: 0,
            wait_until_ms: 0,
            data: Data {
                payouts: if private_sell {
                    Vec::new()
                } else {
                    vec![Payout::default(); legs]
                },
                orders: vec![Order::default(); sales],
                ..Data::default()
            },
        };
        Ok(Arc::new(Self {
            inner: Mutex::new(Engine {
                m: machine,
                gateway: gateway_base(&gateway)?,
                seed: Some(seed),
            }),
        }))
    }

    /// Resumes a persisted operation without key material; signing waits for `unlock`.
    #[uniffi::constructor]
    pub fn restore(state: String, gateway: String) -> Result<Arc<Self>, SignerError> {
        let mut m: Machine = serde_json::from_str(&state).map_err(|_| SignerError::InvalidInput)?;
        if m.version != STATE_VERSION {
            return Err(SignerError::InvalidInput);
        }
        if m.plan.kind == "confidentialSwap"
            && m.approved_ms.is_some()
            && m.data.review_limits.is_none()
            && m.data.signed_operation.is_none()
        {
            // Historical unsigned approvals did not persist economic limits. Refresh the same
            // operation/wallet plan and obtain native review; signed/unknown journals are untouched.
            m.approved_ms = None;
            m.data.prepared = None;
            m.data.funding_review_changed = true;
            m.pending = None;
            m.reapproval = None;
            m.paused = None;
            m.step = Step::SourceChain { execute: false };
        }
        Ok(Arc::new(Self {
            inner: Mutex::new(Engine {
                m,
                gateway: gateway_base(&gateway)?,
                seed: None,
            }),
        }))
    }

    pub fn next_step(&self, now_ms: u64) -> Result<SwapStep, SignerError> {
        let mut e = self.inner.lock().map_err(|_| SignerError::CryptoFailed)?;
        e.next(now_ms)
    }

    pub fn on_response(
        &self,
        id: u64,
        status: u16,
        body: String,
        now_ms: u64,
    ) -> Result<(), SignerError> {
        if body.len() > 1 << 20 {
            return Err(SignerError::InvalidInput);
        }
        let mut e = self.inner.lock().map_err(|_| SignerError::CryptoFailed)?;
        e.respond(id, status, &body, now_ms)
    }

    /// Called only by the native review after a passkey assertion. Opens the 15-minute authorization.
    pub fn approve(&self, now_ms: u64) -> Result<(), SignerError> {
        let mut e = self.inner.lock().map_err(|_| SignerError::CryptoFailed)?;
        if e.m.cancelled
            || e.seed.is_none()
            || now_ms >= e.m.session_until_ms
            || e.operation_expired(now_ms)
        {
            e.seed = None;
            return Err(SignerError::Expired);
        }
        if e.m.reapproval.take().is_some() {
            // Continue with exactly the quote that was shown; a later requote is checked again.
            e.m.step = match e.m.step.clone() {
                Step::PayoutQuote { index } => Step::PayoutIntent { index },
                Step::FusionPreview { index } if e.sell() => Step::SellQuote { index },
                Step::FusionPreview { index } => Step::FusionPermit { index },
                Step::SellQuote { index } => Step::FusionPermit { index },
                other => other,
            };
            e.m.session_until_ms = now_ms + SESSION_MS;
            return Ok(());
        }
        if e.m.step != Step::Review || e.m.approved_ms.is_some() {
            return Err(SignerError::InvalidInput);
        }
        if e.m.plan.kind == "confidentialSwap" {
            e.m.data.review_limits = Some(e.funding_review_limits()?);
            e.m.data.funding_review_changed = false;
        }
        e.m.approved_ms = Some(now_ms);
        e.m.session_until_ms = now_ms + SESSION_MS;
        Ok(())
    }

    /// New passkey unlock for the same approved plan; the entropy must derive the same wallets.
    pub fn unlock(&self, entropy: Vec<u8>, now_ms: u64) -> Result<(), SignerError> {
        let mut e = self.inner.lock().map_err(|_| SignerError::CryptoFailed)?;
        if e.m.cancelled || e.operation_expired(now_ms) {
            return Err(SignerError::Expired);
        }
        let seed = seed_from_entropy(entropy)?;
        let holders_ok = match &e.m.plan.holder_indices {
            Some(indices) => {
                indices.len() == e.m.holders.len()
                    && indices.iter().zip(&e.m.holders).all(|(i, a)| {
                        derive_key(&seed, *i).is_ok_and(|k| evm::key_address(&k) == *a)
                    })
            }
            None => e.m.holders.iter().all(|a| a.is_zero()),
        };
        let same = evm::key_address(&derive_key(&seed, e.m.plan.source_index)?) == e.m.source
            && evm::key_address(&derive_key(&seed, CONFIDENTIAL_ACCOUNT)?) == e.m.confidential
            && e.m.plan.recipient_indices.len() == e.m.recipients.len()
            && e.m
                .plan
                .recipient_indices
                .iter()
                .zip(&e.m.recipients)
                .all(|(i, a)| derive_key(&seed, *i).is_ok_and(|k| evm::key_address(&k) == *a))
            && holders_ok;
        if !same {
            return Err(SignerError::InvalidInput);
        }
        e.seed = Some(seed);
        e.m.session_until_ms = now_ms + SESSION_MS;
        Ok(())
    }

    /// Clears a pause so the current step runs again (it re-validates everything it receives).
    pub fn retry(&self) {
        if let Ok(mut e) = self.inner.lock()
            && !e.m.cancelled
        {
            e.m.paused = None;
            e.m.failures = 0;
            e.m.wait_until_ms = 0;
        }
    }

    /// Stops all future signatures. Submitted steps cannot be undone.
    pub fn cancel(&self) {
        if let Ok(mut e) = self.inner.lock() {
            if e.private_sell() {
                if e.m.step == Step::Done {
                    return;
                }
                if e.m
                    .data
                    .orders
                    .iter()
                    .any(|row| row.permit.is_some() || row.signature.is_some())
                    || !e.m.data.sale_inbounds.is_empty()
                {
                    e.m.paused = Some("SALE_PAUSED_SAVED_PROGRESS".into());
                    e.seed = None;
                    return;
                }
            }
            e.m.cancelled = true;
            e.seed = None;
        }
    }

    /// Serialized state without key material. Contains signed payloads: persist it encrypted only.
    pub fn export_state(&self) -> Result<String, SignerError> {
        let e = self.inner.lock().map_err(|_| SignerError::CryptoFailed)?;
        serde_json::to_string(&e.m).map_err(|_| SignerError::CryptoFailed)
    }

    /// Public phase status for JS: no addresses, hashes or signed data.
    pub fn public_status(&self) -> String {
        self.inner
            .lock()
            .map(|e| e.public_status().to_string())
            .unwrap_or_else(|_| "{}".into())
    }

    pub fn operation_id(&self) -> String {
        self.inner
            .lock()
            .map(|e| e.m.id.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
