//! Private Ethereum invest-role Fusion and return authority. Never expose these
//! objects, approval or signatures through Expo. Platform supplies fresh pinned
//! RPC observations, fixed authenticated gateway proofs, passkey authorization,
//! unique operation/quote locking and encrypted signed-before-broadcast journals.
//! Native quote records assert platform authentication, not cryptographic RPC/TLS
//! truth. Successful signing does not prove submission, fill or private settlement.
use crate::{NativeEarnQuoteBinding, NativeSignedEarnTransaction, SignerError, address};
use alloy_consensus::{SignableTransaction, TxEip1559, TxLegacy};
use alloy_primitives::{Address, B256, Signature, TxKind, U256, keccak256};
use bip32::XPrv;
use bip39::{Language, Mnemonic};
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
const USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH: &str = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const NATIVE_ETH: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const FUSION_ROUTER: &str = "0x111111125421ca6dc452d289314280a0f8842a65";
const SETTLEMENT: &str = "0x399740157391a9f1bf4e9921a8834f9bc8f2678e";
const FEE_RECEIVER: &str = "0x90cbe4bdd538d6e9b379bff5fe72c3d67a521de5";
#[derive(Clone, uniffi::Record)]
pub struct NativeEthereumLiquidityState {
    pub chain_id: u64,
    pub owner: String,
    pub observed_at: u64,
    pub block_number: u64,
    pub block_hash: String,
    pub parent_hash: String,
    pub nonce: u64,
    pub native_balance_wei: String,
    pub usdc_balance_atoms: String,
    pub weth_balance_atoms: String,
    pub shares: String,
    pub fusion_allowance_atoms: String,
    pub permit_nonce: String,
    pub usdc_domain_separator: String,
    pub fusion_nonce_slot: String,
    pub fusion_invalidator_word: String,
    pub sender_code: String,
    pub recipient_code: String,
    pub recipient_asset_balance_atoms: String,
    pub base_fee_wei: String,
    pub usdc_code_hash: String,
    pub weth_code_hash: String,
    pub router_code_hash: String,
    pub settlement_code_hash: String,
    pub fee_receiver_code_hash: String,
    pub vault_code_hash: String,
}
/// Fixed authenticated native gateway response, not a JS/provider attestation.
#[derive(Clone, uniffi::Record)]
pub struct NativeFusionQuoteBinding {
    pub operation_id: String,
    pub revision: u64,
    pub quote_id: String,
    pub owner: String,
    pub confidential_account: String,
    pub input_atoms: String,
    pub minimum_eth_wei: String,
    pub gross_eth_wei: String,
    pub deadline: u64,
    pub quoted_at: u64,
    pub expires_at: u64,
    pub order_hash: String,
    pub extension_hash: String,
    pub authenticated_body_hash: String,
    pub resolver_gas_units: String,
    pub resolver_gas_price_wei: String,
    pub resolver_gas_cost_wei: String,
    pub resolver_profit_wei: String,
    pub input_value_wei: String,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeSignedFusionPermit {
    pub owner: String,
    pub input_atoms: String,
    pub nonce: String,
    pub deadline: u64,
    pub signature: String,
    pub signature_hash: String,
    pub permit_data: String,
}
#[derive(uniffi::Record)]
pub struct NativeSignedFusionOrder {
    pub operation_id: String,
    pub revision: u64,
    pub quote_id: String,
    pub order_hash: String,
    pub signature: String,
    pub unsigned_order: String,
    pub extension: String,
    pub review_hash: String,
}
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FusionOrder {
    maker: String,
    maker_asset: String,
    taker_asset: String,
    maker_traits: String,
    salt: String,
    making_amount: String,
    taking_amount: String,
    receiver: String,
}
struct Authority {
    cycle_index: u32,
    investment_slot: Option<u32>,
    seed: Option<Zeroizing<[u8; 64]>>,
    owner: String,
    confidential: String,
    id: String,
    revision: u64,
    deadline: u64,
    started: Instant,
    lifetime: Duration,
    quote_expires: u64,
    hash: Option<String>,
    approved: bool,
}
struct AuthorityConfig<'a> {
    id: &'a str,
    revision: u64,
    chain: u64,
    cycle_index: u32,
    investment_slot: Option<u32>,
    expected: &'a str,
    c: &'a str,
    deadline: u64,
}
impl Authority {
    fn new(entropy: Vec<u8>, config: AuthorityConfig<'_>) -> Result<Self, SignerError> {
        let AuthorityConfig {
            id,
            revision,
            chain,
            cycle_index,
            investment_slot,
            expected,
            c,
            deadline,
        } = config;
        let clock = now()?;
        let started = Instant::now();
        let entropy = Zeroizing::new(entropy);
        if chain != 1
            || entropy.len() != 32
            || revision == 0
            || id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || deadline <= clock
            || deadline > clock + 600
        {
            return Err(SignerError::InvalidInput);
        }
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
            .map_err(|_| SignerError::CryptoFailed)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        drop(mnemonic);
        drop(entropy);
        let owner = address(
            crate::earn_distribution::earn_investment_key(&seed, 1, cycle_index, investment_slot)?
                .private_key()
                .verifying_key(),
        );
        let confidential = address(derive(&seed, cycle_index, 2)?.private_key().verifying_key());
        if addr(expected)? != addr(&owner)? || addr(c)? != addr(&confidential)? {
            return Err(SignerError::InvalidInput);
        }
        Ok(Self {
            cycle_index,
            investment_slot,
            seed: Some(seed),
            owner,
            confidential,
            id: id.into(),
            revision,
            deadline,
            started,
            lifetime: Duration::from_secs(deadline - clock),
            quote_expires: deadline,
            hash: None,
            approved: false,
        })
    }
    fn live(&mut self) -> Result<(), SignerError> {
        let clock = now()?;
        if clock >= self.deadline
            || clock >= self.quote_expires
            || self.started.elapsed() >= self.lifetime
        {
            self.seed = None;
            return Err(SignerError::Expired);
        }
        if self.seed.is_none() {
            return Err(SignerError::InvalidInput);
        }
        Ok(())
    }
    fn review_hash(&mut self) -> Result<String, SignerError> {
        self.live()?;
        self.hash.clone().ok_or(SignerError::InvalidInput)
    }
    fn approve(&mut self, revision: u64, hash: &str) -> Result<(), SignerError> {
        self.live()?;
        if revision != self.revision || self.approved || self.hash.as_deref() != Some(hash) {
            return Err(SignerError::InvalidInput);
        }
        self.approved = true;
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionProposal {
    kind: String,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    expected_from: String,
    amount_atoms: String,
    nonce: u64,
    deadline: u64,
    gas_limit: u64,
    max_fee_per_gas_wei: String,
    priority_fee_per_gas_wei: String,
    maximum_gas_cost_wei: String,
    withdrawal_reserve_wei: String,
    recipient: Option<String>,
    quote_id: String,
    confidential_account: String,
    refund_owner: Option<String>,
    minimum_eth_wei: Option<String>,
    gross_eth_wei: Option<String>,
    maximum_resolver_overhead_wei: Option<String>,
}
struct TransactionInner {
    a: Authority,
    p: TransactionProposal,
    baseline: Option<NativeEthereumLiquidityState>,
    tx: Option<TxEip1559>,
}
#[derive(uniffi::Object)]
pub struct EthereumLiquidityTransactionOperation {
    state: Mutex<TransactionInner>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancellationProposal {
    kind: String,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    expected_from: String,
    confidential_account: String,
    original_raw_transaction: String,
    original_transaction_hash: String,
    nonce: u64,
    deadline: u64,
    gas_limit: u64,
    max_fee_per_gas_wei: String,
    priority_fee_per_gas_wei: String,
    maximum_gas_cost_wei: String,
}
struct CancellationInner {
    a: Authority,
    p: CancellationProposal,
    legacy: bool,
    tx: TxEip1559,
    baseline: Option<NativeEthereumLiquidityState>,
}
/// Native journal recovery only: a zero-value self transfer competing with one
/// independently recovered saved transaction. Never accepts arbitrary calldata.
#[derive(uniffi::Object)]
pub struct EthereumLiquidityCancellationOperation {
    state: Mutex<CancellationInner>,
}
#[uniffi::export]
impl EthereumLiquidityCancellationOperation {
    #[uniffi::constructor]
    pub fn new(proposal_json: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: CancellationProposal = parse(&proposal_json)?;
        if p.kind != "cancelPendingLiquidity" || p.gas_limit != 21000 {
            return Err(SignerError::InvalidInput);
        }
        let a = Authority::new(
            entropy,
            AuthorityConfig {
                id: &p.operation_id,
                revision: p.revision,
                chain: p.chain_id,
                cycle_index: p.cycle_index,
                investment_slot: p.investment_slot,
                expected: &p.expected_from,
                c: &p.confidential_account,
                deadline: p.deadline,
            },
        )?;
        let raw = bytes(&p.original_raw_transaction, 2048)?;
        nonzero_hash(&p.original_transaction_hash)?;
        if format!("{:#x}", keccak256(&raw)) != p.original_transaction_hash.to_lowercase() {
            return Err(SignerError::InvalidInput);
        }
        let mut input = raw.as_slice();
        let (is_legacy, chain, nonce, old_fee, old_tip, digest, signature) =
            if raw.first() == Some(&2) {
                let signed = alloy_consensus::Signed::<TxEip1559>::eip2718_decode(&mut input)
                    .map_err(|_| SignerError::InvalidInput)?;
                (
                    false,
                    signed.tx().chain_id,
                    signed.tx().nonce,
                    signed.tx().max_fee_per_gas,
                    signed.tx().max_priority_fee_per_gas,
                    signed.tx().signature_hash(),
                    *signed.signature(),
                )
            } else if raw.first().is_some_and(|v| *v >= 0xc0) {
                let signed = alloy_consensus::Signed::<TxLegacy>::eip2718_decode(&mut input)
                    .map_err(|_| SignerError::InvalidInput)?;
                (
                    true,
                    signed.tx().chain_id.ok_or(SignerError::InvalidInput)?,
                    signed.tx().nonce,
                    signed.tx().gas_price,
                    0,
                    signed.tx().signature_hash(),
                    *signed.signature(),
                )
            } else {
                return Err(SignerError::InvalidInput);
            };
        let sig = k256::ecdsa::Signature::from_slice(&signature.as_bytes()[..64])
            .map_err(|_| SignerError::InvalidInput)?;
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
            digest.as_ref(),
            &sig,
            k256::ecdsa::RecoveryId::from_byte(u8::from(signature.v()))
                .ok_or(SignerError::InvalidInput)?,
        )
        .map_err(|_| SignerError::InvalidInput)?;
        let bump = |n: u128| -> Result<u128, SignerError> {
            n.checked_mul(9)
                .and_then(|v| v.checked_add(7))
                .map(|v| (v / 8).max(n.saturating_add(1)))
                .ok_or(SignerError::InvalidInput)
        };
        let maximum = fee(&p.max_fee_per_gas_wei)?;
        let priority = fee(&p.priority_fee_per_gas_wei)?;
        if !input.is_empty()
            || chain != 1
            || nonce != p.nonce
            || addr(&address(&recovered))? != addr(&a.owner)?
            || maximum < bump(old_fee)?
            || priority > maximum
            || (is_legacy && priority != 0)
            || (!is_legacy && priority < bump(old_tip)?)
        {
            return Err(SignerError::InvalidInput);
        }
        let cost = U256::from(21000)
            .checked_mul(U256::from(maximum))
            .ok_or(SignerError::InvalidInput)?;
        if cost != dec(&p.maximum_gas_cost_wei)? {
            return Err(SignerError::InvalidInput);
        }
        let tx = TxEip1559 {
            chain_id: 1,
            nonce: p.nonce,
            gas_limit: 21000,
            max_fee_per_gas: maximum,
            max_priority_fee_per_gas: priority,
            to: TxKind::Call(addr(&a.owner)?),
            value: U256::ZERO,
            input: Default::default(),
            access_list: Default::default(),
        };
        Ok(Arc::new(Self {
            state: Mutex::new(CancellationInner {
                a,
                p,
                legacy: is_legacy,
                tx,
                baseline: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        current: NativeEthereumLiquidityState,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || s.baseline.is_some() {
            return Err(SignerError::InvalidInput);
        }
        check_cancellation_state(&s, &current)?;
        let text = format!(
            "CANCEL PENDING ETHEREUM LIQUIDITY · chain 1\nOperation {} · revision {}\nOwner/self recipient {} · value 0 · empty calldata\nOriginal transaction {} · SAME nonce {}\nGas limit 21000 · maximum fee {} wei · priority {} wei · maximum gas cost {} wei\nThe older transaction can still win. This authorization does not prove cancellation; both hashes must be reconciled. Assets remain yours unless the original transfer lands. Future return quotes and gas budgets require new reviews.\nReview deadline {}",
            s.a.id,
            s.a.revision,
            s.a.owner,
            s.p.original_transaction_hash,
            s.p.nonce,
            s.p.max_fee_per_gas_wei,
            s.p.priority_fee_per_gas_wei,
            s.p.maximum_gas_cost_wei,
            s.a.deadline
        );
        s.a.hash = Some(format!("{:#x}", keccak256(text.as_bytes())));
        s.baseline = Some(current);
        Ok(text)
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
        current: NativeEthereumLiquidityState,
    ) -> Result<NativeSignedEarnTransaction, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || !s.a.approved || s.baseline.is_none() {
            return Err(SignerError::InvalidInput);
        }
        let checked = check_cancellation_state(&s, &current).and_then(|()| {
            continuity(
                s.baseline.as_ref().ok_or(SignerError::InvalidInput)?,
                &current,
            )
        });
        if let Err(error) = checked {
            s.a.seed = None;
            return Err(error);
        }
        let seed = s.a.seed.take().ok_or(SignerError::InvalidInput)?;
        let digest = if s.legacy {
            legacy(&s.tx).signature_hash()
        } else {
            s.tx.signature_hash()
        };
        let signature = signature(&seed, s.a.cycle_index, s.a.investment_slot, digest)?;
        let mut raw = Vec::new();
        if s.legacy {
            legacy(&s.tx)
                .into_signed(signature)
                .eip2718_encode(&mut raw);
        } else {
            s.tx.clone().into_signed(signature).eip2718_encode(&mut raw);
        }
        Ok(NativeSignedEarnTransaction {
            raw_transaction: alloy_primitives::hex::encode_prefixed(&raw),
            transaction_hash: format!("{:#x}", keccak256(raw)),
            from: s.a.owner.clone(),
            nonce: s.p.nonce,
            operation_id: s.a.id.clone(),
            revision: s.a.revision,
            step: 0,
            review_hash: s.a.hash.clone().ok_or(SignerError::InvalidInput)?,
        })
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.a.seed = None;
            s.a.approved = false;
        }
    }
}
fn check_cancellation_state(
    s: &CancellationInner,
    current: &NativeEthereumLiquidityState,
) -> Result<(), SignerError> {
    check_state(&s.a, current)?;
    let cost = dec(&s.p.maximum_gas_cost_wei)?;
    if current.nonce != s.p.nonce
        || dec(&current.native_balance_wei)? < cost
        || dec(&current.base_fee_wei)?
            .checked_add(U256::from(s.tx.max_priority_fee_per_gas))
            .ok_or(SignerError::InvalidInput)?
            > U256::from(s.tx.max_fee_per_gas)
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
#[uniffi::export]
impl EthereumLiquidityTransactionOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: TransactionProposal = parse(&proposal)?;
        if !["fusionUsdcApproval", "returnUsdc", "returnEth"].contains(&p.kind.as_str())
            || dec(&p.amount_atoms)? == U256::ZERO
            || p.nonce == u64::MAX
            || p.quote_id.is_empty()
            || p.quote_id.len() > 128
            || !(21000..=100000).contains(&p.gas_limit)
            || p.kind == "returnEth" && p.gas_limit != 21000
            || fee(&p.max_fee_per_gas_wei)? == 0
            || fee(&p.priority_fee_per_gas_wei)? > fee(&p.max_fee_per_gas_wei)?
        {
            return Err(SignerError::InvalidInput);
        }
        dec(&p.maximum_gas_cost_wei)?;
        dec(&p.withdrawal_reserve_wei)?;
        if p.kind == "returnEth"
            && (fee(&p.priority_fee_per_gas_wei)? != 0
                || dec(&p.withdrawal_reserve_wei)? != U256::ZERO)
        {
            return Err(SignerError::InvalidInput);
        }
        if p.kind == "fusionUsdcApproval" {
            if p.recipient.is_some()
                || p.refund_owner.is_some()
                || p.minimum_eth_wei.is_none()
                || p.gross_eth_wei.is_none()
                || p.maximum_resolver_overhead_wei.is_none()
            {
                return Err(SignerError::InvalidInput);
            }
        } else {
            let r = addr(p.recipient.as_deref().ok_or(SignerError::InvalidInput)?)?;
            if r.as_slice()[..18].iter().all(|v| *v == 0)
                || r == addr(&p.expected_from)?
                || p.minimum_eth_wei.is_some()
                || p.gross_eth_wei.is_some()
                || p.maximum_resolver_overhead_wei.is_some()
            {
                return Err(SignerError::InvalidInput);
            }
            addr(p.refund_owner.as_deref().ok_or(SignerError::InvalidInput)?)?;
        }
        let a = Authority::new(
            entropy,
            AuthorityConfig {
                id: &p.operation_id,
                revision: p.revision,
                chain: p.chain_id,
                cycle_index: p.cycle_index,
                investment_slot: p.investment_slot,
                expected: &p.expected_from,
                c: &p.confidential_account,
                deadline: p.deadline,
            },
        )?;
        Ok(Arc::new(Self {
            state: Mutex::new(TransactionInner {
                a,
                p,
                baseline: None,
                tx: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        current: NativeEthereumLiquidityState,
        fusion_quote: Option<NativeFusionQuoteBinding>,
        return_quote: Option<NativeEarnQuoteBinding>,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || s.baseline.is_some() {
            return Err(SignerError::InvalidInput);
        }
        check_state(&s.a, &current)?;
        if current.nonce != s.p.nonce {
            return Err(SignerError::InvalidInput);
        }
        let amount = dec(&s.p.amount_atoms)?;
        let (to, input, value, body_hash, expires) = if s.p.kind == "fusionUsdcApproval" {
            if return_quote.is_some() {
                return Err(SignerError::InvalidInput);
            }
            let q = fusion_quote.as_ref().ok_or(SignerError::InvalidInput)?;
            check_fusion_quote(
                &s.a,
                &s.p.quote_id,
                &s.p.amount_atoms,
                s.p.minimum_eth_wei
                    .as_deref()
                    .ok_or(SignerError::InvalidInput)?,
                s.p.gross_eth_wei
                    .as_deref()
                    .ok_or(SignerError::InvalidInput)?,
                s.p.maximum_resolver_overhead_wei
                    .as_deref()
                    .ok_or(SignerError::InvalidInput)?,
                q,
            )?;
            if dec(&current.usdc_balance_atoms)? < amount {
                return Err(SignerError::InvalidInput);
            }
            (
                addr(USDC)?,
                token_data("approve", addr(FUSION_ROUTER)?, amount),
                U256::ZERO,
                q.authenticated_body_hash.clone(),
                q.expires_at,
            )
        } else {
            if fusion_quote.is_some() {
                return Err(SignerError::InvalidInput);
            }
            let q = return_quote.as_ref().ok_or(SignerError::InvalidInput)?;
            check_return_quote(&s.a, &s.p, q)?;
            if current.recipient_code != "0x"
                || dec(&current.recipient_asset_balance_atoms)? != U256::ZERO
                || dec(&current.shares)? != U256::ZERO
                || dec(&current.weth_balance_atoms)? != U256::ZERO
            {
                return Err(SignerError::InvalidInput);
            }
            let r = addr(s.p.recipient.as_deref().ok_or(SignerError::InvalidInput)?)?;
            if s.p.kind == "returnUsdc" {
                if dec(&current.usdc_balance_atoms)? != amount {
                    return Err(SignerError::InvalidInput);
                }
                (
                    addr(USDC)?,
                    token_data("transfer", r, amount),
                    U256::ZERO,
                    q.authenticated_body_hash.clone(),
                    q.expires_at,
                )
            } else {
                (
                    r,
                    Vec::new(),
                    amount,
                    q.authenticated_body_hash.clone(),
                    q.expires_at,
                )
            }
        };
        let tx = TxEip1559 {
            chain_id: 1,
            nonce: s.p.nonce,
            gas_limit: s.p.gas_limit,
            max_fee_per_gas: fee(&s.p.max_fee_per_gas_wei)?,
            max_priority_fee_per_gas: fee(&s.p.priority_fee_per_gas_wei)?,
            to: TxKind::Call(to),
            value,
            input: input.into(),
            access_list: Default::default(),
        };
        check_tx_cost(&s.p, &current, &tx)?;
        let review = format!(
            "{} · ETHEREUM chain 1\nOperation {} · revision {}\nOwner {}\nAmount {} base units\nTarget {} · recipient {}\nQuote {} · confidential account {} · refund owner {}\nNonce {} · gas {}\nMaximum fee/gas {} wei · priority fee/gas {} wei\nMaximum gas cost {} wei · retained reserve {} wei\nDeadline {} Unix seconds\nInput data hash {:#x}\nExact independent authorization. Cancellation cannot revoke signed transactions. Gas receipt and final balance require independent reconciliation. Return receipt alone does not prove private credit.",
            s.p.kind,
            s.a.id,
            s.a.revision,
            s.a.owner,
            s.p.amount_atoms,
            to,
            s.p.recipient.as_deref().unwrap_or("none"),
            s.p.quote_id,
            s.a.confidential,
            s.p.refund_owner.as_deref().unwrap_or("none"),
            tx.nonce,
            tx.gas_limit,
            tx.max_fee_per_gas,
            tx.max_priority_fee_per_gas,
            s.p.maximum_gas_cost_wei,
            s.p.withdrawal_reserve_wei,
            s.a.deadline,
            keccak256(&tx.input)
        );
        let review = if s.p.kind == "returnEth" {
            format!(
                "{review}\nLegacy type 0 fixed gas price {} wei; exact full native balance sweep, 21000 gas, no priority fee. Zero remainder requires actual gasUsed21000 at this fixed gas price.",
                tx.max_fee_per_gas
            )
        } else {
            review
        };
        let review = if let Some(q) = &return_quote {
            format!(
                "{review}\n{}",
                crate::earn_fees::review(
                    q.fee_policy.as_deref(),
                    if s.p.kind == "returnEth" {
                        "returnEth"
                    } else {
                        "returnUsdc"
                    },
                    None
                )?
            )
        } else {
            review
        };
        let mut binding = review.as_bytes().to_vec();
        binding.extend(transaction_digest(&s.p, &tx).as_slice());
        binding.extend(body_hash.as_bytes());
        s.a.hash = Some(format!("{:#x}", keccak256(binding)));
        s.a.quote_expires = expires;
        s.baseline = Some(current);
        s.tx = Some(tx);
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
        current: NativeEthereumLiquidityState,
    ) -> Result<NativeSignedEarnTransaction, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if !s.a.approved {
            return Err(SignerError::InvalidInput);
        }
        let checked = (|| {
            if revision != s.a.revision {
                return Err(SignerError::InvalidInput);
            }
            check_state(&s.a, &current)?;
            continuity(
                s.baseline.as_ref().ok_or(SignerError::InvalidInput)?,
                &current,
            )?;
            check_tx_cost(
                &s.p,
                &current,
                s.tx.as_ref().ok_or(SignerError::InvalidInput)?,
            )
        })();
        if let Err(e) = checked {
            s.a.seed = None;
            return Err(e);
        }
        let seed = s.a.seed.take().ok_or(SignerError::InvalidInput)?;
        let tx = s.tx.as_ref().ok_or(SignerError::InvalidInput)?.clone();
        let sig = signature(
            &seed,
            s.a.cycle_index,
            s.a.investment_slot,
            transaction_digest(&s.p, &tx),
        )?;
        let mut raw = Vec::new();
        if s.p.kind == "returnEth" {
            legacy(&tx).into_signed(sig).eip2718_encode(&mut raw);
        } else {
            tx.into_signed(sig).eip2718_encode(&mut raw);
        }
        Ok(NativeSignedEarnTransaction {
            raw_transaction: alloy_primitives::hex::encode_prefixed(&raw),
            transaction_hash: format!("{:#x}", keccak256(raw)),
            from: s.a.owner.clone(),
            nonce: s.p.nonce,
            operation_id: s.a.id.clone(),
            revision: s.a.revision,
            step: 0,
            review_hash: s.a.hash.clone().ok_or(SignerError::InvalidInput)?,
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
fn fee(s: &str) -> Result<u128, SignerError> {
    u128::try_from(dec(s)?).map_err(|_| SignerError::InvalidInput)
}
fn bytes(s: &str, max: usize) -> Result<Vec<u8>, SignerError> {
    if !s.starts_with("0x") || !s.len().is_multiple_of(2) || s.len() > max * 2 + 2 {
        return Err(SignerError::InvalidInput);
    }
    alloy_primitives::hex::decode(s).map_err(|_| SignerError::InvalidInput)
}
fn nonzero_hash(s: &str) -> Result<(), SignerError> {
    if bytes(s, 32)?.len() != 32
        || s.parse::<B256>().map_err(|_| SignerError::InvalidInput)? == B256::ZERO
        || s == format!("{:#x}", keccak256([]))
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn derive(seed: &[u8; 64], cycle_index: u32, role: u8) -> Result<XPrv, SignerError> {
    crate::earn_cycle_key(seed, 1, cycle_index, role)
}
fn signature(
    seed: &[u8; 64],
    cycle_index: u32,
    investment_slot: Option<u32>,
    hash: B256,
) -> Result<Signature, SignerError> {
    let (sig, id) =
        crate::earn_distribution::earn_investment_key(seed, 1, cycle_index, investment_slot)?
            .private_key()
            .sign_prehash_recoverable(hash.as_ref());
    if id.to_byte() > 1 {
        return Err(SignerError::CryptoFailed);
    }
    let b = sig.to_bytes();
    Ok(Signature::from_scalars_and_parity(
        b[..32].try_into().map_err(|_| SignerError::CryptoFailed)?,
        b[32..].try_into().map_err(|_| SignerError::CryptoFailed)?,
        id.is_y_odd(),
    ))
}
fn signature_hex(
    seed: &[u8; 64],
    cycle_index: u32,
    investment_slot: Option<u32>,
    hash: B256,
) -> Result<String, SignerError> {
    Ok(alloy_primitives::hex::encode_prefixed(
        signature(seed, cycle_index, investment_slot, hash)?.as_bytes(),
    ))
}
fn word(out: &mut Vec<u8>, v: U256) {
    out.extend(v.to_be_bytes::<32>());
}
fn aword(out: &mut Vec<u8>, v: Address) {
    out.extend([0; 12]);
    out.extend(v.as_slice());
}
fn token_data(kind: &str, to: Address, amount: U256) -> Vec<u8> {
    let mut out = keccak256(format!("{kind}(address,uint256)").as_bytes())[..4].to_vec();
    aword(&mut out, to);
    word(&mut out, amount);
    out
}
fn domain(name: &str, version: &str, token: Address) -> B256 {
    let mut out = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    )
    .as_slice()
    .to_vec();
    out.extend(keccak256(name.as_bytes()).as_slice());
    out.extend(keccak256(version.as_bytes()).as_slice());
    word(&mut out, U256::from(1));
    aword(&mut out, token);
    keccak256(out)
}
fn typed_hash(domain: B256, data: Vec<u8>) -> B256 {
    let mut out = vec![0x19, 0x01];
    out.extend(domain.as_slice());
    out.extend(keccak256(data).as_slice());
    keccak256(out)
}
fn permit_digest(owner: Address, input: U256, nonce: U256, deadline: u64) -> B256 {
    let mut out = keccak256(
        b"Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
    )
    .as_slice()
    .to_vec();
    aword(&mut out, owner);
    aword(&mut out, FUSION_ROUTER.parse().expect("pinned router"));
    word(&mut out, input);
    word(&mut out, nonce);
    word(&mut out, U256::from(deadline));
    typed_hash(
        domain("USD Coin", "2", USDC.parse().expect("pinned usdc")),
        out,
    )
}
fn fusion_order_digest(o: &FusionOrder) -> Result<B256, SignerError> {
    let mut out=keccak256(b"Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)").as_slice().to_vec();
    word(&mut out, dec(&o.salt)?);
    for v in [&o.maker, &o.receiver, &o.maker_asset, &o.taker_asset] {
        aword(&mut out, addr(v)?);
    }
    for v in [&o.making_amount, &o.taking_amount, &o.maker_traits] {
        word(&mut out, dec(v)?);
    }
    Ok(typed_hash(
        domain("1inch Aggregation Router", "6", addr(FUSION_ROUTER)?),
        out,
    ))
}
fn check_state(a: &Authority, s: &NativeEthereumLiquidityState) -> Result<(), SignerError> {
    let clock = now()?;
    if s.chain_id != 1
        || addr(&s.owner)? != addr(&a.owner)?
        || s.observed_at > clock
        || clock - s.observed_at > 15
        || s.sender_code != "0x"
        || s.block_number == 0
    {
        return Err(SignerError::InvalidInput);
    }
    for h in [
        &s.block_hash,
        &s.parent_hash,
        &s.usdc_code_hash,
        &s.weth_code_hash,
        &s.router_code_hash,
        &s.settlement_code_hash,
        &s.fee_receiver_code_hash,
        &s.vault_code_hash,
    ] {
        nonzero_hash(h)?;
    }
    for v in [
        &s.native_balance_wei,
        &s.usdc_balance_atoms,
        &s.weth_balance_atoms,
        &s.shares,
        &s.fusion_allowance_atoms,
        &s.permit_nonce,
        &s.fusion_nonce_slot,
        &s.fusion_invalidator_word,
        &s.recipient_asset_balance_atoms,
        &s.base_fee_wei,
    ] {
        dec(v)?;
    }
    Ok(())
}
fn continuity(
    b: &NativeEthereumLiquidityState,
    s: &NativeEthereumLiquidityState,
) -> Result<(), SignerError> {
    if b.nonce != s.nonce
        || b.owner != s.owner
        || b.sender_code != s.sender_code
        || b.native_balance_wei != s.native_balance_wei
        || b.usdc_balance_atoms != s.usdc_balance_atoms
        || b.weth_balance_atoms != s.weth_balance_atoms
        || b.shares != s.shares
        || b.fusion_allowance_atoms != s.fusion_allowance_atoms
        || b.permit_nonce != s.permit_nonce
        || b.usdc_domain_separator != s.usdc_domain_separator
        || b.fusion_nonce_slot != s.fusion_nonce_slot
        || b.fusion_invalidator_word != s.fusion_invalidator_word
        || b.recipient_code != s.recipient_code
        || b.recipient_asset_balance_atoms != s.recipient_asset_balance_atoms
        || b.usdc_code_hash != s.usdc_code_hash
        || b.weth_code_hash != s.weth_code_hash
        || b.router_code_hash != s.router_code_hash
        || b.settlement_code_hash != s.settlement_code_hash
        || b.fee_receiver_code_hash != s.fee_receiver_code_hash
        || b.vault_code_hash != s.vault_code_hash
        || !(s.block_number == b.block_number && s.block_hash == b.block_hash
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
fn legacy(tx: &TxEip1559) -> TxLegacy {
    TxLegacy {
        chain_id: Some(1),
        nonce: tx.nonce,
        gas_price: tx.max_fee_per_gas,
        gas_limit: tx.gas_limit,
        to: tx.to,
        value: tx.value,
        input: tx.input.clone(),
    }
}
fn transaction_digest(p: &TransactionProposal, tx: &TxEip1559) -> B256 {
    if p.kind == "returnEth" {
        legacy(tx).signature_hash()
    } else {
        tx.signature_hash()
    }
}
fn check_tx_cost(
    p: &TransactionProposal,
    s: &NativeEthereumLiquidityState,
    tx: &TxEip1559,
) -> Result<(), SignerError> {
    if p.kind == "returnEth" && dec(&s.usdc_balance_atoms)? != U256::ZERO {
        return Err(SignerError::InvalidInput);
    }
    if p.kind == "returnEth"
        && dec(&s.native_balance_wei)?
            != tx
                .value
                .checked_add(
                    U256::from(21000)
                        .checked_mul(U256::from(tx.max_fee_per_gas))
                        .ok_or(SignerError::InvalidInput)?,
                )
                .ok_or(SignerError::InvalidInput)?
    {
        return Err(SignerError::InvalidInput);
    }
    let cost = U256::from(tx.gas_limit)
        .checked_mul(U256::from(tx.max_fee_per_gas))
        .ok_or(SignerError::InvalidInput)?;
    if cost > dec(&p.maximum_gas_cost_wei)?
        || dec(&s.base_fee_wei)?
            .checked_add(U256::from(tx.max_priority_fee_per_gas))
            .ok_or(SignerError::InvalidInput)?
            > U256::from(tx.max_fee_per_gas)
        || dec(&s.native_balance_wei)?
            < cost
                .checked_add(tx.value)
                .and_then(|v| v.checked_add(dec(&p.withdrawal_reserve_wei).ok()?))
                .ok_or(SignerError::InvalidInput)?
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_return_quote(
    a: &Authority,
    p: &TransactionProposal,
    q: &NativeEarnQuoteBinding,
) -> Result<(), SignerError> {
    let clock = now()?;
    if q.operation_id != a.id
        || q.revision != a.revision
        || q.quote_id != p.quote_id
        || q.chain_id != 1
        || addr(&q.token)?
            != addr(if p.kind == "returnEth" {
                NATIVE_ETH
            } else {
                USDC
            })?
        || Some(&q.recipient) != p.recipient.as_ref()
        || q.amount_atoms != p.amount_atoms
        || addr(&q.confidential_account)? != addr(&a.confidential)?
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
fn check_fusion_quote(
    a: &Authority,
    id: &str,
    input: &str,
    minimum: &str,
    gross: &str,
    max_overhead: &str,
    q: &NativeFusionQuoteBinding,
) -> Result<(), SignerError> {
    let clock = now()?;
    if q.operation_id != a.id
        || q.revision != a.revision
        || q.quote_id != id
        || addr(&q.owner)? != addr(&a.owner)?
        || addr(&q.confidential_account)? != addr(&a.confidential)?
        || q.input_atoms != input
        || q.minimum_eth_wei != minimum
        || q.gross_eth_wei != gross
        || q.deadline != a.deadline
        || q.quoted_at > clock.checked_add(5).ok_or(SignerError::InvalidInput)?
        || clock.saturating_sub(q.quoted_at) > 60
        || q.expires_at <= clock
        || q.expires_at
            > q.quoted_at
                .checked_add(60)
                .ok_or(SignerError::InvalidInput)?
        || q.expires_at > a.deadline
        || dec(input)? == U256::ZERO
        || dec(minimum)? == U256::ZERO
        || dec(gross)? < dec(minimum)?
    {
        return Err(SignerError::InvalidInput);
    }
    for h in [&q.order_hash, &q.extension_hash, &q.authenticated_body_hash] {
        nonzero_hash(h)?;
    }
    let units = dec(&q.resolver_gas_units)?;
    let price = dec(&q.resolver_gas_price_wei)?;
    let gas = dec(&q.resolver_gas_cost_wei)?;
    let profit = dec(&q.resolver_profit_wei)?;
    let input_value = dec(&q.input_value_wei)?;
    let overhead = gas.checked_add(profit).ok_or(SignerError::InvalidInput)?;
    if units < U256::from(243431)
        || price == U256::ZERO
        || units.checked_mul(price).ok_or(SignerError::InvalidInput)? != gas
        || profit < ceil(gas, U256::from(10))?
        || overhead > dec(max_overhead)?
        || dec(gross)?
            .checked_add(overhead)
            .ok_or(SignerError::InvalidInput)?
            > input_value
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermitProposal {
    kind: String,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    expected_from: String,
    confidential_account: String,
    quote_id: String,
    input_atoms: String,
    minimum_eth_wei: String,
    gross_eth_wei: String,
    maximum_resolver_overhead_wei: String,
    deadline: u64,
    nonce: String,
}
struct PermitInner {
    a: Authority,
    p: PermitProposal,
    baseline: Option<NativeEthereumLiquidityState>,
}
#[derive(uniffi::Object)]
pub struct EthereumFusionPermitOperation {
    state: Mutex<PermitInner>,
}
#[uniffi::export]
impl EthereumFusionPermitOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: PermitProposal = parse(&proposal)?;
        if p.kind != "fusionUsdcPermit"
            || p.quote_id.is_empty()
            || p.quote_id.len() > 128
            || dec(&p.input_atoms)? == U256::ZERO
            || dec(&p.minimum_eth_wei)? == U256::ZERO
            || dec(&p.gross_eth_wei)? < dec(&p.minimum_eth_wei)?
        {
            return Err(SignerError::InvalidInput);
        }
        dec(&p.nonce)?;
        dec(&p.maximum_resolver_overhead_wei)?;
        let a = Authority::new(
            entropy,
            AuthorityConfig {
                id: &p.operation_id,
                revision: p.revision,
                chain: p.chain_id,
                cycle_index: p.cycle_index,
                investment_slot: p.investment_slot,
                expected: &p.expected_from,
                c: &p.confidential_account,
                deadline: p.deadline,
            },
        )?;
        Ok(Arc::new(Self {
            state: Mutex::new(PermitInner {
                a,
                p,
                baseline: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        current: NativeEthereumLiquidityState,
        quote: NativeFusionQuoteBinding,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || s.baseline.is_some() {
            return Err(SignerError::InvalidInput);
        }
        check_state(&s.a, &current)?;
        check_permit_state(&s.p, &current)?;
        check_fusion_quote(
            &s.a,
            &s.p.quote_id,
            &s.p.input_atoms,
            &s.p.minimum_eth_wei,
            &s.p.gross_eth_wei,
            &s.p.maximum_resolver_overhead_wei,
            &quote,
        )?;
        let digest = permit_digest(
            addr(&s.a.owner)?,
            dec(&s.p.input_atoms)?,
            dec(&s.p.nonce)?,
            s.a.deadline,
        );
        let review = format!(
            "FUSION EXACT USDC PERMIT · ETHEREUM chain 1\nOperation {} · revision {}\nOwner {} · confidential account {}\nUSDC {} · spender {}\nExact input {} atoms · permit nonce {} · deadline {} Unix seconds\nQuote {} · minimum net ETH {} wei · gross ETH {} wei\nMaximum resolver gas and profit overhead {} wei\nFixed EIP-2612 USD Coin version 2 digest {:#x}\nIndependent permit authorization; an order requires another review. A signed permit can grant the exact allowance until expiry. Signing does not prove a fill.",
            s.a.id,
            s.a.revision,
            s.a.owner,
            s.a.confidential,
            USDC,
            FUSION_ROUTER,
            s.p.input_atoms,
            s.p.nonce,
            s.a.deadline,
            s.p.quote_id,
            s.p.minimum_eth_wei,
            s.p.gross_eth_wei,
            s.p.maximum_resolver_overhead_wei,
            digest
        );
        s.a.hash = Some(review_binding(
            &review,
            digest,
            &quote.authenticated_body_hash,
        ));
        s.a.quote_expires = quote.expires_at;
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
        current: NativeEthereumLiquidityState,
    ) -> Result<NativeSignedFusionPermit, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if !s.a.approved {
            return Err(SignerError::InvalidInput);
        }
        let checked = (|| {
            if revision != s.a.revision {
                return Err(SignerError::InvalidInput);
            }
            check_state(&s.a, &current)?;
            continuity(
                s.baseline.as_ref().ok_or(SignerError::InvalidInput)?,
                &current,
            )?;
            check_permit_state(&s.p, &current)
        })();
        if let Err(e) = checked {
            s.a.seed = None;
            return Err(e);
        }
        let seed = s.a.seed.take().ok_or(SignerError::InvalidInput)?;
        let digest = permit_digest(
            addr(&s.a.owner)?,
            dec(&s.p.input_atoms)?,
            dec(&s.p.nonce)?,
            s.a.deadline,
        );
        let sig = signature_hex(&seed, s.a.cycle_index, s.a.investment_slot, digest)?;
        let b = bytes(&sig, 65)?;
        let mut data = Vec::new();
        aword(&mut data, addr(&s.a.owner)?);
        aword(&mut data, addr(FUSION_ROUTER)?);
        word(&mut data, dec(&s.p.input_atoms)?);
        word(&mut data, U256::from(s.a.deadline));
        word(&mut data, U256::from(b[64]));
        data.extend(&b[..64]);
        Ok(NativeSignedFusionPermit {
            owner: s.a.owner.clone(),
            input_atoms: s.p.input_atoms.clone(),
            nonce: s.p.nonce.clone(),
            deadline: s.a.deadline,
            signature: sig,
            signature_hash: format!("{digest:#x}"),
            permit_data: alloy_primitives::hex::encode_prefixed(data),
        })
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.a.seed = None;
            s.a.approved = false;
        }
    }
}
fn check_permit_state(
    p: &PermitProposal,
    s: &NativeEthereumLiquidityState,
) -> Result<(), SignerError> {
    if s.permit_nonce != p.nonce
        || s.usdc_domain_separator.to_lowercase()
            != format!("{:#x}", domain("USD Coin", "2", addr(USDC)?))
        || dec(&s.usdc_balance_atoms)? < dec(&p.input_atoms)?
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn review_binding(review: &str, digest: B256, body_hash: &str) -> String {
    let mut out = review.as_bytes().to_vec();
    out.extend(digest.as_slice());
    out.extend(body_hash.as_bytes());
    format!("{:#x}", keccak256(out))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrderProposal {
    kind: String,
    #[serde(default)]
    cycle_index: u32,
    investment_slot: Option<u32>,
    operation_id: String,
    revision: u64,
    chain_id: u64,
    expected_from: String,
    confidential_account: String,
    quote_id: String,
    input_atoms: String,
    minimum_eth_wei: String,
    gross_eth_wei: String,
    maximum_resolver_overhead_wei: String,
    deadline: u64,
    funding_mode: String,
    unsigned_order: FusionOrder,
    extension: String,
}
struct OrderInner {
    a: Authority,
    p: OrderProposal,
    baseline: Option<NativeEthereumLiquidityState>,
    permit: Option<NativeSignedFusionPermit>,
}
#[derive(uniffi::Object)]
pub struct EthereumFusionOrderOperation {
    state: Mutex<OrderInner>,
}
#[uniffi::export]
impl EthereumFusionOrderOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: OrderProposal = parse(&proposal)?;
        if p.kind != "fusionEthOrder"
            || p.quote_id.is_empty()
            || p.quote_id.len() > 128
            || !["allowance", "permit"].contains(&p.funding_mode.as_str())
            || dec(&p.input_atoms)? == U256::ZERO
            || dec(&p.minimum_eth_wei)? == U256::ZERO
            || dec(&p.gross_eth_wei)? < dec(&p.minimum_eth_wei)?
        {
            return Err(SignerError::InvalidInput);
        }
        dec(&p.maximum_resolver_overhead_wei)?;
        bytes(&p.extension, 4096)?;
        let a = Authority::new(
            entropy,
            AuthorityConfig {
                id: &p.operation_id,
                revision: p.revision,
                chain: p.chain_id,
                cycle_index: p.cycle_index,
                investment_slot: p.investment_slot,
                expected: &p.expected_from,
                c: &p.confidential_account,
                deadline: p.deadline,
            },
        )?;
        Ok(Arc::new(Self {
            state: Mutex::new(OrderInner {
                a,
                p,
                baseline: None,
                permit: None,
            }),
        }))
    }
    pub fn prepare(
        &self,
        revision: u64,
        current: NativeEthereumLiquidityState,
        quote: NativeFusionQuoteBinding,
        permit: Option<NativeSignedFusionPermit>,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if revision != s.a.revision || s.baseline.is_some() {
            return Err(SignerError::InvalidInput);
        }
        check_state(&s.a, &current)?;
        check_fusion_quote(
            &s.a,
            &s.p.quote_id,
            &s.p.input_atoms,
            &s.p.minimum_eth_wei,
            &s.p.gross_eth_wei,
            &s.p.maximum_resolver_overhead_wei,
            &quote,
        )?;
        check_order(&s.a, &s.p, &current, permit.as_ref())?;
        let digest = fusion_order_digest(&s.p.unsigned_order)?;
        let ext_hash = keccak256(bytes(&s.p.extension, 4096)?);
        if quote.order_hash.to_lowercase() != format!("{digest:#x}")
            || quote.extension_hash.to_lowercase() != format!("{ext_hash:#x}")
        {
            return Err(SignerError::InvalidInput);
        }
        let nonce = order_nonce(&s.p.unsigned_order)?;
        let review = format!(
            "FUSION USDC TO NATIVE ETH · ETHEREUM chain 1\nOperation {} · revision {}\nOwner and ETH recipient {} · confidential account {}\nQuote {} · funding {}\nExact USDC input {} atoms · minimum net ETH {} wei · gross resolver ETH {} wei\nMaximum resolver gas and profit overhead {} wei\nRouter {} · settlement {} · protocol fee receiver {}\nOne full fill; no partial or multiple fills, integrator fee, surplus fee, arbitrary interaction or Permit2\nOrder nonce {} · deadline {} Unix seconds\nOrder hash {:#x} · extension hash {:#x}\nIndependent order authorization. A signed order may fill until expiry; cancellation cannot recall a completed fill. Reconcile received native ETH before vault approval or deposit.",
            s.a.id,
            s.a.revision,
            s.a.owner,
            s.a.confidential,
            s.p.quote_id,
            s.p.funding_mode,
            s.p.input_atoms,
            s.p.minimum_eth_wei,
            s.p.gross_eth_wei,
            s.p.maximum_resolver_overhead_wei,
            FUSION_ROUTER,
            SETTLEMENT,
            FEE_RECEIVER,
            nonce,
            s.a.deadline,
            digest,
            ext_hash
        );
        s.a.hash = Some(review_binding(
            &review,
            digest,
            &quote.authenticated_body_hash,
        ));
        s.a.quote_expires = quote.expires_at;
        s.baseline = Some(current);
        s.permit = permit;
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
        current: NativeEthereumLiquidityState,
    ) -> Result<NativeSignedFusionOrder, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        s.a.live()?;
        if !s.a.approved {
            return Err(SignerError::InvalidInput);
        }
        let checked = (|| {
            if revision != s.a.revision {
                return Err(SignerError::InvalidInput);
            }
            check_state(&s.a, &current)?;
            continuity(
                s.baseline.as_ref().ok_or(SignerError::InvalidInput)?,
                &current,
            )?;
            check_order(&s.a, &s.p, &current, s.permit.as_ref())
        })();
        if let Err(e) = checked {
            s.a.seed = None;
            return Err(e);
        }
        let seed = s.a.seed.take().ok_or(SignerError::InvalidInput)?;
        let digest = fusion_order_digest(&s.p.unsigned_order)?;
        Ok(NativeSignedFusionOrder {
            operation_id: s.a.id.clone(),
            revision: s.a.revision,
            quote_id: s.p.quote_id.clone(),
            order_hash: format!("{digest:#x}"),
            signature: signature_hex(&seed, s.a.cycle_index, s.a.investment_slot, digest)?,
            unsigned_order: serde_json::to_string(&s.p.unsigned_order)
                .map_err(|_| SignerError::InvalidInput)?,
            extension: s.p.extension.clone(),
            review_hash: s.a.hash.clone().ok_or(SignerError::InvalidInput)?,
        })
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.a.seed = None;
            s.a.approved = false;
        }
    }
}
fn order_nonce(o: &FusionOrder) -> Result<U256, SignerError> {
    Ok((dec(&o.maker_traits)? >> 120usize) & ((U256::from(1) << 40usize) - U256::from(1)))
}
fn check_order(
    a: &Authority,
    p: &OrderProposal,
    s: &NativeEthereumLiquidityState,
    permit: Option<&NativeSignedFusionPermit>,
) -> Result<(), SignerError> {
    let o = &p.unsigned_order;
    let nonce = order_nonce(o)?;
    let flags = (U256::from(1) << 255usize)
        | (U256::from(1) << 251usize)
        | (U256::from(1) << 249usize)
        | (U256::from(1) << 247usize);
    let expected = flags | (U256::from(a.deadline) << 80usize) | (nonce << 120usize);
    if addr(&o.maker)? != addr(&a.owner)?
        || addr(&o.maker_asset)? != addr(USDC)?
        || addr(&o.taker_asset)? != addr(WETH)?
        || o.making_amount != p.input_atoms
        || dec(&o.maker_traits)? != expected
        || a.deadline >= (1u64 << 40)
        || dec(&s.usdc_balance_atoms)? < dec(&p.input_atoms)?
        || dec(&s.fusion_nonce_slot)? != nonce >> 8usize
    {
        return Err(SignerError::InvalidInput);
    }
    let bit = usize::try_from(nonce & U256::from(255)).map_err(|_| SignerError::InvalidInput)?;
    if (dec(&s.fusion_invalidator_word)? & (U256::from(1) << bit)) != U256::ZERO {
        return Err(SignerError::InvalidInput);
    }
    let ext = bytes(&p.extension, 4096)?;
    let mask = (U256::from(1) << 160usize) - U256::from(1);
    if dec(&o.salt)? & mask != U256::from_be_slice(keccak256(&ext).as_slice()) & mask {
        return Err(SignerError::InvalidInput);
    }
    let fields = extension_fields(&ext)?;
    if [0, 1, 4, 6, 8].iter().any(|i| !fields[*i].is_empty()) || fields[2] != fields[3] {
        return Err(SignerError::InvalidInput);
    }
    if p.funding_mode == "allowance" {
        if permit.is_some()
            || !fields[5].is_empty()
            || dec(&s.fusion_allowance_atoms)? < dec(&p.input_atoms)?
        {
            return Err(SignerError::InvalidInput);
        }
    } else {
        let permit = permit.ok_or(SignerError::InvalidInput)?;
        check_signed_permit(a, p, s, permit)?;
        let mut expected = addr(USDC)?.as_slice().to_vec();
        expected.extend(bytes(&permit.permit_data, 224)?);
        if fields[5] != expected {
            return Err(SignerError::InvalidInput);
        }
    }
    check_fusion_extension(a, p, &fields[2], &fields[7])
}
fn extension_fields(ext: &[u8]) -> Result<Vec<Vec<u8>>, SignerError> {
    if ext.len() < 32 {
        return Err(SignerError::InvalidInput);
    }
    let offsets = U256::from_be_slice(&ext[..32]);
    let data = &ext[32..];
    let mut previous = 0usize;
    let mut result = Vec::new();
    for i in 0..8 {
        let end = usize::try_from((offsets >> (i * 32)) & U256::from(u32::MAX))
            .map_err(|_| SignerError::InvalidInput)?;
        if end < previous || end > data.len() {
            return Err(SignerError::InvalidInput);
        }
        result.push(data[previous..end].to_vec());
        previous = end;
    }
    result.push(data[previous..].to_vec());
    Ok(result)
}
fn read_num(slice: &[u8]) -> u64 {
    slice.iter().fold(0u64, |v, b| (v << 8) | u64::from(*b))
}
fn check_fusion_extension(
    a: &Authority,
    p: &OrderProposal,
    amount: &[u8],
    post: &[u8],
) -> Result<(), SignerError> {
    if amount.len() < 45
        || post.len() < 115
        || amount[..20] != addr(SETTLEMENT)?.as_slice()[..]
        || post[..20] != addr(SETTLEMENT)?.as_slice()[..]
    {
        return Err(SignerError::InvalidInput);
    }
    let clock = now()?;
    let start = read_num(&amount[27..31]);
    let duration = read_num(&amount[31..34]);
    if duration != 180
        || amount[34..38] != [0; 4]
        || start > clock.checked_add(120).ok_or(SignerError::InvalidInput)?
        || clock.saturating_sub(start) > 60
        || a.deadline < start.checked_add(180).ok_or(SignerError::InvalidInput)?
        || a.deadline > start.checked_add(240).ok_or(SignerError::InvalidInput)?
    {
        return Err(SignerError::InvalidInput);
    }
    // Flat auction: no rate bump or curve points, so gas-adjustment fields cannot raise/lower the rate.
    let fee_bytes = &amount[38..44];
    let resolver = read_num(&fee_bytes[3..5]);
    let discount = u64::from(fee_bytes[5]);
    let count = usize::from(amount[44]);
    if fee_bytes[..3] != [0; 3]
        || discount > 100
        || count == 0
        || count > 100
        || amount.len() != 45 + count * 10
        || post[20] != 1
        || post[21..41] != [0; 20]
        || post[61..81] != addr(&a.owner)?.as_slice()[..]
        || post[81..87] != fee_bytes[..]
    {
        return Err(SignerError::InvalidInput);
    }
    if post[41..61]
        != (if resolver > 0 {
            addr(FEE_RECEIVER)?
        } else {
            Address::ZERO
        })
        .as_slice()[..]
        || addr(&p.unsigned_order.receiver)?
            != if resolver > 0 {
                addr(SETTLEMENT)?
            } else {
                addr(&a.owner)?
            }
    {
        return Err(SignerError::InvalidInput);
    }
    let resolving_start = read_num(&post[87..91]);
    if resolving_start > start
        || resolving_start > clock.checked_add(5).ok_or(SignerError::InvalidInput)?
        || clock.saturating_sub(resolving_start) > 60
        || usize::from(post[91]) != count
        || post.len() != 92 + count * 12 + 33
        || post[post.len() - 1] != 0
    {
        return Err(SignerError::InvalidInput);
    }
    let mut allowed = resolving_start;
    let mut halves = Vec::<Vec<u8>>::new();
    for i in 0..count {
        let half = &amount[45 + i * 10..55 + i * 10];
        let at = 92 + i * 12;
        if half.iter().all(|b| *b == 0)
            || halves.iter().any(|h| h == half)
            || post[at..at + 10] != half[..]
        {
            return Err(SignerError::InvalidInput);
        }
        halves.push(half.to_vec());
        allowed = allowed
            .checked_add(read_num(&post[at + 10..at + 12]))
            .ok_or(SignerError::InvalidInput)?;
        if allowed > start + 180 {
            return Err(SignerError::InvalidInput);
        }
    }
    let effective = U256::from(resolver * discount / 100);
    let base = U256::from(100000);
    let denominator = base + effective;
    let taking = dec(&p.unsigned_order.taking_amount)?;
    let gross = ceil(
        taking
            .checked_mul(denominator)
            .ok_or(SignerError::InvalidInput)?,
        base,
    )?;
    let fee = gross
        .checked_mul(effective)
        .ok_or(SignerError::InvalidInput)?
        / denominator;
    let net = gross.checked_sub(fee).ok_or(SignerError::InvalidInput)?;
    if net != dec(&p.minimum_eth_wei)? || gross != dec(&p.gross_eth_wei)? {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
fn check_signed_permit(
    a: &Authority,
    p: &OrderProposal,
    s: &NativeEthereumLiquidityState,
    permit: &NativeSignedFusionPermit,
) -> Result<(), SignerError> {
    if addr(&permit.owner)? != addr(&a.owner)?
        || permit.input_atoms != p.input_atoms
        || permit.nonce != s.permit_nonce
        || permit.deadline != a.deadline
        || s.usdc_domain_separator.to_lowercase()
            != format!("{:#x}", domain("USD Coin", "2", addr(USDC)?))
    {
        return Err(SignerError::InvalidInput);
    }
    let digest = permit_digest(
        addr(&a.owner)?,
        dec(&p.input_atoms)?,
        dec(&permit.nonce)?,
        a.deadline,
    );
    if permit.signature_hash.to_lowercase() != format!("{digest:#x}") {
        return Err(SignerError::InvalidInput);
    }
    let b = bytes(&permit.signature, 65)?;
    if b.len() != 65 || ![27, 28].contains(&b[64]) {
        return Err(SignerError::InvalidInput);
    }
    let sig =
        k256::ecdsa::Signature::from_slice(&b[..64]).map_err(|_| SignerError::InvalidInput)?;
    if sig.normalize_s() != sig {
        return Err(SignerError::InvalidInput);
    }
    let id = k256::ecdsa::RecoveryId::from_byte(b[64] - 27).ok_or(SignerError::InvalidInput)?;
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(digest.as_ref(), &sig, id)
        .map_err(|_| SignerError::InvalidInput)?;
    if addr(&address(&key))? != addr(&a.owner)? {
        return Err(SignerError::InvalidInput);
    }
    let mut expected = Vec::new();
    aword(&mut expected, addr(&a.owner)?);
    aword(&mut expected, addr(FUSION_ROUTER)?);
    word(&mut expected, dec(&p.input_atoms)?);
    word(&mut expected, U256::from(a.deadline));
    word(&mut expected, U256::from(b[64]));
    expected.extend(&b[..64]);
    if bytes(&permit.permit_data, 224)? != expected {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    const OWNER: &str = "0xB5927c0bbE474886EA8A87a2E9a761386Dec63bc";
    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }
    fn state() -> NativeEthereumLiquidityState {
        NativeEthereumLiquidityState {
            chain_id: 1,
            owner: OWNER.into(),
            observed_at: now(),
            block_number: 100,
            block_hash: format!("0x{}", "11".repeat(32)),
            parent_hash: format!("0x{}", "22".repeat(32)),
            nonce: 4,
            native_balance_wei: "1000000000000000000".into(),
            usdc_balance_atoms: "1000000".into(),
            weth_balance_atoms: "0".into(),
            shares: "0".into(),
            fusion_allowance_atoms: "1000000".into(),
            permit_nonce: "4".into(),
            usdc_domain_separator: "".into(),
            fusion_nonce_slot: "0".into(),
            fusion_invalidator_word: "0".into(),
            sender_code: "0x".into(),
            recipient_code: "0x".into(),
            recipient_asset_balance_atoms: "0".into(),
            base_fee_wei: "1000000000".into(),
            usdc_code_hash: format!("0x{}", "33".repeat(32)),
            weth_code_hash: format!("0x{}", "44".repeat(32)),
            router_code_hash: format!("0x{}", "55".repeat(32)),
            settlement_code_hash: format!("0x{}", "66".repeat(32)),
            fee_receiver_code_hash: format!("0x{}", "77".repeat(32)),
            vault_code_hash: format!("0x{}", "88".repeat(32)),
        }
    }
    fn c() -> String {
        crate::derive_earn_confidential_address(vec![0; 32], 1).unwrap()
    }
    fn tx_proposal(kind: &str) -> Value {
        json!({"kind":kind,"operationId":"return1","revision":7,"chainId":1,"expectedFrom":OWNER,"amountAtoms":"1000000","nonce":4,"deadline":now()+300,"gasLimit":if kind=="returnEth"{21000}else{65000},"maxFeePerGasWei":"10000000000","priorityFeePerGasWei":if kind=="returnEth"{"0"}else{"1000000000"},"maximumGasCostWei":"650000000000000","withdrawalReserveWei":"0","recipient":"0x1111111111111111111111111111111111111111","quoteId":"quote1","confidentialAccount":c(),"refundOwner":OWNER})
    }
    fn return_state(kind: &str) -> NativeEthereumLiquidityState {
        let mut s = state();
        if kind == "returnEth" {
            s.native_balance_wei = "210000001000000".into();
            s.usdc_balance_atoms = "0".into();
        }
        s
    }
    fn return_proof(p: &Value) -> NativeEarnQuoteBinding {
        NativeEarnQuoteBinding {
            operation_id: "return1".into(),
            revision: 7,
            quote_id: "quote1".into(),
            chain_id: 1,
            token: if p["kind"] == "returnEth" {
                "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            } else {
                "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
            }
            .into(),
            recipient: p["recipient"].as_str().unwrap().into(),
            amount_atoms: p["amountAtoms"].as_str().unwrap().into(),
            confidential_account: c(),
            refund_owner: OWNER.into(),
            expires_at: p["deadline"].as_u64().unwrap(),
            authenticated_body_hash: format!("0x{}", "99".repeat(32)),
            fee_policy: None,
        }
    }
    const EXT: &str = "0x000000f70000006e0000006e0000006e0000006e000000370000000000000000399740157391a9f1bf4e9921a8834f9bc8f2678e00000000000000713fb3000000b40000000000000000644b0111111111111111111111399740157391a9f1bf4e9921a8834f9bc8f2678e00000000000000713fb3000000b40000000000000000644b0111111111111111111111399740157391a9f1bf4e9921a8834f9bc8f2678e01000000000000000000000000000000000000000090cbe4bdd538d6e9b379bff5fe72c3d67a521de5b5927c0bbe474886ea8a87a2e9a761386dec63bc00000000644b713fb30001111111111111111111110000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00";
    fn static_order() -> Value {
        json!({"maker":OWNER,"makerAsset":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","takerAsset":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","makerTraits":"62645329528782394789705396186340918897185917484560159740076986458868472086528","salt":"2486288056144609084805508274342597061287755602249","makingAmount":"1000000","takingAmount":"200000000000000","receiver":"0x399740157391a9f1bf4e9921a8834f9bc8f2678e"})
    }
    #[test]
    fn fusion_and_fixed_usdc_permit_digests_match_installed_sdk_and_viem() {
        assert_eq!(
            format!(
                "{:#x}",
                fusion_order_digest(
                    &serde_json::from_value::<FusionOrder>(static_order()).unwrap()
                )
                .unwrap()
            ),
            "0x226d2648be933df963d4760dc134c8971e98085745d2172a6538bd7f3d3c12d3"
        );
        assert_eq!(
            format!(
                "{:#x}",
                permit_digest(
                    OWNER.parse().unwrap(),
                    alloy_primitives::U256::from(1000000),
                    alloy_primitives::U256::from(4),
                    1900000240
                )
            ),
            "0xd55e3df6656505436b193a682cc4f9de2ba2b5e616689537035f9806bdc4a839"
        );
    }
    #[test]
    fn ethereum_return_requires_verified_quote_and_native_empty_recipient_state() {
        for kind in ["returnEth", "returnUsdc"] {
            let p = tx_proposal(kind);
            let o = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
            assert!(o.prepare(7, return_state(kind), None, None).is_err());
            let review = o
                .prepare(7, return_state(kind), None, Some(return_proof(&p)))
                .unwrap();
            assert!(review.contains(OWNER));
            assert!(o.sign(7, return_state(kind)).is_err());
            o.approve(7, o.review_hash().unwrap()).unwrap();
            let signed = o.sign(7, return_state(kind)).unwrap();
            assert_eq!(
                signed.raw_transaction.starts_with("0x02"),
                kind == "returnUsdc"
            );
            assert_eq!(signed.from, OWNER);
            assert!(o.sign(7, return_state(kind)).is_err());
        }
    }
    #[test]
    fn returns_deny_bad_bindings_role_zero_contracts_used_recipients_and_fee_shortfall() {
        let p = tx_proposal("returnUsdc");
        for i in 0..8 {
            let o = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
            let mut s = state();
            let mut q = return_proof(&p);
            match i {
                0 => q.refund_owner = "0x1111111111111111111111111111111111111111".into(),
                1 => q.confidential_account = OWNER.into(),
                2 => q.chain_id = 4663,
                3 => q.amount_atoms = "999999".into(),
                4 => s.recipient_code = "0x6000".into(),
                5 => s.recipient_asset_balance_atoms = "1".into(),
                6 => s.native_balance_wei = "1".into(),
                _ => s.shares = "1".into(),
            };
            assert!(o.prepare(7, s, None, Some(q)).is_err());
        }
        let p = p
            .to_string()
            .replace(OWNER, "0x115Fd06B8190FDb68C1A840468661Ada279D1d72");
        assert!(EthereumLiquidityTransactionOperation::new(p, vec![0; 32]).is_err());
    }
    #[test]
    fn return_nonce_revision_and_fresh_state_tampering_revoke_authority() {
        let p = tx_proposal("returnEth");
        let o = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, return_state("returnEth"), None, Some(return_proof(&p)))
            .unwrap();
        assert!(o.approve(8, o.review_hash().unwrap()).is_err());
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let mut s = return_state("returnEth");
        s.nonce = 5;
        assert!(o.sign(7, s).is_err());
        assert!(o.sign(7, return_state("returnEth")).is_err());
    }
    fn recover(sig: &str, hash: B256) -> String {
        let b = bytes(sig, 65).unwrap();
        let k = k256::ecdsa::VerifyingKey::recover_from_prehash(
            hash.as_ref(),
            &k256::ecdsa::Signature::from_slice(&b[..64]).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(b[64] - 27).unwrap(),
        )
        .unwrap();
        address(&k)
    }
    fn active_order() -> Value {
        let start = now();
        let deadline = start + 240;
        let mut ext = bytes(EXT, 4096).unwrap();
        for offset in [59, 114, 229] {
            ext[offset..offset + 4].copy_from_slice(&(start as u32).to_be_bytes());
        }
        let mask: U256 = (U256::from(1) << 160) - U256::from(1);
        let salt: U256 =
            (U256::from(1) << 160) | (U256::from_be_slice(keccak256(&ext).as_slice()) & mask);
        let flags: U256 = (U256::from(1) << 255)
            | (U256::from(1) << 251)
            | (U256::from(1) << 249)
            | (U256::from(1) << 247);
        let mut o = static_order();
        o["salt"] = json!(salt.to_string());
        o["makerTraits"] = json!(
            (flags | (U256::from(deadline) << 80usize) | (U256::from(5) << 120usize)).to_string()
        );
        json!({"kind":"fusionEthOrder","operationId":"fusion1","revision":7,"chainId":1,"expectedFrom":OWNER,"confidentialAccount":c(),"quoteId":"fq1","inputAtoms":"1000000","minimumEthWei":"200000000000000","grossEthWei":"200150000000000","maximumResolverOverheadWei":"300000000000000","deadline":deadline,"fundingMode":"allowance","unsignedOrder":o,"extension":alloy_primitives::hex::encode_prefixed(ext)})
    }
    fn fusion_proof(p: &Value) -> NativeFusionQuoteBinding {
        let o: FusionOrder = serde_json::from_value(p["unsignedOrder"].clone()).unwrap();
        NativeFusionQuoteBinding {
            operation_id: "fusion1".into(),
            revision: 7,
            quote_id: "fq1".into(),
            owner: OWNER.into(),
            confidential_account: c(),
            input_atoms: "1000000".into(),
            minimum_eth_wei: "200000000000000".into(),
            gross_eth_wei: "200150000000000".into(),
            deadline: p["deadline"].as_u64().unwrap(),
            quoted_at: now(),
            expires_at: now() + 60,
            order_hash: format!("{:#x}", fusion_order_digest(&o).unwrap()),
            extension_hash: format!(
                "{:#x}",
                keccak256(bytes(p["extension"].as_str().unwrap(), 4096).unwrap())
            ),
            authenticated_body_hash: format!("0x{}", "99".repeat(32)),
            resolver_gas_units: "243432".into(),
            resolver_gas_price_wei: "1000000000".into(),
            resolver_gas_cost_wei: "243432000000000".into(),
            resolver_profit_wei: "24343200000000".into(),
            input_value_wei: "1000000000000000".into(),
        }
    }
    #[test]
    fn final_auction_preserves_reviewed_permit_expiration_after_ceremony_delay() {
        let mut p = active_order();
        // A refreshed 180-second auction starts later; the previously reviewed
        // absolute deadline still covers it with a shorter bounded tail.
        let deadline = p["deadline"].as_u64().unwrap() - 10;
        p["deadline"] = json!(deadline);
        let traits: U256 = p["unsignedOrder"]["makerTraits"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let clear: U256 = !(((U256::from(1) << 40usize) - U256::from(1)) << 80usize);
        p["unsignedOrder"]["makerTraits"] =
            json!(((traits & clear) | (U256::from(deadline) << 80usize)).to_string());
        let operation = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        operation
            .prepare(7, state(), fusion_proof(&p), None)
            .unwrap();
    }
    #[test]
    fn expired_saved_return_can_only_be_cancelled_at_its_exact_nonce_by_its_owner() {
        let original = tx_proposal("returnUsdc");
        let o =
            EthereumLiquidityTransactionOperation::new(original.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, state(), None, Some(return_proof(&original)))
            .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let signed = o.sign(7, state()).unwrap();
        let p = json!({"kind":"cancelPendingLiquidity","operationId":"return1","revision":8,"chainId":1,"expectedFrom":OWNER,"confidentialAccount":c(),"originalRawTransaction":signed.raw_transaction,"originalTransactionHash":signed.transaction_hash,"nonce":4,"deadline":now()+300,"gasLimit":21000,"maxFeePerGasWei":"11250000000","priorityFeePerGasWei":"1125000000","maximumGasCostWei":"236250000000000"});
        let cancel =
            EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(cancel.sign(8, state()).is_err());
        let review = cancel.prepare(8, state()).unwrap();
        assert!(review.contains("older transaction can still win"));
        cancel.approve(8, cancel.review_hash().unwrap()).unwrap();
        let cancelled = cancel.sign(8, state()).unwrap();
        let raw = bytes(&cancelled.raw_transaction, 2048).unwrap();
        let decoded =
            alloy_consensus::Signed::<TxEip1559>::eip2718_decode(&mut raw.as_slice()).unwrap();
        assert_eq!(decoded.tx().to, TxKind::Call(addr(OWNER).unwrap()));
        assert_eq!(decoded.tx().value, U256::ZERO);
        assert!(decoded.tx().input.is_empty());
        assert_eq!(decoded.tx().nonce, 4);
        assert!(cancel.sign(8, state()).is_err());
        for change in [
            json!({"nonce":5}),
            json!({"maxFeePerGasWei":"10000000000"}),
            json!({"originalTransactionHash":format!("0x{}","99".repeat(32))}),
            json!({"gasLimit":22000}),
        ] {
            let mut bad = p.clone();
            for (k, v) in change.as_object().unwrap() {
                bad[k] = v.clone();
            }
            assert!(
                EthereumLiquidityCancellationOperation::new(bad.to_string(), vec![0; 32]).is_err()
            );
        }
    }
    fn permit_proposal(p: &Value) -> Value {
        json!({"kind":"fusionUsdcPermit","operationId":"fusion1","revision":7,"chainId":1,"expectedFrom":OWNER,"confidentialAccount":c(),"quoteId":"fq1","inputAtoms":"1000000","minimumEthWei":"200000000000000","grossEthWei":"200150000000000","maximumResolverOverheadWei":"300000000000000","deadline":p["deadline"],"nonce":"4"})
    }
    fn permit_state() -> NativeEthereumLiquidityState {
        let mut s = state();
        s.native_balance_wei = "0".into();
        s.fusion_allowance_atoms = "0".into();
        s.usdc_domain_separator = format!("{:#x}", domain("USD Coin", "2", addr(USDC).unwrap()));
        s
    }
    #[test]
    fn fixed_permit_zero_eth_and_fusion_order_are_native_approved_once_and_recover_owner() {
        let p = active_order();
        let q = fusion_proof(&p);
        let permit =
            EthereumFusionPermitOperation::new(permit_proposal(&p).to_string(), vec![0; 32])
                .unwrap();
        permit.prepare(7, permit_state(), q.clone()).unwrap();
        assert!(permit.sign(7, permit_state()).is_err());
        permit.approve(7, permit.review_hash().unwrap()).unwrap();
        let signed = permit.sign(7, permit_state()).unwrap();
        assert_eq!(
            recover(
                &signed.signature,
                permit_digest(
                    addr(OWNER).unwrap(),
                    U256::from(1000000),
                    U256::from(4),
                    signed.deadline
                )
            ),
            OWNER
        );
        assert_eq!(bytes(&signed.permit_data, 224).unwrap().len(), 224);
        assert!(permit.sign(7, permit_state()).is_err());
        let order = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        order.prepare(7, state(), q, None).unwrap();
        assert!(order.sign(7, state()).is_err());
        order.approve(7, order.review_hash().unwrap()).unwrap();
        let signed = order.sign(7, state()).unwrap();
        assert_eq!(
            recover(&signed.signature, signed.order_hash.parse().unwrap()),
            OWNER
        );
        assert!(order.sign(7, state()).is_err());
    }
    #[test]
    fn fusion_rejects_mutated_semantics_even_with_matching_gateway_hash() {
        for i in 0..9 {
            let mut p = active_order();
            let mut s = state();
            match i {
                0 => p["unsignedOrder"]["receiver"] = json!(OWNER),
                1 => p["unsignedOrder"]["maker"] = json!(USDC),
                2 => p["unsignedOrder"]["makingAmount"] = json!("999999"),
                3 => p["unsignedOrder"]["makerTraits"] = json!("0"),
                4 => s.fusion_invalidator_word = "32".into(),
                5 => s.fusion_allowance_atoms = "0".into(),
                6 => {
                    let mut ext = bytes(p["extension"].as_str().unwrap(), 4096).unwrap();
                    ext[213] ^= 1;
                    p["extension"] = json!(alloy_primitives::hex::encode_prefixed(ext));
                }
                7 => p["unsignedOrder"]["salt"] = json!("1"),
                _ => p["fundingMode"] = json!("permit"),
            };
            let q = fusion_proof(&p);
            let result = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]);
            assert!(
                result.is_err() || result.unwrap().prepare(7, s, q, None).is_err(),
                "tamper {i}"
            );
        }
    }
    #[test]
    fn permit_and_order_fresh_nonce_domain_quote_cost_and_revision_must_match() {
        let p = active_order();
        let pp = permit_proposal(&p);
        for i in 0..4 {
            let o = EthereumFusionPermitOperation::new(pp.to_string(), vec![0; 32]).unwrap();
            let mut s = permit_state();
            let mut q = fusion_proof(&p);
            match i {
                0 => s.permit_nonce = "5".into(),
                1 => s.usdc_domain_separator = format!("0x{}", "aa".repeat(32)),
                2 => q.resolver_gas_cost_wei = "1".into(),
                _ => q.confidential_account = OWNER.into(),
            };
            assert!(o.prepare(7, s, q).is_err());
        }
        let o = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, state(), fusion_proof(&p), None).unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let mut s = state();
        s.fusion_invalidator_word = "32".into();
        assert!(o.sign(7, s).is_err());
        assert!(o.sign(7, state()).is_err());
    }
    fn set_extension(p: &mut Value, ext: Vec<u8>) {
        let mask = (U256::from(1) << 160usize) - U256::from(1);
        let salt =
            (U256::from(1) << 160usize) | (U256::from_be_slice(keccak256(&ext).as_slice()) & mask);
        p["unsignedOrder"]["salt"] = json!(salt.to_string());
        p["extension"] = json!(alloy_primitives::hex::encode_prefixed(ext));
    }
    #[test]
    fn canonical_sdk_delayed_auction_uses_whitelist_start_now() {
        let mut p = active_order();
        let mut ext = bytes(p["extension"].as_str().unwrap(), 4096).unwrap();
        let start = now() + 12;
        for at in [59, 114] {
            ext[at..at + 4].copy_from_slice(&(start as u32).to_be_bytes());
        }
        let deadline = start + 240;
        p["deadline"] = json!(deadline);
        let traits = dec(p["unsignedOrder"]["makerTraits"].as_str().unwrap()).unwrap();
        let clear = !(((U256::from(1) << 40usize) - U256::from(1)) << 80usize);
        p["unsignedOrder"]["makerTraits"] =
            json!(((traits & clear) | (U256::from(deadline) << 80usize)).to_string());
        set_extension(&mut p, ext);
        let o = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, state(), fusion_proof(&p), None).unwrap();
    }
    #[test]
    fn signed_permit_is_exactly_embedded_then_rehashed_and_separately_reviewed() {
        let mut p = active_order();
        let permit =
            EthereumFusionPermitOperation::new(permit_proposal(&p).to_string(), vec![0; 32])
                .unwrap();
        permit.prepare(7, permit_state(), fusion_proof(&p)).unwrap();
        permit.approve(7, permit.review_hash().unwrap()).unwrap();
        let signed = permit.sign(7, permit_state()).unwrap();
        let ext = bytes(p["extension"].as_str().unwrap(), 4096).unwrap();
        let mut fields = extension_fields(&ext).unwrap();
        fields[5] = addr(USDC).unwrap().as_slice().to_vec();
        fields[5].extend(bytes(&signed.permit_data, 224).unwrap());
        let mut offsets = U256::ZERO;
        let mut cursor = 0;
        let mut data: Vec<u8> = Vec::new();
        for (i, field) in fields[..8].iter().enumerate() {
            cursor += field.len();
            offsets |= U256::from(cursor) << (32 * i);
            data.extend(field);
        }
        let mut ext = offsets.to_be_bytes::<32>().to_vec();
        ext.extend(data);
        set_extension(&mut p, ext);
        p["fundingMode"] = json!("permit");
        let o = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, permit_state(), fusion_proof(&p), Some(signed.clone()))
            .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        assert_eq!(
            recover(
                &o.sign(7, permit_state()).unwrap().signature,
                fusion_proof(&p).order_hash.parse().unwrap()
            ),
            OWNER
        );
        let mut bad = signed;
        bad.permit_data = bad.permit_data.replace("000f4240", "000f423f");
        let o = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, permit_state(), fusion_proof(&p), Some(bad))
                .is_err()
        );
    }
    #[test]
    fn fusion_unknown_duplicate_fields_expiry_and_concurrent_signing_deny() {
        let p = active_order();
        let mut unknown = p.clone();
        unknown["digest"] = json!("0x01");
        assert!(EthereumFusionOrderOperation::new(unknown.to_string(), vec![0; 32]).is_err());
        let duplicate =
            p.to_string()
                .replacen("\"revision\":7", "\"revision\":7,\"revision\":7", 1);
        assert!(EthereumFusionOrderOperation::new(duplicate, vec![0; 32]).is_err());
        let o = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, state(), fusion_proof(&p), None).unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let first = o.clone();
        let second = o.clone();
        let threads = [
            std::thread::spawn(move || first.sign(7, state())),
            std::thread::spawn(move || second.sign(7, state())),
        ];
        let successes = threads
            .into_iter()
            .filter(|t| t.thread().id() != std::thread::current().id())
            .map(|t| t.join().unwrap().is_ok() as u8)
            .sum::<u8>();
        assert_eq!(successes, 1);
        let o = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, state(), fusion_proof(&p), None).unwrap();
        o.state.lock().unwrap().a.lifetime = Duration::ZERO;
        assert!(matches!(o.review_hash(), Err(SignerError::Expired)));
    }
    #[test]
    fn native_eth_return_legacy_exact_sweep_recovers_owner_and_zero_residual() {
        let mut p = tx_proposal("returnEth");
        p["priorityFeePerGasWei"] = json!("0");
        let mut s = state();
        s.native_balance_wei = "210000001000000".into();
        s.usdc_balance_atoms = "0".into();
        let o = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        o.prepare(7, s.clone(), None, Some(return_proof(&p)))
            .unwrap();
        o.approve(7, o.review_hash().unwrap()).unwrap();
        let signed = o.sign(7, s.clone()).unwrap();
        let raw = bytes(&signed.raw_transaction, 2048).unwrap();
        let decoded = alloy_consensus::Signed::<alloy_consensus::TxLegacy>::eip2718_decode(
            &mut raw.as_slice(),
        )
        .unwrap();
        let sig = decoded.signature();
        let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
            decoded.tx().signature_hash().as_ref(),
            &k256::ecdsa::Signature::from_slice(&sig.as_bytes()[..64]).unwrap(),
            k256::ecdsa::RecoveryId::from_byte(u8::from(sig.v())).unwrap(),
        )
        .unwrap();
        assert_eq!(address(&key), OWNER);
        assert_eq!(decoded.tx().chain_id, Some(1));
        assert_eq!(decoded.tx().gas_price, 10000000000);
        assert_eq!(decoded.tx().gas_limit, 21000);
        assert!(decoded.tx().input.is_empty());
        assert_eq!(
            dec(&s.native_balance_wei).unwrap()
                - decoded.tx().value
                - U256::from(21000) * U256::from(decoded.tx().gas_price),
            U256::ZERO
        );
        let mut stranded = s.clone();
        stranded.usdc_balance_atoms = "1".into();
        let o = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(
            o.prepare(7, stranded, None, Some(return_proof(&p)))
                .is_err()
        );
        let mut partial = s;
        partial.native_balance_wei = "210000001000001".into();
        let o = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        assert!(o.prepare(7, partial, None, Some(return_proof(&p))).is_err());
        let mut tip = p.clone();
        tip["priorityFeePerGasWei"] = json!("1");
        assert!(EthereumLiquidityTransactionOperation::new(tip.to_string(), vec![0; 32]).is_err());
    }
    fn cancellation_fixture(legacy: bool, entropy: u8, chain_id: u64, nonce: u64) -> Value {
        use alloy_primitives::Bytes;
        let seed = Mnemonic::from_entropy_in(Language::English, &[entropy; 32])
            .unwrap()
            .to_seed("");
        let raw = if legacy {
            let tx = TxLegacy {
                chain_id: Some(chain_id),
                nonce,
                gas_price: 10_000_000_000,
                gas_limit: 21000,
                to: TxKind::Call(addr(USDC).unwrap()),
                value: U256::from(1),
                input: Bytes::new(),
            };
            let sig = signature(&seed, 0, None, tx.signature_hash()).unwrap();
            let mut raw = Vec::new();
            tx.into_signed(sig).eip2718_encode(&mut raw);
            raw
        } else {
            let tx = TxEip1559 {
                chain_id,
                nonce,
                max_fee_per_gas: 10_000_000_000,
                max_priority_fee_per_gas: 1_000_000_000,
                gas_limit: 65000,
                to: TxKind::Call(addr(USDC).unwrap()),
                value: U256::ZERO,
                input: Bytes::from(vec![1, 2]),
                access_list: Default::default(),
            };
            let sig = signature(&seed, 0, None, tx.signature_hash()).unwrap();
            let mut raw = Vec::new();
            tx.into_signed(sig).eip2718_encode(&mut raw);
            raw
        };
        json!({"kind":"cancelPendingLiquidity","operationId":"cancel-fixture","revision":8,"chainId":1,"expectedFrom":OWNER,"confidentialAccount":c(),"originalRawTransaction":alloy_primitives::hex::encode_prefixed(&raw),"originalTransactionHash":format!("{:#x}",keccak256(&raw)),"nonce":4,"deadline":now()+300,"gasLimit":21000,"maxFeePerGasWei":"11250000000","priorityFeePerGasWei":if legacy {"0"}else{"1125000000"},"maximumGasCostWei":"236250000000000"})
    }
    #[test]
    fn cancellation_of_legacy_original_is_fixed_price_owned_self_zero_empty_data() {
        let p = cancellation_fixture(true, 0, 1, 4);
        let cancel =
            EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32]).unwrap();
        cancel.prepare(8, state()).unwrap();
        cancel.approve(8, cancel.review_hash().unwrap()).unwrap();
        let signed = cancel.sign(8, state()).unwrap();
        let raw = bytes(&signed.raw_transaction, 2048).unwrap();
        assert!(raw[0] >= 0xc0);
        let decoded =
            alloy_consensus::Signed::<TxLegacy>::eip2718_decode(&mut raw.as_slice()).unwrap();
        assert_eq!(decoded.tx().chain_id, Some(1));
        assert_eq!(decoded.tx().nonce, 4);
        assert_eq!(decoded.tx().gas_price, 11_250_000_000);
        assert_eq!(decoded.tx().gas_limit, 21000);
        assert_eq!(decoded.tx().to, TxKind::Call(addr(OWNER).unwrap()));
        assert_eq!(decoded.tx().value, U256::ZERO);
        assert!(decoded.tx().input.is_empty());
        assert_eq!(
            recover(
                &alloy_primitives::hex::encode_prefixed(decoded.signature().as_bytes()),
                decoded.tx().signature_hash()
            ),
            OWNER
        );
        assert_eq!(signed.transaction_hash, format!("{:#x}", keccak256(raw)));
    }
    #[test]
    fn cancellation_rejects_foreign_signer_chain_nonce_and_trailing_raw_for_both_families() {
        for legacy in [false, true] {
            for (entropy, chain, nonce) in [(1, 1, 4), (0, 143, 4), (0, 1, 5)] {
                let p = cancellation_fixture(legacy, entropy, chain, nonce);
                assert!(
                    EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32])
                        .is_err()
                );
            }
            let mut p = cancellation_fixture(legacy, 0, 1, 4);
            let mut raw = bytes(p["originalRawTransaction"].as_str().unwrap(), 2048).unwrap();
            raw.push(0);
            p["originalRawTransaction"] = json!(alloy_primitives::hex::encode_prefixed(&raw));
            p["originalTransactionHash"] = json!(format!("{:#x}", keccak256(raw)));
            assert!(
                EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32]).is_err()
            );
        }
    }
    #[test]
    fn cancellation_prepare_and_approved_sign_recheck_nonce_balance_and_base_fee() {
        for legacy in [false, true] {
            for phase in ["prepare", "sign"] {
                for change in ["nonce", "balance", "baseFee"] {
                    let p = cancellation_fixture(legacy, 0, 1, 4);
                    let cancel =
                        EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32])
                            .unwrap();
                    if phase == "sign" {
                        cancel.prepare(8, state()).unwrap();
                        cancel.approve(8, cancel.review_hash().unwrap()).unwrap();
                    }
                    let mut fresh = state();
                    match change {
                        "nonce" => fresh.nonce = 5,
                        "balance" => fresh.native_balance_wei = "236249999999999".into(),
                        _ => fresh.base_fee_wei = "11250000001".into(),
                    }
                    if phase == "prepare" {
                        assert!(cancel.prepare(8, fresh).is_err());
                    } else {
                        assert!(cancel.sign(8, fresh).is_err());
                        assert!(cancel.sign(8, state()).is_err());
                    }
                }
            }
        }
    }

    #[test]
    fn liquidity_return_signs_fresh_cycle_investment_key() {
        let mut p = tx_proposal("returnUsdc");
        p["cycleIndex"] = json!(2);
        let selected = crate::derive_earn_cycle_addresses(vec![0; 32], 1, 2).unwrap()[1].clone();
        p["expectedFrom"] = json!(selected);
        p["refundOwner"] = json!(selected);
        p["confidentialAccount"] =
            json!(crate::derive_earn_cycle_confidential_address(vec![0; 32], 1, 2).unwrap());
        let operation =
            EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut current = return_state("returnUsdc");
        current.owner = selected.clone();
        let mut q = return_proof(&p);
        q.refund_owner = selected.clone();
        q.confidential_account = p["confidentialAccount"].as_str().unwrap().into();
        operation
            .prepare(7, current.clone(), None, Some(q))
            .unwrap();
        operation
            .approve(7, operation.review_hash().unwrap())
            .unwrap();
        let signed = operation.sign(7, current).unwrap();
        assert_eq!(signed.from, selected);
        let raw = bytes(&signed.raw_transaction, 2048).unwrap();
        let tx = alloy_consensus::Signed::<TxEip1559>::eip2718_decode(&mut raw.as_slice()).unwrap();
        assert_eq!(
            recover(
                &alloy_primitives::hex::encode_prefixed(tx.signature().as_bytes()),
                tx.tx().signature_hash()
            ),
            selected
        );
        let mut permit = permit_proposal(&active_order());
        permit["cycleIndex"] = json!(2);
        permit["expectedFrom"] = p["expectedFrom"].clone();
        permit["confidentialAccount"] = p["confidentialAccount"].clone();
        assert!(EthereumFusionPermitOperation::new(permit.to_string(), vec![0; 32]).is_ok());
        let mut order = active_order();
        order["cycleIndex"] = json!(2);
        order["expectedFrom"] = p["expectedFrom"].clone();
        order["confidentialAccount"] = p["confidentialAccount"].clone();
        assert!(EthereumFusionOrderOperation::new(order.to_string(), vec![0; 32]).is_ok());
    }
    #[test]
    fn distribution_liquidity_return_signs_slot_key() {
        let mut p = tx_proposal("returnUsdc");
        p["cycleIndex"] = json!(2);
        p["investmentSlot"] = json!(4);
        let selected = crate::distribution_test_address(1, 2, 4);
        p["expectedFrom"] = json!(selected);
        p["refundOwner"] = json!(selected);
        p["confidentialAccount"] =
            json!(crate::derive_earn_cycle_confidential_address(vec![0; 32], 1, 2).unwrap());
        let operation =
            EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        let mut current = return_state("returnUsdc");
        current.owner = selected.clone();
        let mut q = return_proof(&p);
        q.refund_owner = selected.clone();
        q.confidential_account = p["confidentialAccount"].as_str().unwrap().into();
        operation
            .prepare(7, current.clone(), None, Some(q))
            .unwrap();
        operation
            .approve(7, operation.review_hash().unwrap())
            .unwrap();
        let signed = operation.sign(7, current).unwrap();
        assert_eq!(signed.from, selected);
        let raw = bytes(&signed.raw_transaction, 2048).unwrap();
        let tx = alloy_consensus::Signed::<TxEip1559>::eip2718_decode(&mut raw.as_slice()).unwrap();
        assert_eq!(
            recover(
                &alloy_primitives::hex::encode_prefixed(tx.signature().as_bytes()),
                tx.tx().signature_hash()
            ),
            selected
        );
        let mut permit = permit_proposal(&active_order());
        permit["cycleIndex"] = json!(2);
        permit["investmentSlot"] = json!(4);
        permit["expectedFrom"] = p["expectedFrom"].clone();
        permit["confidentialAccount"] = p["confidentialAccount"].clone();
        assert!(EthereumFusionPermitOperation::new(permit.to_string(), vec![0; 32]).is_ok());
        let mut order = active_order();
        order["cycleIndex"] = json!(2);
        order["investmentSlot"] = json!(4);
        order["expectedFrom"] = p["expectedFrom"].clone();
        order["confidentialAccount"] = p["confidentialAccount"].clone();
        assert!(EthereumFusionOrderOperation::new(order.to_string(), vec![0; 32]).is_ok());
    }
    #[test]
    fn distribution_fusion_permit_and_order_recover_selected_wallet() {
        for slot in [0, 4] {
            let selected = crate::distribution_test_address(1, 2, slot);
            let confidential =
                crate::derive_earn_cycle_confidential_address(vec![0; 32], 1, 2).unwrap();
            let mut p = active_order();
            p["cycleIndex"] = json!(2);
            p["investmentSlot"] = json!(slot);
            p["expectedFrom"] = json!(selected);
            p["confidentialAccount"] = json!(confidential);
            p["unsignedOrder"]["maker"] = json!(selected);
            let extension = p["extension"]
                .as_str()
                .unwrap()
                .replace(&OWNER[2..].to_lowercase(), &selected[2..].to_lowercase());
            let mask: U256 = (U256::from(1) << 160usize) - U256::from(1);
            let salt: U256 = (U256::from(1) << 160usize)
                | (U256::from_be_slice(keccak256(bytes(&extension, 4096).unwrap()).as_slice())
                    & mask);
            p["extension"] = json!(extension);
            p["unsignedOrder"]["salt"] = json!(salt.to_string());
            let mut proof = fusion_proof(&p);
            proof.owner = selected.clone();
            proof.confidential_account = confidential.clone();
            let mut permit = permit_proposal(&p);
            permit["cycleIndex"] = json!(2);
            permit["investmentSlot"] = json!(slot);
            permit["expectedFrom"] = json!(selected);
            permit["confidentialAccount"] = json!(confidential);
            let mut current = permit_state();
            current.owner = selected.clone();
            let op = EthereumFusionPermitOperation::new(permit.to_string(), vec![0; 32]).unwrap();
            op.prepare(7, current.clone(), proof.clone()).unwrap();
            assert!(op.sign(7, current.clone()).is_err());
            op.approve(7, op.review_hash().unwrap()).unwrap();
            let signed = op.sign(7, current).unwrap();
            assert_eq!(
                recover(&signed.signature, signed.signature_hash.parse().unwrap()),
                selected
            );
            let mut current = state();
            current.owner = selected.clone();
            let op = EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).unwrap();
            op.prepare(7, current.clone(), proof, None).unwrap();
            assert!(op.sign(7, current.clone()).is_err());
            op.approve(7, op.review_hash().unwrap()).unwrap();
            let signed = op.sign(7, current).unwrap();
            assert_eq!(
                recover(&signed.signature, signed.order_hash.parse().unwrap()),
                selected
            );
            for bad_slot in [(slot + 1) % 5, 5, u32::MAX] {
                p["investmentSlot"] = json!(bad_slot);
                permit["investmentSlot"] = json!(bad_slot);
                assert!(EthereumFusionOrderOperation::new(p.to_string(), vec![0; 32]).is_err());
                assert!(
                    EthereumFusionPermitOperation::new(permit.to_string(), vec![0; 32]).is_err()
                );
            }
        }
    }
    #[test]
    fn distribution_cancellation_keeps_the_original_slot_authority() {
        let selected = crate::distribution_test_address(1, 2, 3);
        let confidential =
            crate::derive_earn_cycle_confidential_address(vec![0; 32], 1, 2).unwrap();
        let mut p = tx_proposal("returnUsdc");
        p["cycleIndex"] = json!(2);
        p["investmentSlot"] = json!(3);
        p["expectedFrom"] = json!(selected);
        p["refundOwner"] = json!(selected);
        p["confidentialAccount"] = json!(confidential);
        let mut current = state();
        current.owner = selected.clone();
        let mut proof = return_proof(&p);
        proof.refund_owner = selected.clone();
        proof.confidential_account = confidential.clone();
        let op = EthereumLiquidityTransactionOperation::new(p.to_string(), vec![0; 32]).unwrap();
        op.prepare(7, current.clone(), None, Some(proof)).unwrap();
        op.approve(7, op.review_hash().unwrap()).unwrap();
        let signed = op.sign(7, current.clone()).unwrap();
        let mut p = json!({"kind":"cancelPendingLiquidity","operationId":"return1","revision":8,"chainId":1,"cycleIndex":2,"investmentSlot":3,"expectedFrom":selected,"confidentialAccount":confidential,"originalRawTransaction":signed.raw_transaction,"originalTransactionHash":signed.transaction_hash,"nonce":4,"deadline":now()+300,"gasLimit":21000,"maxFeePerGasWei":"11250000000","priorityFeePerGasWei":"1125000000","maximumGasCostWei":"236250000000000"});
        let op = EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32]).unwrap();
        op.prepare(8, current.clone()).unwrap();
        op.approve(8, op.review_hash().unwrap()).unwrap();
        let signed = op.sign(8, current).unwrap();
        let raw = bytes(&signed.raw_transaction, 2048).unwrap();
        let tx = alloy_consensus::Signed::<TxEip1559>::eip2718_decode(&mut raw.as_slice()).unwrap();
        assert_eq!(
            recover(
                &alloy_primitives::hex::encode_prefixed(tx.signature().as_bytes()),
                tx.tx().signature_hash()
            ),
            selected
        );
        assert_eq!(tx.tx().to, TxKind::Call(addr(&selected).unwrap()));
        p["investmentSlot"] = json!(2);
        assert!(EthereumLiquidityCancellationOperation::new(p.to_string(), vec![0; 32]).is_err());
    }
}
