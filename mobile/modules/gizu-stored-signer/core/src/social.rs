//! Sealed Strategies social sign-in: the two EIP-712 structures the API accepts to open a comment
//! and like session. JS supplies the backend's challenge only (nonce, issue time and, for owners,
//! the strategy id). This module derives every other field itself, so no FFI parameter can make the
//! social key sign anything but a `SignIn` for its own address, or make a strategy key sign
//! anything but an `OwnerLink` that binds that address to a strategy. Formats match
//! `shared/strategy-social-vectors.json`.
//!
//! The social key lives on its own hardened branch, `m/44'/60'/147'/{registryChain}'/0`, separate
//! from strategy keys (146') and every funded wallet. It holds no funds and only identifies a
//! commenter, so likes and comments never reveal a wallet or strategy signer address.
use crate::strategy::{WALLET_STRATEGY_INDEX, pinned_registry, strategy_key};
use crate::swap::evm;
use crate::{SignerError, roles};
use alloy_primitives::{Address, B256, U256, keccak256};
use bip32::{DerivationPath, XPrv};

const DOMAIN_NAME: &str = "GizuSocial";
const DOMAIN_VERSION: &str = "1";
const SIGN_IN_TYPE: &str = "SignIn(address account,bytes32 nonce,uint64 issuedAt)";
const OWNER_LINK_TYPE: &str = "OwnerLink(address account,uint256 strategyId,bytes32 nonce)";
/// The API's challenge is valid for 5 minutes; allow the same again for clock drift.
const ISSUED_AT_WINDOW_MS: u64 = 600_000;

/// A signed sign-in for the API's `POST /v1/social/sessions`.
#[derive(uniffi::Record, Debug, PartialEq, Eq)]
pub struct SocialSignIn {
    pub account: String,
    pub signature: String,
    /// `OwnerLink` signed by strategy key 0, present when an owned strategy id was given.
    pub owner_signature: Option<String>,
}

/// The social key's checksummed address. Public data; no approval needed.
#[uniffi::export]
pub fn social_address(entropy: Vec<u8>, chain_id: u64) -> Result<String, SignerError> {
    let seed = roles::seed_from_entropy(entropy)?;
    Ok(evm::key_address(&social_key(&seed, chain_id)?).to_checksum(None))
}

/// Signs the backend's sign-in challenge with the social key and, when `owner_strategy_id` is
/// given, links the social address to that strategy with strategy key 0. `nonce` is `0x` and 64
/// hex digits; `issued_at` is unix seconds and must be within 10 minutes of `now_ms`.
#[uniffi::export]
pub fn social_sign_in(
    entropy: Vec<u8>,
    chain_id: u64,
    nonce: String,
    issued_at: u64,
    owner_strategy_id: Option<u64>,
    now_ms: u64,
) -> Result<SocialSignIn, SignerError> {
    let nonce = parse_nonce(&nonce)?;
    check_issued_at(issued_at, now_ms)?;
    if owner_strategy_id == Some(0) {
        return Err(SignerError::InvalidInput);
    }
    let seed = roles::seed_from_entropy(entropy)?;
    let social = social_key(&seed, chain_id)?;
    let account = evm::key_address(&social);
    let signature = evm::sign(&social, sign_in_digest(chain_id, account, nonce, issued_at))?;
    let owner_signature = owner_strategy_id
        .map(|strategy_id| {
            let key = strategy_key(&seed, chain_id, WALLET_STRATEGY_INDEX)?;
            let digest = owner_link_digest(chain_id, account, strategy_id, nonce);
            Ok::<_, SignerError>(evm::sign(&key, digest)?.rsv_hex())
        })
        .transpose()?;
    Ok(SocialSignIn {
        account: account.to_checksum(None),
        signature: signature.rsv_hex(),
        owner_signature,
    })
}

/// Social keys exist only on chains with a pinned registry, the chain the API verifies against.
fn social_key(seed: &[u8; 64], chain_id: u64) -> Result<XPrv, SignerError> {
    pinned_registry(chain_id)?;
    let path: DerivationPath = format!("m/44'/60'/147'/{chain_id}'/0")
        .parse()
        .map_err(|_| SignerError::InvalidInput)?;
    XPrv::derive_from_path(seed, &path).map_err(|_| SignerError::CryptoFailed)
}

/// Exactly `0x` and 64 hex digits, as the API issues it.
fn parse_nonce(nonce: &str) -> Result<B256, SignerError> {
    let digits = nonce.strip_prefix("0x").ok_or(SignerError::InvalidInput)?;
    if digits.len() != 64 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SignerError::InvalidInput);
    }
    digits.parse().map_err(|_| SignerError::InvalidInput)
}

fn check_issued_at(issued_at_secs: u64, now_ms: u64) -> Result<(), SignerError> {
    let issued_ms = issued_at_secs
        .checked_mul(1_000)
        .ok_or(SignerError::InvalidInput)?;
    if issued_ms.saturating_add(ISSUED_AT_WINDOW_MS) < now_ms {
        return Err(SignerError::Expired);
    }
    if issued_ms > now_ms.saturating_add(ISSUED_AT_WINDOW_MS) {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}

/// `EIP712Domain(string name,string version,uint256 chainId)`: no verifying contract, no salt.
fn domain(chain_id: u64) -> B256 {
    let mut buf = Vec::with_capacity(128);
    buf.extend_from_slice(
        keccak256("EIP712Domain(string name,string version,uint256 chainId)").as_slice(),
    );
    buf.extend_from_slice(keccak256(DOMAIN_NAME).as_slice());
    buf.extend_from_slice(keccak256(DOMAIN_VERSION).as_slice());
    buf.extend_from_slice(&evm::word_u256(U256::from(chain_id)));
    keccak256(buf)
}

fn sign_in_digest(chain_id: u64, account: Address, nonce: B256, issued_at: u64) -> B256 {
    evm::typed_hash(
        domain(chain_id),
        SIGN_IN_TYPE,
        &[
            evm::word_address(account),
            nonce.0,
            evm::word_u256(U256::from(issued_at)),
        ],
    )
}

fn owner_link_digest(chain_id: u64, account: Address, strategy_id: u64, nonce: B256) -> B256 {
    evm::typed_hash(
        domain(chain_id),
        OWNER_LINK_TYPE,
        &[
            evm::word_address(account),
            evm::word_u256(U256::from(strategy_id)),
            nonce.0,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strategy::{
        STRATEGY_REGISTRY_BASE_SEPOLIA, UPDATE_PRICE_TYPE, price_digest, strategy_price_signature,
    };
    use alloy_primitives::hex;
    use serde_json::Value;

    const SEPOLIA: u64 = 84_532;
    const NOW_MS: u64 = 1_900_000_000_000;
    const NONCE: &str = "0x9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";

    fn vectors() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../shared/strategy-social-vectors.json"
        )))
        .unwrap()
    }
    fn b256(value: &Value) -> B256 {
        value.as_str().unwrap().parse().unwrap()
    }
    fn address(value: &Value) -> Address {
        value.as_str().unwrap().parse().unwrap()
    }
    fn u64_of(value: &Value) -> u64 {
        value.as_u64().unwrap()
    }

    /// Recovers a 65-byte r,s,v signature, requiring low s and v of 27 or 28.
    fn recovered(digest: B256, signature: &str) -> Address {
        let raw = evm::hex_bytes(signature).unwrap();
        assert_eq!(raw.len(), 65);
        let (r, s): ([u8; 32], [u8; 32]) = (
            raw[..32].try_into().unwrap(),
            raw[32..64].try_into().unwrap(),
        );
        let half_n: U256 = "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"
            .parse()
            .unwrap();
        assert!(U256::from_be_bytes(s) <= half_n, "high-s signature");
        assert!(raw[64] == 27 || raw[64] == 28);
        evm::recover(digest, &r, &s, raw[64] - 27).unwrap()
    }

    fn strategy_zero(chain_id: u64) -> Address {
        crate::strategy_addresses(vec![0; 32], chain_id, 0, 1).unwrap()[0]
            .parse()
            .unwrap()
    }

    #[test]
    fn social_key_derives_on_its_own_branch() {
        let social = social_address(vec![0; 32], SEPOLIA).unwrap();
        let seed = roles::seed_from_entropy(vec![0; 32]).unwrap();
        let path: DerivationPath = "m/44'/60'/147'/84532'/0".parse().unwrap();
        let expected = evm::key_address(&XPrv::derive_from_path(&*seed, &path).unwrap());
        assert_eq!(social, expected.to_checksum(None));
        assert_eq!(social, vectors()["social"]["address"].as_str().unwrap());

        // Never a strategy key, a funded account or an Earn wallet of the same seed.
        let strategies = crate::strategy_addresses(vec![0; 32], SEPOLIA, 0, 32).unwrap();
        let base = crate::strategy_addresses(vec![0; 32], 8453, 0, 32).unwrap();
        let accounts = crate::derive_account_addresses(vec![0; 32]).unwrap();
        let earn = crate::derive_earn_addresses(vec![0; 32], 4663).unwrap();
        for list in [&strategies, &base, &accounts, &earn] {
            assert!(!list.contains(&social));
        }
        // A different seed has a different social address.
        assert_ne!(social_address(vec![1; 32], SEPOLIA).unwrap(), social);
    }

    #[test]
    fn social_key_exists_only_on_the_pinned_chain() {
        for chain in [1, 8453, 4663, 0, u64::MAX] {
            assert!(matches!(
                social_address(vec![0; 32], chain),
                Err(SignerError::InvalidInput)
            ));
            assert!(
                social_sign_in(
                    vec![0; 32],
                    chain,
                    NONCE.into(),
                    NOW_MS / 1_000,
                    None,
                    NOW_MS
                )
                .is_err()
            );
        }
        assert!(social_address(vec![0; 31], SEPOLIA).is_err());
    }

    #[test]
    fn sign_in_recovers_the_social_address() {
        let issued_at = NOW_MS / 1_000 - 30;
        let signed =
            social_sign_in(vec![0; 32], SEPOLIA, NONCE.into(), issued_at, None, NOW_MS).unwrap();
        let account: Address = signed.account.parse().unwrap();
        assert_eq!(
            signed.account,
            social_address(vec![0; 32], SEPOLIA).unwrap()
        );
        assert_eq!(signed.owner_signature, None);
        let digest = sign_in_digest(SEPOLIA, account, NONCE.parse().unwrap(), issued_at);
        assert_eq!(recovered(digest, &signed.signature), account);
        // An uppercase nonce is the same nonce.
        let upper = format!("0x{}", NONCE[2..].to_uppercase());
        assert_eq!(
            social_sign_in(vec![0; 32], SEPOLIA, upper, issued_at, None, NOW_MS).unwrap(),
            signed
        );
    }

    #[test]
    fn owner_link_recovers_strategy_key_zero() {
        let issued_at = NOW_MS / 1_000;
        let signed = social_sign_in(
            vec![0; 32],
            SEPOLIA,
            NONCE.into(),
            issued_at,
            Some(42),
            NOW_MS,
        )
        .unwrap();
        let account: Address = signed.account.parse().unwrap();
        let link = owner_link_digest(SEPOLIA, account, 42, NONCE.parse().unwrap());
        let owner = recovered(link, signed.owner_signature.as_deref().unwrap());
        assert_eq!(owner, strategy_zero(SEPOLIA));
        assert_ne!(owner, account);
        // The sign-in itself is unchanged by the owner link.
        let digest = sign_in_digest(SEPOLIA, account, NONCE.parse().unwrap(), issued_at);
        assert_eq!(recovered(digest, &signed.signature), account);
        assert!(matches!(
            social_sign_in(
                vec![0; 32],
                SEPOLIA,
                NONCE.into(),
                issued_at,
                Some(0),
                NOW_MS
            ),
            Err(SignerError::InvalidInput)
        ));
    }

    #[test]
    fn issued_at_must_be_within_ten_minutes() {
        let sign =
            |issued_at| social_sign_in(vec![0; 32], SEPOLIA, NONCE.into(), issued_at, None, NOW_MS);
        let now = NOW_MS / 1_000;
        assert!(sign(now - 600).is_ok());
        assert!(sign(now + 600).is_ok());
        assert!(matches!(sign(now - 601), Err(SignerError::Expired)));
        assert!(matches!(sign(now + 601), Err(SignerError::InvalidInput)));
        assert!(matches!(sign(0), Err(SignerError::Expired)));
        assert!(matches!(sign(u64::MAX), Err(SignerError::InvalidInput)));
    }

    #[test]
    fn nonce_must_be_32_hex_bytes() {
        for bad in [
            "",
            "0x",
            &NONCE[2..],
            &NONCE[..65],
            &format!("{NONCE}00"),
            &format!("0X{}", &NONCE[2..]),
            &format!("0x{}g", &NONCE[2..65]),
            &format!("0x+{}", &NONCE[3..]),
        ] {
            assert!(
                matches!(
                    social_sign_in(
                        vec![0; 32],
                        SEPOLIA,
                        bad.to_string(),
                        NOW_MS / 1_000,
                        None,
                        NOW_MS
                    ),
                    Err(SignerError::InvalidInput)
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn matches_shared_social_vectors() {
        let v = vectors();
        assert_eq!(v["entropyHex"].as_str().unwrap(), hex::encode([0u8; 32]));
        let chain = u64_of(&v["chainId"]);
        assert_eq!(chain, SEPOLIA);
        let social = address(&v["social"]["address"]);
        let strategy = address(&v["strategy"]["address"]);
        assert_eq!(
            social_address(vec![0; 32], chain).unwrap(),
            social.to_checksum(None)
        );
        assert_eq!(strategy_zero(chain), strategy);

        // Type strings, then domains.
        assert_eq!(v["signIn"]["typeString"].as_str().unwrap(), SIGN_IN_TYPE);
        assert_eq!(
            v["ownerLink"]["typeString"].as_str().unwrap(),
            OWNER_LINK_TYPE
        );
        assert_eq!(
            v["updatePrice"]["typeString"].as_str().unwrap(),
            UPDATE_PRICE_TYPE
        );
        assert_eq!(v["socialDomain"]["name"].as_str().unwrap(), DOMAIN_NAME);
        assert_eq!(
            v["socialDomain"]["version"].as_str().unwrap(),
            DOMAIN_VERSION
        );
        assert_eq!(domain(chain), b256(&v["socialDomain"]["separator"]));
        assert_eq!(
            address(&v["registryDomain"]["verifyingContract"]),
            STRATEGY_REGISTRY_BASE_SEPOLIA
        );
        assert_eq!(
            evm::domain_separator(
                "GizuStrategyRegistry",
                "1",
                chain,
                STRATEGY_REGISTRY_BASE_SEPOLIA
            ),
            b256(&v["registryDomain"]["separator"])
        );

        // SignIn: digest, the exact deterministic signature, and the exported function.
        let s = &v["signIn"];
        let nonce = b256(&s["nonce"]);
        let issued_at = u64_of(&s["issuedAt"]);
        assert_eq!(address(&s["account"]), social);
        let digest = sign_in_digest(chain, social, nonce, issued_at);
        assert_eq!(digest, b256(&s["digest"]));
        assert_eq!(recovered(digest, s["signature"].as_str().unwrap()), social);

        let o = &v["ownerLink"];
        let strategy_id = u64_of(&o["strategyId"]);
        assert_eq!(address(&o["account"]), social);
        assert_eq!(b256(&o["nonce"]), nonce);
        let link = owner_link_digest(chain, social, strategy_id, nonce);
        assert_eq!(link, b256(&o["digest"]));
        assert_eq!(recovered(link, o["signature"].as_str().unwrap()), strategy);

        let signed = social_sign_in(
            vec![0; 32],
            chain,
            s["nonce"].as_str().unwrap().into(),
            issued_at,
            Some(strategy_id),
            issued_at * 1_000,
        )
        .unwrap();
        assert_eq!(signed.account, social.to_checksum(None));
        assert_eq!(signed.signature, s["signature"].as_str().unwrap());
        assert_eq!(
            signed.owner_signature.as_deref(),
            Some(o["signature"].as_str().unwrap())
        );

        // UpdatePrice under the pinned registry domain, signed by strategy key 0.
        let p = &v["updatePrice"];
        let monthly = p["monthlyPriceAtoms"].as_str().unwrap();
        let signal = p["signalPriceAtoms"].as_str().unwrap();
        let deadline = u64_of(&p["deadline"]);
        let digest = price_digest(
            chain,
            STRATEGY_REGISTRY_BASE_SEPOLIA,
            u64_of(&p["strategyId"]),
            u64_of(&p["version"]),
            monthly.parse().unwrap(),
            signal.parse().unwrap(),
            deadline,
        );
        assert_eq!(digest, b256(&p["digest"]));
        assert_eq!(
            recovered(digest, p["signature"].as_str().unwrap()),
            strategy
        );
        let priced = strategy_price_signature(
            vec![0; 32],
            chain,
            0,
            u64_of(&p["strategyId"]),
            u64_of(&p["version"]),
            monthly.into(),
            signal.into(),
            deadline,
            (deadline - 600) * 1_000,
        )
        .unwrap();
        assert_eq!(priced.signer, strategy.to_checksum(None));
        assert_eq!(priced.signature, p["signature"].as_str().unwrap());
    }
}
