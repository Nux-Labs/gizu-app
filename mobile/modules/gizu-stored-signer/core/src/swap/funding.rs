//! F's Monad UserOperation: one USDC transfer to the quoted deposit, paid in USDC through the pinned paymaster.
use super::evm::{self, AbiReader, RawSignature};
use super::pins::*;
use crate::SignerError;
use crate::gas::{self, FeeRounding};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserOperation {
    pub sender: String,
    pub nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_data: Option<String>,
    pub call_data: String,
    pub call_gas_limit: String,
    pub verification_gas_limit: String,
    pub pre_verification_gas: String,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
    pub paymaster: String,
    pub paymaster_verification_gas_limit: String,
    pub paymaster_post_op_gas_limit: String,
    pub paymaster_data: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsignedAuthorization {
    pub chain_id: u64,
    pub address: Address,
    pub nonce: u64,
}

/// Chain facts read natively from the pinned Monad RPC, never taken from the gateway.
#[derive(Clone, Debug)]
pub struct FundingChain {
    pub code: Vec<u8>,
    pub transaction_count: u64,
    pub paymaster_allowance: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedFunding {
    pub fee_cap: U256,
    pub hash: B256,
}

fn u128_field(s: &str) -> Result<U256, SignerError> {
    let v = evm::quantity(s)?;
    if v > U256::from(u128::MAX) {
        return Err(SignerError::InvalidInput);
    }
    Ok(v)
}

fn delegation_code() -> Vec<u8> {
    let mut code = vec![0xef, 0x01, 0x00];
    code.extend_from_slice(SIMPLE_7702.as_slice());
    code
}

fn transfer_call(data: &[u8]) -> Result<(Address, U256), SignerError> {
    if data.len() != 68 || data[..4] != evm::selector("transfer(address,uint256)") {
        return Err(SignerError::InvalidInput);
    }
    let r = AbiReader::new(&data[4..]);
    Ok((r.address(0)?, r.uint(32)?))
}

fn approve_call(data: &[u8]) -> Result<(Address, U256), SignerError> {
    if data.len() != 68 || data[..4] != evm::selector("approve(address,uint256)") {
        return Err(SignerError::InvalidInput);
    }
    let r = AbiReader::new(&data[4..]);
    Ok((r.address(0)?, r.uint(32)?))
}

/// Decodes Simple7702 `execute` / `executeBatch` into (to, value, data) calls.
pub fn decode_calls(call_data: &[u8]) -> Result<Vec<(Address, U256, Vec<u8>)>, SignerError> {
    if call_data.len() < 4 {
        return Err(SignerError::InvalidInput);
    }
    let body = AbiReader::new(&call_data[4..]);
    if call_data[..4] == evm::selector("execute(address,uint256,bytes)") {
        let data_offset = body.usize(64)?;
        return Ok(vec![(
            body.address(0)?,
            body.uint(32)?,
            body.bytes(data_offset)?.to_vec(),
        )]);
    }
    if call_data[..4] != evm::selector("executeBatch((address,uint256,bytes)[])") {
        return Err(SignerError::InvalidInput);
    }
    let array = body.usize(0)?;
    let count = body.usize(array)?;
    if count == 0 || count > 2 {
        return Err(SignerError::InvalidInput);
    }
    let items = AbiReader::new(
        call_data
            .get(4 + array + 32..)
            .ok_or(SignerError::InvalidInput)?,
    );
    (0..count)
        .map(|i| {
            let tuple_offset = items.usize(i * 32)?;
            let tuple = AbiReader::new(
                call_data
                    .get(4 + array + 32 + tuple_offset..)
                    .ok_or(SignerError::InvalidInput)?,
            );
            let data_offset = tuple.usize(64)?;
            Ok((
                tuple.address(0)?,
                tuple.uint(32)?,
                tuple.bytes(data_offset)?.to_vec(),
            ))
        })
        .collect()
}

fn paymaster_terms(op: &UserOperation) -> Result<gas::DirectTokenPaymasterTerms, SignerError> {
    // The shared decoder preserves the historical accepted layout for fee/hash compatibility.
    gas::decode_erc20_paymaster_terms(&evm::hex_bytes(&op.paymaster_data)?, MONAD_USDC)
}

/// Protocol integer charge cap, preserved for historical signed-operation compatibility.
pub fn fee_cap(op: &UserOperation, now_secs: u64) -> Result<U256, SignerError> {
    let terms = paymaster_terms(op)?;
    if terms.valid_until != 0 && terms.valid_until <= now_secs {
        return Err(SignerError::Expired);
    }
    let fields = [
        u128_field(&op.pre_verification_gas)?,
        u128_field(&op.call_gas_limit)?,
        u128_field(&op.verification_gas_limit)?,
        u128_field(&op.paymaster_post_op_gas_limit)?,
        u128_field(&op.paymaster_verification_gas_limit)?,
    ];
    let cost = gas::erc20_fee_cap(
        &fields,
        terms.post_op_gas,
        u128_field(&op.max_fee_per_gas)?,
        terms.exchange_rate,
        FeeRounding::ProtocolFloor,
    )?;
    if cost.is_zero() {
        return Err(SignerError::InvalidInput);
    }
    Ok(cost)
}

/// Newly prepared operations need time for signing and the submission round trip. Historical
/// signed journals are reconciled directly and never need another readiness check or signature.
pub fn readiness_code(
    op: &UserOperation,
    now_secs: u64,
) -> Result<Option<&'static str>, SignerError> {
    let terms = paymaster_terms(op)?;
    if terms.valid_after > now_secs {
        return Ok(Some("PAYMASTER_NOT_YET_VALID"));
    }
    if terms.valid_until != 0 && terms.valid_until <= now_secs {
        return Ok(Some("PAYMASTER_QUOTE_EXPIRED"));
    }
    if terms.valid_until != 0 && terms.valid_until.saturating_sub(now_secs) < 30 {
        return Ok(Some("PAYMASTER_VALIDITY_TOO_SHORT"));
    }
    Ok(None)
}

pub fn approval_code(
    op: &UserOperation,
    fee: U256,
    chain: &FundingChain,
) -> Result<Option<&'static str>, SignerError> {
    let calls = decode_calls(&evm::hex_bytes(&op.call_data)?)?;
    let (_, rest) = calls.split_last().ok_or(SignerError::InvalidInput)?;
    match rest {
        [] => Ok((chain.paymaster_allowance < fee).then_some("TOKEN_PAYMASTER_ALLOWANCE_LOW")),
        [(_, _, data)] => {
            let (spender, approved) = approve_call(data)?;
            if spender != PIMLICO_ERC20_PAYMASTER {
                return Err(SignerError::InvalidInput);
            }
            if approved < fee {
                return Ok(Some("TOKEN_PAYMASTER_ALLOWANCE_LOW"));
            }
            let upper = fee
                .checked_add(fee / U256::from(50))
                .ok_or(SignerError::InvalidInput)?;
            Ok((approved > upper).then_some("GAS_APPROVAL_UNSTABLE"))
        }
        _ => Err(SignerError::InvalidInput),
    }
}

fn pack128(high: U256, low: U256) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[..16].copy_from_slice(&high.to_be_bytes::<32>()[16..]);
    w[16..].copy_from_slice(&low.to_be_bytes::<32>()[16..]);
    w
}

/// ERC-4337 v0.8 userOpHash (EIP-712 over PackedUserOperation, 7702 initCode carries the delegate).
pub fn user_operation_hash(
    op: &UserOperation,
    authorization: Option<&UnsignedAuthorization>,
) -> Result<B256, SignerError> {
    let init_code = match (&op.factory, authorization) {
        (None, _) => vec![],
        (Some(f), Some(a)) if f == "0x7702" => {
            let mut code = a.address.as_slice().to_vec();
            code.extend(evm::hex_bytes(op.factory_data.as_deref().unwrap_or("0x"))?);
            code
        }
        _ => return Err(SignerError::InvalidInput),
    };
    let mut paymaster_and_data = evm::addr(&op.paymaster)?.as_slice().to_vec();
    paymaster_and_data.extend_from_slice(
        &u128_field(&op.paymaster_verification_gas_limit)?.to_be_bytes::<32>()[16..],
    );
    paymaster_and_data
        .extend_from_slice(&u128_field(&op.paymaster_post_op_gas_limit)?.to_be_bytes::<32>()[16..]);
    paymaster_and_data.extend(evm::hex_bytes(&op.paymaster_data)?);
    let domain = evm::domain_separator("ERC4337", "1", MONAD_CHAIN_ID, ENTRY_POINT_V08);
    Ok(evm::typed_hash(
        domain,
        "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)",
        &[
            evm::word_address(evm::addr(&op.sender)?),
            evm::word_u256(evm::quantity(&op.nonce)?),
            keccak256(&init_code).0,
            keccak256(evm::hex_bytes(&op.call_data)?).0,
            pack128(
                u128_field(&op.verification_gas_limit)?,
                u128_field(&op.call_gas_limit)?,
            ),
            evm::word_u256(u128_field(&op.pre_verification_gas)?),
            pack128(
                u128_field(&op.max_priority_fee_per_gas)?,
                u128_field(&op.max_fee_per_gas)?,
            ),
            keccak256(&paymaster_and_data).0,
        ],
    ))
}

/// Accepts only: optional approve(paymaster, feeCap) then transfer(deposit, amount), with amount + fee inside the budget.
#[allow(clippy::too_many_arguments)]
pub fn check_funding(
    op: &UserOperation,
    authorization: Option<&UnsignedAuthorization>,
    source: Address,
    deposit: Address,
    amount: U256,
    budget: U256,
    chain: &FundingChain,
    now_secs: u64,
) -> Result<CheckedFunding, SignerError> {
    if evm::addr(&op.sender)? != source || evm::addr(&op.paymaster)? != PIMLICO_ERC20_PAYMASTER {
        return Err(SignerError::InvalidInput);
    }
    if budget > U256::from(MAX_SOURCE_ATOMS) || amount.is_zero() || deposit == source {
        return Err(SignerError::InvalidInput);
    }
    let delegated = chain.code == delegation_code();
    if !chain.code.is_empty() && !delegated {
        return Err(SignerError::InvalidInput);
    }
    let factory_7702 = op.factory.as_deref() == Some("0x7702")
        && op.factory_data.as_deref().is_none_or(|d| d == "0x");
    let auth_7702 = authorization.is_some_and(|a| {
        a.chain_id == MONAD_CHAIN_ID
            && a.address == SIMPLE_7702
            && a.nonce == chain.transaction_count
    });
    match (delegated, factory_7702, auth_7702, authorization.is_some()) {
        (true, false, false, false) => {}
        (_, true, true, true) => {}
        _ => return Err(SignerError::InvalidInput),
    }
    if u128_field(&op.max_priority_fee_per_gas)? > u128_field(&op.max_fee_per_gas)? {
        return Err(SignerError::InvalidInput);
    }
    let fee = fee_cap(op, now_secs)?;
    if amount.checked_add(fee).is_none_or(|total| total > budget) {
        return Err(SignerError::InvalidInput);
    }
    let calls = decode_calls(&evm::hex_bytes(&op.call_data)?)?;
    let (last, _) = calls.split_last().ok_or(SignerError::InvalidInput)?;
    if calls
        .iter()
        .any(|(to, value, _)| *to != MONAD_USDC || !value.is_zero())
    {
        return Err(SignerError::InvalidInput);
    }
    if transfer_call(&last.2)? != (deposit, amount) {
        return Err(SignerError::InvalidInput);
    }
    // A new signature requires allowance covering the final signed cap. Historical signed
    // payloads retain their exact bytes and go through reconciliation instead of this validator.
    if approval_code(op, fee, chain)?.is_some() {
        return Err(SignerError::InvalidInput);
    }
    Ok(CheckedFunding {
        fee_cap: fee,
        hash: user_operation_hash(op, authorization)?,
    })
}

/// JSON-RPC `eth_sendUserOperation` body with the signature and optional EIP-7702 authorization.
pub fn rpc_operation(
    op: &UserOperation,
    signature: &RawSignature,
    authorization: Option<(&UnsignedAuthorization, &RawSignature)>,
) -> serde_json::Value {
    let mut value = serde_json::to_value(op).expect("user operation serializes");
    value["signature"] = serde_json::Value::String(signature.rsv_hex());
    if let Some((a, sig)) = authorization {
        value["eip7702Auth"] = serde_json::json!({
            "address": a.address.to_checksum(None),
            "chainId": evm::quantity_u64(a.chain_id),
            "nonce": evm::quantity_u64(a.nonce),
            "r": alloy_primitives::hex::encode_prefixed(sig.r),
            "s": alloy_primitives::hex::encode_prefixed(sig.s),
            "yParity": format!("0x{:02x}", sig.y_parity),
        });
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/research-mainnet.json")).unwrap()
    }
    fn research_op() -> (UserOperation, UnsignedAuthorization, serde_json::Value) {
        let signed = fixture()["deposit"]["signedUserOperation"].clone();
        let rpc = &signed["rpcOperation"];
        let mut fields = rpc.clone();
        let object = fields.as_object_mut().unwrap();
        object.remove("signature");
        object.remove("eip7702Auth");
        let op: UserOperation = serde_json::from_value(fields).unwrap();
        let auth = UnsignedAuthorization {
            chain_id: 143,
            address: evm::addr(rpc["eip7702Auth"]["address"].as_str().unwrap()).unwrap(),
            nonce: 0,
        };
        (op, auth, signed)
    }
    fn fresh_chain() -> FundingChain {
        FundingChain {
            code: vec![],
            transaction_count: 0,
            paymaster_allowance: U256::ZERO,
        }
    }
    fn deposit() -> Address {
        evm::addr("0xc7e7a6F342D3B4EF26AE17e43A22F77B3dDc610B").unwrap()
    }
    fn source() -> Address {
        evm::addr("0xcd58DBfdDa39dea8cacA8592Eca2b8a637Cf4934").unwrap()
    }
    const SIGNED_AT: u64 = 1_790_300_000;

    #[test]
    fn reproduces_the_research_user_operation_hash_and_signer() {
        let (op, auth, signed) = research_op();
        let hash = user_operation_hash(&op, Some(&auth)).unwrap();
        assert_eq!(
            format!("{hash:#x}"),
            signed["userOperationHash"].as_str().unwrap()
        );
        let sig = evm::hex_bytes(signed["rpcOperation"]["signature"].as_str().unwrap()).unwrap();
        let (mut r, mut s) = ([0u8; 32], [0u8; 32]);
        r.copy_from_slice(&sig[..32]);
        s.copy_from_slice(&sig[32..64]);
        assert_eq!(evm::recover(hash, &r, &s, sig[64] - 27).unwrap(), source());
    }

    #[test]
    fn accepts_the_research_funding_within_its_budget() {
        let (op, auth, _) = research_op();
        let checked = check_funding(
            &op,
            Some(&auth),
            source(),
            deposit(),
            U256::from(1_196_276u64),
            U256::from(1_200_000u64),
            &fresh_chain(),
            SIGNED_AT,
        )
        .unwrap();
        assert_eq!(checked.fee_cap, U256::from(2_925u64));
    }

    #[test]
    fn rejects_a_changed_deposit_amount_budget_or_delegation() {
        let (op, auth, _) = research_op();
        let ok = |deposit_to: Address, amount: u64, budget: u64, chain: &FundingChain| {
            check_funding(
                &op,
                Some(&auth),
                source(),
                deposit_to,
                U256::from(amount),
                U256::from(budget),
                chain,
                SIGNED_AT,
            )
            .is_ok()
        };
        assert!(!ok(source(), 1_196_276, 1_200_000, &fresh_chain()));
        assert!(!ok(deposit(), 1_196_275, 1_200_000, &fresh_chain()));
        assert!(!ok(deposit(), 1_196_276, 1_199_000, &fresh_chain()));
        assert!(ok(deposit(), 1_196_276, 10_000_001, &fresh_chain()));
        let unknown = FundingChain {
            code: vec![0xef, 0x01, 0x00, 1, 2, 3],
            ..fresh_chain()
        };
        assert!(!ok(deposit(), 1_196_276, 1_200_000, &unknown));
        let wrong_nonce = FundingChain {
            transaction_count: 1,
            ..fresh_chain()
        };
        assert!(!ok(deposit(), 1_196_276, 1_200_000, &wrong_nonce));
        assert!(
            check_funding(
                &op,
                Some(&auth),
                source(),
                deposit(),
                U256::from(1_196_276u64),
                U256::from(1_200_000u64),
                &fresh_chain(),
                1_800_000_000
            )
            .is_err()
        );
        let delegated = FundingChain {
            code: delegation_code(),
            ..fresh_chain()
        };
        assert!(
            check_funding(
                &op,
                Some(&auth),
                source(),
                deposit(),
                U256::from(1_196_276u64),
                U256::from(1_200_000u64),
                &delegated,
                SIGNED_AT
            )
            .is_ok()
        );
    }

    #[test]
    fn serializes_the_bundler_request_in_viem_form() {
        let (op, auth, signed) = research_op();
        let rpc = &signed["rpcOperation"];
        let parse = |v: &serde_json::Value| {
            let mut out = [0u8; 32];
            out.copy_from_slice(&evm::hex_bytes(v.as_str().unwrap()).unwrap());
            out
        };
        let raw = evm::hex_bytes(rpc["signature"].as_str().unwrap()).unwrap();
        let sig = RawSignature {
            r: raw[..32].try_into().unwrap(),
            s: raw[32..64].try_into().unwrap(),
            y_parity: raw[64] - 27,
        };
        let auth_sig = RawSignature {
            r: parse(&rpc["eip7702Auth"]["r"]),
            s: parse(&rpc["eip7702Auth"]["s"]),
            y_parity: 1,
        };
        let value = rpc_operation(&op, &sig, Some((&auth, &auth_sig)));
        assert_eq!(value["eip7702Auth"], rpc["eip7702Auth"]);
        assert_eq!(value["callData"], rpc["callData"]);
        assert_eq!(value["signature"], rpc["signature"]);
    }
}
