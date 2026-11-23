//! Sealed Strategies: per-strategy signing keys, the sealed basket commitment and the two EIP-712
//! structures `StrategyRegistry` accepts. JS supplies public basket data only. This module checks it
//! against the pinned asset universe, hashes it and signs, so no FFI parameter can make a strategy
//! key sign anything but a registry creation or commitment. Formats match
//! `contracts/src/StrategyRegistry.sol` and `shared/strategy-commit-vectors.json`.
//!
//! Strategy keys live on their own hardened branch, `m/44'/60'/146'/{registryChain}'/{index}`, so
//! they never share an index with funding, swap, confidential or Earn wallets. They hold no funds:
//! a relayer submits what they sign.
use crate::swap::{evm, pins};
use crate::{SignerError, roles};
use alloy_primitives::{Address, B256, U256, address, hex, keccak256};
use bip32::{DerivationPath, XPrv};

pub const STRATEGY_BASE_SEPOLIA_CHAIN_ID: u64 = 84_532;
/// StrategyRegistry on Base Sepolia, deployed 2026-11-23. Base mainnet is pinned once deployed.
pub const STRATEGY_REGISTRY_BASE_SEPOLIA: Address =
    address!("0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7");
/// Earn vaults a basket may allocate to (Robinhood USDG and Ethereum USDC profiles).
pub const STRATEGY_ROBINHOOD_EARN_VAULT: Address =
    address!("0xBeEff033F34C046626B8D0A041844C5d1A5409dd");
pub const STRATEGY_ETHEREUM_EARN_VAULT: Address =
    address!("0x55C1B6e461a6334B567bAF0FEb5D728715446f05");

const ETHEREUM_CHAIN_ID: u64 = 1;
const ASSET_TOKEN: u8 = 0;
const ASSET_VAULT: u8 = 1;
const TOTAL_BPS: u32 = 10_000;
const WEIGHT_STEP_BPS: u16 = 500;
const MAX_ASSETS: usize = 10;
const MAX_EMBARGO_SECS: u32 = 30 * 86_400;
/// A signed creation or commitment must land within an hour, like a swap permit.
const SIGNATURE_LIFETIME_MS: u64 = 3_600_000;
const MAX_STRATEGY_INDEX: u32 = 0x7fff_ffff;
const MAX_ADDRESS_BATCH: u32 = 32;
const DOMAIN_NAME: &str = "GizuStrategyRegistry";
const DOMAIN_VERSION: &str = "1";
const CREATE_TYPE: &str = "CreateStrategy(uint32 embargo,bytes32 metadataHash,uint64 deadline)";
const COMMIT_TYPE: &str =
    "Commit(uint256 strategyId,uint64 seq,bytes32 commitment,uint64 deadline)";

/// One basket entry. `kind` is 0 for a token and 1 for an Earn vault.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct StrategyAsset {
    pub chain_id: u64,
    pub kind: u8,
    pub address: String,
    pub weight_bps: u16,
}

/// Terms a strategy is published with. They are hashed natively, so the review shows exactly the
/// terms the signature commits to.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct StrategyMetadata {
    pub name: String,
    pub monthly_price_atoms: String,
    pub signal_price_atoms: String,
    pub seats: u32,
}

#[derive(uniffi::Record, Debug, PartialEq, Eq)]
pub struct StrategyCreateSignature {
    pub signer: String,
    pub metadata_hash: String,
    pub signature: String,
}

/// One line of the native review: the pinned asset's label and its weight.
#[derive(uniffi::Record, Debug, PartialEq, Eq)]
pub struct StrategyReviewLine {
    pub label: String,
    pub weight_bps: u16,
}

/// The sorted basket the commitment covers, which the backend keeps for the later reveal.
#[derive(uniffi::Record, Debug, PartialEq, Eq)]
pub struct SealedStrategyCommit {
    pub signer: String,
    pub asset_ids: Vec<String>,
    pub weights_bps: Vec<u16>,
    pub commitment: String,
    pub signature: String,
}

/// Public strategy signer addresses, used to rediscover a wallet's strategies after restore.
#[uniffi::export]
pub fn strategy_addresses(
    entropy: Vec<u8>,
    chain_id: u64,
    start: u32,
    count: u32,
) -> Result<Vec<String>, SignerError> {
    if count == 0 || count > MAX_ADDRESS_BATCH {
        return Err(SignerError::InvalidInput);
    }
    let seed = roles::seed_from_entropy(entropy)?;
    (0..count)
        .map(|offset| {
            let index = start.checked_add(offset).ok_or(SignerError::InvalidInput)?;
            Ok(evm::key_address(&strategy_key(&seed, chain_id, index)?).to_checksum(None))
        })
        .collect()
}

/// Hashes the terms as the API does and signs `CreateStrategy` for the pinned registry.
#[uniffi::export]
pub fn strategy_create_signature(
    entropy: Vec<u8>,
    chain_id: u64,
    index: u32,
    embargo: u32,
    metadata: StrategyMetadata,
    deadline: u64,
    now_ms: u64,
) -> Result<StrategyCreateSignature, SignerError> {
    if embargo == 0 || embargo > MAX_EMBARGO_SECS {
        return Err(SignerError::InvalidInput);
    }
    check_deadline(deadline, now_ms)?;
    let registry = pinned_registry(chain_id)?;
    let metadata_hash = strategy_metadata_hash(&metadata)?;
    let seed = roles::seed_from_entropy(entropy)?;
    let key = strategy_key(&seed, chain_id, index)?;
    sign_create(&key, chain_id, registry, embargo, metadata_hash, deadline)
}

/// Validates a basket and labels it from the pinned universe for the native review, largest
/// weight first. Nothing here comes from JS but the addresses and weights being reviewed.
#[uniffi::export]
pub fn strategy_review(assets: Vec<StrategyAsset>) -> Result<Vec<StrategyReviewLine>, SignerError> {
    sealed_basket(&assets)?;
    let mut lines = assets
        .iter()
        .map(|asset| {
            Ok(StrategyReviewLine {
                label: asset_label(asset.chain_id, asset.kind, evm::addr(&asset.address)?)
                    .ok_or(SignerError::InvalidInput)?,
                weight_bps: asset.weight_bps,
            })
        })
        .collect::<Result<Vec<_>, SignerError>>()?;
    lines.sort_by(|a, b| b.weight_bps.cmp(&a.weight_bps));
    Ok(lines)
}

/// Validates strategy terms and returns their hash, so the review can bind its approval to them
/// before anything is signed.
#[uniffi::export]
pub fn strategy_terms_hash(metadata: StrategyMetadata) -> Result<String, SignerError> {
    Ok(hex::encode_prefixed(strategy_metadata_hash(&metadata)?))
}

/// Network name of a registry chain, for the native review.
#[uniffi::export]
pub fn strategy_network_name(chain_id: u64) -> Result<String, SignerError> {
    match chain_id {
        pins::BASE_CHAIN_ID => Ok("Base".into()),
        STRATEGY_BASE_SEPOLIA_CHAIN_ID => Ok("Base Sepolia".into()),
        _ => Err(SignerError::InvalidInput),
    }
}

fn asset_label(chain_id: u64, kind: u8, token: Address) -> Option<String> {
    let symbol = |targets: &[Address], symbols: &[&str]| {
        targets
            .iter()
            .position(|target| *target == token)
            .map(|i| symbols[i].to_string())
    };
    match (chain_id, kind) {
        (pins::BASE_CHAIN_ID, ASSET_TOKEN) if token == pins::BASE_USDC => {
            Some("USDC (cash)".into())
        }
        (pins::BASE_CHAIN_ID, ASSET_TOKEN) => {
            symbol(&pins::BASE_BUY_TARGETS, &BASE_SYMBOLS).map(|symbol| format!("{symbol} on Base"))
        }
        (pins::ROBINHOOD_CHAIN_ID, ASSET_TOKEN) => {
            symbol(&pins::ROBINHOOD_BUY_TARGETS, &ROBINHOOD_SYMBOLS)
                .map(|symbol| format!("{symbol} on Robinhood"))
        }
        (pins::ROBINHOOD_CHAIN_ID, ASSET_VAULT) if token == STRATEGY_ROBINHOOD_EARN_VAULT => {
            Some("Steakhouse USDG vault".into())
        }
        (ETHEREUM_CHAIN_ID, ASSET_VAULT) if token == STRATEGY_ETHEREUM_EARN_VAULT => {
            Some("Pendle USDC vault".into())
        }
        _ => None,
    }
}

const MAX_NAME_UTF16_UNITS: usize = 48;
const MAX_SEATS: u32 = 100;

/// The API's and the app's canonical JSON, keys in this order. serde_json escapes strings the
/// way `JSON.stringify` does, so all three hash the same bytes.
#[derive(serde::Serialize)]
struct CanonicalMetadata<'a> {
    v: u8,
    name: &'a str,
    #[serde(rename = "monthlyPriceAtoms")]
    monthly_price_atoms: &'a str,
    #[serde(rename = "signalPriceAtoms")]
    signal_price_atoms: &'a str,
    seats: u32,
}

/// JavaScript's `\s`: the API checks names with a JavaScript regular expression.
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `^(0|[1-9]\d{0,11})$`: USDC base units up to twelve digits.
fn price_atoms(value: &str) -> bool {
    value == "0"
        || (!value.is_empty()
            && value.len() <= 12
            && !value.starts_with('0')
            && value.bytes().all(|b| b.is_ascii_digit()))
}

/// The API's rules for strategy terms (`backend/src/http/routes/strategies.routes.ts`), then the
/// keccak hash of their canonical JSON.
pub(crate) fn strategy_metadata_hash(metadata: &StrategyMetadata) -> Result<B256, SignerError> {
    let name = metadata.name.as_str();
    let units = name.encode_utf16().count();
    let valid_name = units > 0
        && units <= MAX_NAME_UTF16_UNITS
        && !name.starts_with(js_whitespace)
        && !name.ends_with(js_whitespace)
        // `.` in the API's pattern matches anything but a line terminator.
        && !name.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    if !valid_name
        || !price_atoms(&metadata.monthly_price_atoms)
        || !price_atoms(&metadata.signal_price_atoms)
        || metadata.seats == 0
        || metadata.seats > MAX_SEATS
    {
        return Err(SignerError::InvalidInput);
    }
    let json = serde_json::to_string(&CanonicalMetadata {
        v: 1,
        name,
        monthly_price_atoms: &metadata.monthly_price_atoms,
        signal_price_atoms: &metadata.signal_price_atoms,
        seats: metadata.seats,
    })
    .map_err(|_| SignerError::InvalidInput)?;
    Ok(keccak256(json.as_bytes()))
}

/// Checks and seals a basket for commitment `seq` of `strategy_id`, then signs `Commit`.
#[uniffi::export]
#[allow(clippy::too_many_arguments)]
pub fn strategy_seal_commit(
    entropy: Vec<u8>,
    chain_id: u64,
    index: u32,
    strategy_id: u64,
    seq: u64,
    assets: Vec<StrategyAsset>,
    salt: Vec<u8>,
    deadline: u64,
    now_ms: u64,
) -> Result<SealedStrategyCommit, SignerError> {
    if strategy_id == 0 || salt.len() != 32 {
        return Err(SignerError::InvalidInput);
    }
    check_deadline(deadline, now_ms)?;
    let registry = pinned_registry(chain_id)?;
    let basket = sealed_basket(&assets)?;
    let seed = roles::seed_from_entropy(entropy)?;
    let key = strategy_key(&seed, chain_id, index)?;
    seal_commit(
        &key,
        chain_id,
        registry,
        strategy_id,
        seq,
        &basket,
        B256::from_slice(&salt),
        deadline,
    )
}

fn pinned_registry(chain_id: u64) -> Result<Address, SignerError> {
    match chain_id {
        STRATEGY_BASE_SEPOLIA_CHAIN_ID => Ok(STRATEGY_REGISTRY_BASE_SEPOLIA),
        _ => Err(SignerError::InvalidInput),
    }
}

fn strategy_key(seed: &[u8; 64], chain_id: u64, index: u32) -> Result<XPrv, SignerError> {
    if ![pins::BASE_CHAIN_ID, STRATEGY_BASE_SEPOLIA_CHAIN_ID].contains(&chain_id)
        || index > MAX_STRATEGY_INDEX
    {
        return Err(SignerError::InvalidInput);
    }
    let path: DerivationPath = format!("m/44'/60'/146'/{chain_id}'/{index}")
        .parse()
        .map_err(|_| SignerError::InvalidInput)?;
    XPrv::derive_from_path(seed, &path).map_err(|_| SignerError::CryptoFailed)
}

fn check_deadline(deadline_secs: u64, now_ms: u64) -> Result<(), SignerError> {
    let deadline_ms = deadline_secs
        .checked_mul(1_000)
        .ok_or(SignerError::InvalidInput)?;
    if deadline_ms <= now_ms {
        return Err(SignerError::Expired);
    }
    if deadline_ms > now_ms.saturating_add(SIGNATURE_LIFETIME_MS) {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}

/// Symbols of `pins::BASE_BUY_TARGETS`, index for index, for the native review only.
const BASE_SYMBOLS: [&str; 34] = [
    "GOOGLc", "SPCXc", "AAPLc", "AMZNc", "NVDAc", "CRWVc", "METAc", "KOc", "BRK.Bc", "MCDc",
    "ANTc", "TSLAc", "MSFTc", "ORCLc", "HSAIc", "LLYc", "AVGOc", "BUDc", "NVOc", "ULc", "PDDc",
    "SONYc", "TTWOc", "AMDc", "SAPc", "MRNAc", "INFYc", "LIc", "NOKc", "MSTRc", "MRVLc", "CRCLc",
    "PLTRc", "HOODc",
];
/// Symbols of `pins::ROBINHOOD_BUY_TARGETS`, index for index, for the native review only.
const ROBINHOOD_SYMBOLS: [&str; 25] = [
    "QQQ", "NVDA", "SPCX", "TSLA", "META", "USO", "MU", "GOOGL", "GLD", "AAPL", "SNDK", "CRWV",
    "SGOV", "AMZN", "BE", "AMAT", "IBM", "MSFT", "SLV", "LLY", "RDDT", "MRVL", "TTWO", "INTC",
    "AVGO",
];

/// keccak256(abi.encode(uint64 chainId, uint8 kind, address token)).
pub(crate) fn asset_id(chain_id: u64, kind: u8, token: Address) -> B256 {
    let mut buf = Vec::with_capacity(96);
    buf.extend_from_slice(&evm::word_u256(U256::from(chain_id)));
    buf.extend_from_slice(&evm::word_u256(U256::from(kind)));
    buf.extend_from_slice(&evm::word_address(token));
    keccak256(buf)
}

/// Buyable Base and Robinhood stocks, Base USDC as cash, and Gizu's Earn vaults.
fn in_universe(chain_id: u64, kind: u8, token: Address) -> bool {
    match (chain_id, kind) {
        (pins::BASE_CHAIN_ID, ASSET_TOKEN) => {
            token == pins::BASE_USDC || pins::BASE_BUY_TARGETS.contains(&token)
        }
        (pins::ROBINHOOD_CHAIN_ID, ASSET_TOKEN) => pins::ROBINHOOD_BUY_TARGETS.contains(&token),
        (pins::ROBINHOOD_CHAIN_ID, ASSET_VAULT) => token == STRATEGY_ROBINHOOD_EARN_VAULT,
        (ETHEREUM_CHAIN_ID, ASSET_VAULT) => token == STRATEGY_ETHEREUM_EARN_VAULT,
        _ => false,
    }
}

/// Validates a basket and returns it sorted by asset id, as the registry's reveal requires.
pub(crate) fn sealed_basket(assets: &[StrategyAsset]) -> Result<Vec<(B256, u16)>, SignerError> {
    if assets.is_empty() || assets.len() > MAX_ASSETS {
        return Err(SignerError::InvalidInput);
    }
    let mut total = 0u32;
    let mut basket = Vec::with_capacity(assets.len());
    for asset in assets {
        let token = evm::addr(&asset.address)?;
        if asset.weight_bps == 0
            || asset.weight_bps % WEIGHT_STEP_BPS != 0
            || !in_universe(asset.chain_id, asset.kind, token)
        {
            return Err(SignerError::InvalidInput);
        }
        total += u32::from(asset.weight_bps);
        basket.push((
            asset_id(asset.chain_id, asset.kind, token),
            asset.weight_bps,
        ));
    }
    if total != TOTAL_BPS {
        return Err(SignerError::InvalidInput);
    }
    basket.sort_by(|a, b| a.0.cmp(&b.0));
    if basket.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(SignerError::InvalidInput);
    }
    Ok(basket)
}

/// keccak256(abi.encode(id, seq, keccak(assetIds), keccak(weights as words), salt)).
pub(crate) fn basket_commitment(
    strategy_id: u64,
    seq: u64,
    basket: &[(B256, u16)],
    salt: B256,
) -> B256 {
    let assets: Vec<u8> = basket.iter().flat_map(|(id, _)| id.0).collect();
    let weights: Vec<u8> = basket
        .iter()
        .flat_map(|(_, weight)| evm::word_u256(U256::from(*weight)))
        .collect();
    let mut buf = Vec::with_capacity(160);
    buf.extend_from_slice(&evm::word_u256(U256::from(strategy_id)));
    buf.extend_from_slice(&evm::word_u256(U256::from(seq)));
    buf.extend_from_slice(keccak256(assets).as_slice());
    buf.extend_from_slice(keccak256(weights).as_slice());
    buf.extend_from_slice(salt.as_slice());
    keccak256(buf)
}

fn domain(chain_id: u64, registry: Address) -> B256 {
    evm::domain_separator(DOMAIN_NAME, DOMAIN_VERSION, chain_id, registry)
}

fn create_digest(
    chain_id: u64,
    registry: Address,
    embargo: u32,
    metadata_hash: B256,
    deadline: u64,
) -> B256 {
    evm::typed_hash(
        domain(chain_id, registry),
        CREATE_TYPE,
        &[
            evm::word_u256(U256::from(embargo)),
            metadata_hash.0,
            evm::word_u256(U256::from(deadline)),
        ],
    )
}

fn commit_digest(
    chain_id: u64,
    registry: Address,
    strategy_id: u64,
    seq: u64,
    commitment: B256,
    deadline: u64,
) -> B256 {
    evm::typed_hash(
        domain(chain_id, registry),
        COMMIT_TYPE,
        &[
            evm::word_u256(U256::from(strategy_id)),
            evm::word_u256(U256::from(seq)),
            commitment.0,
            evm::word_u256(U256::from(deadline)),
        ],
    )
}

fn sign_create(
    key: &XPrv,
    chain_id: u64,
    registry: Address,
    embargo: u32,
    metadata_hash: B256,
    deadline: u64,
) -> Result<StrategyCreateSignature, SignerError> {
    let digest = create_digest(chain_id, registry, embargo, metadata_hash, deadline);
    Ok(StrategyCreateSignature {
        signer: evm::key_address(key).to_checksum(None),
        metadata_hash: hex::encode_prefixed(metadata_hash),
        signature: evm::sign(key, digest)?.rsv_hex(),
    })
}

#[allow(clippy::too_many_arguments)]
fn seal_commit(
    key: &XPrv,
    chain_id: u64,
    registry: Address,
    strategy_id: u64,
    seq: u64,
    basket: &[(B256, u16)],
    salt: B256,
    deadline: u64,
) -> Result<SealedStrategyCommit, SignerError> {
    let commitment = basket_commitment(strategy_id, seq, basket, salt);
    let digest = commit_digest(chain_id, registry, strategy_id, seq, commitment, deadline);
    Ok(SealedStrategyCommit {
        signer: evm::key_address(key).to_checksum(None),
        asset_ids: basket
            .iter()
            .map(|(id, _)| hex::encode_prefixed(id))
            .collect(),
        weights_bps: basket.iter().map(|(_, weight)| *weight).collect(),
        commitment: hex::encode_prefixed(commitment),
        signature: evm::sign(key, digest)?.rsv_hex(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const NOW_MS: u64 = 1_900_000_000_000;

    fn secp256k1_half_n() -> U256 {
        "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"
            .parse()
            .unwrap()
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../shared/strategy-commit-vectors.json"
        )))
        .unwrap()
    }
    fn b256(value: &Value) -> B256 {
        value.as_str().unwrap().parse().unwrap()
    }
    fn vector_metadata(m: &Value) -> StrategyMetadata {
        StrategyMetadata {
            name: m["name"].as_str().unwrap().to_string(),
            monthly_price_atoms: m["monthlyPriceAtoms"].as_str().unwrap().to_string(),
            signal_price_atoms: m["signalPriceAtoms"].as_str().unwrap().to_string(),
            seats: m["seats"].as_u64().unwrap() as u32,
        }
    }

    #[test]
    fn metadata_hashes_match_the_api_and_app() {
        let v = vectors();
        for case in v["metadata"].as_array().unwrap() {
            assert_eq!(
                hex::encode_prefixed(strategy_metadata_hash(&vector_metadata(case)).unwrap()),
                case["hash"].as_str().unwrap()
            );
            assert_eq!(
                strategy_terms_hash(vector_metadata(case)).unwrap(),
                case["hash"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn metadata_follows_the_api_rules() {
        let ok = vector_metadata(&vectors()["metadata"][0]);
        let with = |name: &str| StrategyMetadata {
            name: name.into(),
            ..ok.clone()
        };
        assert!(strategy_metadata_hash(&with("A")).is_ok());
        assert!(strategy_metadata_hash(&with("Tab\tinside is allowed")).is_ok());
        for bad in [
            " lead",
            "trail ",
            "\u{a0}nbsp",
            "new\nline",
            "sep\u{2028}arator",
            "",
        ] {
            assert!(strategy_metadata_hash(&with(bad)).is_err(), "{bad:?}");
        }
        // Length counts UTF-16 units, as JavaScript does: 24 emoji fit, 25 do not.
        assert!(strategy_metadata_hash(&with(&"🚀".repeat(24))).is_ok());
        assert!(strategy_metadata_hash(&with(&"🚀".repeat(25))).is_err());
        assert!(strategy_metadata_hash(&with(&"a".repeat(49))).is_err());
        for price in ["01", "", "1.5", "1234567890123", "-1"] {
            let bad = StrategyMetadata {
                monthly_price_atoms: price.into(),
                ..ok.clone()
            };
            assert!(strategy_metadata_hash(&bad).is_err(), "{price:?}");
        }
        for seats in [0, 101] {
            assert!(
                strategy_metadata_hash(&StrategyMetadata {
                    seats,
                    ..ok.clone()
                })
                .is_err()
            );
        }
    }

    #[test]
    fn the_review_labels_assets_from_the_pinned_universe() {
        let lines = strategy_review(vector_assets(&vectors())).unwrap();
        assert_eq!(
            lines,
            vec![
                StrategyReviewLine {
                    label: "NVDAc on Base".into(),
                    weight_bps: 4000
                },
                StrategyReviewLine {
                    label: "GOOGLc on Base".into(),
                    weight_bps: 3500
                },
                StrategyReviewLine {
                    label: "USDC (cash)".into(),
                    weight_bps: 1500
                },
                StrategyReviewLine {
                    label: "Steakhouse USDG vault".into(),
                    weight_bps: 1000
                },
            ]
        );
        let robinhood = vec![
            StrategyAsset {
                chain_id: 4663,
                kind: 0,
                address: pins::ROBINHOOD_BUY_TARGETS[3].to_checksum(None),
                weight_bps: 5000,
            },
            StrategyAsset {
                chain_id: 1,
                kind: 1,
                address: STRATEGY_ETHEREUM_EARN_VAULT.to_checksum(None),
                weight_bps: 5000,
            },
        ];
        let labels: Vec<String> = strategy_review(robinhood)
            .unwrap()
            .into_iter()
            .map(|l| l.label)
            .collect();
        assert_eq!(labels, vec!["TSLA on Robinhood", "Pendle USDC vault"]);
        let mut invalid = vector_assets(&vectors());
        invalid[0].weight_bps += 500;
        assert!(strategy_review(invalid).is_err());
        assert_eq!(strategy_network_name(84_532).unwrap(), "Base Sepolia");
        assert!(strategy_network_name(1).is_err());
    }

    fn vector_assets(v: &Value) -> Vec<StrategyAsset> {
        v["basket"]["assets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| StrategyAsset {
                chain_id: a["chainId"].as_u64().unwrap(),
                kind: a["kind"].as_u64().unwrap() as u8,
                address: a["address"].as_str().unwrap().to_string(),
                weight_bps: a["weightBps"].as_u64().unwrap() as u16,
            })
            .collect()
    }
    fn zero_key(chain: u64, index: u32) -> XPrv {
        strategy_key(
            &roles::seed_from_entropy(vec![0; 32]).unwrap(),
            chain,
            index,
        )
        .unwrap()
    }
    fn recovered(digest: B256, signature: &str) -> Address {
        let raw = evm::hex_bytes(signature).unwrap();
        assert_eq!(raw.len(), 65);
        let (r, s): ([u8; 32], [u8; 32]) = (
            raw[..32].try_into().unwrap(),
            raw[32..64].try_into().unwrap(),
        );
        assert!(
            U256::from_be_bytes(s) <= secp256k1_half_n(),
            "registry rejects high-s signatures"
        );
        assert!(raw[64] == 27 || raw[64] == 28);
        evm::recover(digest, &r, &s, raw[64] - 27).unwrap()
    }

    #[test]
    fn signer_addresses_match_shared_vectors() {
        let v = vectors();
        for signer in v["signers"].as_array().unwrap() {
            let chain = signer["chainId"].as_u64().unwrap();
            let index = signer["index"].as_u64().unwrap() as u32;
            let got = strategy_addresses(vec![0; 32], chain, index, 1).unwrap();
            assert_eq!(got, vec![signer["address"].as_str().unwrap().to_string()]);
        }
        let batch = strategy_addresses(vec![0; 32], 8453, 0, 2).unwrap();
        assert_eq!(batch[0], v["signers"][0]["address"].as_str().unwrap());
        assert_eq!(batch[1], v["signers"][1]["address"].as_str().unwrap());
    }

    #[test]
    fn strategy_branch_is_distinct_from_existing_wallets() {
        let strategy = strategy_addresses(vec![0; 32], 8453, 0, 4).unwrap();
        let accounts = crate::derive_account_addresses(vec![0; 32]).unwrap();
        let earn = crate::derive_earn_addresses(vec![0; 32], 4663).unwrap();
        for address in &strategy {
            assert!(!accounts.contains(address));
            assert!(!earn.contains(address));
        }
        let sepolia = strategy_addresses(vec![0; 32], 84_532, 0, 4).unwrap();
        assert!(strategy.iter().all(|a| !sepolia.contains(a)));
    }

    #[test]
    fn basket_commitment_matches_shared_vectors() {
        let v = vectors();
        let mut assets = vector_assets(&v);
        // Callers may list assets in any order; the sealed basket is sorted by asset id.
        assets.reverse();
        let basket = sealed_basket(&assets).unwrap();
        let expected_ids: Vec<B256> = v["basket"]["assets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| b256(&a["assetId"]))
            .collect();
        assert_eq!(
            basket.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            expected_ids
        );
        assert_eq!(
            basket.iter().map(|(_, w)| *w).collect::<Vec<_>>(),
            vec![1000, 4000, 3500, 1500]
        );
        let id = v["basket"]["strategyId"].as_u64().unwrap();
        let seq = v["basket"]["seq"].as_u64().unwrap();
        assert_eq!(
            basket_commitment(id, seq, &basket, b256(&v["basket"]["salt"])),
            b256(&v["basket"]["commitment"])
        );
    }

    #[test]
    fn digests_match_shared_vectors() {
        let v = vectors();
        let chain = v["domain"]["chainId"].as_u64().unwrap();
        let registry: Address = v["domain"]["verifyingContract"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(domain(chain, registry), b256(&v["domain"]["separator"]));
        let create = create_digest(
            chain,
            registry,
            v["create"]["embargo"].as_u64().unwrap() as u32,
            b256(&v["create"]["metadataHash"]),
            v["create"]["deadline"].as_u64().unwrap(),
        );
        assert_eq!(create, b256(&v["create"]["digest"]));
        let commit = commit_digest(
            chain,
            registry,
            v["basket"]["strategyId"].as_u64().unwrap(),
            v["basket"]["seq"].as_u64().unwrap(),
            b256(&v["basket"]["commitment"]),
            v["commit"]["deadline"].as_u64().unwrap(),
        );
        assert_eq!(commit, b256(&v["commit"]["digest"]));
    }

    #[test]
    fn vector_signatures_recover_the_strategy_signer() {
        let v = vectors();
        let registry: Address = v["domain"]["verifyingContract"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let key = zero_key(8453, 0);
        let signer: Address = v["signers"][0]["address"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();

        let create = sign_create(
            &key,
            8453,
            registry,
            604_800,
            b256(&v["create"]["metadataHash"]),
            2_000_000_000,
        )
        .unwrap();
        assert_eq!(create.signer, signer.to_checksum(None));
        assert_eq!(
            recovered(b256(&v["create"]["digest"]), &create.signature),
            signer
        );

        let basket = sealed_basket(&vector_assets(&v)).unwrap();
        let sealed = seal_commit(
            &key,
            8453,
            registry,
            1,
            0,
            &basket,
            b256(&v["basket"]["salt"]),
            2_000_000_000,
        )
        .unwrap();
        assert_eq!(
            sealed.commitment,
            v["basket"]["commitment"].as_str().unwrap()
        );
        assert_eq!(sealed.weights_bps, vec![1000, 4000, 3500, 1500]);
        assert_eq!(
            recovered(b256(&v["commit"]["digest"]), &sealed.signature),
            signer
        );
    }

    #[test]
    fn exported_functions_sign_for_the_pinned_sepolia_registry() {
        let v = vectors();
        let deadline = NOW_MS / 1_000 + 600;
        let create = strategy_create_signature(
            vec![0; 32],
            84_532,
            0,
            60,
            vector_metadata(&v["metadata"][0]),
            deadline,
            NOW_MS,
        )
        .unwrap();
        let signer: Address = v["signers"][2]["address"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(create.signer, signer.to_checksum(None));
        assert_eq!(
            create.metadata_hash,
            v["metadata"][0]["hash"].as_str().unwrap()
        );
        let digest = create_digest(
            84_532,
            STRATEGY_REGISTRY_BASE_SEPOLIA,
            60,
            b256(&v["metadata"][0]["hash"]),
            deadline,
        );
        assert_eq!(recovered(digest, &create.signature), signer);

        let salt = evm::hex_bytes(v["basket"]["salt"].as_str().unwrap()).unwrap();
        let sealed = strategy_seal_commit(
            vec![0; 32],
            84_532,
            0,
            1,
            0,
            vector_assets(&v),
            salt,
            deadline,
            NOW_MS,
        )
        .unwrap();
        // The commitment does not depend on the registry chain; the signature domain does.
        assert_eq!(
            sealed.commitment,
            v["basket"]["commitment"].as_str().unwrap()
        );
        let digest = commit_digest(
            84_532,
            STRATEGY_REGISTRY_BASE_SEPOLIA,
            1,
            0,
            b256(&v["basket"]["commitment"]),
            deadline,
        );
        assert_eq!(recovered(digest, &sealed.signature), signer);
    }

    #[test]
    fn rejects_baskets_outside_the_rules() {
        let v = vectors();
        let ok = vector_assets(&v);
        assert!(sealed_basket(&ok).is_ok());

        let mut unknown = ok.clone();
        unknown[1].address = "0x000000000000000000000000000000000000dEaD".into();
        assert!(sealed_basket(&unknown).is_err());

        let mut wrong_kind = ok.clone();
        wrong_kind[0].kind = ASSET_TOKEN; // the Robinhood vault listed as a token
        assert!(sealed_basket(&wrong_kind).is_err());

        let mut wrong_chain = ok.clone();
        wrong_chain[1].chain_id = 4663; // a Base stock claimed on Robinhood Chain
        assert!(sealed_basket(&wrong_chain).is_err());

        let mut off_step = ok.clone();
        off_step[1].weight_bps += 100;
        off_step[2].weight_bps -= 100;
        assert!(sealed_basket(&off_step).is_err());

        let mut short = ok.clone();
        short[1].weight_bps -= 500;
        assert!(sealed_basket(&short).is_err());

        let mut zero = ok.clone();
        zero[2].weight_bps += zero[0].weight_bps;
        zero[0].weight_bps = 0;
        assert!(sealed_basket(&zero).is_err());

        let mut duplicate = ok.clone();
        duplicate[2] = StrategyAsset {
            weight_bps: 3500,
            ..duplicate[1].clone()
        };
        duplicate[1].weight_bps = 4000;
        assert!(sealed_basket(&duplicate).is_err());

        assert!(sealed_basket(&[]).is_err());
        let many: Vec<StrategyAsset> = pins::BASE_BUY_TARGETS[..11]
            .iter()
            .map(|t| StrategyAsset {
                chain_id: 8453,
                kind: 0,
                address: t.to_checksum(None),
                weight_bps: 500,
            })
            .collect();
        assert!(sealed_basket(&many).is_err());

        let mut lowercase = ok.clone();
        lowercase[1].address = lowercase[1].address.to_lowercase();
        assert_eq!(
            sealed_basket(&lowercase).unwrap(),
            sealed_basket(&ok).unwrap()
        );
    }

    #[test]
    fn rejects_invalid_signing_requests() {
        let v = vectors();
        let meta = vector_metadata(&v["metadata"][0]);
        let salt = evm::hex_bytes(v["basket"]["salt"].as_str().unwrap()).unwrap();
        let ok_deadline = NOW_MS / 1_000 + 600;
        let create = |chain, embargo, meta: &StrategyMetadata, deadline| {
            strategy_create_signature(
                vec![0; 32],
                chain,
                0,
                embargo,
                meta.clone(),
                deadline,
                NOW_MS,
            )
        };
        assert!(create(84_532, 60, &meta, ok_deadline).is_ok());
        assert!(create(84_532, 0, &meta, ok_deadline).is_err());
        assert!(create(84_532, MAX_EMBARGO_SECS + 1, &meta, ok_deadline).is_err());
        assert!(matches!(
            create(84_532, 60, &meta, NOW_MS / 1_000),
            Err(SignerError::Expired)
        ));
        assert!(create(84_532, 60, &meta, NOW_MS / 1_000 + 3_601).is_err());
        let unnamed = StrategyMetadata {
            name: String::new(),
            ..meta.clone()
        };
        assert!(create(84_532, 60, &unnamed, ok_deadline).is_err());
        // Base mainnet keys derive, but signing waits until its registry is pinned.
        assert!(create(8453, 60, &meta, ok_deadline).is_err());
        assert!(create(1, 60, &meta, ok_deadline).is_err());

        let seal = |strategy_id, salt: Vec<u8>| {
            strategy_seal_commit(
                vec![0; 32],
                84_532,
                0,
                strategy_id,
                0,
                vector_assets(&v),
                salt,
                ok_deadline,
                NOW_MS,
            )
        };
        assert!(seal(1, salt.clone()).is_ok());
        assert!(seal(0, salt.clone()).is_err());
        assert!(seal(1, salt[..31].to_vec()).is_err());

        assert!(strategy_addresses(vec![0; 32], 8453, 0, 0).is_err());
        assert!(strategy_addresses(vec![0; 32], 8453, 0, MAX_ADDRESS_BATCH + 1).is_err());
        assert!(strategy_addresses(vec![0; 32], 8453, u32::MAX, 2).is_err());
        assert!(strategy_addresses(vec![0; 32], 8453, MAX_STRATEGY_INDEX + 1, 1).is_err());
        assert!(strategy_addresses(vec![0; 31], 8453, 0, 1).is_err());
        assert!(strategy_addresses(vec![0; 32], 143, 0, 1).is_err());
    }

    #[test]
    fn pinned_vaults_match_the_earn_profiles() {
        assert_eq!(
            STRATEGY_ETHEREUM_EARN_VAULT,
            crate::ETHEREUM_EARN_VAULT.parse::<Address>().unwrap()
        );
        assert_eq!(
            STRATEGY_ROBINHOOD_EARN_VAULT,
            crate::earn_sponsored::HOOD_VAULT
                .parse::<Address>()
                .unwrap()
        );
    }
}
