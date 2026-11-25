//! Ai's target-chain side: the EIP-2612 stablecoin permit and the 1inch Fusion (LOP v4) order that spends it.
//! Every domain, spender and settlement contract comes from the plan's `TargetChain`.
use super::evm::{self, RawSignature};
use super::pins::*;
use crate::SignerError;
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitOrder {
    pub salt: String,
    pub maker: String,
    pub receiver: String,
    pub maker_asset: String,
    pub taker_asset: String,
    pub making_amount: String,
    pub taking_amount: String,
    pub maker_traits: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedOrder {
    pub hash: B256,
    pub taking_amount: U256,
    pub expiration: u64,
}

pub struct Permit {
    pub chain: &'static TargetChain,
    pub name: String,
    pub version: String,
    pub token: Address,
    pub owner: Address,
    pub value: U256,
    pub nonce: U256,
    pub deadline: u64,
}

impl Permit {
    pub fn digest(&self) -> Result<B256, SignerError> {
        if self.name.is_empty()
            || self.name.len() > 64
            || !matches!(self.version.as_str(), "1" | "2")
        {
            return Err(SignerError::InvalidInput);
        }
        let token = if self.token.is_zero() {
            self.chain.settlement_token
        } else {
            self.token
        };
        let domain = evm::domain_separator(&self.name, &self.version, self.chain.id, token);
        Ok(evm::typed_hash(
            domain,
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
            &[
                evm::word_address(self.owner),
                evm::word_address(self.chain.lop),
                evm::word_u256(self.value),
                evm::word_u256(self.nonce),
                evm::word_u256(U256::from(self.deadline)),
            ],
        ))
    }
    /// LOP v4 forwards the seven ABI words (no selector) to `IERC20Permit.permit`.
    pub fn encode(&self, sig: &RawSignature) -> Vec<u8> {
        let mut out = Vec::with_capacity(224);
        out.extend_from_slice(&evm::word_address(self.owner));
        out.extend_from_slice(&evm::word_address(self.chain.lop));
        out.extend_from_slice(&evm::word_u256(self.value));
        out.extend_from_slice(&evm::word_u256(U256::from(self.deadline)));
        out.extend_from_slice(&evm::word_u256(U256::from(27 + sig.y_parity)));
        out.extend_from_slice(&sig.r);
        out.extend_from_slice(&sig.s);
        out
    }
}

pub fn order_hash(order: &LimitOrder, chain: &TargetChain) -> Result<B256, SignerError> {
    let domain = evm::domain_separator("1inch Aggregation Router", "6", chain.id, chain.lop);
    Ok(evm::typed_hash(
        domain,
        "Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)",
        &[
            evm::word_u256(evm::decimal(&order.salt)?),
            evm::word_address(evm::addr(&order.maker)?),
            evm::word_address(evm::addr(&order.receiver)?),
            evm::word_address(evm::addr(&order.maker_asset)?),
            evm::word_address(evm::addr(&order.taker_asset)?),
            evm::word_u256(evm::decimal(&order.making_amount)?),
            evm::word_u256(evm::decimal(&order.taking_amount)?),
            evm::word_u256(evm::decimal(&order.maker_traits)?),
        ],
    ))
}

struct Extension<'a> {
    fields: [&'a [u8]; 8],
    custom: &'a [u8],
}
const MAKER_ASSET_SUFFIX: usize = 0;
const TAKER_ASSET_SUFFIX: usize = 1;
const MAKING_AMOUNT_DATA: usize = 2;
const TAKING_AMOUNT_DATA: usize = 3;
const PREDICATE: usize = 4;
const MAKER_PERMIT: usize = 5;
const PRE_INTERACTION: usize = 6;
const POST_INTERACTION: usize = 7;

fn parse_extension(bytes: &[u8]) -> Result<Extension<'_>, SignerError> {
    let offsets = U256::from_be_slice(bytes.get(..32).ok_or(SignerError::InvalidInput)?);
    let body = &bytes[32..];
    let mut fields: [&[u8]; 8] = [&[]; 8];
    let mut start = 0usize;
    for (i, field) in fields.iter_mut().enumerate() {
        let end = ((offsets >> (32 * i)) & U256::from(u32::MAX)).to::<usize>();
        if end < start || end > body.len() {
            return Err(SignerError::InvalidInput);
        }
        *field = &body[start..end];
        start = end;
    }
    Ok(Extension {
        fields,
        custom: &body[start..],
    })
}

fn bit(traits: U256, index: usize) -> bool {
    traits.bit(index)
}

/// Real receiver per the Fusion FeeTaker post-interaction; also rejects chained interactions.
fn fee_taker_receiver(post: &[u8], maker: Address) -> Result<Address, SignerError> {
    let mut at = 20;
    let flags = *post.get(at).ok_or(SignerError::InvalidInput)?;
    at += 1 + 40;
    let receiver = if flags & 1 == 1 {
        let r = Address::from_slice(post.get(at..at + 20).ok_or(SignerError::InvalidInput)?);
        at += 20;
        r
    } else {
        maker
    };
    at += 6;
    let whitelist = *post.get(at + 4).ok_or(SignerError::InvalidInput)? as usize;
    at += 5 + whitelist * 12 + 33;
    if flags & !1 != 0 || at != post.len() {
        return Err(SignerError::InvalidInput);
    }
    Ok(receiver)
}

pub struct ApprovedOrder {
    pub chain: &'static TargetChain,
    pub maker: Address,
    pub target: Address,
    pub amount: U256,
    pub min_out: U256,
    pub permit: Vec<u8>,
    pub permit_deadline: u64,
    pub maker_asset: Address,
    pub receiver: Address,
}

/// Why a Fusion order draft was refused. Only `BelowMinimum` is a price move that a fresh
/// preview can cure; every other reason means the draft does not match the approved order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderReject {
    Binding,
    BelowMinimum,
    Traits,
    Expiry,
    Salt,
    Extension,
    Receiver,
}

impl OrderReject {
    pub fn code(self) -> &'static str {
        match self {
            OrderReject::Binding => "BINDING",
            OrderReject::BelowMinimum => "BELOW_MINIMUM",
            OrderReject::Traits => "TRAITS",
            OrderReject::Expiry => "EXPIRY",
            OrderReject::Salt => "SALT",
            OrderReject::Extension => "EXTENSION",
            OrderReject::Receiver => "RECEIVER",
        }
    }
}

/// Research `validateFusionOrder`, plus the LOP v4 bindings the summary omitted: salt↔extension, traits and receiver.
pub fn check_order(
    order: &LimitOrder,
    extension_hex: &str,
    approved: &ApprovedOrder,
    now_secs: u64,
) -> Result<CheckedOrder, SignerError> {
    check_order_detail(order, extension_hex, approved, now_secs)
        .map_err(|_| SignerError::InvalidInput)
}

/// `check_order` that names the rule a draft broke.
pub fn check_order_detail(
    order: &LimitOrder,
    extension_hex: &str,
    approved: &ApprovedOrder,
    now_secs: u64,
) -> Result<CheckedOrder, OrderReject> {
    let binding = |_| OrderReject::Binding;
    let maker = evm::addr(&order.maker).map_err(binding)?;
    let receiver = evm::addr(&order.receiver).map_err(binding)?;
    let making = evm::decimal(&order.making_amount).map_err(binding)?;
    let taking = evm::decimal(&order.taking_amount).map_err(binding)?;
    let traits = evm::decimal(&order.maker_traits).map_err(binding)?;
    let salt = evm::decimal(&order.salt).map_err(binding)?;
    let chain = approved.chain;
    let maker_asset = if approved.maker_asset.is_zero() {
        chain.settlement_token
    } else {
        approved.maker_asset
    };
    let want_receiver = if approved.receiver.is_zero() {
        maker
    } else {
        approved.receiver
    };
    if maker != approved.maker
        || evm::addr(&order.maker_asset).map_err(binding)? != maker_asset
        || evm::addr(&order.taker_asset).map_err(binding)? != approved.target
        || making != approved.amount
        || approved.min_out.is_zero()
    {
        return Err(OrderReject::Binding);
    }
    if taking < approved.min_out {
        return Err(OrderReject::BelowMinimum);
    }
    // HAS_EXTENSION set; no pre-interaction, Permit2, WETH unwrap or epoch manager.
    if !bit(traits, 249)
        || bit(traits, 252)
        || bit(traits, 250)
        || bit(traits, 248)
        || bit(traits, 247)
    {
        return Err(OrderReject::Traits);
    }
    let expiration: u64 =
        ((traits >> 80usize) & ((U256::from(1u64) << 40usize) - U256::from(1u64))).to();
    if expiration <= now_secs || expiration >= approved.permit_deadline {
        return Err(OrderReject::Expiry);
    }
    let extension = evm::hex_bytes(extension_hex).map_err(|_| OrderReject::Extension)?;
    let mask = (U256::from(1) << 160) - U256::from(1);
    if salt & mask != U256::from_be_bytes(keccak256(&extension).0) & mask {
        return Err(OrderReject::Salt);
    }
    let ext = parse_extension(&extension).map_err(|_| OrderReject::Extension)?;
    let mut permit = maker_asset.as_slice().to_vec();
    permit.extend_from_slice(&approved.permit);
    let settles = |data: &[u8]| {
        data.len() >= 20 && Address::from_slice(&data[..20]) == chain.fusion_settlement
    };
    if !ext.fields[MAKER_ASSET_SUFFIX].is_empty()
        || !ext.fields[TAKER_ASSET_SUFFIX].is_empty()
        || !ext.fields[PREDICATE].is_empty()
        || !ext.fields[PRE_INTERACTION].is_empty()
        || !ext.custom.is_empty()
        || ext.fields[MAKER_PERMIT] != permit.as_slice()
        || ext.fields[MAKING_AMOUNT_DATA] != ext.fields[TAKING_AMOUNT_DATA]
        || !settles(ext.fields[MAKING_AMOUNT_DATA])
        || !settles(ext.fields[POST_INTERACTION])
    {
        return Err(OrderReject::Extension);
    }
    let real = if receiver == chain.fusion_settlement {
        fee_taker_receiver(ext.fields[POST_INTERACTION], maker)
            .map_err(|_| OrderReject::Extension)?
    } else if receiver.is_zero() {
        maker
    } else {
        receiver
    };
    if real != want_receiver {
        return Err(OrderReject::Receiver);
    }
    Ok(CheckedOrder {
        hash: order_hash(order, chain).map_err(binding)?,
        taking_amount: taking,
        expiration,
    })
}

/// Research `minimumOut`: the auction end amount less the Fusion slippage.
pub fn minimum_out(auction_end: U256) -> U256 {
    auction_end * U256::from(10_000 - FUSION_SLIPPAGE_BPS) / U256::from(10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/research-mainnet.json")).unwrap()
    }
    fn wallet() -> Address {
        evm::addr("0x8ba1f109551bD432803012645Ac136ddd64DBA72").unwrap()
    }
    fn amzn() -> Address {
        evm::addr("0x12f190a9F9d7D37a250758b26824B97CE941bF54").unwrap()
    }
    fn live() -> (LimitOrder, String, ApprovedOrder, String) {
        let f = &fixture()["fusionUnsignedWithPermitPlaceholder"];
        let order: LimitOrder = serde_json::from_value(f["order"].clone()).unwrap();
        let approved = ApprovedOrder {
            chain: &ROBINHOOD,
            maker: wallet(),
            target: amzn(),
            amount: U256::from(2_000_000u64),
            min_out: U256::from(7_800_000_000_000_000u64),
            permit: vec![0x11; 224],
            permit_deadline: f["deadline"].as_str().unwrap().parse::<u64>().unwrap() + 1,
            maker_asset: Address::ZERO,
            receiver: Address::ZERO,
        };
        (
            order,
            f["extension"].as_str().unwrap().to_string(),
            approved,
            f["orderHash"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn accepts_a_live_fusion_order_and_reproduces_its_hash() {
        let (order, extension, approved, hash) = live();
        let checked = check_order(
            &order,
            &extension,
            &approved,
            approved.permit_deadline - 600,
        )
        .unwrap();
        assert_eq!(format!("{:#x}", checked.hash), hash);
    }

    #[test]
    fn rejects_changed_orders_extensions_and_expiry() {
        let (order, extension, approved, _) = live();
        let now = approved.permit_deadline - 600;
        let rejects =
            |o: &LimitOrder, e: &str, a: &ApprovedOrder, t: u64| check_order(o, e, a, t).is_err();
        assert!(rejects(
            &LimitOrder {
                maker: format!("{:#x}", amzn()),
                ..order.clone()
            },
            &extension,
            &approved,
            now
        ));
        assert!(rejects(
            &LimitOrder {
                taker_asset: format!("{ROBINHOOD_USDG:#x}"),
                ..order.clone()
            },
            &extension,
            &approved,
            now
        ));
        assert!(rejects(
            &LimitOrder {
                making_amount: "2000001".into(),
                ..order.clone()
            },
            &extension,
            &approved,
            now
        ));
        assert!(rejects(
            &LimitOrder {
                receiver: format!("{:#x}", amzn()),
                ..order.clone()
            },
            &extension,
            &approved,
            now
        ));
        assert!(rejects(
            &order,
            &extension,
            &ApprovedOrder {
                min_out: U256::from(8_000_000_000_000_000u64),
                ..approved_clone(&approved)
            },
            now
        ));
        assert!(rejects(
            &order,
            &extension,
            &ApprovedOrder {
                permit: vec![0x22; 224],
                ..approved_clone(&approved)
            },
            now
        ));
        assert!(rejects(
            &order,
            &extension,
            &ApprovedOrder {
                permit_deadline: approved.permit_deadline - 1,
                ..approved_clone(&approved)
            },
            now
        ));
        assert!(rejects(
            &order,
            &extension,
            &approved,
            approved.permit_deadline
        ));
        let tampered = format!("{}00", extension);
        assert!(rejects(&order, &tampered, &approved, now));
    }

    fn approved_clone(a: &ApprovedOrder) -> ApprovedOrder {
        ApprovedOrder {
            chain: a.chain,
            maker: a.maker,
            target: a.target,
            amount: a.amount,
            min_out: a.min_out,
            permit: a.permit.clone(),
            permit_deadline: a.permit_deadline,
            maker_asset: a.maker_asset,
            receiver: a.receiver,
        }
    }

    #[test]
    fn a_custom_receiver_in_the_fee_taker_data_is_rejected() {
        let mut post = FUSION_SETTLEMENT.as_slice().to_vec();
        post.push(1);
        post.extend_from_slice(&[0; 40]);
        post.extend_from_slice(amzn().as_slice());
        post.extend_from_slice(&[0; 6]);
        post.extend_from_slice(&[0, 0, 0, 0, 0]);
        post.extend_from_slice(&[0; 33]);
        assert_eq!(fee_taker_receiver(&post, wallet()).unwrap(), amzn());
        post.push(0);
        assert!(fee_taker_receiver(&post, wallet()).is_err());
    }

    #[test]
    fn research_order_and_permit_recover_the_recipient_wallet() {
        let f = fixture();
        let fusion = &f["fusion"];
        let wallet = evm::addr(fusion["wallet"].as_str().unwrap()).unwrap();
        let order: LimitOrder = serde_json::from_value(fusion["signed"]["order"].clone()).unwrap();
        let hash = order_hash(&order, &ROBINHOOD).unwrap();
        assert_eq!(
            format!("{hash:#x}"),
            fusion["signed"]["orderHash"].as_str().unwrap()
        );
        let sig = evm::hex_bytes(fusion["signed"]["signature"].as_str().unwrap()).unwrap();
        assert_eq!(
            evm::recover(
                hash,
                sig[..32].try_into().unwrap(),
                sig[32..64].try_into().unwrap(),
                sig[64] - 27
            )
            .unwrap(),
            wallet
        );
        let data = evm::hex_bytes(fusion["permit"]["data"].as_str().unwrap()).unwrap();
        let permit = Permit {
            chain: &ROBINHOOD,
            name: "Global Dollar".into(),
            version: "1".into(),
            token: ROBINHOOD_USDG,
            owner: wallet,
            value: evm::decimal(fusion["amountInAtoms"].as_str().unwrap()).unwrap(),
            nonce: evm::decimal(fusion["permit"]["nonce"].as_str().unwrap()).unwrap(),
            deadline: fusion["permit"]["deadline"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        };
        let raw = RawSignature {
            r: data[160..192].try_into().unwrap(),
            s: data[192..224].try_into().unwrap(),
            y_parity: data[159] - 27,
        };
        assert_eq!(
            evm::recover(permit.digest().unwrap(), &raw.r, &raw.s, raw.y_parity).unwrap(),
            wallet
        );
        assert_eq!(permit.encode(&raw), data);
        let approved = ApprovedOrder {
            chain: &ROBINHOOD,
            maker: wallet,
            target: evm::addr(fusion["target"].as_str().unwrap()).unwrap(),
            amount: permit.value,
            min_out: evm::decimal(fusion["approvedMinOutAtoms"].as_str().unwrap()).unwrap(),
            permit: data.clone(),
            permit_deadline: permit.deadline,
            maker_asset: Address::ZERO,
            receiver: Address::ZERO,
        };
        check_order(
            &order,
            fusion["signed"]["extension"].as_str().unwrap(),
            &approved,
            permit.deadline - 3_590,
        )
        .unwrap();
    }

    #[test]
    fn a_signature_for_one_chain_does_not_verify_on_another() {
        let (order, ..) = live();
        assert_ne!(
            order_hash(&order, &ROBINHOOD).unwrap(),
            order_hash(&order, &BASE).unwrap()
        );
        let permit = |chain| Permit {
            chain,
            name: "USD Coin".into(),
            version: "2".into(),
            token: Address::ZERO,
            owner: wallet(),
            value: U256::from(1_000_000u64),
            nonce: U256::ZERO,
            deadline: 2_000_000_000,
        };
        assert_ne!(
            permit(&ROBINHOOD).digest().unwrap(),
            permit(&BASE).digest().unwrap()
        );
        // The Base permit names Base USDC and the canonical LOP as spender.
        let base = permit(&BASE);
        let raw = RawSignature {
            r: [1; 32],
            s: [2; 32],
            y_parity: 0,
        };
        assert_eq!(&base.encode(&raw)[32..64], &evm::word_address(BASE_LOP));
        let expected = evm::typed_hash(
            evm::domain_separator("USD Coin", "2", BASE_CHAIN_ID, BASE_USDC),
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
            &[
                evm::word_address(wallet()),
                evm::word_address(BASE_LOP),
                evm::word_u256(base.value),
                evm::word_u256(U256::ZERO),
                evm::word_u256(U256::from(base.deadline)),
            ],
        );
        assert_eq!(base.digest().unwrap(), expected);
    }

    #[test]
    fn an_order_settled_through_another_chains_contract_is_rejected() {
        let (order, extension, approved, _) = live();
        let now = approved.permit_deadline - 600;
        let on_base = ApprovedOrder {
            chain: &BASE,
            maker_asset: ROBINHOOD_USDG,
            ..approved_clone(&approved)
        };
        assert_eq!(
            check_order_detail(&order, &extension, &on_base, now),
            Err(OrderReject::Extension)
        );
    }
}
