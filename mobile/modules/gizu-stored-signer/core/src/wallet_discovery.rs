//! Read-only native discovery. Candidate batches must never cross the JavaScript bridge.
use crate::{SignerError, address, earn_cycle_key, roles};
use bip32::{DerivationPath, XPrv};
use serde::Serialize;

const MAX_DISCOVERY_CYCLE: u32 = 1_000_000;

#[derive(Serialize)]
struct DiscoveryCandidate {
    derivation: &'static str,
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot: Option<u32>,
    address: String,
}

/// Native-only candidate metadata and public addresses, with no signing authority.
/// This does not allocate a cycle or reconstruct its historical distribution weights.
#[uniffi::export]
pub fn wallet_discovery_candidates(
    entropy: Vec<u8>,
    chain_id: u64,
    cycle_index: u32,
) -> Result<String, SignerError> {
    // Consume through the existing zeroizing entropy/seed boundary even for invalid bounds.
    let seed = roles::seed_from_entropy(entropy)?;
    if ![1, 4663].contains(&chain_id) || cycle_index > MAX_DISCOVERY_CYCLE {
        return Err(SignerError::InvalidInput);
    }
    let mut candidates = Vec::with_capacity(8);
    for (role_index, role) in ["hold", "invest", "confidential"].into_iter().enumerate() {
        let key = earn_cycle_key(&seed, chain_id, cycle_index, role_index as u8)?;
        candidates.push(DiscoveryCandidate {
            derivation: "legacy",
            role,
            slot: None,
            address: address(key.private_key().verifying_key()),
        });
    }
    for slot in 0..5 {
        let index = cycle_index
            .checked_mul(8)
            .and_then(|index| index.checked_add(slot))
            .filter(|index| *index <= 0x7fff_ffff)
            .ok_or(SignerError::InvalidInput)?;
        let path: DerivationPath = format!("m/44'/60'/145'/{chain_id}'/{index}")
            .parse()
            .map_err(|_| SignerError::InvalidInput)?;
        let key =
            XPrv::derive_from_path(seed.as_ref(), &path).map_err(|_| SignerError::CryptoFailed)?;
        candidates.push(DiscoveryCandidate {
            derivation: "distribution-v1",
            role: "invest",
            slot: Some(slot),
            address: address(key.private_key().verifying_key()),
        });
    }
    serde_json::to_string(&candidates).map_err(|_| SignerError::CryptoFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SignerError;
    use serde_json::{Value, json};
    use std::collections::HashSet;

    fn candidates(chain: u64, cycle: u32) -> Vec<Value> {
        serde_json::from_str(&wallet_discovery_candidates(vec![0; 32], chain, cycle).unwrap())
            .unwrap()
    }

    #[test]
    fn discovery_preserves_legacy_roles_and_recognizes_each_distribution_slot() {
        // Independent BIP32 fixtures from the documented paths and zero test entropy.
        for (chain, cycle, legacy, distribution) in [
            (
                1,
                0,
                [
                    "0x115Fd06B8190FDb68C1A840468661Ada279D1d72",
                    "0xB5927c0bbE474886EA8A87a2E9a761386Dec63bc",
                    "0x39b29D0d9cDE660fC7faE8fF188a052B806667CD",
                ],
                [
                    "0xa4455Fee428D1Bf5Bf0d5B79416a9B6de684D6b3",
                    "0xe869383c84BF853C1a230D0C0dB626550958EAd6",
                    "0x13eD77e880de913d00Cf361eDd7300ac56E97644",
                    "0x35699a2d710567F83C6b5a598C7CCBC5a70d4D1E",
                    "0x09ADF25F85802f9a7d9607cA4F56E0766C591b33",
                ],
            ),
            (
                4663,
                1,
                [
                    "0xf78EfD2A5DEDbFc884F45421d2740f8455a5a841",
                    "0x05c0362abC0bE301f6f9b74207D2B4E57c4b7608",
                    "0x1e12Fa6b231672e74661D908501742a8fE72b5d1",
                ],
                [
                    "0x6AbF2124c2e6F1ae278FeB0Fd6B893E483905449",
                    "0xF05b3539939066A083E4d5eb9D29aF0979e3D549",
                    "0xa09d934F8B5093BEd153E52e4275816470cb6c5c",
                    "0x3c6649262A601d2D0d1Cb2b4F1b67C5C325FB6Df",
                    "0x003BCba7Fc0698CAC4Db8FF48313A88958E293F6",
                ],
            ),
        ] {
            let actual = candidates(chain, cycle);
            assert_eq!(actual.len(), 8);
            for (index, role) in ["hold", "invest", "confidential"].iter().enumerate() {
                assert_eq!(
                    actual[index],
                    json!({"derivation":"legacy", "role":role, "address":legacy[index]})
                );
            }
            for (slot, address) in distribution.iter().enumerate() {
                assert_eq!(
                    actual[slot + 3],
                    json!({"derivation":"distribution-v1", "role":"invest", "slot":slot, "address":address})
                );
            }
        }
    }

    #[test]
    fn discovery_never_aliases_chains_cycles_namespaces_or_source_accounts() {
        let mut seen = HashSet::new();
        let source = crate::derive_account_addresses(vec![0; 32]).unwrap();
        for chain in [1, 4663] {
            for cycle in [0, 1, 2, 1_000_000] {
                let actual = candidates(chain, cycle);
                assert_eq!(actual, candidates(chain, cycle));
                let pair = crate::derive_earn_cycle_addresses(vec![0; 32], chain, cycle).unwrap();
                assert_eq!(actual[0]["address"], pair[0]);
                assert_eq!(actual[1]["address"], pair[1]);
                assert_eq!(
                    actual[2]["address"],
                    crate::derive_earn_cycle_confidential_address(vec![0; 32], chain, cycle)
                        .unwrap()
                );
                for candidate in actual {
                    let address = candidate["address"].as_str().unwrap().to_owned();
                    assert!(!source.contains(&address));
                    assert!(seen.insert(address));
                }
            }
        }
        assert_eq!(seen.len(), 64);
        assert_eq!(
            candidates(1, 1_000_000)[7]["address"],
            "0xD0331Ff7253A2765340ac94d8B30F56908DD508B"
        );
        assert_ne!(
            wallet_discovery_candidates(vec![0; 32], 1, 0).unwrap(),
            wallet_discovery_candidates(vec![1; 32], 1, 0).unwrap()
        );
    }

    #[test]
    fn discovery_rejects_invalid_entropy_profiles_and_out_of_budget_cycles() {
        for size in [0, 16, 31, 33, 64] {
            assert!(matches!(
                wallet_discovery_candidates(vec![0; size], 1, 0),
                Err(SignerError::InvalidInput)
            ));
        }
        for chain in [0, 143, 10143, u64::MAX] {
            assert!(matches!(
                wallet_discovery_candidates(vec![0; 32], chain, 0),
                Err(SignerError::InvalidInput)
            ));
        }
        for cycle in [1_000_001, 268_435_455, 268_435_456, u32::MAX] {
            assert!(matches!(
                wallet_discovery_candidates(vec![0; 32], 1, cycle),
                Err(SignerError::InvalidInput)
            ));
        }
    }

    #[test]
    fn discovery_returns_only_native_address_candidates_without_signing_material() {
        for candidate in candidates(1, 0) {
            let object = candidate.as_object().unwrap();
            assert!(
                object
                    .keys()
                    .all(|key| ["derivation", "role", "slot", "address"].contains(&key.as_str()))
            );
            let address = object["address"].as_str().unwrap();
            assert_eq!(address.len(), 42);
            assert!(address.starts_with("0x"));
            assert!(address[2..].bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }
}
