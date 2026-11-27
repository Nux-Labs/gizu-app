//! Mainnet addresses the swap policy accepts. A provider payload naming anything else is rejected.
use alloy_primitives::{Address, address};

pub const MONAD_CHAIN_ID: u64 = 143;
pub const ROBINHOOD_CHAIN_ID: u64 = 4663;
pub const MONAD_RPC: &str = "https://rpc.monad.xyz";
pub const ROBINHOOD_RPC: &str = "https://rpc.mainnet.chain.robinhood.com";

pub const MONAD_USDC: Address = address!("0x754704bc059f8c67012fed69bc8a327a5aafb603");
pub const ENTRY_POINT_V08: Address = address!("0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108");
pub const SIMPLE_7702: Address = address!("0xe6Cae83BdE06E4c305530e199D7217f42808555B");
pub const PIMLICO_ERC20_PAYMASTER: Address = address!("0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402");
pub const CONFIDENTIAL_CONTRACT: &str = "intents.far";
pub const AUTH_VERIFYING_CONTRACT: &str = "intents.near";
pub const ROBINHOOD_USDG: Address = address!("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
pub const ONEINCH_LOP: Address = address!("0x5A705DE8982235a7fa45bB83dCaCf03a211389C7");
pub const FUSION_SETTLEMENT: Address = address!("0xb55ba9617dafae1236313c3cb7806439ceefbd13");

/// Robinhood stock tokens a new buy may target, deepest USDG market first
/// (`shared/swap-targets-v2.json`, chain 4663). Sell and recovery are not limited to this list.
pub const ROBINHOOD_BUY_TARGETS: [Address; 25] = [
    address!("0xD5f3879160bc7c32ebb4dC785F8a4F505888de68"), // QQQ
    address!("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"), // NVDA
    address!("0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa"), // SPCX
    address!("0x322F0929c4625eD5bAd873c95208D54E1c003b2d"), // TSLA
    address!("0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35"), // META
    address!("0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344"), // USO
    address!("0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD"), // MU
    address!("0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3"), // GOOGL
    address!("0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e"), // GLD
    address!("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"), // AAPL
    address!("0xB90A19fF0Af67f7779afF50A882A9CfF42446400"), // SNDK
    address!("0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3"), // CRWV
    address!("0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5"), // SGOV
    address!("0x12f190a9F9d7D37a250758b26824B97CE941bF54"), // AMZN
    address!("0x822CC93fFD030293E9842c30BBD678F530701867"), // BE
    address!("0x36046893810a7E7fCE501229d57dc3FC8c8716d0"), // AMAT
    address!("0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619"), // IBM
    address!("0xe93237C50D904957Cf27E7B1133b510C669c2e74"), // MSFT
    address!("0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f"), // SLV
    address!("0x8005d266423c7ea827372c9c864491e5786600ea"), // LLY
    address!("0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C"), // RDDT
    address!("0x62fd0668e10D8B72339BE2DCF7643001688ff13B"), // MRVL
    address!("0x5e81213613b6B86EaB4c6c50d718d34359459786"), // TTWO
    address!("0xc72b96e0E48ecd4DC75E1e45396e26300BC39681"), // INTC
    address!("0x156E175DD063a8cE274C50654eF40e0032b3fbcF"), // AVGO
];

pub const BASE_CHAIN_ID: u64 = 8453;
pub const BASE_RPC: &str = "https://mainnet.base.org";
pub const BASE_USDC: Address = address!("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
pub const ARBITRUM_CHAIN_ID: u64 = 42161;
pub const ARBITRUM_RPC: &str = "https://arb1.arbitrum.io/rpc";
pub const ARBITRUM_USDC: Address = address!("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
pub const PRIVATE_USDC_ASSET: &str = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";

#[derive(Clone, Copy)]
pub struct FundingSourceConfig {
    pub chain_id: u64,
    pub usdc: Address,
    pub origin_asset: &'static str,
    pub rpc: &'static str,
}

/// Exact funding sources; unrelated EVM tokens and action destination chains are not admitted.
pub fn funding_source(chain_id: u64) -> Option<FundingSourceConfig> {
    let (usdc, origin_asset, rpc) = match chain_id {
        MONAD_CHAIN_ID => (MONAD_USDC, PRIVATE_USDC_ASSET, MONAD_RPC),
        BASE_CHAIN_ID => (
            BASE_USDC,
            "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
            BASE_RPC,
        ),
        ARBITRUM_CHAIN_ID => (
            ARBITRUM_USDC,
            "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
            ARBITRUM_RPC,
        ),
        _ => return None,
    };
    Some(FundingSourceConfig {
        chain_id,
        usdc,
        origin_asset,
        rpc,
    })
}
/// Base runs the canonical LOP v4 deployment; only Robinhood Chain has its own.
pub const BASE_LOP: Address = address!("0x111111125421cA6dc452d289314280a0f8842A65");
/// The Fusion `settlementAddress` 1inch quotes for chain 8453.
pub const BASE_FUSION_SETTLEMENT: Address = address!("0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5");

/// Coinbase-issued stock tokens a new buy may target on Base, deepest USDC market first
/// (`shared/swap-targets-v2.json`, chain 8453). Sell and recovery are not limited to this list.
pub const BASE_BUY_TARGETS: [Address; 34] = [
    address!("0xb2000000000000000000002D0BA3164cc74f58B7"), // GOOGLc
    address!("0xb2000000000000000000007b9fcbd005511aCBd5"), // SPCXc
    address!("0xb200000000000000000000C2e324d24d7eEcd1fb"), // AAPLc
    address!("0xb200000000000000000000d9192b6B456483C2E8"), // AMZNc
    address!("0xb20000000000000000000078ee7ce2fE4908108C"), // NVDAc
    address!("0xB200000000000000000000F111184A74720787E6"), // CRWVc
    address!("0xb2000000000000000000008bC8786B856E61707C"), // METAc
    address!("0xb200000000000000000000ffef181DB6dC5ed6A3"), // KOc
    address!("0xb20000000000000000000024170488e788CBbCb4"), // BRK.Bc
    address!("0xb200000000000000000000d2f4cf2f7DEBB244BB"), // MCDc
    address!("0xb20000000000000000000016e38FD364d271Ba28"), // ANTc
    address!("0xb2000000000000000000001e800a7f5189430cD0"), // TSLAc
    address!("0xB200000000000000000000Ab99cFa739E253872B"), // MSFTc
    address!("0xb200000000000000000000347AFbA223D7B6b63C"), // ORCLc
    address!("0xb200000000000000000000f3049F4aa834b23b64"), // HSAIc
    address!("0xB200000000000000000000f1a0F91e34892E4718"), // LLYc
    address!("0xB200000000000000000000Fc737aeA6196aB5a4c"), // AVGOc
    address!("0xB200000000000000000000c36ce081Dd09e86cA2"), // BUDc
    address!("0xb2000000000000000000008D5328e9208773dC58"), // NVOc
    address!("0xB200000000000000000000349ef3Aa93a0897476"), // ULc
    address!("0xB200000000000000000000c8A7223510467D8563"), // PDDc
    address!("0xb200000000000000000000a26326a922FFA87f6C"), // SONYc
    address!("0xB200000000000000000000f720C26062Bc3067Da"), // TTWOc
    address!("0xB2000000000000000000000d8Ce462E99ee7A47B"), // AMDc
    address!("0xb200000000000000000000da6F64c306234127E0"), // SAPc
    address!("0xB200000000000000000000e215e9B76ecBA02468"), // MRNAc
    address!("0xb200000000000000000000F6b0417af5F52341FC"), // INFYc
    address!("0xb200000000000000000000D61eFD9F54A23ef9eB"), // LIc
    address!("0xB2000000000000000000005ac674f707E357409c"), // NOKc
    address!("0xb2000000000000000000004884b426556b92883d"), // MSTRc
    address!("0xB200000000000000000000eC3c4c7395Cc609813"), // MRVLc
    address!("0xB20000000000000000000019f6E7C675b73C2e4D"), // CRCLc
    address!("0xb2000000000000000000007d16372840dF4dAbbe"), // PLTRc
    address!("0xb2000000000000000000006F944897540579D3f2"), // HOODc
];

/// A chain a swap may hold its stock on: where the token trades, which stablecoin Aurora pays out
/// there, and the 1inch Fusion contracts that settle against it.
#[derive(Debug, PartialEq, Eq)]
pub struct TargetChain {
    pub id: u64,
    /// Shown in the review, e.g. "Robinhood USDG".
    pub name: &'static str,
    pub rpc: &'static str,
    /// Aurora's `blockchain` key for `settlement_token`.
    pub aurora_blockchain: &'static str,
    pub settlement_token: Address,
    pub settlement_symbol: &'static str,
    pub lop: Address,
    pub fusion_settlement: Address,
    pub buy_targets: &'static [Address],
}

pub const ROBINHOOD: TargetChain = TargetChain {
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood",
    rpc: ROBINHOOD_RPC,
    aurora_blockchain: "hood",
    settlement_token: ROBINHOOD_USDG,
    settlement_symbol: "USDG",
    lop: ONEINCH_LOP,
    fusion_settlement: FUSION_SETTLEMENT,
    buy_targets: &ROBINHOOD_BUY_TARGETS,
};

pub const BASE: TargetChain = TargetChain {
    id: BASE_CHAIN_ID,
    name: "Base",
    rpc: BASE_RPC,
    aurora_blockchain: "base",
    settlement_token: BASE_USDC,
    settlement_symbol: "USDC",
    lop: BASE_LOP,
    fusion_settlement: BASE_FUSION_SETTLEMENT,
    buy_targets: &BASE_BUY_TARGETS,
};

/// The chain a plan names, or `None` for a chain the engine does not support.
pub fn target_chain(id: u64) -> Option<&'static TargetChain> {
    [&ROBINHOOD, &BASE].into_iter().find(|chain| chain.id == id)
}

impl TargetChain {
    pub fn is_buy_target(&self, token: Address) -> bool {
        self.buy_targets.contains(&token)
    }
}

pub const USDC_DECIMALS: u8 = 6;
// Numeric representability bound; production budgets have no ten-USDC test cap.
pub const MAX_SOURCE_ATOMS: u64 = u64::MAX;
pub const QUOTE_SLIPPAGE_BPS: u32 = 100;
pub const FUSION_SLIPPAGE_BPS: u64 = 100;
pub const PERMIT_LIFETIME_SECS: u64 = 3_600;
pub const SESSION_MS: u64 = 900_000;
pub const OPERATION_MS: u64 = 24 * 3_600_000;
