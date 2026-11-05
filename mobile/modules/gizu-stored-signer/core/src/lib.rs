//! Native-private entropy derivation and transaction policy. Never export secrets to JS.
mod confidential_withdrawal;
pub use confidential_withdrawal::*;
mod earn_distribution;
mod earn_fees;
pub use earn_distribution::{derive_earn_distribution_addresses, earn_distribution_allocations};
mod earn_values;
pub use earn_values::*;
mod portfolio;
mod swap_holdings;
pub use swap_holdings::*;
mod source_planner;
mod wallet_discovery;
use alloy_primitives::{Address, keccak256};
use bip32::{DerivationPath, XPrv};
use bip39::{Language, Mnemonic};
use k256::ecdsa::VerifyingKey;
pub use portfolio::*;
pub use source_planner::*;
pub use wallet_discovery::wallet_discovery_candidates;
use zeroize::Zeroizing;
uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SignerError {
    #[error("Invalid native input")]
    InvalidInput,
    #[error("Native cryptographic check failed")]
    CryptoFailed,
    #[error("Native operation expired")]
    Expired,
}
fn address(key: &VerifyingKey) -> String {
    let point = key.to_sec1_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..]).to_checksum(None)
}
#[uniffi::export]
pub fn derive_wallet_address(entropy: Vec<u8>) -> Result<String, SignerError> {
    derive_account_addresses(entropy).map(|mut accounts| accounts.remove(0))
}
/// Consumes native-owned random entropy, not passkey PRF. Returns public data only.
#[uniffi::export]
pub fn derive_account_addresses(entropy: Vec<u8>) -> Result<Vec<String>, SignerError> {
    let entropy = Zeroizing::new(entropy);
    if entropy.len() != 32 {
        return Err(SignerError::InvalidInput);
    }
    let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
        .map_err(|_| SignerError::CryptoFailed)?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    drop(mnemonic);
    drop(entropy);
    (0..16)
        .map(|i| {
            let path: DerivationPath = format!("m/44'/60'/0'/0/{i}")
                .parse()
                .map_err(|_| SignerError::InvalidInput)?;
            let child = XPrv::derive_from_path(seed.as_ref(), &path)
                .map_err(|_| SignerError::CryptoFailed)?;
            Ok(address(child.private_key().verifying_key()))
        })
        .collect()
}
mod earn_auth;
mod roles;
mod swap;
pub use earn_auth::*;
mod earn_payout;
pub use earn_payout::*;
mod earn_ethereum_liquidity;
pub use earn_ethereum_liquidity::*;
mod earn_sponsored;
pub use earn_sponsored::*;
mod earn_execution;
pub use earn_execution::*;
mod transfers;
pub use roles::*;
pub use swap::*;
pub use transfers::*;

/// Earn v1 has one immutable pair per source wallet and selected profile.
/// A separate derivation namespace keeps legacy accounts and destination chains apart.
/// The original verified entropy backup recovers both supported profile candidates.
#[uniffi::export]
pub fn derive_earn_addresses(entropy: Vec<u8>, chain_id: u64) -> Result<Vec<String>, SignerError> {
    let entropy = Zeroizing::new(entropy);
    if entropy.len() != 32 || ![1, 4663].contains(&chain_id) {
        return Err(SignerError::InvalidInput);
    }
    let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
        .map_err(|_| SignerError::CryptoFailed)?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    drop(mnemonic);
    drop(entropy);
    (0..2)
        .map(|role| {
            let path: DerivationPath = format!("m/44'/60'/143'/{chain_id}'/{role}")
                .parse()
                .map_err(|_| SignerError::InvalidInput)?;
            let child = XPrv::derive_from_path(seed.as_ref(), &path)
                .map_err(|_| SignerError::CryptoFailed)?;
            Ok(address(child.private_key().verifying_key()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entropy_is_deterministic_and_accounts_are_distinct() {
        let a = derive_account_addresses(vec![0; 32]).unwrap();
        assert_eq!(a.len(), 16);
        assert_eq!(a[0], "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb");
        assert_eq!(a, derive_account_addresses(vec![0; 32]).unwrap());
        assert_ne!(a, derive_account_addresses(vec![1; 32]).unwrap());
        assert_eq!(a.iter().collect::<std::collections::HashSet<_>>().len(), 16);
    }
    #[test]
    fn rejects_wrong_entropy_lengths() {
        for n in [0, 16, 31, 33, 64] {
            assert!(derive_account_addresses(vec![0; n]).is_err());
        }
    }
    #[test]
    fn earn_pair_is_recoverable_distinct_and_profile_bound() {
        let ethereum = derive_earn_addresses(vec![0; 32], 1).unwrap();
        assert_eq!(
            ethereum,
            vec![
                "0x115Fd06B8190FDb68C1A840468661Ada279D1d72",
                "0xB5927c0bbE474886EA8A87a2E9a761386Dec63bc"
            ]
        );
        assert_eq!(ethereum.len(), 2);
        assert_eq!(ethereum, derive_earn_addresses(vec![0; 32], 1).unwrap());
        let robinhood = derive_earn_addresses(vec![0; 32], 4663).unwrap();
        assert_eq!(
            robinhood,
            vec![
                "0xbA8794cf84F56Aa255d51E7260F16f3a15e5128b",
                "0x378740d42cdfa6Cf83D531359299E79e03f869A9"
            ]
        );
        let source = derive_account_addresses(vec![0; 32]).unwrap();
        let all: Vec<_> = ethereum.iter().chain(robinhood.iter()).collect();
        assert_eq!(
            all.iter().collect::<std::collections::HashSet<_>>().len(),
            4
        );
        assert!(all.iter().all(|a| !source.contains(a)));
        assert_ne!(ethereum, derive_earn_addresses(vec![1; 32], 1).unwrap());
    }
    #[test]
    fn earn_rejects_other_profiles_and_invalid_entropy() {
        for chain in [0, 143, 10143, u64::MAX] {
            assert!(derive_earn_addresses(vec![0; 32], chain).is_err());
        }
        for n in [0, 16, 31, 33, 64] {
            assert!(derive_earn_addresses(vec![0; n], 1).is_err());
        }
    }
}

#[uniffi::export]
pub fn derive_earn_cycle_addresses(
    entropy: Vec<u8>,
    chain_id: u64,
    cycle_index: u32,
) -> Result<Vec<String>, SignerError> {
    let seed = roles::seed_from_entropy(entropy)?;
    (0..2)
        .map(|role| {
            earn_cycle_key(&seed, chain_id, cycle_index, role)
                .map(|key| address(key.private_key().verifying_key()))
        })
        .collect()
}
#[uniffi::export]
pub fn derive_earn_cycle_confidential_address(
    entropy: Vec<u8>,
    chain_id: u64,
    cycle_index: u32,
) -> Result<String, SignerError> {
    let seed = roles::seed_from_entropy(entropy)?;
    let key = earn_cycle_key(&seed, chain_id, cycle_index, 2)?;
    Ok(address(key.private_key().verifying_key()))
}
#[cfg(test)]
mod cycle_tests {
    use super::*;
    #[test]
    fn fresh_cycles_are_distinct_recoverable_and_preserve_v1() {
        for chain in [1, 4663] {
            assert_eq!(
                derive_earn_cycle_addresses(vec![0; 32], chain, 0).unwrap(),
                derive_earn_addresses(vec![0; 32], chain).unwrap()
            );
            assert_eq!(
                derive_earn_cycle_confidential_address(vec![0; 32], chain, 0).unwrap(),
                derive_earn_confidential_address(vec![0; 32], chain).unwrap()
            );
            let all: Vec<_> = (0..4)
                .flat_map(|cycle| {
                    let mut addresses =
                        derive_earn_cycle_addresses(vec![0; 32], chain, cycle).unwrap();
                    addresses.push(
                        derive_earn_cycle_confidential_address(vec![0; 32], chain, cycle).unwrap(),
                    );
                    addresses
                })
                .collect();
            assert_eq!(
                all.iter().collect::<std::collections::HashSet<_>>().len(),
                12
            );
            assert_eq!(
                derive_earn_cycle_addresses(vec![0; 32], chain, 1).unwrap(),
                derive_earn_cycle_addresses(vec![0; 32], chain, 1).unwrap()
            );
        }
    }
    #[test]
    fn cycles_reject_overflow_and_other_profiles() {
        assert!(derive_earn_cycle_addresses(vec![0; 32], 1, u32::MAX).is_err());
        assert!(derive_earn_cycle_addresses(vec![0; 32], 1, (0x7fff_ffff - 2) / 3 + 1).is_err());
        assert!(derive_earn_cycle_confidential_address(vec![0; 32], 143, 1).is_err());
    }
}

/// Fixed, validated role paths only. Cycle zero preserves every v1 address.
pub(crate) fn earn_cycle_key(
    seed: &[u8; 64],
    chain_id: u64,
    cycle_index: u32,
    role: u8,
) -> Result<XPrv, SignerError> {
    if ![1, 4663].contains(&chain_id) || role > 2 || cycle_index > (0x7fff_ffff - 2) / 3 {
        return Err(SignerError::InvalidInput);
    }
    let path = if cycle_index == 0 {
        format!("m/44'/60'/143'/{chain_id}'/{role}")
    } else {
        let child = cycle_index
            .checked_mul(3)
            .and_then(|n| n.checked_add(u32::from(role)))
            .filter(|n| *n <= 0x7fff_ffff)
            .ok_or(SignerError::InvalidInput)?;
        format!("m/44'/60'/144'/{chain_id}'/{child}")
    };
    XPrv::derive_from_path(
        seed,
        &path
            .parse::<DerivationPath>()
            .map_err(|_| SignerError::InvalidInput)?,
    )
    .map_err(|_| SignerError::CryptoFailed)
}

#[cfg(test)]
pub(crate) fn distribution_test_address(chain: u64, cycle: u32, slot: u32) -> String {
    let seed = roles::seed_from_entropy(vec![0; 32]).unwrap();
    let path: DerivationPath = format!("m/44'/60'/145'/{chain}'/{}", cycle * 8 + slot)
        .parse()
        .unwrap();
    address(
        XPrv::derive_from_path(&seed, &path)
            .unwrap()
            .private_key()
            .verifying_key(),
    )
}

#[cfg(test)]
mod distribution_tests {
    use super::*;
    #[test]
    fn distribution_domain_is_stable_distinct_and_bounded() {
        let mut all = std::collections::HashSet::new();
        for chain in [1, 4663] {
            for cycle in [0, 1, 2, 268435455] {
                let legacy = derive_earn_cycle_addresses(vec![0; 32], chain, cycle).unwrap();
                let confidential =
                    derive_earn_cycle_confidential_address(vec![0; 32], chain, cycle).unwrap();
                let five =
                    derive_earn_distribution_addresses(vec![0; 32], chain, cycle, 5).unwrap();
                for count in [1, 2, 5] {
                    assert_eq!(
                        derive_earn_distribution_addresses(vec![0; 32], chain, cycle, count)
                            .unwrap(),
                        five[..count as usize]
                    );
                }
                for (slot, addr) in five.iter().enumerate() {
                    assert_eq!(*addr, distribution_test_address(chain, cycle, slot as u32));
                    assert!(!legacy.contains(addr));
                    assert_ne!(addr, &confidential);
                    assert!(all.insert(addr.clone()));
                }
            }
        }
        for (chain, cycle, count) in [
            (143, 0, 1),
            (1, 0, 0),
            (1, 0, 6),
            (1, 268435456, 1),
            (1, u32::MAX, 5),
        ] {
            assert!(derive_earn_distribution_addresses(vec![0; 32], chain, cycle, count).is_err());
        }
        assert!(derive_earn_distribution_addresses(vec![0; 31], 1, 0, 1).is_err());
    }
    #[test]
    fn distribution_cumulative_allocations_conserve_and_ignore_fragmentation() {
        for weights in [
            vec![10000u32],
            vec![3333, 6667],
            vec![1000, 2000, 3000, 1500, 2500],
        ] {
            let plan = serde_json::json!({"version":1,"weightsBps":weights}).to_string();
            let mut offset = 0u128;
            let mut totals = vec![0u128; weights.len()];
            for credit in [100003u128, 123457, 200001] {
                let amounts = earn_distribution_allocations(
                    plan.clone(),
                    credit.to_string(),
                    offset.to_string(),
                )
                .unwrap();
                assert_eq!(
                    amounts
                        .iter()
                        .map(|n| n.parse::<u128>().unwrap())
                        .sum::<u128>(),
                    credit
                );
                for (total, amount) in totals.iter_mut().zip(amounts) {
                    *total += amount.parse::<u128>().unwrap();
                }
                offset += credit;
            }
            assert_eq!(
                totals,
                earn_distribution_allocations(plan, offset.to_string(), "0".into())
                    .unwrap()
                    .iter()
                    .map(|n| n.parse::<u128>().unwrap())
                    .collect::<Vec<_>>()
            );
        }
        let maximum = alloy_primitives::U256::MAX.to_string();
        assert_eq!(
            earn_distribution_allocations(
                r#"{"version":1,"weightsBps":[10000]}"#.into(),
                maximum.clone(),
                "0".into()
            )
            .unwrap(),
            vec![maximum]
        );
    }
    #[test]
    fn distribution_rejects_malformed_uneconomic_or_overflowing_allocations() {
        for plan in [
            r#"{"version":2,"weightsBps":[10000]}"#,
            r#"{"version":1,"weightsBps":[]}"#,
            r#"{"version":1,"weightsBps":[0,10000]}"#,
            r#"{"version":1,"weightsBps":[9999]}"#,
            r#"{"version":1,"weightsBps":[1,1,1,1,1,9995]}"#,
            r#"{"version":1,"weightsBps":[10000],"extra":1}"#,
        ] {
            assert!(
                earn_distribution_allocations(plan.into(), "10000".into(), "0".into()).is_err()
            );
        }
        for (credit, offset) in [("0", "0"), ("1", "0"), ("1", "3"), ("01", "0"), ("1", "-1")] {
            assert!(
                earn_distribution_allocations(
                    r#"{"version":1,"weightsBps":[3333,3333,3334]}"#.into(),
                    credit.into(),
                    offset.into()
                )
                .is_err()
            );
        }
        assert!(
            earn_distribution_allocations(
                r#"{"version":1,"weightsBps":[10000]}"#.into(),
                "1".into(),
                alloy_primitives::U256::MAX.to_string()
            )
            .is_err()
        );
    }
}
