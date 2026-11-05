//! Constrained native ERC-4337 EntryPoint 0.8 / Simple7702 Earn signer.
//! Objects, approval, signatures and RPC payloads are private Kotlin/Swift FFI.
//! Platform must authenticate quotes through its fixed backend TLS, obtain
//! purpose-bound native passkey approval, serialize wallet/nonce operations and
//! journal both signatures before broadcast. Rust does not attest TLS/RPC truth.
use crate::{SignerError, address};
use alloy_consensus::private::alloy_eips::eip7702::Authorization;
use alloy_primitives::{Address, B256, U256, keccak256};
use bip32::XPrv;
use bip39::{Language, Mnemonic};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
const IMPLEMENTATION: &str = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
const ENTRY_POINT: &str = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const PAYMASTER: &str = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
const SOURCE_TOKEN: &str = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const HOOD_TOKEN: &str = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const HOOD_VAULT: &str = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const HOOD_ROUTER: &str = "0xcC108538f36242D6E0d6B9255f6D9Ccd137D70Fe";
const FACTORY: &str = "0x7702000000000000000000000000000000000000";
#[derive(Clone, uniffi::Record)]
pub struct NativeSponsoredState {
    pub chain_id: u64,
    pub owner: String,
    pub observed_at: u64,
    pub block_number: u64,
    pub block_hash: String,
    pub parent_hash: String,
    pub entry_point_nonce: String,
    pub transaction_nonce: u64,
    pub latest_transaction_nonce: u64,
    pub token_balance_atoms: String,
    pub paymaster_allowance_atoms: String,
    pub shares: String,
    pub preview_deposit_shares: String,
    pub max_redeem_shares: String,
    pub vault_asset: String,
    pub token_decimals: u32,
    pub sender_code: String,
    pub recipient_code: String,
    pub base_fee_wei: String,
    pub token_code_hash: String,
    pub paymaster_code_hash: String,
    pub implementation_code_hash: String,
    pub entry_point_code_hash: String,
    pub vault_code_hash: String,
    pub router_code_hash: String,
}
/// Only native authenticated fixed-backend TLS may construct this proof. It is
/// NOT an attestation if constructed from a JS/provider proposal. Platform must
/// authenticate C, asset registry, refund owner and quote body independently.
#[derive(Clone, uniffi::Record)]
pub struct NativeEarnQuoteBinding {
    pub operation_id: String,
    pub revision: u64,
    pub quote_id: String,
    pub chain_id: u64,
    pub token: String,
    pub recipient: String,
    pub amount_atoms: String,
    pub confidential_account: String,
    pub refund_owner: String,
    pub expires_at: u64,
    pub authenticated_body_hash: String,
    pub fee_policy: Option<String>,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeSignedEarnAuthorization {
    pub chain_id: u64,
    pub address: String,
    pub nonce: u64,
    pub from: String,
    pub r: String,
    pub s: String,
    pub y_parity: u32,
    pub signature_hash: String,
}
#[derive(uniffi::Record)]
pub struct NativeSignedEarnUserOperation {
    pub user_operation_hash: String,
    pub signature: String,
    pub rpc_user_operation: String,
    pub operation_id: String,
    pub revision: u64,
    pub review_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SponsoredProposal {
    kind: String,
    #[serde(default)]
    funding_batch_id: Option<String>,
    #[serde(default)]
    funding_batch_size: Option<u32>,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    #[serde(default)]
    source_account_index: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    profile_chain_id: u64,
    expected_from: String,
    token: String,
    amount_atoms: String,
    nonce: String,
    deadline: u64,
    maximum_token_fee_atoms: String,
    budget_atoms: String,
    withdrawal_reserve_atoms: String,
    slippage_bps: u32,
    vault: Option<String>,
    router: Option<String>,
    recipient: Option<String>,
    quote_id: Option<String>,
    confidential_account: Option<String>,
    refund_owner: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserOp {
    sender: String,
    nonce: String,
    call_data: String,
    call_gas_limit: String,
    verification_gas_limit: String,
    pre_verification_gas: String,
    paymaster_post_op_gas_limit: String,
    paymaster_verification_gas_limit: String,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
    paymaster: String,
    paymaster_data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    factory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    factory_data: Option<String>,
    #[serde(default = "empty_hex")]
    signature: String,
}
fn empty_hex() -> String {
    "0x".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegationProposal {
    kind: String,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    #[serde(default)]
    source_account_index: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    expected_from: String,
    nonce: u64,
    deadline: u64,
}
struct Authority {
    cycle_index: u32,
    investment_slot: Option<u32>,
    source_account_index: u32,
    seed: Option<Zeroizing<[u8; 64]>>,
    owner: String,
    chain: u64,
    operation_id: String,
    revision: u64,
    deadline: u64,
    started: Instant,
    lifetime: Duration,
    review_hash: Option<String>,
    approved: bool,
}
struct AuthorityConfig<'a> {
    chain: u64,
    cycle_index: u32,
    investment_slot: Option<u32>,
    source_account_index: Option<u32>,
    operation_id: String,
    revision: u64,
    deadline: u64,
    expected: &'a str,
}
impl Authority {
    fn new(entropy: Vec<u8>, config: AuthorityConfig<'_>) -> Result<Self, SignerError> {
        let AuthorityConfig {
            chain,
            cycle_index,
            investment_slot,
            source_account_index,
            operation_id,
            revision,
            deadline,
            expected,
        } = config;
        let started = Instant::now();
        let clock = now()?;
        if ![143, 4663].contains(&chain)
            || revision == 0
            || deadline <= clock
            || deadline > clock.checked_add(600).ok_or(SignerError::InvalidInput)?
            || operation_id.is_empty()
            || operation_id.len() > 128
            || !operation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(SignerError::InvalidInput);
        }
        let entropy = Zeroizing::new(entropy);
        if entropy.len() != 32 {
            return Err(SignerError::InvalidInput);
        }
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
            .map_err(|_| SignerError::CryptoFailed)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        drop(mnemonic);
        drop(entropy);
        if chain != 143 && source_account_index.is_some() {
            return Err(SignerError::InvalidInput);
        }
        let source_account_index = source_account_index.unwrap_or(0);
        let owner = address(
            key(
                &seed,
                chain,
                cycle_index,
                investment_slot,
                source_account_index,
            )?
            .private_key()
            .verifying_key(),
        );
        if addr(expected)? != addr(&owner)? {
            return Err(SignerError::InvalidInput);
        }
        Ok(Self {
            cycle_index,
            investment_slot,
            source_account_index,
            seed: Some(seed),
            owner,
            chain,
            operation_id,
            revision,
            deadline,
            started,
            lifetime: Duration::from_secs(deadline - clock),
            review_hash: None,
            approved: false,
        })
    }
    fn live(&mut self) -> Result<(), SignerError> {
        if now()? >= self.deadline || self.started.elapsed() >= self.lifetime {
            self.seed = None;
            return Err(SignerError::Expired);
        }
        if self.seed.is_none() {
            return Err(SignerError::InvalidInput);
        }
        Ok(())
    }
    fn approve(&mut self, revision: u64, hash: &str) -> Result<(), SignerError> {
        self.live()?;
        if revision != self.revision || self.approved || self.review_hash.as_deref() != Some(hash) {
            return Err(SignerError::InvalidInput);
        }
        self.approved = true;
        Ok(())
    }
    fn review_hash(&mut self) -> Result<String, SignerError> {
        self.live()?;
        self.review_hash.clone().ok_or(SignerError::InvalidInput)
    }
}
struct PreparedSponsored {
    op: UserOp,
    baseline: NativeSponsoredState,
    auth: Option<NativeSignedEarnAuthorization>,
    hash: B256,
    cap: U256,
}
struct SponsoredInner {
    proposal_hash: B256,
    a: Authority,
    p: SponsoredProposal,
    prepared: Option<PreparedSponsored>,
}
#[derive(uniffi::Object)]
pub struct SponsoredEarnOperation {
    state: Mutex<SponsoredInner>,
}
#[uniffi::export]
impl SponsoredEarnOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: SponsoredProposal = parse(&proposal)?;
        match (&p.funding_batch_id, p.funding_batch_size) {
            (None, None) => {}
            (Some(id), Some(size))
                if p.kind == "sourceFunding"
                    && (1..=256).contains(&size)
                    && !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) => {}
            _ => return Err(SignerError::InvalidInput),
        }

        let source = p.kind == "sourceFunding";
        if !(source && p.chain_id == 143
            || ["hoodDeposit", "hoodRedeemAll", "hoodTokenReturn"].contains(&p.kind.as_str())
                && p.chain_id == 4663)
            || ![1, 4663].contains(&p.profile_chain_id)
            || p.chain_id == 4663 && p.profile_chain_id != 4663
            || addr(&p.token)? != addr(if source { SOURCE_TOKEN } else { HOOD_TOKEN })?
            || dec(&p.amount_atoms)? == U256::ZERO
            || dec(&p.maximum_token_fee_atoms)? == U256::ZERO
            || dec(&p.budget_atoms)? == U256::ZERO
            || p.slippage_bps > 100
            || p.kind != "hoodDeposit" && p.slippage_bps != 0
            || hexnum(&p.nonce)? > U256::from(u64::MAX)
            || p.kind == "hoodDeposit" && dec(&p.withdrawal_reserve_atoms)? == U256::ZERO
        {
            return Err(SignerError::InvalidInput);
        }
        dec(&p.withdrawal_reserve_atoms)?;
        if source {
            if p.vault.is_some() || p.router.is_some() {
                return Err(SignerError::InvalidInput);
            }
        } else if addr(p.vault.as_deref().ok_or(SignerError::InvalidInput)?)? != addr(HOOD_VAULT)?
            || addr(p.router.as_deref().ok_or(SignerError::InvalidInput)?)? != addr(HOOD_ROUTER)?
        {
            return Err(SignerError::InvalidInput);
        }
        let transfer = source || p.kind == "hoodTokenReturn";
        if transfer {
            let recipient = addr(p.recipient.as_deref().ok_or(SignerError::InvalidInput)?)?;
            if recipient.as_slice()[..18].iter().all(|v| *v == 0)
                || recipient == addr(&p.expected_from)?
                || p.quote_id
                    .as_ref()
                    .is_none_or(|id| id.is_empty() || id.len() > 128)
            {
                return Err(SignerError::InvalidInput);
            }
            addr(
                p.confidential_account
                    .as_deref()
                    .ok_or(SignerError::InvalidInput)?,
            )?;
            addr(p.refund_owner.as_deref().ok_or(SignerError::InvalidInput)?)?;
        } else if p.recipient.is_some()
            || p.quote_id.is_some()
            || p.confidential_account.is_some()
            || p.refund_owner.is_some()
        {
            return Err(SignerError::InvalidInput);
        }
        let a = Authority::new(
            entropy,
            AuthorityConfig {
                chain: p.chain_id,
                cycle_index: p.cycle_index,
                investment_slot: p.investment_slot,
                source_account_index: p.source_account_index,
                operation_id: p.operation_id.clone(),
                revision: p.revision,
                deadline: p.deadline,
                expected: &p.expected_from,
            },
        )?;
        Ok(Arc::new(Self {
            state: Mutex::new(SponsoredInner {
                proposal_hash: keccak256(proposal.as_bytes()),
                a,
                p,
                prepared: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        user_operation: String,
        current: NativeSponsoredState,
        quote: Option<NativeEarnQuoteBinding>,
        authorization: Option<NativeSignedEarnAuthorization>,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || s.prepared.is_some() {
            return Err(SignerError::InvalidInput);
        }
        let op: UserOp = parse(&user_operation)?;
        check_sponsored(&s.a, &s.p, &op, &current, authorization.as_ref())?;
        check_quote(&s.a, &s.p, quote.as_ref())?;
        let cap = fee_cap(&op, &s.p.token)?;
        if cap > dec(&s.p.maximum_token_fee_atoms)? {
            return Err(SignerError::InvalidInput);
        }
        let amount = dec(&s.p.amount_atoms)?;
        let balance = dec(&current.token_balance_atoms)?;
        let reserve = dec(&s.p.withdrawal_reserve_atoms)?;
        let spend = if s.p.kind == "hoodRedeemAll" {
            cap
        } else {
            amount.checked_add(cap).ok_or(SignerError::InvalidInput)?
        };
        if spend > dec(&s.p.budget_atoms)?
            || spend
                .checked_add(reserve)
                .ok_or(SignerError::InvalidInput)?
                > balance
        {
            return Err(SignerError::InvalidInput);
        }
        let decoded = decode_calls(&bytes(&op.call_data, 16384)?)?;
        let mut expected = Vec::new();
        if dec(&current.paymaster_allowance_atoms)? < cap {
            let first = decoded.first().ok_or(SignerError::InvalidInput)?;
            if first.to != addr(&s.p.token)?
                || first.data.len() != 68
                || first.data[..4] != keccak256(b"approve(address,uint256)")[..4]
                || read_address(&first.data, 4)? != addr(PAYMASTER)?
            {
                return Err(SignerError::InvalidInput);
            }
            let approval = read_word(&first.data, 36)?;
            let upper = ceil(
                cap.checked_mul(U256::from(101))
                    .ok_or(SignerError::InvalidInput)?,
                U256::from(100),
            )?;
            if approval < cap || approval > upper {
                return Err(SignerError::InvalidInput);
            }
            expected.push(token_call(&s.p.token, "approve", PAYMASTER, approval)?);
        }
        if s.p.kind == "sourceFunding" || s.p.kind == "hoodTokenReturn" {
            expected.push(token_call(
                &s.p.token,
                "transfer",
                s.p.recipient.as_deref().ok_or(SignerError::InvalidInput)?,
                amount,
            )?);
        } else {
            if s.p.kind == "hoodRedeemAll"
                && (dec(&current.shares)? != amount || dec(&current.max_redeem_shares)? < amount)
            {
                return Err(SignerError::InvalidInput);
            }
            let price = if s.p.kind == "hoodDeposit" {
                // The vault accrues interest every block, so the planner's share price cannot match
                // a later recomputation exactly. Accept it only between the live price and the
                // live price plus the approved slippage; every other call byte stays exact.
                let shares = dec(&current.preview_deposit_shares)?;
                let router = decoded.last().ok_or(SignerError::InvalidInput)?;
                if router.to != addr(HOOD_ROUTER)? {
                    return Err(SignerError::InvalidInput);
                }
                let planned = read_word(&router.data, 68)?;
                if planned < price(amount, shares, 0)?
                    || planned > price(amount, shares, s.p.slippage_bps)?
                {
                    return Err(SignerError::InvalidInput);
                }
                planned
            } else {
                U256::ZERO
            };
            expected.push(token_call(
                if s.p.kind == "hoodDeposit" {
                    HOOD_TOKEN
                } else {
                    HOOD_VAULT
                },
                "approve",
                HOOD_ROUTER,
                amount,
            )?);
            expected.push(Call {
                to: addr(HOOD_ROUTER)?,
                data: vault_input(s.p.kind == "hoodDeposit", amount, price, s.p.deadline),
            });
        }
        if decoded != expected {
            return Err(SignerError::InvalidInput);
        }
        let hash = user_op_hash(s.a.chain, &op, authorization.as_ref())?;
        let review = format!(
            "{} · chain {}\nOperation {} · revision {}\nOwner {}\nToken {}\nAmount {} base units\nMaximum token gas charge {} · approved fee bound {}\nBudget {} · retained withdrawal reserve {} base units\nNonce {} · deadline {}\nEntryPoint {} · implementation {}\nPaymaster {}\nVault {} · router {}\nRecipient {} · confidential account {} · refund owner {}\nSlippage {} bps\nCalls {} · hash {:#x}\nDelegation authorization included: {}\nExact atomic wallet calls only. Withdrawal is separately authorized. Full redemption has no minimum-assets output guard. Local expiry cannot revoke signed transfer/UserOp/7702 authorization. Journal before broadcast.",
            s.p.kind,
            s.a.chain,
            s.a.operation_id,
            s.a.revision,
            s.a.owner,
            s.p.token,
            s.p.amount_atoms,
            cap,
            s.p.maximum_token_fee_atoms,
            s.p.budget_atoms,
            s.p.withdrawal_reserve_atoms,
            s.p.nonce,
            s.a.deadline,
            ENTRY_POINT,
            IMPLEMENTATION,
            PAYMASTER,
            s.p.vault.as_deref().unwrap_or("none"),
            s.p.router.as_deref().unwrap_or("none"),
            s.p.recipient.as_deref().unwrap_or("none"),
            s.p.confidential_account.as_deref().unwrap_or("none"),
            s.p.refund_owner.as_deref().unwrap_or("none"),
            s.p.slippage_bps,
            expected.len(),
            hash,
            authorization.is_some()
        );
        let review = if let Some(q) = &quote {
            format!(
                "{review}\n{}",
                crate::earn_fees::review(
                    q.fee_policy.as_deref(),
                    if s.p.kind == "sourceFunding" {
                        "source"
                    } else {
                        "returnRobinhood"
                    },
                    None
                )?
            )
        } else {
            review
        };
        let mut binding = review.as_bytes().to_vec();
        binding.extend_from_slice(user_operation.as_bytes());
        binding.extend_from_slice(s.proposal_hash.as_ref());
        if let Some(q) = &quote {
            binding.extend_from_slice(q.authenticated_body_hash.as_bytes());
        }
        s.a.review_hash = Some(format!("{:#x}", keccak256(binding)));
        s.prepared = Some(PreparedSponsored {
            op,
            baseline: current,
            auth: authorization,
            hash,
            cap,
        });
        Ok(review)
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        self.state
            .lock()
            .map_err(|_| SignerError::CryptoFailed)?
            .a
            .review_hash()
    }
    pub fn approve(&self, revision: u64, review_hash: String) -> Result<(), SignerError> {
        self.state
            .lock()
            .map_err(|_| SignerError::CryptoFailed)?
            .a
            .approve(revision, &review_hash)
    }
    pub fn sign(
        &self,
        revision: u64,
        current: NativeSponsoredState,
    ) -> Result<NativeSignedEarnUserOperation, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if !s.a.approved {
            return Err(SignerError::InvalidInput);
        }
        let checked = (|| {
            let p = s.prepared.as_ref().ok_or(SignerError::InvalidInput)?;
            if revision != s.a.revision {
                return Err(SignerError::InvalidInput);
            }
            check_sponsored(&s.a, &s.p, &p.op, &current, p.auth.as_ref())?;
            continuity(&p.baseline, &current)?;
            if fee_cap(&p.op, &s.p.token)? != p.cap {
                return Err(SignerError::InvalidInput);
            }
            Ok(())
        })();
        if let Err(e) = checked {
            s.a.seed = None;
            return Err(e);
        }
        let seed = s.a.seed.take().ok_or(SignerError::InvalidInput)?;
        let p = s.prepared.as_ref().ok_or(SignerError::InvalidInput)?;
        let signature = sign_hash(
            &seed,
            s.a.chain,
            s.a.cycle_index,
            s.a.investment_slot,
            s.a.source_account_index,
            p.hash,
        )?;
        let mut rpc = serde_json::to_value(&p.op).map_err(|_| SignerError::CryptoFailed)?;
        rpc["signature"] = serde_json::json!(signature);
        if let Some(auth) = &p.auth {
            rpc["eip7702Auth"] = serde_json::json!({"chainId":format!("0x{:x}",auth.chain_id),"address":auth.address,"nonce":format!("0x{:x}",auth.nonce),"r":auth.r,"s":auth.s,"yParity":format!("0x{:02x}",auth.y_parity)});
        }
        Ok(NativeSignedEarnUserOperation {
            user_operation_hash: format!("{:#x}", p.hash),
            signature,
            rpc_user_operation: rpc.to_string(),
            operation_id: s.a.operation_id.clone(),
            revision: s.a.revision,
            review_hash: s.a.review_hash.clone().ok_or(SignerError::InvalidInput)?,
        })
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.a.seed = None;
            s.a.approved = false;
        }
    }
}
struct DelegationInner {
    a: Authority,
    p: DelegationProposal,
    baseline: Option<NativeSponsoredState>,
}
#[derive(uniffi::Object)]
pub struct EarnDelegationOperation {
    state: Mutex<DelegationInner>,
}
#[uniffi::export]
impl EarnDelegationOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: DelegationProposal = parse(&proposal)?;
        if !(p.kind == "authorizeSource7702" && p.chain_id == 143
            || p.kind == "authorizeHood7702" && p.chain_id == 4663)
            || p.nonce == u64::MAX
        {
            return Err(SignerError::InvalidInput);
        }
        let a = Authority::new(
            entropy,
            AuthorityConfig {
                chain: p.chain_id,
                cycle_index: p.cycle_index,
                investment_slot: p.investment_slot,
                source_account_index: p.source_account_index,
                operation_id: p.operation_id.clone(),
                revision: p.revision,
                deadline: p.deadline,
                expected: &p.expected_from,
            },
        )?;
        Ok(Arc::new(Self {
            state: Mutex::new(DelegationInner {
                a,
                p,
                baseline: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        current: NativeSponsoredState,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || s.baseline.is_some() {
            return Err(SignerError::InvalidInput);
        }
        check_delegation(&s.a, s.p.nonce, &current)?;
        let review = format!(
            "EIP-7702 delegation · chain {}\nOperation {} · revision {}\nOwner {}\nDelegate {}\nAuthorization nonce {}\nDeadline {} (local authority only)\nPersistent account delegation enables EntryPoint08 {} execution. Sign only after explicit native passkey approval; never during preview. Signed authorization has no on-chain deadline and must be journaled with its sponsored UserOperation.",
            s.a.chain,
            s.a.operation_id,
            s.a.revision,
            s.a.owner,
            IMPLEMENTATION,
            s.p.nonce,
            s.a.deadline,
            ENTRY_POINT
        );
        s.a.review_hash = Some(format!("{:#x}", keccak256(review.as_bytes())));
        s.baseline = Some(current);
        Ok(review)
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        self.state
            .lock()
            .map_err(|_| SignerError::CryptoFailed)?
            .a
            .review_hash()
    }
    pub fn approve(&self, revision: u64, review_hash: String) -> Result<(), SignerError> {
        self.state
            .lock()
            .map_err(|_| SignerError::CryptoFailed)?
            .a
            .approve(revision, &review_hash)
    }
    pub fn sign(
        &self,
        revision: u64,
        current: NativeSponsoredState,
    ) -> Result<NativeSignedEarnAuthorization, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if !s.a.approved {
            return Err(SignerError::InvalidInput);
        }
        let check = (|| {
            if revision != s.a.revision {
                return Err(SignerError::InvalidInput);
            }
            check_delegation(&s.a, s.p.nonce, &current)?;
            continuity(
                s.baseline.as_ref().ok_or(SignerError::InvalidInput)?,
                &current,
            )
        })();
        if let Err(e) = check {
            s.a.seed = None;
            return Err(e);
        }
        let seed = s.a.seed.take().ok_or(SignerError::InvalidInput)?;
        let hash = authorization_hash(s.a.chain, s.p.nonce)?;
        let sig = bytes(
            &sign_hash(
                &seed,
                s.a.chain,
                s.a.cycle_index,
                s.a.investment_slot,
                s.a.source_account_index,
                hash,
            )?,
            65,
        )?;
        Ok(NativeSignedEarnAuthorization {
            chain_id: s.a.chain,
            address: IMPLEMENTATION.into(),
            nonce: s.p.nonce,
            from: s.a.owner.clone(),
            r: alloy_primitives::hex::encode_prefixed(&sig[..32]),
            s: alloy_primitives::hex::encode_prefixed(&sig[32..64]),
            y_parity: u32::from(sig[64] - 27),
            signature_hash: format!("{hash:#x}"),
        })
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.a.seed = None;
            s.a.approved = false;
        }
    }
}
fn now() -> Result<u64, SignerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|_| SignerError::InvalidInput)
}
fn parse<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, SignerError> {
    if s.len() > 65536 {
        return Err(SignerError::InvalidInput);
    }
    serde_json::from_str(s).map_err(|_| SignerError::InvalidInput)
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
fn hexnum(s: &str) -> Result<U256, SignerError> {
    let d = s.strip_prefix("0x").ok_or(SignerError::InvalidInput)?;
    if d.is_empty()
        || d.len() > 64
        || d.len() > 1 && d.starts_with('0')
        || !d.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(SignerError::InvalidInput);
    }
    U256::from_str_radix(d, 16).map_err(|_| SignerError::InvalidInput)
}
fn bytes(s: &str, max: usize) -> Result<Vec<u8>, SignerError> {
    if !s.starts_with("0x") || !s.len().is_multiple_of(2) || s.len() > max * 2 + 2 {
        return Err(SignerError::InvalidInput);
    }
    alloy_primitives::hex::decode(s).map_err(|_| SignerError::InvalidInput)
}
fn key(
    seed: &[u8; 64],
    chain: u64,
    cycle_index: u32,
    investment_slot: Option<u32>,
    source_account_index: u32,
) -> Result<XPrv, SignerError> {
    if chain == 143 {
        if investment_slot.is_some() {
            return Err(SignerError::InvalidInput);
        }
        crate::roles::validate_public_source_index(source_account_index)?;
        // Validate the complete cycle's fixed namespace before approving source funds.
        if cycle_index > (0x7fff_ffff - 2) / 3 {
            return Err(SignerError::InvalidInput);
        }
        crate::roles::derive_key(seed, source_account_index)
    } else {
        crate::earn_distribution::earn_investment_key(seed, chain, cycle_index, investment_slot)
    }
}
fn sign_hash(
    seed: &[u8; 64],
    chain: u64,
    cycle_index: u32,
    investment_slot: Option<u32>,
    source_account_index: u32,
    hash: B256,
) -> Result<String, SignerError> {
    let (sig, id) = key(
        seed,
        chain,
        cycle_index,
        investment_slot,
        source_account_index,
    )?
    .private_key()
    .sign_prehash_recoverable(hash.as_ref());
    if id.to_byte() > 1 {
        return Err(SignerError::CryptoFailed);
    }
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + id.to_byte());
    Ok(alloy_primitives::hex::encode_prefixed(out))
}
fn nonzero_hash(s: &str) -> Result<(), SignerError> {
    if bytes(s, 32)?.len() != 32
        || s.parse::<B256>().map_err(|_| SignerError::InvalidInput)? == B256::ZERO
        || s.eq_ignore_ascii_case(&format!("{:#x}", keccak256([])))
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn common_state(a: &Authority, s: &NativeSponsoredState) -> Result<(), SignerError> {
    let clock = now()?;
    if s.chain_id != a.chain
        || addr(&s.owner)? != addr(&a.owner)?
        || s.observed_at > clock
        || clock - s.observed_at > 15
        || s.block_number == 0
        || s.token_decimals != 6
        || s.transaction_nonce != s.latest_transaction_nonce
    {
        return Err(SignerError::InvalidInput);
    }
    for h in [
        &s.block_hash,
        &s.parent_hash,
        &s.token_code_hash,
        &s.paymaster_code_hash,
        &s.implementation_code_hash,
        &s.entry_point_code_hash,
    ] {
        nonzero_hash(h)?;
    }
    for v in [
        &s.token_balance_atoms,
        &s.paymaster_allowance_atoms,
        &s.shares,
        &s.preview_deposit_shares,
        &s.max_redeem_shares,
        &s.base_fee_wei,
    ] {
        dec(v)?;
    }
    hexnum(&s.entry_point_nonce)?;
    Ok(())
}
fn check_delegation(
    a: &Authority,
    nonce: u64,
    s: &NativeSponsoredState,
) -> Result<(), SignerError> {
    common_state(a, s)?;
    if s.transaction_nonce != nonce || s.sender_code != "0x" {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_sponsored(
    a: &Authority,
    p: &SponsoredProposal,
    op: &UserOp,
    s: &NativeSponsoredState,
    auth: Option<&NativeSignedEarnAuthorization>,
) -> Result<(), SignerError> {
    common_state(a, s)?;
    if addr(&op.sender)? != addr(&a.owner)?
        || hexnum(&op.nonce)? != hexnum(&p.nonce)?
        || hexnum(&s.entry_point_nonce)? != hexnum(&p.nonce)?
        || addr(&op.paymaster)? != addr(PAYMASTER)?
        || op.signature != "0x"
        || hexnum(&op.max_priority_fee_per_gas)? > hexnum(&op.max_fee_per_gas)?
        || dec(&s.base_fee_wei)?
            .checked_add(hexnum(&op.max_priority_fee_per_gas)?)
            .ok_or(SignerError::InvalidInput)?
            > hexnum(&op.max_fee_per_gas)?
    {
        return Err(SignerError::InvalidInput);
    }
    for fee in [&op.max_fee_per_gas, &op.max_priority_fee_per_gas] {
        if hexnum(fee)? > U256::from(u128::MAX) {
            return Err(SignerError::InvalidInput);
        }
    }
    for gas in [
        &op.call_gas_limit,
        &op.verification_gas_limit,
        &op.pre_verification_gas,
        &op.paymaster_post_op_gas_limit,
        &op.paymaster_verification_gas_limit,
    ] {
        let n = hexnum(gas)?;
        if n == U256::ZERO || n > U256::from(10_000_000) {
            return Err(SignerError::InvalidInput);
        }
    }
    match (&op.factory, &op.factory_data) {
        (None, None) => (),
        (Some(f), Some(d)) if (f == "0x7702" || f.eq_ignore_ascii_case(FACTORY)) && d == "0x" => (),
        _ => return Err(SignerError::InvalidInput),
    }
    if s.sender_code == "0x" {
        if op.factory.is_none() {
            return Err(SignerError::InvalidInput);
        }
        validate_auth(a, s, auth.ok_or(SignerError::InvalidInput)?)?;
    } else if !s
        .sender_code
        .eq_ignore_ascii_case(&format!("0xef0100{}", &IMPLEMENTATION[2..]))
        || auth.is_some()
    {
        return Err(SignerError::InvalidInput);
    }
    if p.chain_id == 4663 {
        if addr(&s.vault_asset)? != addr(HOOD_TOKEN)? {
            return Err(SignerError::InvalidInput);
        }
        nonzero_hash(&s.vault_code_hash)?;
        nonzero_hash(&s.router_code_hash)?;
    }
    if (p.kind == "sourceFunding" || p.kind == "hoodTokenReturn") && s.recipient_code != "0x" {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn validate_auth(
    a: &Authority,
    s: &NativeSponsoredState,
    auth: &NativeSignedEarnAuthorization,
) -> Result<(), SignerError> {
    if auth.chain_id != a.chain
        || addr(&auth.address)? != addr(IMPLEMENTATION)?
        || addr(&auth.from)? != addr(&a.owner)?
        || auth.nonce != s.transaction_nonce
        || auth.y_parity > 1
    {
        return Err(SignerError::InvalidInput);
    }
    let hash = authorization_hash(a.chain, auth.nonce)?;
    if auth.signature_hash != format!("{hash:#x}") {
        return Err(SignerError::InvalidInput);
    }
    let mut sig = bytes(&auth.r, 32)?;
    sig.extend_from_slice(&bytes(&auth.s, 32)?);
    if sig.len() != 64 {
        return Err(SignerError::InvalidInput);
    }
    let sig = k256::ecdsa::Signature::from_slice(&sig).map_err(|_| SignerError::CryptoFailed)?;
    let id =
        k256::ecdsa::RecoveryId::from_byte(auth.y_parity as u8).ok_or(SignerError::InvalidInput)?;
    let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(hash.as_ref(), &sig, id)
        .map_err(|_| SignerError::CryptoFailed)?;
    if addr(&address(&recovered))? != addr(&a.owner)? {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn authorization_hash(chain: u64, nonce: u64) -> Result<B256, SignerError> {
    Ok(Authorization {
        chain_id: U256::from(chain),
        address: addr(IMPLEMENTATION)?,
        nonce,
    }
    .signature_hash())
}
fn continuity(b: &NativeSponsoredState, s: &NativeSponsoredState) -> Result<(), SignerError> {
    if b.owner != s.owner
        || b.entry_point_nonce != s.entry_point_nonce
        || b.transaction_nonce != s.transaction_nonce
        || b.sender_code != s.sender_code
        || b.token_balance_atoms != s.token_balance_atoms
        || b.paymaster_allowance_atoms != s.paymaster_allowance_atoms
        || b.shares != s.shares
        || b.preview_deposit_shares != s.preview_deposit_shares
        || b.max_redeem_shares != s.max_redeem_shares
        || b.token_code_hash != s.token_code_hash
        || b.paymaster_code_hash != s.paymaster_code_hash
        || b.implementation_code_hash != s.implementation_code_hash
        || b.entry_point_code_hash != s.entry_point_code_hash
        || b.vault_code_hash != s.vault_code_hash
        || b.router_code_hash != s.router_code_hash
        || !(b.block_number == s.block_number && b.block_hash == s.block_hash
            || s.block_number
                == b.block_number
                    .checked_add(1)
                    .ok_or(SignerError::InvalidInput)?
                && s.parent_hash == b.block_hash)
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_quote(
    a: &Authority,
    p: &SponsoredProposal,
    q: Option<&NativeEarnQuoteBinding>,
) -> Result<(), SignerError> {
    if p.kind != "sourceFunding" && p.kind != "hoodTokenReturn" {
        if q.is_some() {
            return Err(SignerError::InvalidInput);
        }
        return Ok(());
    }
    let q = q.ok_or(SignerError::InvalidInput)?;
    let clock = now()?;
    let seed = a.seed.as_ref().ok_or(SignerError::InvalidInput)?;
    let c = address(
        crate::earn_cycle_key(seed, p.profile_chain_id, p.cycle_index, 2)?
            .private_key()
            .verifying_key(),
    );
    if q.operation_id != a.operation_id
        || q.revision != a.revision
        || Some(&q.quote_id) != p.quote_id.as_ref()
        || q.chain_id != a.chain
        || addr(&q.token)? != addr(&p.token)?
        || Some(&q.recipient) != p.recipient.as_ref()
        || q.amount_atoms != p.amount_atoms
        || Some(&q.confidential_account) != p.confidential_account.as_ref()
        || addr(&q.confidential_account)? != addr(&c)?
        || Some(&q.refund_owner) != p.refund_owner.as_ref()
        || addr(&q.refund_owner)? != addr(&a.owner)?
        || q.expires_at < a.deadline
        || q.expires_at <= clock
        || q.expires_at > clock + 600
    {
        return Err(SignerError::InvalidInput);
    }
    nonzero_hash(&q.authenticated_body_hash)
}
fn ceil(n: U256, d: U256) -> Result<U256, SignerError> {
    if d == U256::ZERO {
        return Err(SignerError::InvalidInput);
    }
    let (q, r) = n.div_rem(d);
    q.checked_add(U256::from(u8::from(r != U256::ZERO)))
        .ok_or(SignerError::InvalidInput)
}
fn fee_cap(op: &UserOp, token: &str) -> Result<U256, SignerError> {
    let data = bytes(&op.paymaster_data, 4096)?;
    // Pimlico's 118-byte direct-token config accepts compact (64) or full (65)
    // signatures. Preserve the complete payload when hashing/signing the UserOp.
    if ![182, 183].contains(&data.len())
        || ![2, 3].contains(&data[0])
        || data[1] != 0
        || Address::from_slice(&data[14..34]) != addr(token)?
    {
        return Err(SignerError::InvalidInput);
    }
    let until = U256::from_be_slice(&data[2..8]);
    let after = U256::from_be_slice(&data[8..14]);
    let clock = U256::from(now()?);
    if after > clock || until != U256::ZERO && until <= clock {
        return Err(SignerError::Expired);
    }
    let post = U256::from_be_slice(&data[34..50]);
    let rate = U256::from_be_slice(&data[50..82]);
    let fee = hexnum(&op.max_fee_per_gas)?;
    if rate == U256::ZERO || fee == U256::ZERO || post > U256::from(10_000_000) {
        return Err(SignerError::InvalidInput);
    }
    let mut gas = post;
    for f in [
        &op.call_gas_limit,
        &op.verification_gas_limit,
        &op.pre_verification_gas,
        &op.paymaster_post_op_gas_limit,
        &op.paymaster_verification_gas_limit,
    ] {
        gas = gas
            .checked_add(hexnum(f)?)
            .ok_or(SignerError::InvalidInput)?;
    }
    ceil(
        gas.checked_mul(fee)
            .and_then(|v| v.checked_mul(rate))
            .ok_or(SignerError::InvalidInput)?,
        U256::from(10u128.pow(18)),
    )
}
#[derive(PartialEq)]
struct Call {
    to: Address,
    data: Vec<u8>,
}
fn word(out: &mut Vec<u8>, v: U256) {
    out.extend_from_slice(&v.to_be_bytes::<32>());
}
fn aword(out: &mut Vec<u8>, v: Address) {
    out.extend_from_slice(&[0; 12]);
    out.extend_from_slice(v.as_slice());
}
fn token_call(token: &str, kind: &str, to: &str, amount: U256) -> Result<Call, SignerError> {
    let mut data = keccak256(format!("{kind}(address,uint256)").as_bytes())[..4].to_vec();
    aword(&mut data, addr(to)?);
    word(&mut data, amount);
    Ok(Call {
        to: addr(token)?,
        data,
    })
}
fn dynamic(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    word(&mut out, U256::from(data.len()));
    out.extend_from_slice(data);
    out.resize(out.len().div_ceil(32) * 32, 0);
    out
}
fn encode_calls(calls: &[Call]) -> Vec<u8> {
    let mut out = keccak256(if calls.len() == 1 {
        b"execute(address,uint256,bytes)".as_slice()
    } else {
        b"executeBatch((address,uint256,bytes)[])".as_slice()
    })[..4]
        .to_vec();
    if calls.len() == 1 {
        aword(&mut out, calls[0].to);
        word(&mut out, U256::ZERO);
        word(&mut out, U256::from(96));
        out.extend(dynamic(&calls[0].data));
    } else {
        word(&mut out, U256::from(32));
        word(&mut out, U256::from(calls.len()));
        let mut bodies = Vec::new();
        let mut offset = calls.len() * 32;
        for c in calls {
            word(&mut out, U256::from(offset));
            let mut body = Vec::new();
            aword(&mut body, c.to);
            word(&mut body, U256::ZERO);
            word(&mut body, U256::from(96));
            body.extend(dynamic(&c.data));
            offset += body.len();
            bodies.extend(body);
        }
        out.extend(bodies);
    }
    out
}
fn read_word(data: &[u8], at: usize) -> Result<U256, SignerError> {
    Ok(U256::from_be_slice(
        data.get(at..at.checked_add(32).ok_or(SignerError::InvalidInput)?)
            .ok_or(SignerError::InvalidInput)?,
    ))
}
fn index(data: &[u8], at: usize) -> Result<usize, SignerError> {
    usize::try_from(read_word(data, at)?).map_err(|_| SignerError::InvalidInput)
}
fn read_address(data: &[u8], at: usize) -> Result<Address, SignerError> {
    let v = data
        .get(at..at.checked_add(32).ok_or(SignerError::InvalidInput)?)
        .ok_or(SignerError::InvalidInput)?;
    if v[..12] != [0; 12] {
        return Err(SignerError::InvalidInput);
    }
    Ok(Address::from_slice(&v[12..]))
}
fn decode_call(data: &[u8], base: usize) -> Result<Call, SignerError> {
    let to = read_address(data, base)?;
    if read_word(data, base.checked_add(32).ok_or(SignerError::InvalidInput)?)? != U256::ZERO
        || index(data, base.checked_add(64).ok_or(SignerError::InvalidInput)?)? != 96
    {
        return Err(SignerError::InvalidInput);
    }
    let start = base.checked_add(96).ok_or(SignerError::InvalidInput)?;
    let length = index(data, start)?;
    let start = start.checked_add(32).ok_or(SignerError::InvalidInput)?;
    let end = start.checked_add(length).ok_or(SignerError::InvalidInput)?;
    Ok(Call {
        to,
        data: data
            .get(start..end)
            .ok_or(SignerError::InvalidInput)?
            .to_vec(),
    })
}
fn decode_calls(data: &[u8]) -> Result<Vec<Call>, SignerError> {
    if data.len() < 4 {
        return Err(SignerError::InvalidInput);
    }
    let mut calls = Vec::new();
    if data[..4] == keccak256(b"execute(address,uint256,bytes)")[..4] {
        calls.push(decode_call(data, 4)?);
    } else if data[..4] == keccak256(b"executeBatch((address,uint256,bytes)[])")[..4] {
        if index(data, 4)? != 32 {
            return Err(SignerError::InvalidInput);
        }
        let n = index(data, 36)?;
        if !(2..=3).contains(&n) {
            return Err(SignerError::InvalidInput);
        }
        for i in 0..n {
            let at = 68 + i * 32;
            let base = 68usize
                .checked_add(index(data, at)?)
                .ok_or(SignerError::InvalidInput)?;
            calls.push(decode_call(data, base)?);
        }
    } else {
        return Err(SignerError::InvalidInput);
    }
    if encode_calls(&calls) != data {
        return Err(SignerError::InvalidInput);
    }
    Ok(calls)
}
fn price(amount: U256, shares: U256, bps: u32) -> Result<U256, SignerError> {
    ceil(
        amount
            .checked_mul(U256::from(10u128.pow(27)))
            .and_then(|v| v.checked_mul(U256::from(10000 + bps)))
            .ok_or(SignerError::InvalidInput)?,
        shares
            .checked_mul(U256::from(10000))
            .ok_or(SignerError::InvalidInput)?,
    )
}
fn vault_input(deposit: bool, amount: U256, price: U256, deadline: u64) -> Vec<u8> {
    let mut out=keccak256(if deposit {b"vaultBundlesV1Deposit(address,uint256,uint256,(uint8,bytes),uint256,address,uint256)".as_slice()}else {b"vaultBundlesV1Withdraw(address,uint256,uint256,(uint256,uint256,uint256,uint8,bytes32,bytes32),uint256,address,uint256)".as_slice()})[..4].to_vec();
    aword(&mut out, HOOD_VAULT.parse().expect("pinned vault"));
    if deposit {
        for v in [
            amount,
            price,
            U256::from(224),
            U256::ZERO,
            U256::ZERO,
            U256::from(deadline),
            U256::ZERO,
            U256::from(64),
            U256::ZERO,
        ] {
            word(&mut out, v);
        }
    } else {
        for v in [
            U256::ZERO,
            amount,
            U256::ZERO,
            U256::ZERO,
            U256::from(deadline),
            U256::ZERO,
            U256::ZERO,
            U256::ZERO,
            U256::ZERO,
            U256::ZERO,
            U256::from(deadline),
        ] {
            word(&mut out, v);
        }
    }
    out
}
fn user_op_hash(
    chain: u64,
    op: &UserOp,
    auth: Option<&NativeSignedEarnAuthorization>,
) -> Result<B256, SignerError> {
    let mut domain = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    )
    .as_slice()
    .to_vec();
    domain.extend(keccak256(b"ERC4337").as_slice());
    domain.extend(keccak256(b"1").as_slice());
    word(&mut domain, U256::from(chain));
    aword(&mut domain, addr(ENTRY_POINT)?);
    let mut data=keccak256(b"PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)").as_slice().to_vec();
    aword(&mut data, addr(&op.sender)?);
    word(&mut data, hexnum(&op.nonce)?);
    let init = if op.factory.is_some() {
        addr(if auth.is_some() {
            IMPLEMENTATION
        } else {
            FACTORY
        })?
        .as_slice()
        .to_vec()
    } else {
        vec![]
    };
    data.extend(keccak256(init).as_slice());
    data.extend(keccak256(bytes(&op.call_data, 16384)?).as_slice());
    for f in [&op.verification_gas_limit, &op.call_gas_limit] {
        data.extend(
            u128::try_from(hexnum(f)?)
                .map_err(|_| SignerError::InvalidInput)?
                .to_be_bytes(),
        );
    }
    word(&mut data, hexnum(&op.pre_verification_gas)?);
    for f in [&op.max_priority_fee_per_gas, &op.max_fee_per_gas] {
        data.extend(
            u128::try_from(hexnum(f)?)
                .map_err(|_| SignerError::InvalidInput)?
                .to_be_bytes(),
        );
    }
    let mut paymaster = addr(&op.paymaster)?.as_slice().to_vec();
    for f in [
        &op.paymaster_verification_gas_limit,
        &op.paymaster_post_op_gas_limit,
    ] {
        paymaster.extend(
            u128::try_from(hexnum(f)?)
                .map_err(|_| SignerError::InvalidInput)?
                .to_be_bytes(),
        );
    }
    paymaster.extend(bytes(&op.paymaster_data, 4096)?);
    data.extend(keccak256(paymaster).as_slice());
    let mut encoded = vec![0x19, 0x01];
    encoded.extend(keccak256(domain).as_slice());
    encoded.extend(keccak256(data).as_slice());
    Ok(keccak256(encoded))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    const SOURCE: &str = "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb";
    const TOKEN: &str = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
    const HOOD: &str = "0x378740d42cdfa6Cf83D531359299E79e03f869A9";
    const USDG: &str = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    const IMPL: &str = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
    const PM: &str = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }
    fn state(chain: u64) -> NativeSponsoredState {
        NativeSponsoredState {
            chain_id: chain,
            owner: if chain == 143 { SOURCE } else { HOOD }.into(),
            observed_at: now(),
            block_number: 100,
            block_hash: format!("0x{}", "11".repeat(32)),
            parent_hash: format!("0x{}", "22".repeat(32)),
            entry_point_nonce: "0x4".into(),
            transaction_nonce: 4,
            latest_transaction_nonce: 4,
            token_balance_atoms: "10000000".into(),
            paymaster_allowance_atoms: "100000".into(),
            shares: "2000000".into(),
            preview_deposit_shares: "1000000".into(),
            max_redeem_shares: "2000000".into(),
            vault_asset: USDG.into(),
            token_decimals: 6,
            sender_code: format!("0xef0100{}", IMPL[2..].to_lowercase()),
            recipient_code: "0x".into(),
            base_fee_wei: "1000000".into(),
            token_code_hash: format!("0x{}", "33".repeat(32)),
            paymaster_code_hash: format!("0x{}", "44".repeat(32)),
            implementation_code_hash: format!("0x{}", "55".repeat(32)),
            entry_point_code_hash: format!("0x{}", "66".repeat(32)),
            vault_code_hash: format!("0x{}", "77".repeat(32)),
            router_code_hash: format!("0x{}", "88".repeat(32)),
        }
    }
    fn proposal() -> Value {
        json!({"kind":"sourceFunding","operationId":"fund-1","revision":7,"chainId":143,"profileChainId":1,"expectedFrom":SOURCE,"token":TOKEN,"amountAtoms":"1000000","nonce":"0x4","deadline":now()+300,"maximumTokenFeeAtoms":"100000","budgetAtoms":"2000000","withdrawalReserveAtoms":"0","slippageBps":0,"recipient":"0x1111111111111111111111111111111111111111","quoteId":"quote1","confidentialAccount":crate::derive_earn_confidential_address(vec![0;32],1).unwrap(),"refundOwner":SOURCE})
    }
    fn proof(p: &Value) -> NativeEarnQuoteBinding {
        NativeEarnQuoteBinding {
            operation_id: "fund-1".into(),
            revision: 7,
            quote_id: "quote1".into(),
            chain_id: 143,
            token: TOKEN.into(),
            recipient: p["recipient"].as_str().unwrap().into(),
            amount_atoms: "1000000".into(),
            confidential_account: p["confidentialAccount"].as_str().unwrap().into(),
            refund_owner: SOURCE.into(),
            expires_at: p["deadline"].as_u64().unwrap(),
            authenticated_body_hash: format!("0x{}", "99".repeat(32)),
            fee_policy: None,
        }
    }
    fn op() -> Value {
        let mut d = vec![0; 182];
        d[0] = 3;
        d[14..34].copy_from_slice(&alloy_primitives::hex::decode(TOKEN).unwrap());
        d[49] = 1;
        d[81] = 1;
        d[181] = 27;
        json!({"sender":SOURCE,"nonce":"0x4","callData":"0xb61d27f6000000000000000000000000754704bc059f8c67012fed69bc8a327a5aafb603000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000","callGasLimit":"0x186a0","verificationGasLimit":"0xc350","preVerificationGas":"0x7530","paymasterPostOpGasLimit":"0x2710","paymasterVerificationGasLimit":"0x4e20","maxFeePerGas":"0x3b9aca00","maxPriorityFeePerGas":"0xf4240","paymaster":PM,"paymasterData":alloy_primitives::hex::encode_prefixed(d),"signature":"0x"})
    }
    fn prepared() -> Arc<SponsoredEarnOperation> {
        let p = proposal();
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let review = o
            .prepare(7, op().to_string(), state(143), Some(proof(&p)), None)
            .unwrap();
        assert!(review.contains("sourceFunding"));
        o
    }
    #[test]
    fn source_hash_matches_viem_2569_and_signature_recovers_legacy_owner() {
        let o = prepared();
        assert!(o.sign(7, state(143)).is_err());
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let result = o.sign(7, state(143)).unwrap();
        assert_eq!(
            result.user_operation_hash,
            "0xeaac96509aa3441dd155f52c9a96e1c2b53b7e6105bfdf8e615b442720e30b20"
        );
        let signature = alloy_primitives::hex::decode(&result.signature).unwrap();
        let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
            &alloy_primitives::hex::decode(&result.user_operation_hash).unwrap(),
            &k256::ecdsa::Signature::from_slice(&signature[..64]).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(signature[64] - 27).unwrap(),
        )
        .unwrap();
        assert_eq!(crate::address(&key), SOURCE);
        assert!(o.sign(7, state(143)).is_err());
    }
    #[test]
    fn missing_native_quote_or_altered_provider_fields_never_authorize() {
        let p = proposal();
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, op().to_string(), state(143), None, None)
                .is_err()
        );
        for field in [
            "sender",
            "nonce",
            "paymaster",
            "callData",
            "maxFeePerGas",
            "factoryData",
            "signature",
        ] {
            let mut rpc = op();
            rpc[field] = json!(if field == "nonce" {
                "0x5"
            } else if field == "maxFeePerGas" {
                "0x100000000000000000000000000000000"
            } else if field == "signature" {
                "0x11"
            } else {
                "0x"
            });
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(
                o.prepare(7, rpc.to_string(), state(143), Some(proof(&p)), None)
                    .is_err(),
                "{field}"
            );
        }
        let mut q = proof(&p);
        q.recipient = HOOD.into();
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, op().to_string(), state(143), Some(q), None)
                .is_err()
        );
    }
    #[test]
    fn state_revision_expiry_and_concurrency_remove_one_shot_authority() {
        for i in 0..5 {
            let o = prepared();
            o.approve(7, o.review_hash().unwrap()).unwrap();
            let mut s = state(143);
            match i {
                0 => s.chain_id = 4663,
                1 => s.entry_point_nonce = "0x5".into(),
                2 => s.token_balance_atoms = "1".into(),
                3 => s.sender_code = "0x1234".into(),
                _ => s.observed_at = now() - 16,
            };
            assert!(o.sign(7, s).is_err());
            assert!(o.sign(7, state(143)).is_err());
        }
        let o = prepared();
        assert!(o.approve(8, o.review_hash().unwrap()).is_err());
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let a = o.clone();
        let b = o.clone();
        let h1 = std::thread::spawn(move || a.sign(7, state(143)).is_ok());
        let h2 = std::thread::spawn(move || b.sign(7, state(143)).is_ok());
        assert_eq!(
            u32::from(h1.join().unwrap()) + u32::from(h2.join().unwrap()),
            1
        );
    }
    #[test]
    fn native_delegation_signs_exact_alloy_hash_only_after_separate_approval() {
        let p = json!({"kind":"authorizeSource7702","operationId":"delegate1","revision":2,"chainId":143,"expectedFrom":SOURCE,"nonce":4,"deadline":now()+300});
        let o = EarnDelegationOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut s = state(143);
        s.sender_code = "0x".into();
        assert!(o.sign(2, s.clone()).is_err());
        let review = o.prepare(2, s.clone()).unwrap();
        assert!(review.contains(IMPL));
        o.approve(2, o.review_hash().unwrap()).unwrap();
        let result = o.sign(2, s.clone()).unwrap();
        assert_eq!(
            result.signature_hash,
            "0x6a5921fd3bf859c8f4b48c6de29b99e295125b5e2231b1b94f6a9bfea6741e92"
        );
        assert_eq!(result.from, SOURCE);
        assert!(o.sign(2, s).is_err());
    }
    #[test]
    fn paymaster_unsupported_flags_and_floor_rounding_are_rejected() {
        let p = proposal();
        for index in [0, 1, 14] {
            let mut rpc = op();
            let mut bytes =
                alloy_primitives::hex::decode(rpc["paymasterData"].as_str().unwrap()).unwrap();
            bytes[index] = 0xff;
            rpc["paymasterData"] = json!(alloy_primitives::hex::encode_prefixed(bytes));
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(
                o.prepare(7, rpc.to_string(), state(143), Some(proof(&p)), None)
                    .is_err()
            );
        }
        let o = prepared();
        assert!(o.review_hash().is_ok());
    }
    #[test]
    fn fresh_zero_native_wallet_bundles_verified_authorization_with_correct_hash() {
        let mut state = state(143);
        state.sender_code = "0x".into();
        let proposal_auth = json!({"kind":"authorizeSource7702","operationId":"delegate1","revision":2,"chainId":143,"expectedFrom":SOURCE,"nonce":4,"deadline":now()+300});
        let a = EarnDelegationOperation::new(proposal_auth.to_string(), vec![0; 32]).unwrap();
        a.prepare(2, state.clone()).unwrap();
        a.approve(2, a.review_hash().unwrap()).unwrap();
        let auth = a.sign(2, state.clone()).unwrap();
        let p = proposal();
        let mut rpc = op();
        rpc["factory"] = json!("0x7702");
        rpc["factoryData"] = json!("0x");
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, rpc.to_string(), state.clone(), Some(proof(&p)), None)
                .is_err()
        );
        for i in 0..5 {
            let mut bad = auth.clone();
            match i {
                0 => bad.chain_id = 4663,
                1 => bad.nonce = 5,
                2 => bad.address = HOOD.into(),
                3 => bad.from = HOOD.into(),
                _ => bad.r = format!("0x{}", "11".repeat(32)),
            };
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(
                o.prepare(
                    7,
                    rpc.to_string(),
                    state.clone(),
                    Some(proof(&p)),
                    Some(bad)
                )
                .is_err()
            );
        }
        o.prepare(
            7,
            rpc.to_string(),
            state.clone(),
            Some(proof(&p)),
            Some(auth),
        )
        .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let signed = o.sign(7, state).unwrap();
        assert_eq!(
            signed.user_operation_hash,
            "0xd71e84ddea913b84f7c281d961004c6907e050d5e47e4571243874af182a8157"
        );
        let signed: Value = serde_json::from_str(&signed.rpc_user_operation).unwrap();
        assert_eq!(signed["eip7702Auth"]["address"], IMPL);
    }
    fn hood_proposal(kind: &str) -> Value {
        let mut p = proposal();
        p["kind"] = json!(kind);
        p["chainId"] = json!(4663);
        p["profileChainId"] = json!(4663);
        p["expectedFrom"] = json!(HOOD);
        p["token"] = json!(USDG);
        p["vault"] = json!(HOOD_VAULT);
        p["router"] = json!(HOOD_ROUTER);
        p["budgetAtoms"] = json!("10000000");
        p["withdrawalReserveAtoms"] = json!(if kind == "hoodDeposit" { "1000" } else { "0" });
        p["slippageBps"] = json!(if kind == "hoodDeposit" { 10 } else { 0 });
        p["amountAtoms"] = json!(if kind == "hoodDeposit" {
            "1000000"
        } else {
            "2000000"
        });
        for field in ["recipient", "quoteId", "confidentialAccount", "refundOwner"] {
            p.as_object_mut().unwrap().remove(field);
        }
        p
    }
    fn hood_op(p: &Value) -> Value {
        let mut rpc = op();
        rpc["sender"] = json!(HOOD);
        let mut data =
            alloy_primitives::hex::decode(rpc["paymasterData"].as_str().unwrap()).unwrap();
        data[14..34].copy_from_slice(&alloy_primitives::hex::decode(USDG).unwrap());
        rpc["paymasterData"] = json!(alloy_primitives::hex::encode_prefixed(data));
        let deposit = p["kind"] == "hoodDeposit";
        let amount = dec(p["amountAtoms"].as_str().unwrap()).unwrap();
        let price = if deposit {
            U256::from_str_radix("1001000000000000000000000000", 10).unwrap()
        } else {
            U256::ZERO
        };
        let calls = vec![
            token_call(
                if deposit { USDG } else { HOOD_VAULT },
                "approve",
                HOOD_ROUTER,
                amount,
            )
            .unwrap(),
            Call {
                to: addr(HOOD_ROUTER).unwrap(),
                data: vault_input(deposit, amount, price, p["deadline"].as_u64().unwrap()),
            },
        ];
        rpc["callData"] = json!(alloy_primitives::hex::encode_prefixed(encode_calls(&calls)));
        rpc
    }
    #[test]
    fn hood_deposit_accepts_a_planned_share_price_within_live_slippage() {
        let p = hood_proposal("hoodDeposit");
        let prepare = |shares: &str| {
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            let mut s = state(4663);
            s.preview_deposit_shares = shares.into();
            o.prepare(7, hood_op(&p).to_string(), s, None, None)
        };
        // Planned at 1000000 shares; interest accrues before signing, so live shares fall slightly.
        assert!(prepare("999999").is_ok());
        // A price drop beyond the 10 bps bound, or a plan already below the live price, fails.
        assert!(prepare("1002000").is_err());
        assert!(prepare("998000").is_err());
    }
    #[test]
    fn hood_deposit_full_redemption_and_canonical_sdk_router_are_pinned() {
        for kind in ["hoodDeposit", "hoodRedeemAll"] {
            let p = hood_proposal(kind);
            let rpc = hood_op(&p);
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            o.prepare(7, rpc.to_string(), state(4663), None, None)
                .unwrap();
            o.approve(7, o.review_hash().unwrap()).unwrap();
            let signed = o.sign(7, state(4663)).unwrap();
            assert!(!signed.signature.is_empty());
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            let mut bad = rpc.clone();
            bad["callData"] = json!(
                rpc["callData"]
                    .as_str()
                    .unwrap()
                    .replace(&HOOD_VAULT[2..].to_lowercase(), &TOKEN[2..].to_lowercase())
            );
            assert!(
                o.prepare(7, bad.to_string(), state(4663), None, None)
                    .is_err()
            );
        }
        for (deposit, amount, price, hash) in [
            (
                true,
                1000000,
                "1001000000000000000000000000",
                "0xdebcc7a03747d1f0492756c5341bcd650bda3cb3daed653ae2a6f7dc15692f9a",
            ),
            (
                false,
                2000000,
                "0",
                "0xc4e7ef2a8d4b1b123420937988444615400009987df0cd2658cd5f456a439464",
            ),
        ] {
            assert_eq!(
                format!(
                    "{:#x}",
                    keccak256(vault_input(
                        deposit,
                        U256::from(amount),
                        dec(price).unwrap(),
                        1900000000
                    ))
                ),
                hash
            );
        }
    }
    #[test]
    fn direct_token_paymaster_supports_compact_and_full_signatures_only() {
        for mode in [2u8, 3] {
            for length in [182usize, 183] {
                let mut rpc = op();
                let mut data =
                    alloy_primitives::hex::decode(rpc["paymasterData"].as_str().unwrap()).unwrap();
                data[0] = mode;
                data.resize(length, 0);
                rpc["paymasterData"] = json!(alloy_primitives::hex::encode_prefixed(data));
                let parsed: UserOp = serde_json::from_value(rpc).unwrap();
                assert!(fee_cap(&parsed, SOURCE_TOKEN).is_ok());
            }
        }
        for length in [181usize, 184] {
            let mut rpc = op();
            let mut data =
                alloy_primitives::hex::decode(rpc["paymasterData"].as_str().unwrap()).unwrap();
            data.resize(length, 0);
            rpc["paymasterData"] = json!(alloy_primitives::hex::encode_prefixed(data));
            let parsed: UserOp = serde_json::from_value(rpc).unwrap();
            assert!(fee_cap(&parsed, SOURCE_TOKEN).is_err());
        }
    }
    #[test]
    fn paymaster_extra_bytes_and_ceil_fee_budget_fail_closed() {
        let p = proposal();
        let mut rpc = op();
        let d = rpc["paymasterData"].as_str().unwrap().to_owned() + "0000";
        rpc["paymasterData"] = json!(d);
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, rpc.to_string(), state(143), Some(proof(&p)), None)
                .is_err()
        );
        let mut p = proposal();
        p["budgetAtoms"] = json!("1000000");
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, op().to_string(), state(143), Some(proof(&p)), None)
                .is_err()
        );
    }
    #[test]
    fn finite_paymaster_approval_exact_call_count_and_ceil_bound_are_checked() {
        let p = proposal();
        let mut state = state(143);
        state.paymaster_allowance_atoms = "0".into();
        for amount in [
            U256::ZERO,
            U256::from(1),
            U256::from(2),
            U256::from(3),
            U256::MAX,
        ] {
            let mut rpc = op();
            let calls = vec![
                token_call(TOKEN, "approve", PM, amount).unwrap(),
                token_call(
                    TOKEN,
                    "transfer",
                    p["recipient"].as_str().unwrap(),
                    U256::from(1000000),
                )
                .unwrap(),
            ];
            rpc["callData"] = json!(alloy_primitives::hex::encode_prefixed(encode_calls(&calls)));
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert_eq!(
                o.prepare(7, rpc.to_string(), state.clone(), Some(proof(&p)), None)
                    .is_ok(),
                amount == U256::from(1) || amount == U256::from(2)
            );
        }
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, op().to_string(), state.clone(), Some(proof(&p)), None)
                .is_err()
        );
    }
    #[test]
    fn hoodie_batch_and_userop_hash_match_offline_sdk_and_viem_fixtures() {
        let mut p = hood_proposal("hoodDeposit");
        p["deadline"] = json!(1900000000u64);
        let rpc = hood_op(&p);
        assert_eq!(
            format!(
                "{:#x}",
                keccak256(bytes(rpc["callData"].as_str().unwrap(), 16384).unwrap())
            ),
            "0x49d3802435dfcd4f3d5800456984448969c6d539b53ad9e2d2e8969ac6d8625a"
        );
        assert_eq!(
            format!(
                "{:#x}",
                user_op_hash(4663, &parse::<UserOp>(&rpc.to_string()).unwrap(), None).unwrap()
            ),
            "0xd09c99c699d07acc618680c0533d6bb42cd173c6c801062dd6b402a3dde8b712"
        );
        let p = hood_proposal("hoodDeposit");
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, hood_op(&p).to_string(), state(4663), None, None)
            .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let signed = o.sign(7, state(4663)).unwrap();
        let signature = bytes(&signed.signature, 65).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
            &bytes(&signed.user_operation_hash, 32).unwrap(),
            &k256::ecdsa::Signature::from_slice(&signature[..64]).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(signature[64] - 27).unwrap(),
        )
        .unwrap();
        assert_eq!(crate::address(&recovered), HOOD);
    }
    #[test]
    fn hood_return_requires_native_derived_confidential_binding_and_empty_recipient_code() {
        let mut p = hood_proposal("hoodTokenReturn");
        p["recipient"] = json!("0x1111111111111111111111111111111111111111");
        p["quoteId"] = json!("return1");
        p["confidentialAccount"] =
            json!(crate::derive_earn_confidential_address(vec![0; 32], 4663).unwrap());
        p["refundOwner"] = json!(HOOD);
        let mut rpc = hood_op(&hood_proposal("hoodDeposit"));
        rpc["callData"] = json!(alloy_primitives::hex::encode_prefixed(encode_calls(&[
            token_call(
                USDG,
                "transfer",
                p["recipient"].as_str().unwrap(),
                U256::from(2000000)
            )
            .unwrap()
        ])));
        let mut proof = proof(&proposal());
        proof.chain_id = 4663;
        proof.token = USDG.into();
        proof.quote_id = "return1".into();
        proof.amount_atoms = "2000000".into();
        proof.refund_owner = HOOD.into();
        proof.confidential_account = p["confidentialAccount"].as_str().unwrap().into();
        proof.expires_at = p["deadline"].as_u64().unwrap();
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, rpc.to_string(), state(4663), None, None)
                .is_err()
        );
        for i in 0..6 {
            let mut q = proof.clone();
            match i {
                0 => q.chain_id = 143,
                1 => q.token = TOKEN.into(),
                2 => q.refund_owner = SOURCE.into(),
                3 => q.confidential_account = SOURCE.into(),
                4 => q.expires_at = now() - 1,
                _ => q.authenticated_body_hash = format!("0x{}", "00".repeat(32)),
            };
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(
                o.prepare(7, rpc.to_string(), state(4663), Some(q), None)
                    .is_err()
            );
        }
        let mut bad_state = state(4663);
        bad_state.recipient_code = "0x6000".into();
        assert!(
            o.prepare(7, rpc.to_string(), bad_state, Some(proof.clone()), None)
                .is_err()
        );
        o.prepare(7, rpc.to_string(), state(4663), Some(proof), None)
            .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        assert!(o.sign(7, state(4663)).is_ok());
    }
    #[test]
    fn expiry_and_cancellation_clear_sponsored_authority() {
        let o = prepared();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        o.state.lock().unwrap().a.started = Instant::now() - Duration::from_secs(301);
        assert!(matches!(o.sign(7, state(143)), Err(SignerError::Expired)));
        let o = prepared();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        o.invalidate();
        assert!(o.sign(7, state(143)).is_err());
    }
    #[test]
    fn strict_json_rejects_duplicates_unknowns_wrong_roles_and_zero_amounts() {
        let p = proposal().to_string();
        for bad in [
            p.replace("\"revision\":7", "\"revision\":7,\"revision\":7"),
            p.replace("\"revision\":7", "\"revision\":7,\"digest\":\"0x\""),
            p.replace(SOURCE, HOOD),
            p.replace("\"1000000\"", "\"0\""),
        ] {
            assert!(SponsoredEarnOperation::new(bad, vec![0; 32]).is_err());
        }
    }

    #[test]
    fn source_funding_signs_selected_public_account_and_cycle_confidential_identity() {
        for index in [0, 1, 3, 17] {
            let selected =
                crate::derive_account_address_range(vec![0; 32], index, 1).unwrap()[0].clone();
            let mut p = proposal();
            p["sourceAccountIndex"] = json!(index);
            p["cycleIndex"] = json!(2);
            p["expectedFrom"] = json!(selected);
            p["refundOwner"] = json!(selected);
            p["confidentialAccount"] =
                json!(crate::derive_earn_cycle_confidential_address(vec![0; 32], 1, 2).unwrap());
            let operation = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            let mut current = state(143);
            current.owner = selected.clone();
            let mut rpc = op();
            rpc["sender"] = json!(selected);
            let mut q = proof(&p);
            q.refund_owner = selected.clone();
            q.confidential_account = p["confidentialAccount"].as_str().unwrap().into();
            operation
                .prepare(7, rpc.to_string(), current.clone(), Some(q), None)
                .unwrap();
            operation
                .approve(7, operation.review_hash().unwrap())
                .unwrap();
            let result = operation.sign(7, current).unwrap();
            let signature = alloy_primitives::hex::decode(&result.signature).unwrap();
            let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
                &alloy_primitives::hex::decode(&result.user_operation_hash).unwrap(),
                &k256::ecdsa::Signature::from_slice(&signature[..64]).unwrap(),
                k256::ecdsa::RecoveryId::from_byte(signature[64] - 27).unwrap(),
            )
            .unwrap();
            assert_eq!(crate::address(&recovered), selected);
        }
    }
    #[test]
    fn non_source_proposals_reject_source_index_and_confidential_index_is_not_public() {
        let mut p = proposal();
        p["sourceAccountIndex"] = json!(2);
        assert!(SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).is_err());
        let mut p = hood_proposal("hoodVaultDeposit");
        p["sourceAccountIndex"] = json!(1);
        assert!(SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).is_err());
    }

    #[test]
    fn source_batch_metadata_is_review_bound_and_rejected_for_other_kinds() {
        let mut hashes = Vec::new();
        for batch in ["batch1", "batch2"] {
            let mut p = proposal();
            p["fundingBatchId"] = json!(batch);
            p["fundingBatchSize"] = json!(2);
            let operation = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            operation
                .prepare(7, op().to_string(), state(143), Some(proof(&p)), None)
                .unwrap();
            hashes.push(operation.review_hash().unwrap());
        }
        assert_ne!(hashes[0], hashes[1]);
        let mut p = hood_proposal("hoodVaultDeposit");
        p["fundingBatchId"] = json!("batch1");
        p["fundingBatchSize"] = json!(2);
        assert!(SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).is_err());
        let mut p = proposal();
        p["fundingBatchId"] = json!("batch1");
        assert!(SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).is_err());
    }
    #[test]
    fn distribution_sponsored_deposit_and_redeem_use_slot_key() {
        for kind in ["hoodDeposit", "hoodRedeemAll"] {
            for slot in 0..5 {
                let mut p = hood_proposal(kind);
                let selected = crate::distribution_test_address(4663, 2, slot);
                p["cycleIndex"] = json!(2);
                p["investmentSlot"] = json!(slot);
                p["expectedFrom"] = json!(selected);
                let mut rpc = hood_op(&p);
                rpc["sender"] = json!(selected);
                let mut current = state(4663);
                current.owner = selected.clone();
                let operation = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
                operation
                    .prepare(7, rpc.to_string(), current.clone(), None, None)
                    .unwrap();
                operation
                    .approve(7, operation.review_hash().unwrap())
                    .unwrap();
                let signed = operation.sign(7, current).unwrap();
                let signature = bytes(&signed.signature, 65).unwrap();
                let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
                    &bytes(&signed.user_operation_hash, 32).unwrap(),
                    &k256::ecdsa::Signature::from_slice(&signature[..64]).unwrap(),
                    k256::ecdsa::RecoveryId::from_byte(signature[64] - 27).unwrap(),
                )
                .unwrap();
                assert_eq!(address(&recovered), selected);
            }
        }
        let mut p = proposal();
        p["investmentSlot"] = json!(0);
        assert!(SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).is_err());
    }
    #[test]
    fn distribution_delegation_uses_slot_and_cannot_change_source_authority() {
        let selected = crate::distribution_test_address(4663, 2, 4);
        let mut p = json!({"kind":"authorizeHood7702","chainId":4663,"cycleIndex":2,"investmentSlot":4,"operationId":"delegate1","revision":7,"expectedFrom":selected,"nonce":4,"deadline":now()+300});
        let operation = EarnDelegationOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut current = state(4663);
        current.owner = selected.clone();
        current.sender_code = "0x".into();
        operation.prepare(7, current.clone()).unwrap();
        operation
            .approve(7, operation.review_hash().unwrap())
            .unwrap();
        let signed = operation.sign(7, current).unwrap();
        assert_eq!(signed.from, selected);
        let mut signature = bytes(&signed.r, 32).unwrap();
        signature.extend(bytes(&signed.s, 32).unwrap());
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
            &bytes(&signed.signature_hash, 32).unwrap(),
            &k256::ecdsa::Signature::from_slice(&signature).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(signed.y_parity as u8).unwrap(),
        )
        .unwrap();
        assert_eq!(address(&recovered), selected);
        p["kind"] = json!("authorizeSource7702");
        p["chainId"] = json!(143);
        p["expectedFrom"] = json!(SOURCE);
        assert!(EarnDelegationOperation::new(p.to_string(), vec![0; 32]).is_err());
    }
    #[test]
    fn distribution_hood_return_binds_confidential_cycle_and_refund_owner() {
        let mut current = state(4663);
        let selected = crate::distribution_test_address(4663, 2, 4);
        current.owner = selected.clone();
        let mut p = hood_proposal("hoodTokenReturn");
        p["cycleIndex"] = json!(2);
        p["investmentSlot"] = json!(4);
        p["expectedFrom"] = json!(selected);
        p["recipient"] = json!("0x1111111111111111111111111111111111111111");
        p["quoteId"] = json!("return1");
        p["confidentialAccount"] =
            json!(crate::derive_earn_cycle_confidential_address(vec![0; 32], 4663, 2).unwrap());
        p["refundOwner"] = json!(selected);
        let mut rpc = hood_op(&hood_proposal("hoodDeposit"));
        rpc["sender"] = json!(selected);
        rpc["callData"] = json!(alloy_primitives::hex::encode_prefixed(encode_calls(&[
            token_call(
                USDG,
                "transfer",
                p["recipient"].as_str().unwrap(),
                U256::from(2000000)
            )
            .unwrap()
        ])));
        let mut proof = proof(&proposal());
        proof.chain_id = 4663;
        proof.token = USDG.into();
        proof.quote_id = "return1".into();
        proof.amount_atoms = "2000000".into();
        proof.refund_owner = selected.clone();
        proof.confidential_account = p["confidentialAccount"].as_str().unwrap().into();
        proof.expires_at = p["deadline"].as_u64().unwrap();
        let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, rpc.to_string(), current.clone(), None, None)
                .is_err()
        );
        for i in 0..6 {
            let mut q = proof.clone();
            match i {
                0 => q.chain_id = 143,
                1 => q.token = TOKEN.into(),
                2 => q.refund_owner = SOURCE.into(),
                3 => q.confidential_account = SOURCE.into(),
                4 => q.expires_at = now() - 1,
                _ => q.authenticated_body_hash = format!("0x{}", "00".repeat(32)),
            };
            let o = SponsoredEarnOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(
                o.prepare(7, rpc.to_string(), current.clone(), Some(q), None)
                    .is_err()
            );
        }
        let mut bad_state = current.clone();
        bad_state.recipient_code = "0x6000".into();
        assert!(
            o.prepare(7, rpc.to_string(), bad_state, Some(proof.clone()), None)
                .is_err()
        );
        o.prepare(7, rpc.to_string(), current.clone(), Some(proof), None)
            .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        assert!(o.sign(7, current.clone()).is_ok());
    }
}
