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
/// (`shared/swap-targets-v1.json`). Sell and recovery are not limited to this list.
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

pub fn is_buy_target(token: Address) -> bool {
    ROBINHOOD_BUY_TARGETS.contains(&token)
}

pub const USDC_DECIMALS: u8 = 6;
// Numeric representability bound; production budgets have no ten-USDC test cap.
pub const MAX_SOURCE_ATOMS: u64 = u64::MAX;
pub const QUOTE_SLIPPAGE_BPS: u32 = 100;
pub const FUSION_SLIPPAGE_BPS: u64 = 100;
pub const PERMIT_LIFETIME_SECS: u64 = 3_600;
pub const SESSION_MS: u64 = 900_000;
pub const OPERATION_MS: u64 = 24 * 3_600_000;
