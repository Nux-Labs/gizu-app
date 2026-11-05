//! Narrow Ethereum Earn signer, private UniFFI plumbing for Kotlin/Swift only.
//! Never register approval/signing/raw records on the Expo bridge. Platform code
//! must supply state observed through its pinned native RPC, native passkey/UI
//! approval, an encrypted signed-before-broadcast journal and wallet/nonce locking.
//! This core neither fetches state nor broadcasts or establishes RPC consensus truth.
//!
//! Return routes are deliberately unsupported: a public provider quote alone does
//! not authenticate its recipient's confidential-account binding. No native quote
//! verification contract plus independent recipient state evidence exists yet.
use crate::{SignerError, address};
use alloy_consensus::{SignableTransaction, TxEip1559};
use alloy_primitives::{Address, B256, Signature, TxKind, U256, keccak256};
use bip32::XPrv;
use bip39::{Language, Mnemonic};
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

pub const ETHEREUM_EARN_VAULT: &str = "0x55C1B6e461a6334B567bAF0FEb5D728715446f05";
pub const ETHEREUM_EARN_USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
/// Installed @morpho-org/morpho-sdk 6.0.0 -> morpho-ts Ethereum registry.
pub const ETHEREUM_EARN_ROUTER: &str = "0x02912516d49dE997db75B9D7858faAE59209650B";
const MAX_LIFETIME: u64 = 600;

#[derive(Deserialize, PartialEq)]
enum Kind {
    #[serde(rename = "vaultDeposit")]
    Deposit,
    #[serde(rename = "vaultRedeemAll")]
    Redeem,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    kind: Kind,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    expected_from: String,
    vault: String,
    token: String,
    router: String,
    amount_atoms: String,
    deadline: u64,
    slippage_bps: u32,
    nonce: u64,
    gas_limits: Vec<u64>,
    max_fee_per_gas_wei: String,
    priority_fee_per_gas_wei: String,
    maximum_gas_cost_wei: String,
    withdrawal_reserve_wei: String,
}

/// Native transport observations at one canonical block (pending nonce). For
/// deposit allowanceAtoms is USDC->router; for redemption it is vault->router.
/// previewDepositShares is previewDeposit(exact proposal amount). State is private
/// native-to-native input, never a backend/Expo attestation or a signing proposal.
#[derive(Clone, uniffi::Record)]
pub struct EarnExecutionState {
    pub chain_id: u64,
    pub owner: String,
    pub nonce: u64,
    pub observed_at: u64,
    pub block_number: u64,
    pub block_hash: String,
    pub parent_hash: String,
    pub native_balance_wei: String,
    pub base_fee_wei: String,
    pub usdc_balance_atoms: String,
    pub shares: String,
    pub allowance_atoms: String,
    pub preview_deposit_shares: String,
    pub max_redeem_shares: String,
    pub vault_asset: String,
    pub token_decimals: u32,
    pub sender_code: String,
    pub token_code_hash: String,
    pub vault_code_hash: String,
    pub router_code_hash: String,
}
/// Raw transaction is native-private: journal durably before submitting. An
/// approval transaction has no on-chain deadline; cancellation cannot revoke it.
#[derive(uniffi::Record)]
pub struct NativeSignedEarnTransaction {
    pub raw_transaction: String,
    pub transaction_hash: String,
    pub from: String,
    pub nonce: u64,
    pub operation_id: String,
    pub revision: u64,
    pub step: u32,
    pub review_hash: String,
}
#[derive(uniffi::Record)]
pub struct EarnExecutionCall {
    pub to: String,
    pub data: String,
    pub value_wei: String,
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas_wei: String,
    pub priority_fee_per_gas_wei: String,
}
#[uniffi::export]
/// Hash bounded eth_getCode bytes locally; never accept a provider's claimed hash.
pub fn earn_contract_code_hash(code: String) -> Result<String, SignerError> {
    if code.len() > 1_048_578 || !code.starts_with("0x") || !code.len().is_multiple_of(2) {
        return Err(SignerError::InvalidInput);
    }
    let bytes = alloy_primitives::hex::decode(&code).map_err(|_| SignerError::InvalidInput)?;
    Ok(format!("{:#x}", keccak256(bytes)))
}
struct Prepared {
    transactions: Vec<TxEip1559>,
    baseline: EarnExecutionState,
    max_share_price: U256,
    review_hash: String,
    approved: bool,
    next: usize,
}
struct OperationState {
    seed: Option<Zeroizing<[u8; 64]>>,
    proposal: Proposal,
    proposal_hash: B256,
    from: String,
    started: Instant,
    expires_after: Duration,
    prepared: Option<Prepared>,
}
impl OperationState {
    fn live(&mut self) -> Result<(), SignerError> {
        let clock = now()?;
        if clock >= self.proposal.deadline || self.started.elapsed() >= self.expires_after {
            self.seed = None;
            return Err(SignerError::Expired);
        }
        if self.seed.is_none() {
            return Err(SignerError::InvalidInput);
        }
        Ok(())
    }
}
#[derive(uniffi::Object)]
pub struct EarnExecutionOperation {
    state: Mutex<OperationState>,
}

#[uniffi::export]
impl EarnExecutionOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let entropy = Zeroizing::new(entropy);
        if proposal.len() > 65536 || entropy.len() != 32 {
            return Err(SignerError::InvalidInput);
        }
        let p: Proposal = serde_json::from_str(&proposal).map_err(|_| SignerError::InvalidInput)?;
        let clock = now()?;
        if p.chain_id != 1
            || p.operation_id.is_empty()
            || p.operation_id.len() > 128
            || !p
                .operation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || p.revision == 0
            || p.deadline <= clock
            || p.deadline
                > clock
                    .checked_add(MAX_LIFETIME)
                    .ok_or(SignerError::InvalidInput)?
            || parse_address(&p.vault)? != parse_address(ETHEREUM_EARN_VAULT)?
            || parse_address(&p.token)? != parse_address(ETHEREUM_EARN_USDC)?
            || parse_address(&p.router)? != parse_address(ETHEREUM_EARN_ROUTER)?
            || decimal(&p.amount_atoms)? == U256::ZERO
            || p.slippage_bps > 100
            || (p.kind == Kind::Redeem && p.slippage_bps != 0)
            || p.gas_limits.is_empty()
            || p.gas_limits.len() > 2
            || p.gas_limits
                .iter()
                .any(|g| !(21000..=3_000_000).contains(g))
            || p.nonce == u64::MAX
        {
            return Err(SignerError::InvalidInput);
        }
        let fee = fee_number(&p.max_fee_per_gas_wei)?;
        if fee == 0
            || fee_number(&p.priority_fee_per_gas_wei)? > fee
            || decimal(&p.maximum_gas_cost_wei)? == U256::ZERO
            || (p.kind == Kind::Deposit && decimal(&p.withdrawal_reserve_wei)? == U256::ZERO)
        {
            return Err(SignerError::InvalidInput);
        }
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
            .map_err(|_| SignerError::CryptoFailed)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        drop(mnemonic);
        drop(entropy);
        let key = derive(&seed, p.cycle_index, p.investment_slot)?;
        let from = address(key.private_key().verifying_key());
        if parse_address(&p.expected_from)? != parse_address(&from)? {
            return Err(SignerError::InvalidInput);
        }
        let expires_after = Duration::from_secs(p.deadline - clock);
        Ok(Arc::new(Self {
            state: Mutex::new(OperationState {
                seed: Some(seed),
                proposal: p,
                proposal_hash: keccak256(proposal.as_bytes()),
                from,
                started: Instant::now(),
                expires_after,
                prepared: None,
            }),
        }))
    }
    /// Immutable review. A changed quote/state requires a new operation and fresh
    /// native authorization. No automatic withdrawal follows deposit authorization.
    pub fn prepare(
        &self,
        revision: u64,
        current: EarnExecutionState,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.live()?;
        if s.prepared.is_some() || revision != s.proposal.revision {
            return Err(SignerError::InvalidInput);
        }
        let p = &s.proposal;
        check_state(p, &s.from, &current, p.nonce)?;
        let amount = decimal(&p.amount_atoms)?;
        let allowance = decimal(&current.allowance_atoms)?;
        let needs_approval = allowance < amount;
        if p.gas_limits.len() != if needs_approval { 2 } else { 1 }
            || (needs_approval && p.gas_limits[0] > 100000)
        {
            return Err(SignerError::InvalidInput);
        }
        let price = if p.kind == Kind::Deposit {
            share_price(
                amount,
                decimal(&current.preview_deposit_shares)?,
                p.slippage_bps,
            )?
        } else {
            U256::ZERO
        };
        let mut transactions = Vec::new();
        if needs_approval {
            transactions.push(transaction(
                p,
                p.nonce,
                0,
                if p.kind == Kind::Deposit {
                    ETHEREUM_EARN_USDC
                } else {
                    ETHEREUM_EARN_VAULT
                },
                approve_input(amount),
            )?);
        }
        transactions.push(transaction(
            p,
            p.nonce
                .checked_add(u64::from(needs_approval))
                .ok_or(SignerError::InvalidInput)?,
            usize::from(needs_approval),
            ETHEREUM_EARN_ROUTER,
            vault_input(p.kind == Kind::Deposit, amount, price, p.deadline),
        )?);
        check_cost(p, &current, &transactions)?;
        let mut review = format!(
            "ETHEREUM · chain 1\nOperation {} · revision {}\n{}\nFrom {}\nVault {}\nUSDC {}\nRouter/spender {}\nExact {} base units {}\nDeadline {} Unix seconds\nSlippage {} bps · maximum share price {} (1e27 scaled)\nMaximum authorized gas cost {} wei\nRetained withdrawal reserve {} wei\nReference block {} {}\n",
            p.operation_id,
            p.revision,
            if p.kind == Kind::Deposit {
                "Deposit USDC into vault"
            } else {
                "FULL WITHDRAWAL: redeem all vault shares"
            },
            s.from,
            ETHEREUM_EARN_VAULT,
            ETHEREUM_EARN_USDC,
            ETHEREUM_EARN_ROUTER,
            p.amount_atoms,
            if p.kind == Kind::Deposit {
                "USDC (6 decimals)"
            } else {
                "vault shares"
            },
            p.deadline,
            p.slippage_bps,
            price,
            p.maximum_gas_cost_wei,
            p.withdrawal_reserve_wei,
            current.block_number,
            current.block_hash
        );
        for (i, tx) in transactions.iter().enumerate() {
            review.push_str(&format!("Step {}: {} · nonce {} · gas {} · max fee/gas {} wei · priority/gas {} wei · max cost {} wei\n",
                i+1,if needs_approval && i==0 {"exact token allowance"} else {"vault router execution"},tx.nonce,tx.gas_limit,
                tx.max_fee_per_gas,tx.max_priority_fee_per_gas,U256::from(tx.gas_limit)*U256::from(tx.max_fee_per_gas)));
        }
        review.push_str("Approval covers these exact sequential transactions only. Each step needs fresh native state. Failed deposit can leave allowance. Signed approval has no on-chain expiry. Cancellation cannot revoke signed transactions. Withdrawal requires separate native authorization. Return is unsupported pending native recipient verification.");
        if p.kind == Kind::Redeem {
            review.push_str(" Full redemption uses the SDK withdrawal entrypoint, which supplies no minimum-assets slippage bound.");
        }
        let mut binding = s.proposal_hash.as_slice().to_vec();
        binding.extend_from_slice(review.as_bytes());
        for tx in &transactions {
            binding.extend_from_slice(tx.signature_hash().as_slice());
        }
        let review_hash = format!("{:#x}", keccak256(binding));
        s.prepared = Some(Prepared {
            transactions,
            baseline: current,
            max_share_price: price,
            review_hash,
            approved: false,
            next: 0,
        });
        Ok(review)
    }
    /// Immutable, unsigned native calldata for exact simulation/journal metadata.
    pub fn prepared_calls(&self) -> Result<Vec<EarnExecutionCall>, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.live()?;
        let prepared = s.prepared.as_ref().ok_or(SignerError::InvalidInput)?;
        prepared
            .transactions
            .iter()
            .map(|tx| {
                Ok(EarnExecutionCall {
                    to: match tx.to {
                        TxKind::Call(to) => to.to_checksum(None),
                        TxKind::Create => return Err(SignerError::InvalidInput),
                    },
                    data: alloy_primitives::hex::encode_prefixed(&tx.input),
                    value_wei: tx.value.to_string(),
                    nonce: tx.nonce,
                    gas_limit: tx.gas_limit,
                    max_fee_per_gas_wei: tx.max_fee_per_gas.to_string(),
                    priority_fee_per_gas_wei: tx.max_priority_fee_per_gas.to_string(),
                })
            })
            .collect()
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.live()?;
        Ok(s.prepared
            .as_ref()
            .ok_or(SignerError::InvalidInput)?
            .review_hash
            .clone())
    }
    /// Call only after full-screen native review and verified native passkey
    /// assertion whose challenge binds operationId, revision and this review hash.
    /// Never make this method or its object reachable from Expo/JavaScript.
    pub fn approve(&self, revision: u64, review_hash: String) -> Result<(), SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.live()?;
        if revision != s.proposal.revision {
            return Err(SignerError::InvalidInput);
        }
        let prepared = s.prepared.as_mut().ok_or(SignerError::InvalidInput)?;
        if prepared.approved || prepared.review_hash != review_hash {
            return Err(SignerError::InvalidInput);
        }
        prepared.approved = true;
        Ok(())
    }
    /// No caller-supplied calldata, destination, value, nonce, fee or digest.
    /// Fresh state comes directly from native transport. A state mismatch destroys
    /// authority; never retry a signed step or create a replacement automatically.
    pub fn sign_next(
        &self,
        revision: u64,
        current: EarnExecutionState,
    ) -> Result<NativeSignedEarnTransaction, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.live()?;
        let prepared = s.prepared.as_ref().ok_or(SignerError::InvalidInput)?;
        if !prepared.approved || prepared.next >= prepared.transactions.len() {
            return Err(SignerError::InvalidInput);
        }
        let p = &s.proposal;
        let checked = (|| {
            if revision != p.revision {
                return Err(SignerError::InvalidInput);
            }
            check_state(
                p,
                &s.from,
                &current,
                prepared.transactions[prepared.next].nonce,
            )?;
            check_continuity(&prepared.baseline, &current)?;
            let allowance = decimal(&current.allowance_atoms)?;
            let amount = decimal(&p.amount_atoms)?;
            if prepared.transactions.len() == 2 && prepared.next == 0 {
                if allowance != decimal(&prepared.baseline.allowance_atoms)? {
                    return Err(SignerError::InvalidInput);
                }
            } else if allowance
                != if prepared.transactions.len() == 2 {
                    amount
                } else {
                    decimal(&prepared.baseline.allowance_atoms)?
                }
            {
                return Err(SignerError::InvalidInput);
            }
            if p.kind == Kind::Deposit
                && share_price(amount, decimal(&current.preview_deposit_shares)?, 0)?
                    > prepared.max_share_price
            {
                return Err(SignerError::InvalidInput);
            }
            check_cost(p, &current, &prepared.transactions[prepared.next..])
        })();
        if let Err(error) = checked {
            s.seed = None;
            return Err(error);
        }
        let prepared = s.prepared.as_ref().ok_or(SignerError::InvalidInput)?;
        let tx = prepared.transactions[prepared.next].clone();
        let review_hash = prepared.review_hash.clone();
        let step = prepared.next as u32;
        let key = derive(
            s.seed.as_ref().ok_or(SignerError::InvalidInput)?,
            s.proposal.cycle_index,
            s.proposal.investment_slot,
        )?;
        let (signature, recovery) = key
            .private_key()
            .sign_prehash_recoverable(tx.signature_hash().as_ref());
        if recovery.to_byte() > 1 {
            s.seed = None;
            return Err(SignerError::CryptoFailed);
        }
        let bytes = signature.to_bytes();
        let signature = Signature::from_scalars_and_parity(
            bytes[..32]
                .try_into()
                .map_err(|_| SignerError::CryptoFailed)?,
            bytes[32..]
                .try_into()
                .map_err(|_| SignerError::CryptoFailed)?,
            recovery.is_y_odd(),
        );
        let nonce = tx.nonce;
        let signed = tx.into_signed(signature);
        let mut raw = Vec::new();
        signed.eip2718_encode(&mut raw);
        let result = NativeSignedEarnTransaction {
            raw_transaction: alloy_primitives::hex::encode_prefixed(&raw),
            transaction_hash: format!("{:#x}", keccak256(raw)),
            from: s.from.clone(),
            nonce,
            operation_id: s.proposal.operation_id.clone(),
            revision: s.proposal.revision,
            step,
            review_hash,
        };
        let prepared = s.prepared.as_mut().ok_or(SignerError::InvalidInput)?;
        prepared.next += 1;
        if prepared.next == prepared.transactions.len() {
            s.seed = None;
        }
        Ok(result)
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.seed = None;
            if let Some(p) = s.prepared.as_mut() {
                p.approved = false;
            }
        }
    }
}
fn now() -> Result<u64, SignerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| SignerError::InvalidInput)
}
fn derive(
    seed: &[u8; 64],
    cycle_index: u32,
    investment_slot: Option<u32>,
) -> Result<XPrv, SignerError> {
    crate::earn_distribution::earn_investment_key(seed, 1, cycle_index, investment_slot)
}
fn parse_address(s: &str) -> Result<Address, SignerError> {
    if s.len() != 42 || !s.starts_with("0x") {
        return Err(SignerError::InvalidInput);
    }
    s.parse().map_err(|_| SignerError::InvalidInput)
}
fn decimal(s: &str) -> Result<U256, SignerError> {
    if s.is_empty()
        || s.len() > 78
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(SignerError::InvalidInput);
    }
    U256::from_str_radix(s, 10).map_err(|_| SignerError::InvalidInput)
}
fn fee_number(s: &str) -> Result<u128, SignerError> {
    u128::try_from(decimal(s)?).map_err(|_| SignerError::InvalidInput)
}
fn code_hash(s: &str) -> Result<B256, SignerError> {
    if s.len() != 66 || !s.starts_with("0x") {
        return Err(SignerError::InvalidInput);
    }
    let hash: B256 = s.parse().map_err(|_| SignerError::InvalidInput)?;
    if hash == B256::ZERO || hash == keccak256([]) {
        return Err(SignerError::InvalidInput);
    }
    Ok(hash)
}
fn check_state(
    p: &Proposal,
    from: &str,
    s: &EarnExecutionState,
    nonce: u64,
) -> Result<(), SignerError> {
    let clock = now()?;
    if s.chain_id != 1
        || parse_address(&s.owner)? != parse_address(from)?
        || s.nonce != nonce
        || s.observed_at > clock
        || clock - s.observed_at > 15
        || s.sender_code != "0x"
        || s.token_decimals != 6
        || parse_address(&s.vault_asset)? != parse_address(ETHEREUM_EARN_USDC)?
        || s.block_number == 0
        || decimal(&s.base_fee_wei)?
            .checked_add(decimal(&p.priority_fee_per_gas_wei)?)
            .ok_or(SignerError::InvalidInput)?
            > decimal(&p.max_fee_per_gas_wei)?
    {
        return Err(SignerError::InvalidInput);
    }
    for hash in [
        &s.block_hash,
        &s.parent_hash,
        &s.token_code_hash,
        &s.vault_code_hash,
        &s.router_code_hash,
    ] {
        code_hash(hash)?;
    }
    let amount = decimal(&p.amount_atoms)?;
    for value in [
        &s.allowance_atoms,
        &s.native_balance_wei,
        &s.usdc_balance_atoms,
        &s.shares,
        &s.preview_deposit_shares,
        &s.max_redeem_shares,
    ] {
        decimal(value)?;
    }
    if p.kind == Kind::Deposit {
        if decimal(&s.usdc_balance_atoms)? < amount
            || decimal(&s.preview_deposit_shares)? == U256::ZERO
        {
            return Err(SignerError::InvalidInput);
        }
    } else if decimal(&s.shares)? != amount || decimal(&s.max_redeem_shares)? < amount {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_continuity(
    before: &EarnExecutionState,
    after: &EarnExecutionState,
) -> Result<(), SignerError> {
    if before.token_code_hash != after.token_code_hash
        || before.vault_code_hash != after.vault_code_hash
        || before.router_code_hash != after.router_code_hash
        || before.usdc_balance_atoms != after.usdc_balance_atoms
        || before.shares != after.shares
        || !(after.block_number == before.block_number && after.block_hash == before.block_hash
            || after.block_number
                == before
                    .block_number
                    .checked_add(1)
                    .ok_or(SignerError::InvalidInput)?
                && after.parent_hash == before.block_hash)
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_cost(p: &Proposal, s: &EarnExecutionState, txs: &[TxEip1559]) -> Result<(), SignerError> {
    let mut cost = U256::ZERO;
    for tx in txs {
        cost = cost
            .checked_add(
                U256::from(tx.gas_limit)
                    .checked_mul(U256::from(tx.max_fee_per_gas))
                    .ok_or(SignerError::InvalidInput)?,
            )
            .ok_or(SignerError::InvalidInput)?;
    }
    if cost > decimal(&p.maximum_gas_cost_wei)?
        || decimal(&s.native_balance_wei)?
            < cost
                .checked_add(decimal(&p.withdrawal_reserve_wei)?)
                .ok_or(SignerError::InvalidInput)?
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn share_price(amount: U256, shares: U256, bps: u32) -> Result<U256, SignerError> {
    let numerator = amount
        .checked_mul(U256::from(10u128.pow(27)))
        .and_then(|v| v.checked_mul(U256::from(10000 + bps)))
        .ok_or(SignerError::InvalidInput)?;
    let denominator = shares
        .checked_mul(U256::from(10000))
        .filter(|v| *v != U256::ZERO)
        .ok_or(SignerError::InvalidInput)?;
    let (quotient, remainder) = numerator.div_rem(denominator);
    quotient
        .checked_add(U256::from(u8::from(remainder != U256::ZERO)))
        .ok_or(SignerError::InvalidInput)
}
fn transaction(
    p: &Proposal,
    nonce: u64,
    index: usize,
    to: &str,
    input: Vec<u8>,
) -> Result<TxEip1559, SignerError> {
    Ok(TxEip1559 {
        chain_id: 1,
        nonce,
        gas_limit: p.gas_limits[index],
        max_fee_per_gas: fee_number(&p.max_fee_per_gas_wei)?,
        max_priority_fee_per_gas: fee_number(&p.priority_fee_per_gas_wei)?,
        to: TxKind::Call(parse_address(to)?),
        value: U256::ZERO,
        access_list: Default::default(),
        input: input.into(),
    })
}
fn word(output: &mut Vec<u8>, value: U256) {
    output.extend_from_slice(&value.to_be_bytes::<32>());
}
fn address_word(output: &mut Vec<u8>, value: &str) {
    // Only compiled, pinned constants reach this helper.
    output.extend_from_slice(&[0; 12]);
    output.extend_from_slice(value.parse::<Address>().expect("pinned address").as_slice());
}
fn approve_input(amount: U256) -> Vec<u8> {
    let mut out = keccak256(b"approve(address,uint256)")[..4].to_vec();
    address_word(&mut out, ETHEREUM_EARN_ROUTER);
    word(&mut out, amount);
    out
}
/// Canonical restricted ABI, independently tested against the installed SDK.
/// No custom cryptography/RLP. No trailing metadata, nonempty permit, referral,
/// recipient selector, arbitrary executable calldata, native value or direct ERC4626.
/// SDK ABI sourced from morpho-org/bundles f27e7bcf744310303e24faa522b71d702e696686.
fn vault_input(deposit: bool, amount: U256, price: U256, deadline: u64) -> Vec<u8> {
    let signature = if deposit {
        "vaultBundlesV1Deposit(address,uint256,uint256,(uint8,bytes),uint256,address,uint256)"
    } else {
        "vaultBundlesV1Withdraw(address,uint256,uint256,(uint256,uint256,uint256,uint8,bytes32,bytes32),uint256,address,uint256)"
    };
    let mut out = keccak256(signature.as_bytes())[..4].to_vec();
    address_word(&mut out, ETHEREUM_EARN_VAULT);
    if deposit {
        word(&mut out, amount);
        word(&mut out, price);
        word(&mut out, U256::from(7 * 32)); // dynamic permit offset
        word(&mut out, U256::ZERO);
        word(&mut out, U256::ZERO);
        word(&mut out, U256::from(deadline));
        word(&mut out, U256::ZERO);
        word(&mut out, U256::from(64));
        word(&mut out, U256::ZERO); // kind=none, bytes offset, empty bytes
    } else {
        word(&mut out, U256::ZERO);
        word(&mut out, amount); // assets=0, all shares
        word(&mut out, U256::ZERO);
        word(&mut out, U256::ZERO);
        word(&mut out, U256::from(deadline)); // empty permit value/nonce/deadline
        for _ in 0..5 {
            word(&mut out, U256::ZERO);
        } // v/r/s, referral percentage/recipient
        word(&mut out, U256::from(deadline));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_consensus::{SignableTransaction, Signed, TxEip1559};
    use alloy_primitives::{Address, U256, keccak256};
    use k256::ecdsa::{RecoveryId, Signature as KSignature, VerifyingKey};
    use serde_json::{Value, json};
    use std::time::{SystemTime, UNIX_EPOCH};

    const OWNER: &str = "0xB5927c0bbE474886EA8A87a2E9a761386Dec63bc";
    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }
    fn proposal(kind: &str) -> String {
        json!({"kind":kind,"operationId":"cycle-deposit-1","revision":7,"chainId":1,
            "expectedFrom":OWNER,"vault":ETHEREUM_EARN_VAULT,"token":ETHEREUM_EARN_USDC,"router":ETHEREUM_EARN_ROUTER,
            "amountAtoms":if kind=="vaultDeposit" {"1000000"} else {"2000000"},
            "deadline":now()+300,"slippageBps":if kind=="vaultDeposit" {10} else {0},
            "nonce":4,"gasLimits":[65000,300000],"maxFeePerGasWei":"10000000000","priorityFeePerGasWei":"1000000000",
            "maximumGasCostWei":"3650000000000000","withdrawalReserveWei":"1000000000000000"}).to_string()
    }
    fn state() -> EarnExecutionState {
        EarnExecutionState {
            chain_id: 1,
            owner: OWNER.into(),
            nonce: 4,
            observed_at: now(),
            block_number: 100,
            block_hash: format!("0x{}", "11".repeat(32)),
            parent_hash: format!("0x{}", "22".repeat(32)),
            native_balance_wei: "1000000000000000000".into(),
            base_fee_wei: "1000000000".into(),
            usdc_balance_atoms: "1000000".into(),
            shares: "2000000".into(),
            allowance_atoms: "0".into(),
            preview_deposit_shares: "1000000".into(),
            max_redeem_shares: "2000000".into(),
            vault_asset: ETHEREUM_EARN_USDC.into(),
            token_decimals: 6,
            sender_code: "0x".into(),
            token_code_hash: format!("0x{}", "33".repeat(32)),
            vault_code_hash: format!("0x{}", "44".repeat(32)),
            router_code_hash: format!("0x{}", "55".repeat(32)),
        }
    }
    fn prepared(kind: &str) -> Arc<EarnExecutionOperation> {
        let op = EarnExecutionOperation::new(proposal(kind), vec![0; 32]).unwrap();
        let review = op.prepare(7, state()).unwrap();
        assert!(review.contains(OWNER));
        assert!(review.contains(ETHEREUM_EARN_ROUTER));
        assert!(review.contains("1000000000000000"));
        op
    }
    fn approved(kind: &str) -> Arc<EarnExecutionOperation> {
        let op = prepared(kind);
        op.approve(7, op.review_hash().unwrap()).unwrap();
        op
    }
    fn recover(raw: &str) -> (TxEip1559, Address) {
        let bytes = alloy_primitives::hex::decode(raw).unwrap();
        let signed = Signed::<TxEip1559>::eip2718_decode(&mut bytes.as_slice()).unwrap();
        let sig = KSignature::from_slice(signed.signature().as_bytes()[..64].as_ref()).unwrap();
        let rec = RecoveryId::from_byte(u8::from(signed.signature().v())).unwrap();
        let key =
            VerifyingKey::recover_from_prehash(signed.tx().signature_hash().as_ref(), &sig, rec)
                .unwrap();
        (signed.tx().clone(), crate::address(&key).parse().unwrap())
    }
    #[test]
    fn native_inspection_returns_only_exact_prepared_transactions() {
        let op = prepared("vaultDeposit");
        let calls = op.prepared_calls().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].to, ETHEREUM_EARN_USDC);
        assert!(calls[0].data.starts_with("0x095ea7b3"));
        assert_eq!(calls[0].value_wei, "0");
        assert_eq!(calls[1].to, ETHEREUM_EARN_ROUTER);
        assert!(calls[1].data.starts_with("0x6bbba4e0"));
        assert_eq!(calls[1].nonce, 5);
        assert_eq!(calls[1].gas_limit, 300000);
        op.invalidate();
        assert!(op.prepared_calls().is_err());
    }
    #[test]
    fn native_contract_code_hash_is_bounded_canonical_hex_and_keccak() {
        assert_eq!(
            earn_contract_code_hash("0x6000".into()).unwrap(),
            format!("{:#x}", keccak256([0x60, 0]))
        );
        assert_eq!(
            earn_contract_code_hash("0x".into()).unwrap(),
            format!("{:#x}", keccak256([]))
        );
        for bad in [
            "0x0".to_string(),
            "6000".into(),
            "0xgg".into(),
            format!("0x{}", "00".repeat(524289)),
        ] {
            assert!(earn_contract_code_hash(bad).is_err());
        }
    }
    #[test]
    fn original_deadline_is_also_a_monotonic_authority_ceiling() {
        let op = approved("vaultDeposit");
        op.state.lock().unwrap().started = Instant::now() - Duration::from_secs(301);
        assert!(matches!(
            op.sign_next(7, state()),
            Err(SignerError::Expired)
        ));
        assert!(op.state.lock().unwrap().seed.is_none());
    }
    #[test]
    fn malformed_native_state_financial_fields_fail_closed() {
        let op = EarnExecutionOperation::new(proposal("vaultDeposit"), vec![0; 32]).unwrap();
        let mut s = state();
        s.shares = "malformed".into();
        assert!(op.prepare(7, s).is_err());
    }
    #[test]
    fn redemption_can_spend_its_reserved_gas_without_reserving_it_twice() {
        let mut p: serde_json::Value = serde_json::from_str(&proposal("vaultRedeemAll")).unwrap();
        p["withdrawalReserveWei"] = serde_json::json!("0");
        let op = EarnExecutionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut current = state();
        current.native_balance_wei = "3650000000000000".into();
        op.prepare(7, current.clone()).unwrap();
        op.approve(7, op.review_hash().unwrap()).unwrap();
        assert!(op.sign_next(7, current).is_ok());
        p["kind"] = serde_json::json!("vaultDeposit");
        assert!(EarnExecutionOperation::new(p.to_string(), vec![0; 32]).is_err());
    }
    #[test]
    fn canonical_calldata_matches_installed_sdk_synthetic_fixtures() {
        // @morpho-org/morpho-sdk 6.0.0, no metadata/permit/referral, generated locally without RPC.
        assert_eq!(
            format!(
                "{:#x}",
                keccak256(vault_input(
                    true,
                    U256::from(1000000),
                    U256::from_str_radix("1001000000000000000000000000", 10).unwrap(),
                    1900000000
                ))
            ),
            "0x569365c9c6d42c7b658d3e33374e4033a193d8e04c20fd1b17b93db3603eff1b"
        );
        assert_eq!(
            format!(
                "{:#x}",
                keccak256(vault_input(
                    false,
                    U256::from(2000000),
                    U256::ZERO,
                    1900000000
                ))
            ),
            "0x956e980ea25bd06b3a8daaaa026eb675819a4d47c67b917380d34fa02f97afc0"
        );
    }
    #[test]
    fn exact_deposit_uses_role_one_exact_allowance_and_router() {
        let op = approved("vaultDeposit");
        let first = op.sign_next(7, state()).unwrap();
        let (approval, from) = recover(&first.raw_transaction);
        assert_eq!(from, OWNER.parse::<Address>().unwrap());
        assert_eq!(approval.chain_id, 1);
        assert_eq!(approval.nonce, 4);
        assert_eq!(
            approval.to,
            alloy_primitives::TxKind::Call(ETHEREUM_EARN_USDC.parse().unwrap())
        );
        assert_eq!(approval.value, U256::ZERO);
        assert_eq!(
            alloy_primitives::hex::encode(&approval.input[..4]),
            "095ea7b3"
        );
        assert_eq!(
            U256::from_be_slice(&approval.input[36..]),
            U256::from(1000000)
        );
        let mut fresh = state();
        fresh.nonce = 5;
        fresh.allowance_atoms = "1000000".into();
        let second = op.sign_next(7, fresh.clone()).unwrap();
        let (deposit, from) = recover(&second.raw_transaction);
        assert_eq!(from, OWNER.parse::<Address>().unwrap());
        assert_eq!(deposit.nonce, 5);
        assert_eq!(
            deposit.to,
            alloy_primitives::TxKind::Call(ETHEREUM_EARN_ROUTER.parse().unwrap())
        );
        assert_eq!(
            alloy_primitives::hex::encode(&deposit.input[..4]),
            "6bbba4e0"
        );
        assert_eq!(
            second.transaction_hash,
            format!(
                "{:#x}",
                keccak256(alloy_primitives::hex::decode(&second.raw_transaction).unwrap())
            )
        );
        assert!(op.sign_next(7, fresh).is_err());
    }
    #[test]
    fn full_redemption_requires_own_approval_and_matches_sdk_selector() {
        let op = prepared("vaultRedeemAll");
        assert!(op.sign_next(7, state()).is_err());
        op.approve(7, op.review_hash().unwrap()).unwrap();
        let first = op.sign_next(7, state()).unwrap();
        let (tx, _) = recover(&first.raw_transaction);
        assert_eq!(
            tx.to,
            alloy_primitives::TxKind::Call(ETHEREUM_EARN_VAULT.parse().unwrap())
        );
        assert_eq!(U256::from_be_slice(&tx.input[36..]), U256::from(2000000));
        let mut fresh = state();
        fresh.nonce = 5;
        fresh.allowance_atoms = "2000000".into();
        let second = op.sign_next(7, fresh).unwrap();
        let (tx, _) = recover(&second.raw_transaction);
        assert_eq!(alloy_primitives::hex::encode(&tx.input[..4]), "932084a8");
        assert_eq!(U256::from_be_slice(&tx.input[36..68]), U256::ZERO);
        assert_eq!(U256::from_be_slice(&tx.input[68..100]), U256::from(2000000));
    }
    #[test]
    fn rejects_ambiguous_and_unsupported_public_fields() {
        let good = proposal("vaultDeposit");
        for bad in [
            good.replace("\"chainId\":1", "\"chainId\":1,\"chainId\":1"),
            good.replace("\"revision\":7", "\"revision\":7,\"data\":\"0x\""),
            good.replace("vaultDeposit", "usdcReturn"),
            good.replace("vaultDeposit", "nativeEthReturn"),
            good.replace("1000000\"", "01\""),
            " ".repeat(65537),
        ] {
            assert!(EarnExecutionOperation::new(bad, vec![0; 32]).is_err());
        }
        for (field, value) in [
            ("chainId", json!(4663)),
            (
                "expectedFrom",
                json!("0x115Fd06B8190FDb68C1A840468661Ada279D1d72"),
            ),
            ("vault", json!(OWNER)),
            ("token", json!(OWNER)),
            ("router", json!(OWNER)),
            ("deadline", json!(now() + 601)),
            ("deadline", json!(now())),
            ("slippageBps", json!(101)),
            ("amountAtoms", json!("0")),
            ("kind", json!("nativeTransfers")),
        ] {
            let mut p: Value = serde_json::from_str(&good).unwrap();
            p[field] = value;
            assert!(
                EarnExecutionOperation::new(p.to_string(), vec![0; 32]).is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn approval_binds_review_revision_and_cannot_reprepare() {
        let op = EarnExecutionOperation::new(proposal("vaultDeposit"), vec![0; 32]).unwrap();
        assert!(op.approve(7, "0x00".into()).is_err());
        assert!(op.sign_next(7, state()).is_err());
        op.prepare(7, state()).unwrap();
        assert!(op.prepare(7, state()).is_err());
        assert!(op.approve(8, op.review_hash().unwrap()).is_err());
        assert!(op.approve(7, "0x00".into()).is_err());
        assert!(op.sign_next(7, state()).is_err());
        op.approve(7, op.review_hash().unwrap()).unwrap();
        assert!(op.approve(7, op.review_hash().unwrap()).is_err());
    }
    #[test]
    fn fresh_state_tampering_fails_and_revokes_authority() {
        for i in 0..15 {
            let op = approved("vaultDeposit");
            let mut s = state();
            match i {
                0 => s.chain_id = 4663,
                1 => s.owner = ETHEREUM_EARN_VAULT.into(),
                2 => s.nonce = 5,
                3 => s.native_balance_wei = "1".into(),
                4 => s.usdc_balance_atoms = "999999".into(),
                5 => s.sender_code = "0xef0100".into(),
                6 => s.vault_asset = OWNER.into(),
                7 => s.token_decimals = 18,
                8 => s.observed_at = now() - 16,
                9 => s.router_code_hash = format!("0x{}", "66".repeat(32)),
                10 => s.preview_deposit_shares = "1".into(),
                11 => s.block_hash = format!("0x{}", "66".repeat(32)),
                12 => s.base_fee_wei = "10000000000".into(),
                13 => s.allowance_atoms = "1".into(),
                _ => s.observed_at = now() + 1,
            }
            assert!(op.sign_next(7, s).is_err(), "case {i}");
            assert!(op.sign_next(7, state()).is_err(), "revoked {i}");
        }
        let op = approved("vaultDeposit");
        assert!(op.sign_next(8, state()).is_err());
        assert!(op.sign_next(7, state()).is_err());
    }
    #[test]
    fn affordability_full_share_balance_and_nonce_are_native_checked() {
        for i in 0..6 {
            let op = EarnExecutionOperation::new(proposal("vaultRedeemAll"), vec![0; 32]).unwrap();
            let mut s = state();
            match i {
                0 => s.shares = "1999999".into(),
                1 => s.max_redeem_shares = "1999999".into(),
                2 => s.nonce = 5,
                3 => s.native_balance_wei = "4649999999999999".into(),
                4 => s.chain_id = 2,
                _ => s.owner = ETHEREUM_EARN_VAULT.into(),
            }
            assert!(op.prepare(7, s).is_err(), "case {i}");
        }
        let mut p: Value = serde_json::from_str(&proposal("vaultDeposit")).unwrap();
        p["maximumGasCostWei"] = json!("3649999999999999");
        let op = EarnExecutionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(op.prepare(7, state()).is_err());
    }
    #[test]
    fn existing_allowance_skips_approval_but_still_requires_exact_gas_plan() {
        let mut p: Value = serde_json::from_str(&proposal("vaultDeposit")).unwrap();
        p["gasLimits"] = json!([300000]);
        let op = EarnExecutionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut s = state();
        s.allowance_atoms = "1000000".into();
        op.prepare(7, s.clone()).unwrap();
        op.approve(7, op.review_hash().unwrap()).unwrap();
        let signed = op.sign_next(7, s).unwrap();
        let (tx, _) = recover(&signed.raw_transaction);
        assert_eq!(alloy_primitives::hex::encode(&tx.input[..4]), "6bbba4e0");
    }
    #[test]
    fn concurrent_calls_cannot_get_duplicate_signature() {
        let op = approved("vaultDeposit");
        let mut handles = Vec::new();
        for _ in 0..2 {
            let op = op.clone();
            handles.push(std::thread::spawn(move || op.sign_next(7, state()).is_ok()));
        }
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|ok| *ok)
                .count(),
            1
        );
    }
    #[test]
    fn cancelled_operation_drops_signing_authority() {
        let op = approved("vaultDeposit");
        op.invalidate();
        assert!(op.sign_next(7, state()).is_err());
        assert!(op.review_hash().is_err());
    }

    #[test]
    fn vault_execution_uses_fresh_cycle_investment_address() {
        let mut p: serde_json::Value = serde_json::from_str(&proposal("vaultDeposit")).unwrap();
        p["cycleIndex"] = json!(2);
        let selected = crate::derive_earn_cycle_addresses(vec![0; 32], 1, 2).unwrap()[1].clone();
        p["expectedFrom"] = json!(selected);
        let operation = EarnExecutionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut current = state();
        current.owner = selected.clone();
        operation.prepare(7, current.clone()).unwrap();
        operation
            .approve(7, operation.review_hash().unwrap())
            .unwrap();
        let signed = operation.sign_next(7, current).unwrap();
        assert_eq!(signed.from, selected);
        let raw = alloy_primitives::hex::decode(&signed.raw_transaction).unwrap();
        let tx = alloy_consensus::Signed::<TxEip1559>::eip2718_decode(&mut raw.as_slice()).unwrap();
        let sig = KSignature::from_slice(tx.signature().as_bytes()[..64].as_ref()).unwrap();
        let rec = RecoveryId::from_byte(u8::from(tx.signature().v())).unwrap();
        let key = VerifyingKey::recover_from_prehash(tx.tx().signature_hash().as_ref(), &sig, rec)
            .unwrap();
        assert_eq!(address(&key), selected);
    }
    #[test]
    fn distribution_vault_deposit_and_redeem_sign_selected_slot() {
        for kind in ["vaultDeposit", "vaultRedeemAll"] {
            for slot in 0..5 {
                let mut p: serde_json::Value = serde_json::from_str(&proposal(kind)).unwrap();
                let selected = crate::distribution_test_address(1, 2, slot);
                p["cycleIndex"] = json!(2);
                p["investmentSlot"] = json!(slot);
                p["expectedFrom"] = json!(selected);
                let operation = EarnExecutionOperation::new(p.to_string(), vec![0; 32]).unwrap();
                let mut current = state();
                current.owner = selected.clone();
                operation.prepare(7, current.clone()).unwrap();
                assert!(operation.sign_next(7, current.clone()).is_err());
                operation
                    .approve(7, operation.review_hash().unwrap())
                    .unwrap();
                let signed = operation.sign_next(7, current).unwrap();
                assert_eq!(
                    recover(&signed.raw_transaction).1,
                    selected.parse::<Address>().unwrap()
                );
                p["investmentSlot"] = json!((slot + 1) % 5);
                assert!(EarnExecutionOperation::new(p.to_string(), vec![0; 32]).is_err());
            }
        }
    }
}
