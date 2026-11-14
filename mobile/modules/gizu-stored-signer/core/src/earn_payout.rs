//! Native-only C-role2 private payout authorization. Platform authenticates fixed
//! gateway TLS credit/quote evidence, reserves one child per immutable funding
//! operation and role, and journals signed bytes before submission. Nonce-first-
//! seen is local journal evidence; it is not an on-chain unused-nonce assertion.
//! Unknown submission locks that role/nonce until authenticated reconciliation.
use crate::{SignerError, address};
use alloy_primitives::{Address, B256, U256, keccak256};
use base64::{Engine, engine::general_purpose::STANDARD};
use bip32::XPrv;
use bip39::{Language, Mnemonic};
use chrono::DateTime;
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
const MONAD_USDC: &str = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const ETH_USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const HOOD_USDG: &str = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/// Authenticated fixed gateway history tied to the exact origin transaction.
/// source_history_id is a verified context digest, never a global balance delta.
#[derive(Clone, uniffi::Record)]
pub struct NativeEarnSourceCreditProof {
    pub operation_id: String,
    pub revision: u64,
    pub profile_chain_id: u64,
    pub source_quote_id: String,
    pub source_transaction_hash: String,
    pub source_history_id: String,
    pub confidential_account: String,
    pub source_asset_id: String,
    pub source_token: String,
    pub source_chain_id: u64,
    pub source_decimals: u32,
    pub credited_atoms: String,
    pub private_token_id: String,
    pub observed_at_ms: u64,
    pub expires_at_ms: u64,
    pub authenticated_body_hash: String,
    pub source_owner: String,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeEarnPayoutQuoteBinding {
    pub operation_id: String,
    pub revision: u64,
    pub profile_chain_id: u64,
    pub leg: String,
    pub quote_id: String,
    pub deposit_id: String,
    pub confidential_account: String,
    pub refund_account: String,
    pub source_quote_id: String,
    pub source_transaction_hash: String,
    pub source_history_id: String,
    pub source_credit_body_hash: String,
    pub source_asset_id: String,
    pub private_token_id: String,
    pub amount_atoms: String,
    pub destination_token: String,
    pub destination_recipient: String,
    pub minimum_destination_atoms: String,
    pub deadline_ms: u64,
    pub observed_at_ms: u64,
    pub expires_at_ms: u64,
    pub authenticated_body_hash: String,
    pub payload_hash: String,
    pub fee_bps: u32,
    pub fee_policy: Option<String>,
    pub integrator_fee_bps: u32,
    pub application_fee_atoms: String,
    pub confidentiality: String,
    pub swap_type: String,
    pub deposit_type: String,
    pub recipient_type: String,
    pub refund_type: String,
}
/// Native encrypted journal reservation. Never construct this from Expo or a
/// provider's claim. true means this reservation originally recorded a new nonce,
/// not that intents.far exposes an authoritative nonce-unused view.
#[derive(Clone, uniffi::Record)]
pub struct NativeEarnPayoutJournalEvidence {
    pub operation_id: String,
    pub revision: u64,
    pub profile_chain_id: u64,
    pub leg: String,
    pub reservation_id: String,
    pub nonce: String,
    pub payload_hash: String,
    pub nonce_first_seen: bool,
    pub role_reserved: bool,
    pub previous_submission_unresolved: bool,
    pub observed_at_ms: u64,
}
#[derive(uniffi::Record)]
pub struct NativeSignedEarnPayout {
    pub operation_id: String,
    pub revision: u64,
    pub profile_chain_id: u64,
    pub leg: String,
    pub quote_id: String,
    pub standard: String,
    pub payload: String,
    pub signature: String,
    pub payload_hash: String,
    pub review_hash: String,
    pub nonce: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    kind: String,
    distribution: Option<crate::earn_distribution::EarnDistribution>,
    #[serde(default)]
    source_account_index: u32,
    #[serde(default = "zero_atoms")]
    split_offset_atoms: String,
    #[serde(default)]
    cycle_index: u32,
    operation_id: String,
    revision: u64,
    profile_chain_id: u64,
    leg: String,
    expected_signer: String,
    expected_recipient: String,
    source_quote_id: String,
    source_transaction_hash: String,
    source_history_id: String,
    credited_atoms: String,
    amount_atoms: String,
    quote_id: String,
    minimum_destination_atoms: String,
    deadline_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    signer_id: String,
    verifying_contract: String,
    nonce: String,
    deadline: String,
    intents: Vec<Transfer>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    intent: String,
    receiver_id: String,
    tokens: SingleToken,
}
struct SingleToken {
    id: String,
    amount: String,
}
impl<'de> Deserialize<'de> for SingleToken {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = SingleToken;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("exactly one unique token amount")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let (id, amount) = map
                    .next_entry::<String, String>()?
                    .ok_or_else(|| serde::de::Error::custom("missing token"))?;
                if map.next_entry::<String, String>()?.is_some() {
                    return Err(serde::de::Error::custom("extra or duplicate token"));
                }
                Ok(SingleToken { id, amount })
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
fn zero_atoms() -> String {
    "0".into()
}
struct Inner {
    expected_source_owner: String,
    proposal_hash: B256,
    withdrawal_return_id: Option<String>,
    p: Proposal,
    seed: Option<Zeroizing<[u8; 64]>>,
    confidential: String,
    recipient: String,
    started: Instant,
    lifetime: Duration,
    expires_at_ms: u64,
    review_hash: Option<String>,
    approved: bool,
    payload: Option<String>,
    journal: Option<NativeEarnPayoutJournalEvidence>,
}
#[derive(uniffi::Object)]
pub struct EarnPayoutOperation {
    state: Mutex<Inner>,
}
#[uniffi::export]
impl EarnPayoutOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: Proposal = parse(&proposal)?;
        let clock = now_ms()?;
        let entropy = Zeroizing::new(entropy);
        if p.kind != "confidentialPayout"
            || entropy.len() != 32
            || p.revision == 0
            || ![1, 4663].contains(&p.profile_chain_id)
            || p.deadline_ms <= clock
            || p.deadline_ms > clock.checked_add(600000).ok_or(SignerError::InvalidInput)?
        {
            return Err(SignerError::InvalidInput);
        }
        for id in [&p.operation_id, &p.source_quote_id, &p.quote_id] {
            identifier(id)?;
        }
        hash(&p.source_transaction_hash)?;
        hash(&p.source_history_id)?;
        let credit = dec(&p.credited_atoms)?;
        let offset = dec(&p.split_offset_atoms)?;
        let slot = match &p.distribution {
            Some(plan) => Some(plan.slot(&p.leg)?),
            None if p.leg == "hold" || p.leg == "invest" => None,
            None => return Err(SignerError::InvalidInput),
        };
        let amount = if let Some(plan) = &p.distribution {
            plan.allocations(credit, offset)?[slot.ok_or(SignerError::InvalidInput)? as usize]
        } else {
            let hold = offset
                .checked_add(credit)
                .ok_or(SignerError::InvalidInput)?
                / U256::from(10)
                - offset / U256::from(10);
            let invest = credit - hold;
            if hold.is_zero() || invest.is_zero() {
                return Err(SignerError::InvalidInput);
            }
            if p.leg == "hold" { hold } else { invest }
        };
        if dec(&p.amount_atoms)? != amount || dec(&p.minimum_destination_atoms)?.is_zero() {
            return Err(SignerError::InvalidInput);
        }
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
            .map_err(|_| SignerError::CryptoFailed)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        drop(mnemonic);
        drop(entropy);
        crate::roles::validate_public_source_index(p.source_account_index)?;
        let expected_source_owner = address(
            crate::roles::derive_key(&seed, p.source_account_index)?
                .private_key()
                .verifying_key(),
        );
        let confidential = address(
            crate::earn_confidential_key(
                &seed,
                p.profile_chain_id,
                p.cycle_index,
                &p.expected_signer,
            )?
            .private_key()
            .verifying_key(),
        );
        let recipient_key = if slot.is_some() {
            crate::earn_distribution::earn_investment_key(
                &seed,
                p.profile_chain_id,
                p.cycle_index,
                slot,
            )?
        } else {
            child(
                &seed,
                p.profile_chain_id,
                p.cycle_index,
                u8::from(p.leg == "invest"),
            )?
        };
        let recipient = address(recipient_key.private_key().verifying_key());
        if addr(&p.expected_signer)? != addr(&confidential)?
            || addr(&p.expected_recipient)? != addr(&recipient)?
        {
            return Err(SignerError::InvalidInput);
        }
        let lifetime = Duration::from_millis(p.deadline_ms - clock);
        let expires_at_ms = p.deadline_ms;
        Ok(Arc::new(Self {
            state: Mutex::new(Inner {
                expected_source_owner,
                proposal_hash: keccak256(proposal.as_bytes()),
                withdrawal_return_id: None,
                p,
                seed: Some(seed),
                confidential,
                recipient,
                started: Instant::now(),
                lifetime,
                expires_at_ms,
                review_hash: None,
                approved: false,
                payload: None,
                journal: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        credit: NativeEarnSourceCreditProof,
        quote: NativeEarnPayoutQuoteBinding,
        payload: String,
        journal: NativeEarnPayoutJournalEvidence,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        if revision != s.p.revision || s.payload.is_some() {
            return Err(SignerError::InvalidInput);
        }
        check_credit(&s, &credit)?;
        check_quote(&s, &credit, &quote)?;
        let message: Payload = parse(&payload)?;
        check_payload(&s, &quote, &message)?;
        check_journal(&s, &journal, &payload, &message.nonce)?;
        if quote.payload_hash.to_lowercase() != format!("{:#x}", keccak256(payload.as_bytes())) {
            return Err(SignerError::InvalidInput);
        }
        let review = format!(
            "CONFIDENTIAL EARN PAYOUT · {} · profile chain {}\nFunding operation {} · revision {}\nSigner C {} · destination {}\nConfirmed Monad USDC source credit {} atoms · source quote {} · origin transaction {}\nVerified source history identity {}\nExact {} allocation {} source atoms ({})\nQuote {} · minimum destination {} atoms · token {}\nConfidential deposit receiver {} · refund C {}\n{} · advanced confidentiality\nDeadline {} Unix milliseconds\nExact ERC191 payload hash {:#x} · local nonce reservation {}\nIndependent payout authorization for this funding operation and role. Native journal permits one signed child per role; uncertain submission stays locked. Retry only identical signed bytes. Signing does not prove destination receipt or vault deposit.",
            s.p.leg,
            s.p.profile_chain_id,
            s.p.operation_id,
            s.p.revision,
            s.confidential,
            s.recipient,
            s.p.credited_atoms,
            s.p.source_quote_id,
            s.p.source_transaction_hash,
            s.p.source_history_id,
            s.p.leg,
            s.p.amount_atoms,
            s.p.distribution
                .as_ref()
                .map(|p| p.review())
                .unwrap_or_else(|| "hold=floor10%, invest=remainder90%".into()),
            s.p.quote_id,
            s.p.minimum_destination_atoms,
            quote.destination_token,
            quote.deposit_id,
            quote.refund_account,
            crate::earn_fees::review(
                quote.fee_policy.as_deref(),
                if s.withdrawal_return_id.is_some() {
                    "withdrawal"
                } else if s.p.profile_chain_id == 1 {
                    "payoutEthereum"
                } else {
                    "payoutRobinhood"
                },
                Some(quote.fee_bps)
            )?,
            s.p.deadline_ms,
            keccak256(payload.as_bytes()),
            journal.reservation_id
        );
        let review = if let Some(return_id) = &s.withdrawal_return_id {
            format!(
                "CONFIDENTIAL EARN WITHDRAWAL · cycle {} · profile chain {}\nWithdrawal operation {} · revision {} · return child {}\nSigner C {} · fresh public recipient R {}\nConfirmed returned credit {} private Monad USDC atoms · original source asset {} chain {} token {}\nReturn quote {} · original transaction {} · verified history {}\nExact outbound amount {} atoms · quote {}\nDestination chain 143 Monad USDC {} · minimum {} atoms\nConfidential receiver {} · refund C {}\n{} · advanced confidentiality\nDeadline {} Unix milliseconds\nExact ERC191 payload hash {:#x} · local nonce reservation {}\nIndependent withdrawal authorization for one returned child. Uncertain submission stays locked; retry only identical signed bytes.",
                s.p.cycle_index,
                s.p.profile_chain_id,
                s.p.operation_id,
                s.p.revision,
                return_id,
                s.confidential,
                s.recipient,
                s.p.credited_atoms,
                credit.source_asset_id,
                credit.source_chain_id,
                credit.source_token,
                s.p.source_quote_id,
                s.p.source_transaction_hash,
                s.p.source_history_id,
                s.p.amount_atoms,
                s.p.quote_id,
                MONAD_USDC,
                s.p.minimum_destination_atoms,
                quote.deposit_id,
                quote.refund_account,
                crate::earn_fees::review(
                    quote.fee_policy.as_deref(),
                    "withdrawal",
                    Some(quote.fee_bps)
                )?,
                s.p.deadline_ms,
                keccak256(payload.as_bytes()),
                journal.reservation_id
            )
        } else {
            review
        };
        let review = if s.withdrawal_return_id.is_none() {
            format!(
                "{review}\nSource account index {} · sender {} · previously settled batch credit offset {} atoms",
                s.p.source_account_index, s.expected_source_owner, s.p.split_offset_atoms
            )
        } else {
            review
        };
        let mut binding = review.as_bytes().to_vec();
        binding.extend_from_slice(s.proposal_hash.as_slice());
        binding.extend(credit.authenticated_body_hash.as_bytes());
        binding.extend(quote.authenticated_body_hash.as_bytes());
        s.review_hash = Some(format!("{:#x}", keccak256(binding)));
        s.expires_at_ms =
            s.p.deadline_ms
                .min(credit.expires_at_ms)
                .min(quote.expires_at_ms);
        s.payload = Some(payload);
        s.journal = Some(journal);
        Ok(review)
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        s.review_hash.clone().ok_or(SignerError::InvalidInput)
    }
    pub fn approve(&self, revision: u64, review_hash: String) -> Result<(), SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        if revision != s.p.revision || s.approved || s.review_hash.as_deref() != Some(&review_hash)
        {
            return Err(SignerError::InvalidInput);
        }
        s.approved = true;
        Ok(())
    }
    pub fn sign(
        &self,
        revision: u64,
        current: NativeEarnPayoutJournalEvidence,
    ) -> Result<NativeSignedEarnPayout, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        if !s.approved {
            return Err(SignerError::InvalidInput);
        }
        let checked = (|| {
            if revision != s.p.revision {
                return Err(SignerError::InvalidInput);
            }
            let old = s.journal.as_ref().ok_or(SignerError::InvalidInput)?;
            let payload = s.payload.as_ref().ok_or(SignerError::InvalidInput)?;
            check_journal(&s, &current, payload, &old.nonce)?;
            if current.reservation_id != old.reservation_id {
                return Err(SignerError::InvalidInput);
            }
            Ok(())
        })();
        if let Err(e) = checked {
            s.seed = None;
            return Err(e);
        }
        let seed = s.seed.take().ok_or(SignerError::InvalidInput)?;
        let payload = s.payload.as_ref().ok_or(SignerError::InvalidInput)?.clone();
        let digest = keccak256(format!(
            "\x19Ethereum Signed Message:\n{}{}",
            payload.len(),
            payload
        ));
        let (sig, rec) = crate::earn_confidential_key(
            &seed,
            s.p.profile_chain_id,
            s.p.cycle_index,
            &s.p.expected_signer,
        )?
        .private_key()
        .sign_prehash_recoverable(digest.as_ref());
        if rec.to_byte() > 1 {
            return Err(SignerError::CryptoFailed);
        }
        let mut bytes = sig.to_bytes().to_vec();
        bytes.push(rec.to_byte());
        Ok(NativeSignedEarnPayout {
            operation_id: s.p.operation_id.clone(),
            revision: s.p.revision,
            profile_chain_id: s.p.profile_chain_id,
            leg: s.p.leg.clone(),
            quote_id: s.p.quote_id.clone(),
            standard: "erc191".into(),
            payload,
            signature: format!("secp256k1:{}", bs58::encode(bytes).into_string()),
            payload_hash: current.payload_hash,
            review_hash: s.review_hash.clone().ok_or(SignerError::InvalidInput)?,
            nonce: current.nonce,
        })
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.seed = None;
            s.approved = false;
        }
    }
}
fn now_ms() -> Result<u64, SignerError> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| SignerError::InvalidInput)?
            .as_millis(),
    )
    .map_err(|_| SignerError::InvalidInput)
}
fn parse<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, SignerError> {
    if s.len() > 32768 {
        return Err(SignerError::InvalidInput);
    }
    serde_json::from_str(s).map_err(|_| SignerError::InvalidInput)
}
fn identifier(s: &str) -> Result<(), SignerError> {
    if s.is_empty()
        || s.len() > 256
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn addr(s: &str) -> Result<Address, SignerError> {
    if s.len() != 42 || !s.starts_with("0x") {
        return Err(SignerError::InvalidInput);
    }
    s.parse().map_err(|_| SignerError::InvalidInput)
}
fn dec(s: &str) -> Result<U256, SignerError> {
    if s.is_empty()
        || s.len() > 78
        || s.len() > 1 && s.starts_with('0')
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(SignerError::InvalidInput);
    }
    U256::from_str_radix(s, 10).map_err(|_| SignerError::InvalidInput)
}
fn hash(s: &str) -> Result<(), SignerError> {
    if s.len() != 66
        || !s.starts_with("0x")
        || s.parse::<B256>().map_err(|_| SignerError::InvalidInput)? == B256::ZERO
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn child(seed: &[u8; 64], chain: u64, cycle_index: u32, role: u8) -> Result<XPrv, SignerError> {
    crate::earn_cycle_key(seed, chain, cycle_index, role)
}
fn live(s: &mut Inner) -> Result<(), SignerError> {
    let clock = now_ms()?;
    if clock >= s.expires_at_ms || s.started.elapsed() >= s.lifetime {
        s.seed = None;
        return Err(SignerError::Expired);
    }
    if s.seed.is_none() {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn fresh(observed: u64, expires: u64) -> Result<(), SignerError> {
    let clock = now_ms()?;
    if observed > clock
        || clock - observed > 60000
        || expires <= clock
        || expires > clock.checked_add(600000).ok_or(SignerError::InvalidInput)?
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_private_token(private: &str, asset: &str) -> Result<(), SignerError> {
    identifier(asset)?;
    let prefix = private
        .strip_prefix("imt:")
        .ok_or(SignerError::InvalidInput)?;
    let (hex, suffix) = prefix.split_once(':').ok_or(SignerError::InvalidInput)?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || hex.bytes().all(|b| b == b'0')
        || suffix != asset
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_credit(s: &Inner, c: &NativeEarnSourceCreditProof) -> Result<(), SignerError> {
    fresh(c.observed_at_ms, c.expires_at_ms)?;
    hash(&c.authenticated_body_hash)?;
    hash(&c.source_transaction_hash)?;
    hash(&c.source_history_id)?;
    if s.withdrawal_return_id.is_some() {
        check_private_token(
            &c.private_token_id,
            "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
        )?;
        let token = addr(&c.source_token)?;
        let valid = c.source_chain_id == s.p.profile_chain_id
            && ((c.source_chain_id == 1
                && ((token == addr(ETH_USDC)? && c.source_decimals == 6)
                    || (token == Address::ZERO && c.source_decimals == 18)))
                || (c.source_chain_id == 4663
                    && token == addr(HOOD_USDG)?
                    && c.source_decimals == 6));
        if !valid || c.source_asset_id.is_empty() || c.source_asset_id.len() > 512 {
            return Err(SignerError::InvalidInput);
        }
    } else {
        check_private_token(&c.private_token_id, &c.source_asset_id)?;
        if c.source_chain_id != 143
            || addr(&c.source_token)? != addr(MONAD_USDC)?
            || c.source_decimals != 6
        {
            return Err(SignerError::InvalidInput);
        }
    }
    if addr(&c.source_owner)? != addr(&s.expected_source_owner)? {
        return Err(SignerError::InvalidInput);
    }
    if c.operation_id != s.p.operation_id
        || c.revision != s.p.revision
        || c.profile_chain_id != s.p.profile_chain_id
        || c.source_quote_id != s.p.source_quote_id
        || c.source_transaction_hash != s.p.source_transaction_hash
        || c.source_history_id != s.p.source_history_id
        || addr(&c.confidential_account)? != addr(&s.confidential)?
        || c.credited_atoms != s.p.credited_atoms
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_quote(
    s: &Inner,
    c: &NativeEarnSourceCreditProof,
    q: &NativeEarnPayoutQuoteBinding,
) -> Result<(), SignerError> {
    fresh(q.observed_at_ms, q.expires_at_ms)?;
    hash(&q.authenticated_body_hash)?;
    hash(&q.payload_hash)?;
    identifier(&q.deposit_id)?;
    if q.operation_id != s.p.operation_id
        || q.revision != s.p.revision
        || q.profile_chain_id != s.p.profile_chain_id
        || q.leg != s.p.leg
        || q.quote_id != s.p.quote_id
        || addr(&q.confidential_account)? != addr(&s.confidential)?
        || addr(&q.refund_account)? != addr(&s.confidential)?
        || q.source_quote_id != s.p.source_quote_id
        || q.source_transaction_hash != s.p.source_transaction_hash
        || q.source_history_id != s.p.source_history_id
        || q.source_credit_body_hash != c.authenticated_body_hash
        || q.source_asset_id != c.source_asset_id
        || q.private_token_id != c.private_token_id
        || q.amount_atoms != s.p.amount_atoms
        || addr(&q.destination_token)?
            != addr(if s.withdrawal_return_id.is_some() {
                MONAD_USDC
            } else if s.p.profile_chain_id == 1 {
                ETH_USDC
            } else {
                HOOD_USDG
            })?
        || addr(&q.destination_recipient)? != addr(&s.recipient)?
        || q.minimum_destination_atoms != s.p.minimum_destination_atoms
        || q.deadline_ms != s.p.deadline_ms
        || q.expires_at_ms < s.p.deadline_ms
        || crate::earn_fees::review(
            q.fee_policy.as_deref(),
            if s.withdrawal_return_id.is_some() {
                "withdrawal"
            } else if s.p.profile_chain_id == 1 {
                "payoutEthereum"
            } else {
                "payoutRobinhood"
            },
            Some(q.fee_bps),
        )
        .is_err()
        || q.integrator_fee_bps != 0
        || q.application_fee_atoms != "0"
        || q.confidentiality != "advanced"
        || q.swap_type != "EXACT_INPUT"
        || q.deposit_type != "CONFIDENTIAL_INTENTS"
        || q.recipient_type != "DESTINATION_CHAIN"
        || q.refund_type != "CONFIDENTIAL_INTENTS"
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_payload(
    s: &Inner,
    q: &NativeEarnPayoutQuoteBinding,
    m: &Payload,
) -> Result<(), SignerError> {
    let nonce = STANDARD
        .decode(&m.nonce)
        .map_err(|_| SignerError::InvalidInput)?;
    let deadline = DateTime::parse_from_rfc3339(&m.deadline)
        .map_err(|_| SignerError::InvalidInput)?
        .timestamp_millis();
    if addr(&m.signer_id)? != addr(&s.confidential)?
        || m.verifying_contract != "intents.far"
        || nonce.len() != 32
        || nonce.iter().all(|b| *b == 0)
        || STANDARD.encode(&nonce) != m.nonce
        || u64::try_from(deadline).map_err(|_| SignerError::InvalidInput)? != s.p.deadline_ms
        || m.intents.len() != 1
    {
        return Err(SignerError::InvalidInput);
    }
    let transfer = &m.intents[0];
    if transfer.intent != "transfer"
        || transfer.receiver_id != q.deposit_id
        || transfer.tokens.id != q.private_token_id
        || transfer.tokens.amount != s.p.amount_atoms
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_journal(
    s: &Inner,
    j: &NativeEarnPayoutJournalEvidence,
    payload: &str,
    nonce: &str,
) -> Result<(), SignerError> {
    let clock = now_ms()?;
    hash(&j.reservation_id)?;
    hash(&j.payload_hash)?;
    if j.operation_id != s.p.operation_id
        || j.revision != s.p.revision
        || j.profile_chain_id != s.p.profile_chain_id
        || j.leg != s.p.leg
        || j.nonce != nonce
        || j.payload_hash.to_lowercase() != format!("{:#x}", keccak256(payload.as_bytes()))
        || !j.nonce_first_seen
        || !j.role_reserved
        || j.previous_submission_unresolved
        || j.observed_at_ms > clock
        || clock - j.observed_at_ms > 15000
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
/// Native TLS proof for one independently settled return child.
#[derive(Clone, uniffi::Record)]
pub struct NativeEarnReturnedCreditProof {
    pub return_operation_id: String,
    pub credit: NativeEarnSourceCreditProof,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeEarnWithdrawalQuoteBinding {
    pub destination_chain_id: u64,
    pub quote: NativeEarnPayoutQuoteBinding,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WithdrawalProposal {
    kind: String,
    investment_slot: Option<u32>,
    operation_id: String,
    revision: u64,
    profile_chain_id: u64,
    #[serde(default)]
    cycle_index: u32,
    recipient_index: u32,
    expected_signer: String,
    expected_recipient: String,
    return_operation_id: String,
    return_quote_id: String,
    return_transaction_hash: String,
    return_history_id: String,
    credited_atoms: String,
    amount_atoms: String,
    quote_id: String,
    minimum_destination_atoms: String,
    deadline_ms: u64,
}
#[derive(uniffi::Object)]
pub struct ConfidentialEarnWithdrawalOperation {
    inner: Arc<EarnPayoutOperation>,
}
#[uniffi::export]

/// Shared strict single-token parser for the separate generic cashout signer.
pub(crate) fn strict_private_transfer(
    payload: &str,
    signer: &str,
    receiver: &str,
    token: &str,
    amount: &str,
    expires: u64,
    now: u64,
) -> Result<String, SignerError> {
    let m: Payload = parse(payload)?;
    let nonce = STANDARD
        .decode(&m.nonce)
        .map_err(|_| SignerError::InvalidInput)?;
    let deadline = DateTime::parse_from_rfc3339(&m.deadline)
        .map_err(|_| SignerError::InvalidInput)?
        .timestamp_millis();
    if addr(&m.signer_id)? != addr(signer)?
        || m.verifying_contract != "intents.far"
        || nonce.len() != 32
        || nonce.iter().all(|b| *b == 0)
        || STANDARD.encode(&nonce) != m.nonce
        || deadline <= now as i64
        || deadline > expires as i64
        || expires > now + 60000
        || m.intents.len() != 1
    {
        return Err(SignerError::InvalidInput);
    }
    let t = &m.intents[0];
    if t.intent != "transfer"
        || t.receiver_id != receiver
        || t.tokens.id != token
        || t.tokens.amount != amount
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(m.nonce)
}
impl ConfidentialEarnWithdrawalOperation {
    #[uniffi::constructor]
    pub fn new(
        proposal_json: String,
        entropy: Vec<u8>,
        registry: String,
    ) -> Result<Arc<Self>, SignerError> {
        let p: WithdrawalProposal = parse(&proposal_json)?;
        let clock = now_ms()?;
        if p.kind != "confidentialWithdrawal"
            || p.revision == 0
            || p.recipient_index < crate::FIRST_RECIPIENT
            || p.deadline_ms <= clock
            || p.deadline_ms > clock.checked_add(600000).ok_or(SignerError::InvalidInput)?
            || dec(&p.amount_atoms)?.is_zero()
            || p.amount_atoms != p.credited_atoms
            || dec(&p.minimum_destination_atoms)?.is_zero()
        {
            return Err(SignerError::InvalidInput);
        }
        crate::roles::eligible_public_source(&registry, p.recipient_index)?;
        for id in [
            &p.operation_id,
            &p.return_operation_id,
            &p.return_quote_id,
            &p.quote_id,
        ] {
            identifier(id)?;
        }
        hash(&p.return_transaction_hash)?;
        hash(&p.return_history_id)?;
        let seed = crate::roles::seed_from_entropy(entropy)?;
        let confidential = address(
            crate::earn_confidential_key(
                &seed,
                p.profile_chain_id,
                p.cycle_index,
                &p.expected_signer,
            )?
            .private_key()
            .verifying_key(),
        );
        let recipient = address(
            crate::roles::derive_key(&seed, p.recipient_index)?
                .private_key()
                .verifying_key(),
        );
        if addr(&p.expected_signer)? != addr(&confidential)?
            || addr(&p.expected_recipient)? != addr(&recipient)?
        {
            return Err(SignerError::InvalidInput);
        }
        let return_id = p.return_operation_id;
        let proposal = Proposal {
            distribution: None,
            source_account_index: 0,
            split_offset_atoms: "0".into(),
            kind: p.kind,
            cycle_index: p.cycle_index,
            operation_id: p.operation_id,
            revision: p.revision,
            profile_chain_id: p.profile_chain_id,
            leg: "withdrawal".into(),
            expected_signer: p.expected_signer,
            expected_recipient: p.expected_recipient,
            source_quote_id: p.return_quote_id,
            source_transaction_hash: p.return_transaction_hash,
            source_history_id: p.return_history_id,
            credited_atoms: p.credited_atoms,
            amount_atoms: p.amount_atoms,
            quote_id: p.quote_id,
            minimum_destination_atoms: p.minimum_destination_atoms,
            deadline_ms: p.deadline_ms,
        };
        let inner = Arc::new(EarnPayoutOperation {
            state: Mutex::new(Inner {
                expected_source_owner: address(
                    crate::earn_distribution::earn_investment_key(
                        &seed,
                        p.profile_chain_id,
                        p.cycle_index,
                        p.investment_slot,
                    )?
                    .private_key()
                    .verifying_key(),
                ),
                proposal_hash: keccak256(proposal_json.as_bytes()),
                withdrawal_return_id: Some(return_id),
                p: proposal,
                seed: Some(seed),
                confidential,
                recipient,
                started: Instant::now(),
                lifetime: Duration::from_millis(p.deadline_ms - clock),
                expires_at_ms: p.deadline_ms,
                review_hash: None,
                approved: false,
                payload: None,
                journal: None,
            }),
        });
        Ok(Arc::new(Self { inner }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        returned: NativeEarnReturnedCreditProof,
        quote: NativeEarnWithdrawalQuoteBinding,
        payload: String,
        journal: NativeEarnPayoutJournalEvidence,
    ) -> Result<String, SignerError> {
        {
            let s = self
                .inner
                .state
                .lock()
                .map_err(|_| SignerError::CryptoFailed)?;
            if s.withdrawal_return_id.as_deref() != Some(returned.return_operation_id.as_str())
                || quote.destination_chain_id != 143
            {
                return Err(SignerError::InvalidInput);
            }
        }
        self.inner
            .prepare(revision, returned.credit, quote.quote, payload, journal)
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        self.inner.review_hash()
    }
    pub fn approve(&self, revision: u64, review_hash: String) -> Result<(), SignerError> {
        self.inner.approve(revision, review_hash)
    }
    pub fn sign(
        &self,
        revision: u64,
        journal: NativeEarnPayoutJournalEvidence,
    ) -> Result<NativeSignedEarnPayout, SignerError> {
        self.inner.sign(revision, journal)
    }
    pub fn invalidate(&self) {
        self.inner.invalidate();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn clock() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
    fn hash(b: u8) -> String {
        format!("0x{}", format!("{b:02x}").repeat(32))
    }
    fn c(chain: u64) -> String {
        crate::derive_earn_confidential_address(vec![0; 32], chain).unwrap()
    }
    fn recipient(chain: u64, leg: &str) -> String {
        crate::derive_earn_addresses(vec![0; 32], chain).unwrap()[usize::from(leg == "invest")]
            .clone()
    }
    fn proposal(chain: u64, leg: &str) -> Value {
        json!({"kind":"confidentialPayout","operationId":"funding1","revision":7,"profileChainId":chain,"leg":leg,"expectedSigner":c(chain),"expectedRecipient":recipient(chain,leg),"sourceQuoteId":"source1","sourceTransactionHash":hash(0x11),"sourceHistoryId":hash(0x22),"creditedAtoms":"1000001","amountAtoms":if leg=="hold"{"100000"}else{"900001"},"quoteId":format!("quote-{leg}"),"minimumDestinationAtoms":"1","deadlineMs":clock()+240000})
    }
    fn evidence(
        p: &Value,
    ) -> (
        NativeEarnSourceCreditProof,
        NativeEarnPayoutQuoteBinding,
        String,
        NativeEarnPayoutJournalEvidence,
    ) {
        let chain = p["profileChainId"].as_u64().unwrap();
        let leg = p["leg"].as_str().unwrap();
        let deadline = p["deadlineMs"].as_u64().unwrap();
        let private = format!("imt:{}:nep141:usdc.monad", "ab".repeat(32));
        let nonce = STANDARD.encode([0x99; 32]);
        let payload=json!({"signer_id":c(chain).to_lowercase(),"verifying_contract":"intents.far","nonce":nonce,"deadline":DateTime::from_timestamp_millis(deadline as i64).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"intents":[{"intent":"transfer","receiver_id":"deposit.example","tokens":{private.clone():p["amountAtoms"]}}]}).to_string();
        let payload_hash = format!("{:#x}", keccak256(payload.as_bytes()));
        let credit = NativeEarnSourceCreditProof {
            source_owner: crate::derive_account_addresses(vec![0; 32]).unwrap()[0].clone(),
            operation_id: "funding1".into(),
            revision: 7,
            profile_chain_id: chain,
            source_quote_id: "source1".into(),
            source_transaction_hash: hash(0x11),
            source_history_id: hash(0x22),
            confidential_account: c(chain),
            source_asset_id: "nep141:usdc.monad".into(),
            source_token: MONAD_USDC.into(),
            source_chain_id: 143,
            source_decimals: 6,
            credited_atoms: "1000001".into(),
            private_token_id: private.clone(),
            observed_at_ms: clock(),
            expires_at_ms: deadline,
            authenticated_body_hash: hash(0x33),
        };
        let quote = NativeEarnPayoutQuoteBinding {
            operation_id: "funding1".into(),
            revision: 7,
            profile_chain_id: chain,
            leg: leg.into(),
            quote_id: format!("quote-{leg}"),
            deposit_id: "deposit.example".into(),
            confidential_account: c(chain),
            refund_account: c(chain),
            source_quote_id: "source1".into(),
            source_transaction_hash: hash(0x11),
            source_history_id: hash(0x22),
            source_credit_body_hash: hash(0x33),
            source_asset_id: credit.source_asset_id.clone(),
            private_token_id: private,
            amount_atoms: p["amountAtoms"].as_str().unwrap().into(),
            destination_token: if chain == 1 { ETH_USDC } else { HOOD_USDG }.into(),
            destination_recipient: recipient(chain, leg),
            minimum_destination_atoms: "1".into(),
            deadline_ms: deadline,
            observed_at_ms: clock(),
            expires_at_ms: deadline,
            authenticated_body_hash: hash(0x44),
            payload_hash: payload_hash.clone(),
            fee_bps: 2,
            fee_policy: None,
            integrator_fee_bps: 0,
            application_fee_atoms: "0".into(),
            confidentiality: "advanced".into(),
            swap_type: "EXACT_INPUT".into(),
            deposit_type: "CONFIDENTIAL_INTENTS".into(),
            recipient_type: "DESTINATION_CHAIN".into(),
            refund_type: "CONFIDENTIAL_INTENTS".into(),
        };
        let journal = NativeEarnPayoutJournalEvidence {
            operation_id: "funding1".into(),
            revision: 7,
            profile_chain_id: chain,
            leg: leg.into(),
            reservation_id: hash(0x55),
            nonce,
            payload_hash,
            nonce_first_seen: true,
            role_reserved: true,
            previous_submission_unresolved: false,
            observed_at_ms: clock(),
        };
        (credit, quote, payload, journal)
    }
    fn approved(p: &Value) -> (Arc<EarnPayoutOperation>, NativeEarnPayoutJournalEvidence) {
        let (credit, quote, payload, journal) = evidence(p);
        let o = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let review = o
            .prepare(7, credit, quote, payload, journal.clone())
            .unwrap();
        assert!(review.contains(p["expectedRecipient"].as_str().unwrap()));
        assert!(o.sign(7, journal.clone()).is_err());
        o.approve(7, o.review_hash().unwrap()).unwrap();
        (o, journal)
    }
    #[test]
    fn exact_both_profile_hold_and_invest_payouts_recover_c_and_consume_one_authority() {
        for chain in [1, 4663] {
            for leg in ["hold", "invest"] {
                let p = proposal(chain, leg);
                let (o, journal) = approved(&p);
                let signed = o.sign(7, journal.clone()).unwrap();
                let b = bs58::decode(signed.signature.strip_prefix("secp256k1:").unwrap())
                    .into_vec()
                    .unwrap();
                let digest = keccak256(format!(
                    "\x19Ethereum Signed Message:\n{}{}",
                    signed.payload.len(),
                    signed.payload
                ));
                let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
                    digest.as_ref(),
                    &k256::ecdsa::Signature::from_slice(&b[..64]).unwrap(),
                    k256::ecdsa::RecoveryId::from_byte(b[64]).unwrap(),
                )
                .unwrap();
                assert_eq!(address(&key), c(chain));
                assert_eq!(signed.standard, "erc191");
                assert!(o.sign(7, journal).is_err());
            }
        }
    }
    #[test]
    fn payout_deny_altered_credit_role_asset_fee_and_journal() {
        let p = proposal(1, "invest");
        for i in 0..10 {
            let (mut credit, mut quote, payload, mut journal) = evidence(&p);
            match i {
                0 => credit.credited_atoms = "1000000".into(),
                1 => credit.source_transaction_hash = hash(0x66),
                2 => quote.destination_recipient = recipient(1, "hold"),
                3 => quote.private_token_id = quote.private_token_id.replace("ab", "ac"),
                4 => quote.source_asset_id = "wrong".into(),
                5 => quote.fee_bps = 3,
                6 => quote.refund_account = recipient(1, "invest"),
                7 => journal.nonce_first_seen = false,
                8 => journal.previous_submission_unresolved = true,
                _ => journal.role_reserved = false,
            };
            let o = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(
                o.prepare(7, credit, quote, payload, journal).is_err(),
                "tamper {i}"
            );
        }
    }
    #[test]
    fn payout_deep_payload_validation_and_strict_json() {
        let p = proposal(1, "hold");
        for i in 0..7 {
            let (credit, mut quote, payload, mut journal) = evidence(&p);
            let mut v: Value = serde_json::from_str(&payload).unwrap();
            match i {
                0 => v["verifying_contract"] = json!("intents.near"),
                1 => v["intents"][0]["receiver_id"] = json!("attacker"),
                2 => v["signer_id"] = json!(recipient(1, "hold")),
                3 => v["intents"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"intent":"transfer"})),
                4 => v["intents"][0]["tokens"] = json!({"imt:bad":"100000"}),
                5 => v["nonce"] = json!(STANDARD.encode([0; 31])),
                _ => v["extra"] = json!("unknown"),
            };
            let payload = v.to_string();
            quote.payload_hash = format!("{:#x}", keccak256(payload.as_bytes()));
            journal.payload_hash = quote.payload_hash.clone();
            journal.nonce = v["nonce"].as_str().unwrap().into();
            let o = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(o.prepare(7, credit, quote, payload, journal).is_err());
        }
        let mut unknown = p.clone();
        unknown["rawDigest"] = json!(hash(1));
        assert!(EarnPayoutOperation::new(unknown.to_string(), vec![0; 32]).is_err());
        let duplicate =
            p.to_string()
                .replacen("\"revision\":7", "\"revision\":7,\"revision\":7", 1);
        assert!(EarnPayoutOperation::new(duplicate, vec![0; 32]).is_err());
    }
    #[test]
    fn payout_fresh_journal_tampering_revokes_and_concurrent_sign_is_once() {
        let p = proposal(4663, "invest");
        let (o, mut j) = approved(&p);
        j.nonce = STANDARD.encode([1; 32]);
        assert!(o.sign(7, j).is_err());
        let (_, _, _, j) = evidence(&p);
        assert!(o.sign(7, j).is_err());
        let (o, j) = approved(&p);
        let a = o.clone();
        let b = o;
        let ja = j.clone();
        let threads = [
            std::thread::spawn(move || a.sign(7, ja)),
            std::thread::spawn(move || b.sign(7, j)),
        ];
        assert_eq!(
            threads
                .into_iter()
                .map(|t| u8::from(t.join().unwrap().is_ok()))
                .sum::<u8>(),
            1
        );
    }
    #[test]
    fn erc191_digest_matches_installed_viem_2569_exact_utf8_bytes() {
        let payload = r#"{"signer_id":"0x1111111111111111111111111111111111111111","verifying_contract":"intents.far","nonce":"mZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZk=","deadline":"2030-03-17T17:50:40.000Z","intents":[{"intent":"transfer","receiver_id":"deposit.example","tokens":{"imt:abababababababababababababababababababababababababababababababab:nep141:usdc.monad":"100000"}}]}"#;
        assert_eq!(
            format!(
                "{:#x}",
                keccak256(format!(
                    "\x19Ethereum Signed Message:\n{}{}",
                    payload.len(),
                    payload
                ))
            ),
            "0x7bbadaf1999302a13072e13d4f12c7840e7d08fd538ee92362decd83b2314249"
        );
    }
    #[test]
    fn duplicate_private_tokens_deadline_and_stale_native_evidence_fail_closed() {
        let p = proposal(1, "hold");
        let (credit, mut quote, payload, mut journal) = evidence(&p);
        let token = quote.private_token_id.clone();
        let duplicate = payload.replace(
            &format!("\"{token}\":\"100000\""),
            &format!("\"{token}\":\"100000\",\"{token}\":\"100000\""),
        );
        quote.payload_hash = format!("{:#x}", keccak256(duplicate.as_bytes()));
        journal.payload_hash = quote.payload_hash.clone();
        let o = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(o.prepare(7, credit, quote, duplicate, journal).is_err());
        for i in 0..3 {
            let (o, mut journal) = approved(&p);
            match i {
                0 => journal.observed_at_ms = clock() - 15001,
                1 => journal.reservation_id = hash(0x88),
                _ => journal.previous_submission_unresolved = true,
            };
            assert!(o.sign(7, journal).is_err());
            assert!(o.review_hash().is_err());
        }
        let (o, _) = approved(&p);
        o.state.lock().unwrap().lifetime = Duration::ZERO;
        assert!(matches!(o.review_hash(), Err(SignerError::Expired)));
        let (o, _) = approved(&p);
        o.invalidate();
        assert!(o.review_hash().is_err());
    }

    #[test]
    fn shared_account_two_payout_signs_and_recovers_the_shared_key() {
        for chain in [1, 4663] {
            let mut p = proposal(chain, "invest");
            let c = crate::derive_account_addresses(vec![0; 32]).unwrap()[2].clone();
            p["expectedSigner"] = json!(c);
            let (mut credit, mut quote, raw, mut journal) = evidence(&p);
            credit.confidential_account = c.clone();
            quote.confidential_account = c.clone();
            quote.refund_account = c.clone();
            let mut payload: Value = serde_json::from_str(&raw).unwrap();
            payload["signer_id"] = json!(c.to_lowercase());
            let raw = payload.to_string();
            let digest = format!("{:#x}", keccak256(raw.as_bytes()));
            quote.payload_hash = digest.clone();
            journal.payload_hash = digest;
            let o = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
            o.prepare(7, credit, quote, raw.clone(), journal.clone())
                .unwrap();
            o.approve(7, o.review_hash().unwrap()).unwrap();
            let signed = o.sign(7, journal).unwrap();
            let encoded = signed.signature.strip_prefix("secp256k1:").unwrap();
            let bytes = bs58::decode(encoded).into_vec().unwrap();
            let message = format!("\x19Ethereum Signed Message:\n{}{}", raw.len(), raw);
            let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
                keccak256(message.as_bytes()).as_slice(),
                &k256::ecdsa::Signature::from_slice(&bytes[..64]).unwrap(),
                k256::ecdsa::RecoveryId::from_byte(bytes[64]).unwrap(),
            )
            .unwrap();
            assert_eq!(address(&key), c);
        }
    }

    #[test]
    fn private_payout_constructor_binds_fresh_cycle_roles() {
        for chain in [1, 4663] {
            for leg in ["hold", "invest"] {
                let mut p = proposal(chain, leg);
                p["cycleIndex"] = json!(2);
                p["expectedSigner"] = json!(
                    crate::derive_earn_cycle_confidential_address(vec![0; 32], chain, 2).unwrap()
                );
                p["expectedRecipient"] = json!(
                    crate::derive_earn_cycle_addresses(vec![0; 32], chain, 2).unwrap()
                        [usize::from(leg == "invest")]
                );
                assert!(EarnPayoutOperation::new(p.to_string(), vec![0; 32]).is_ok());
                p["expectedRecipient"] = json!(recipient(chain, leg));
                assert!(EarnPayoutOperation::new(p.to_string(), vec![0; 32]).is_err());
            }
        }
    }

    fn withdrawal_fixture(
        chain: u64,
        native_eth: bool,
    ) -> (
        Value,
        NativeEarnReturnedCreditProof,
        NativeEarnWithdrawalQuoteBinding,
        String,
        NativeEarnPayoutJournalEvidence,
    ) {
        let original = proposal(chain, "invest");
        let (mut credit, mut quote, raw, mut journal) = evidence(&original);
        let c = crate::derive_earn_cycle_confidential_address(vec![0; 32], chain, 2).unwrap();
        let r = crate::derive_account_address_range(vec![0; 32], 3, 1).unwrap()[0].clone();
        let private = format!(
            "imt:{}:nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
            "ab".repeat(32)
        );
        credit.source_owner =
            crate::derive_earn_cycle_addresses(vec![0; 32], chain, 2).unwrap()[1].clone();
        credit.confidential_account = c.clone();
        credit.source_chain_id = chain;
        credit.source_token = if native_eth {
            format!("{:#x}", Address::ZERO)
        } else {
            if chain == 1 { ETH_USDC } else { HOOD_USDG }.into()
        };
        credit.source_decimals = if native_eth { 18 } else { 6 };
        credit.source_asset_id = if native_eth {
            "nep141:eth.ethereum"
        } else {
            "nep141:usdc.ethereum"
        }
        .into();
        credit.private_token_id = private.clone();
        quote.leg = "withdrawal".into();
        quote.confidential_account = c.clone();
        quote.refund_account = c.clone();
        quote.source_asset_id = credit.source_asset_id.clone();
        quote.private_token_id = private.clone();
        quote.amount_atoms = credit.credited_atoms.clone();
        quote.destination_token = MONAD_USDC.into();
        quote.destination_recipient = r.clone();
        let mut message: Value = serde_json::from_str(&raw).unwrap();
        message["signer_id"] = json!(c.to_lowercase());
        message["intents"][0]["tokens"] = json!({private:credit.credited_atoms});
        let payload = message.to_string();
        let payload_hash = format!("{:#x}", keccak256(payload.as_bytes()));
        quote.payload_hash = payload_hash.clone();
        journal.leg = "withdrawal".into();
        journal.payload_hash = payload_hash;
        let p = json!({"kind":"confidentialWithdrawal","operationId":original["operationId"],"revision":7,"profileChainId":chain,"cycleIndex":2,"recipientIndex":3,"expectedSigner":c,"expectedRecipient":r,"returnOperationId":"return1","returnQuoteId":original["sourceQuoteId"],"returnTransactionHash":original["sourceTransactionHash"],"returnHistoryId":original["sourceHistoryId"],"creditedAtoms":original["creditedAtoms"],"amountAtoms":original["creditedAtoms"],"quoteId":original["quoteId"],"minimumDestinationAtoms":"1","deadlineMs":original["deadlineMs"]});
        (
            p,
            NativeEarnReturnedCreditProof {
                return_operation_id: "return1".into(),
                credit,
            },
            NativeEarnWithdrawalQuoteBinding {
                destination_chain_id: 143,
                quote,
            },
            payload,
            journal,
        )
    }
    #[test]
    fn separate_withdrawal_pays_only_returned_credit_to_a_fresh_public_recipient() {
        for (chain, eth) in [(1, false), (1, true), (4663, false)] {
            let (p, credit, quote, payload, journal) = withdrawal_fixture(chain, eth);
            let op = ConfidentialEarnWithdrawalOperation::new(
                p.to_string(),
                vec![0; 32],
                crate::role_registry_covering(3).unwrap(),
            )
            .unwrap();
            let review = op
                .prepare(7, credit, quote, payload.clone(), journal.clone())
                .unwrap();
            assert!(review.contains("WITHDRAWAL"));
            assert!(review.contains("143"));
            assert!(op.sign(7, journal.clone()).is_err());
            op.approve(7, op.review_hash().unwrap()).unwrap();
            let signed = op.sign(7, journal.clone()).unwrap();
            let bytes = bs58::decode(signed.signature.strip_prefix("secp256k1:").unwrap())
                .into_vec()
                .unwrap();
            let digest = keccak256(format!(
                "\x19Ethereum Signed Message:\n{}{}",
                payload.len(),
                payload
            ));
            let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
                digest.as_ref(),
                &k256::ecdsa::Signature::from_slice(&bytes[..64]).unwrap(),
                k256::ecdsa::RecoveryId::from_byte(bytes[64]).unwrap(),
            )
            .unwrap();
            assert_eq!(address(&key), p["expectedSigner"]);
            assert_eq!(signed.leg, "withdrawal");
            assert!(op.sign(7, journal).is_err());
        }
    }
    #[test]
    fn withdrawal_rejects_unallocated_recipient_other_return_child_and_wrong_private_asset() {
        let (p, credit, quote, payload, journal) = withdrawal_fixture(1, false);
        assert!(
            ConfidentialEarnWithdrawalOperation::new(
                p.to_string(),
                vec![0; 32],
                crate::role_registry_initial()
            )
            .is_err()
        );
        for field in ["recipientIndex", "cycleIndex", "amountAtoms"] {
            let mut bad = p.clone();
            bad[field] = if field == "amountAtoms" {
                json!("900001")
            } else {
                json!(0)
            };
            assert!(
                ConfidentialEarnWithdrawalOperation::new(
                    bad.to_string(),
                    vec![0; 32],
                    crate::role_registry_covering(3).unwrap()
                )
                .is_err()
            );
        }
        for mutation in 0..9 {
            let op = ConfidentialEarnWithdrawalOperation::new(
                p.to_string(),
                vec![0; 32],
                crate::role_registry_covering(3).unwrap(),
            )
            .unwrap();
            let (mut c, mut q, mut j) = (credit.clone(), quote.clone(), journal.clone());
            match mutation {
                0 => c.return_operation_id = "another-return".into(),
                1 => c.credit.source_transaction_hash = hash(0x99),
                2 => c.credit.credited_atoms = "1000002".into(),
                3 => {
                    c.credit.private_token_id =
                        format!("imt:{}:nep141:eth.ethereum", "ab".repeat(32))
                }
                4 => q.destination_chain_id = 1,
                5 => q.quote.destination_recipient = recipient(1, "invest"),
                6 => q.quote.destination_token = ETH_USDC.into(),
                7 => j.previous_submission_unresolved = true,
                _ => q.quote.refund_account = recipient(1, "invest"),
            }
            assert!(op.prepare(7, c, q, payload.clone(), j).is_err());
        }
        // A withdrawal kind is never accepted through the deposit payout constructor.
        assert!(EarnPayoutOperation::new(p.to_string(), vec![0; 32]).is_err());
    }

    #[test]
    fn split_offset_assigns_global_ten_percent_rounding_to_the_correct_child() {
        let mut hold = proposal(1, "hold");
        hold["creditedAtoms"] = json!("11");
        hold["amountAtoms"] = json!("2");
        hold["splitOffsetAtoms"] = json!("9");
        hold["sourceAccountIndex"] = json!(1);
        assert!(EarnPayoutOperation::new(hold.to_string(), vec![0; 32]).is_ok());
        hold["amountAtoms"] = json!("1");
        assert!(EarnPayoutOperation::new(hold.to_string(), vec![0; 32]).is_err());
        let mut invest = proposal(1, "invest");
        invest["creditedAtoms"] = json!("11");
        invest["amountAtoms"] = json!("9");
        invest["splitOffsetAtoms"] = json!("9");
        assert!(EarnPayoutOperation::new(invest.to_string(), vec![0; 32]).is_ok());
    }

    #[test]
    fn deposit_credit_binds_the_selected_public_source_owner() {
        let mut p = proposal(1, "invest");
        p["sourceAccountIndex"] = json!(1);
        let (mut credit, quote, payload, journal) = evidence(&p);
        credit.source_owner = crate::derive_account_addresses(vec![0; 32]).unwrap()[1].clone();
        let operation = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            operation
                .prepare(
                    7,
                    credit.clone(),
                    quote.clone(),
                    payload.clone(),
                    journal.clone()
                )
                .is_ok()
        );
        let operation = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
        credit.source_owner = crate::derive_account_addresses(vec![0; 32]).unwrap()[0].clone();
        assert!(
            operation
                .prepare(7, credit, quote, payload, journal)
                .is_err()
        );
    }
    #[test]
    fn distribution_payouts_conserve_full_credit_and_bind_each_slot() {
        for chain in [1, 4663] {
            for weights in [
                vec![10000u64],
                vec![3700, 6300],
                vec![1000, 2000, 3000, 1500, 2500],
            ] {
                let mut allocated = 0;
                for (slot, weight) in weights.iter().enumerate() {
                    let amount = if slot + 1 == weights.len() {
                        1000001 - allocated
                    } else {
                        1000001 * weight / 10000
                    };
                    allocated += amount;
                    let mut p = proposal(chain, "invest");
                    p["distribution"] = json!({"version":1,"weightsBps":weights});
                    p["leg"] = json!(format!("invest:{slot}"));
                    p["quoteId"] = json!(format!("quote-{slot}"));
                    p["amountAtoms"] = json!(amount.to_string());
                    p["expectedRecipient"] =
                        json!(crate::distribution_test_address(chain, 0, slot as u32));
                    let op = EarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap();
                    let (credit, mut quote, payload, journal) = evidence(&p);
                    quote.quote_id = p["quoteId"].as_str().unwrap().into();
                    quote.destination_recipient = p["expectedRecipient"].as_str().unwrap().into();
                    let review = op
                        .prepare(7, credit, quote, payload, journal.clone())
                        .unwrap();
                    assert!(review.contains("Distribution v1"));
                    assert!(!review.contains("hold=floor10%"));
                    for weight in &weights {
                        assert!(review.contains(&format!("{weight} bps")));
                    }
                    op.approve(7, op.review_hash().unwrap()).unwrap();
                    assert_eq!(op.sign(7, journal).unwrap().leg, format!("invest:{slot}"));
                    let mut wrong = p.clone();
                    wrong["expectedRecipient"] = json!(recipient(chain, "invest"));
                    assert!(EarnPayoutOperation::new(wrong.to_string(), vec![0; 32]).is_err());
                    wrong = p.clone();
                    wrong["leg"] = json!("invest");
                    assert!(EarnPayoutOperation::new(wrong.to_string(), vec![0; 32]).is_err());
                    wrong = p.clone();
                    wrong["amountAtoms"] = json!((amount + 1).to_string());
                    assert!(EarnPayoutOperation::new(wrong.to_string(), vec![0; 32]).is_err());
                }
                assert_eq!(allocated, 1000001);
            }
        }
    }
    #[test]
    fn distribution_withdrawal_binds_return_credit_to_selected_investor() {
        let (mut p, mut credit, quote, payload, journal) = withdrawal_fixture(1, false);
        p["investmentSlot"] = json!(3);
        credit.credit.source_owner = crate::distribution_test_address(1, 2, 3);
        let op = ConfidentialEarnWithdrawalOperation::new(
            p.to_string(),
            vec![0; 32],
            crate::role_registry_covering(3).unwrap(),
        )
        .unwrap();
        op.prepare(7, credit, quote, payload, journal.clone())
            .unwrap();
        op.approve(7, op.review_hash().unwrap()).unwrap();
        assert_eq!(op.sign(7, journal).unwrap().leg, "withdrawal");
    }
}
