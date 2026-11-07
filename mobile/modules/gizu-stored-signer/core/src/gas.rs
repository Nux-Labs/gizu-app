//! Exact public gas arithmetic and native-only canonical reference observations.
use crate::SignerError;
use alloy_primitives::{Address, U256};

pub(crate) struct DirectTokenPaymasterTerms {
    pub mode: u8,
    pub flags: u8,
    pub valid_until: u64,
    pub valid_after: u64,
    pub post_op_gas: U256,
    pub exchange_rate: U256,
}

/// Decode the shared direct-token wire layout once. Acceptance of signature
/// lengths, flags, validity windows and policy ceilings stays explicit at each
/// consumer so persisted legacy signatures retain their original interpretation.
pub(crate) fn decode_erc20_paymaster_terms(
    data: &[u8],
    expected_token: Address,
) -> Result<DirectTokenPaymasterTerms, SignerError> {
    if data.len() < 182 || data[0] >> 1 != 1 || Address::from_slice(&data[14..34]) != expected_token
    {
        return Err(SignerError::InvalidInput);
    }
    let six_byte_uint = |bytes: &[u8]| {
        let mut word = [0u8; 8];
        word[2..].copy_from_slice(bytes);
        u64::from_be_bytes(word)
    };
    Ok(DirectTokenPaymasterTerms {
        mode: data[0],
        flags: data[1],
        valid_until: six_byte_uint(&data[2..8]),
        valid_after: six_byte_uint(&data[8..14]),
        post_op_gas: U256::from_be_slice(&data[34..50]),
        exchange_rate: U256::from_be_slice(&data[50..82]),
    })
}

#[derive(Clone, uniffi::Record)]
pub struct NativeGasReference {
    pub chain_id: u64,
    pub reviewed_block_number: u64,
    pub canonical_reviewed_block_hash: String,
    pub current_block_number: u64,
    pub current_block_hash: String,
    pub observed_at_ms: u64,
}

/// Both hashes are observed at their exact heights by native RPC. This record is
/// transport evidence, not a provider/JavaScript assertion or permission to edit a reviewed transaction.
pub(crate) fn validate_canonical_reference(
    reference: &NativeGasReference,
    chain_id: u64,
    reviewed_number: u64,
    reviewed_hash: &str,
    current_number: u64,
    current_hash: &str,
    now_ms: u64,
) -> Result<(), SignerError> {
    if reference.chain_id != chain_id
        || reference.reviewed_block_number != reviewed_number
        || !reference
            .canonical_reviewed_block_hash
            .eq_ignore_ascii_case(reviewed_hash)
        || reference.current_block_number != current_number
        || !reference
            .current_block_hash
            .eq_ignore_ascii_case(current_hash)
        || current_number < reviewed_number
        || current_number == reviewed_number && !current_hash.eq_ignore_ascii_case(reviewed_hash)
        || reference.observed_at_ms > now_ms
        || now_ms - reference.observed_at_ms > 15000
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum FeeRounding {
    ProtocolFloor,
    ConservativeCeil,
}

pub(crate) fn native_fee_cap(gas_limit: U256, max_fee_per_gas: U256) -> Result<U256, SignerError> {
    gas_limit
        .checked_mul(max_fee_per_gas)
        .ok_or(SignerError::InvalidInput)
}

pub(crate) fn ceil_div(n: U256, d: U256) -> Result<U256, SignerError> {
    if d == U256::ZERO {
        return Err(SignerError::InvalidInput);
    }
    let (q, r) = n.div_rem(d);
    q.checked_add(U256::from(u8::from(r != U256::ZERO)))
        .ok_or(SignerError::InvalidInput)
}

pub(crate) fn mul_div(
    n: U256,
    m: U256,
    d: U256,
    rounding: FeeRounding,
) -> Result<U256, SignerError> {
    let product = n.checked_mul(m).ok_or(SignerError::InvalidInput)?;
    if d == U256::ZERO {
        return Err(SignerError::InvalidInput);
    }
    match rounding {
        FeeRounding::ProtocolFloor => Ok(product / d),
        FeeRounding::ConservativeCeil => ceil_div(product, d),
    }
}

pub(crate) fn erc20_fee_cap(
    gas_fields: &[U256],
    post_op_gas: U256,
    max_fee_per_gas: U256,
    exchange_rate: U256,
    rounding: FeeRounding,
) -> Result<U256, SignerError> {
    let gas = gas_fields.iter().try_fold(post_op_gas, |sum, value| {
        sum.checked_add(*value).ok_or(SignerError::InvalidInput)
    })?;
    let native_cost = native_fee_cap(gas, max_fee_per_gas)?;
    mul_div(
        native_cost,
        exchange_rate,
        U256::from(10u128.pow(18)),
        rounding,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_paymaster_decoder_binds_token_and_preserves_explicit_legacy_policy() {
        let token = Address::repeat_byte(0x11);
        let mut data = vec![0u8; 183];
        data[0] = 3;
        data[1] = 7;
        data[2..8].copy_from_slice(&123456u64.to_be_bytes()[2..]);
        data[8..14].copy_from_slice(&123400u64.to_be_bytes()[2..]);
        data[14..34].copy_from_slice(token.as_slice());
        data[49] = 9;
        data[81] = 13;
        let terms = decode_erc20_paymaster_terms(&data, token).unwrap();
        assert_eq!((terms.mode, terms.flags), (3, 7));
        assert_eq!((terms.valid_after, terms.valid_until), (123400, 123456));
        assert_eq!(terms.post_op_gas, U256::from(9));
        assert_eq!(terms.exchange_rate, U256::from(13));
        assert!(decode_erc20_paymaster_terms(&data, Address::ZERO).is_err());
        assert!(decode_erc20_paymaster_terms(&data[..181], token).is_err());
        data[0] = 4;
        assert!(decode_erc20_paymaster_terms(&data, token).is_err());
    }
    #[test]
    fn explicit_rounding_and_checked_limits_are_stable() {
        let scale = U256::from(10u128.pow(18));
        assert_eq!(
            mul_div(
                U256::from(1),
                U256::from(1),
                scale,
                FeeRounding::ProtocolFloor
            )
            .unwrap(),
            U256::ZERO
        );
        assert_eq!(
            mul_div(
                U256::from(1),
                U256::from(1),
                scale,
                FeeRounding::ConservativeCeil
            )
            .unwrap(),
            U256::from(1)
        );
        assert_eq!(
            ceil_div(U256::MAX, scale).unwrap(),
            U256::MAX / scale + U256::from(1)
        );
        assert!(
            mul_div(
                U256::MAX,
                U256::from(2),
                scale,
                FeeRounding::ConservativeCeil
            )
            .is_err()
        );
        assert!(
            erc20_fee_cap(
                &[U256::MAX],
                U256::from(1),
                U256::from(1),
                U256::from(1),
                FeeRounding::ConservativeCeil
            )
            .is_err()
        );
        assert!(ceil_div(U256::from(1), U256::ZERO).is_err());
    }
    #[test]
    fn gas_policy_conformance_shared_vectors() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../shared/gas-policy-v1.json"
        )))
        .unwrap();
        assert_eq!(fixture["version"], "gizu-gas-v1");
        let number =
            |value: &serde_json::Value| U256::from_str_radix(value.as_str().unwrap(), 10).unwrap();
        for vector in fixture["paymasterVectors"].as_array().unwrap() {
            let gas: Vec<U256> = [
                "preVerificationGas",
                "callGasLimit",
                "verificationGasLimit",
                "paymasterPostOpGasLimit",
                "paymasterVerificationGasLimit",
            ]
            .iter()
            .map(|field| number(&vector["gas"][field]))
            .collect();
            for (rounding, expected) in [
                (FeeRounding::ProtocolFloor, "floorAtoms"),
                (FeeRounding::ConservativeCeil, "ceilingAtoms"),
            ] {
                assert_eq!(
                    erc20_fee_cap(
                        &gas,
                        number(&vector["postOpGas"]),
                        number(&vector["maxFeePerGas"]),
                        number(&vector["exchangeRate"]),
                        rounding
                    )
                    .unwrap(),
                    number(&vector[expected]),
                    "{}",
                    vector["name"]
                );
            }
        }
        for vector in fixture["arithmeticVectors"].as_array().unwrap() {
            for (rounding, expected) in [
                (FeeRounding::ProtocolFloor, "floor"),
                (FeeRounding::ConservativeCeil, "ceiling"),
            ] {
                assert_eq!(
                    mul_div(
                        number(&vector["a"]),
                        number(&vector["b"]),
                        number(&vector["denominator"]),
                        rounding
                    )
                    .unwrap(),
                    number(&vector[expected]),
                    "{}",
                    vector["name"]
                );
            }
        }
    }
}
