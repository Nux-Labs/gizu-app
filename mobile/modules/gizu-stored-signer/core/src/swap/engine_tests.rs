//! Drives `SwapOperation` against a scripted gateway and chains. The fake builds provider payloads the
//! validators accept and verifies every signature it receives against the wallet that must have made it.
use super::*;
use crate::swap::aurora::iso_string;
use alloy_primitives::{address, hex};
use base64::Engine as _;
use std::collections::{HashMap, HashSet};

const T0: u64 = 1_790_300_000_000;
const ENTROPY: [u8; 32] = [7; 32];
const GATEWAY: &str = "https://gateway.test";
const SRC: &str = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
const DST: &str = "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near";
const AMZN: Address = address!("0x12f190a9F9d7D37a250758b26824B97CE941bF54");
const FEE: u64 = 3_000;
const WEI_PER_ATOM: u64 = 4_000_000_000;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tamper {
    None,
    FundingRecipient,
    QuoteRefund,
    OrderReceiver,
    /// The order draft names another receiver than the one requested.
    OrderTopReceiver,
}

struct Wallets {
    f: Address,
    c: Address,
    a: [Address; 3],
}

fn wallets() -> Wallets {
    let seed = seed_from_entropy(ENTROPY.to_vec()).unwrap();
    let at = |i| evm::key_address(&derive_key(&seed, i).unwrap());
    Wallets {
        f: at(FUNDING_ACCOUNT),
        c: at(CONFIDENTIAL_ACCOUNT),
        a: [at(3), at(4), at(5)],
    }
}

struct World {
    w: Wallets,
    tamper: Tamper,
    /// Pimlico's approve amount relative to the signed fee cap.
    approve_delta: i64,
    funding_fee: u64,
    funding_credit_bps: u64,
    paymaster_valid_for: u64,
    paymaster_valid_after: u64,
    /// Order drafts still to return 3% under the previewed auction end.
    short_orders: u8,
    f_balance: U256,
    payout_rate_bps: u64,
    credit: U256,
    credit_delay_ms: u64,
    credit_ready_ms: Option<u64>,
    transient_submit_once: bool,
    usdg: HashMap<Address, U256>,
    /// Fusion refuses sells of fewer tokens than this as too small.
    dust_below: U256,
    /// Aurora refuses a USDG deposit under this many atoms as too small for the bridge.
    bridge_min: U256,
    /// C accumulates every sale credit and each payout spends from it, as on mainnet.
    pool_credit: bool,
    /// USDG a sale delivered to its receiver (an Aurora deposit).
    delivered: HashMap<Address, U256>,
    target: HashMap<Address, U256>,
    monad_usdc: HashMap<Address, U256>,
    origin_deposit: HashMap<Address, String>,
    deposits: HashMap<String, (Address, U256, U256, bool)>,
    credited: HashSet<String>,
    last_deposit: Option<String>,
    funded_at: HashMap<String, u64>,
    permits: HashMap<B256, Vec<u8>>,
    fills: HashMap<B256, (String, Address, U256, U256, Address, bool)>,
    inbound_quotes: HashMap<String, (Value, u64)>,
    partial_fill_once: bool,
    user_ops: usize,
    intents: usize,
    orders: usize,
    paths: Vec<String>,
}

impl World {
    fn new() -> Self {
        Self {
            w: wallets(),
            tamper: Tamper::None,
            approve_delta: 0,
            funding_fee: FEE,
            funding_credit_bps: 10_000,
            paymaster_valid_for: 600,
            paymaster_valid_after: 0,
            short_orders: 0,
            f_balance: U256::from(2_000_000u64),
            payout_rate_bps: 9_900,
            credit: U256::ZERO,
            credit_delay_ms: 0,
            credit_ready_ms: None,
            transient_submit_once: false,
            usdg: HashMap::new(),
            dust_below: U256::ZERO,
            bridge_min: U256::ZERO,
            pool_credit: false,
            delivered: HashMap::new(),
            target: HashMap::new(),
            monad_usdc: HashMap::new(),
            origin_deposit: HashMap::new(),
            deposits: HashMap::new(),
            credited: HashSet::new(),
            last_deposit: None,
            funded_at: HashMap::new(),
            permits: HashMap::new(),
            fills: HashMap::new(),
            inbound_quotes: HashMap::new(),
            partial_fill_once: false,
            user_ops: 0,
            intents: 0,
            orders: 0,
            paths: vec![],
        }
    }

    fn handle(&mut self, url: &str, body: Option<&str>, now: u64) -> (u16, String) {
        let body: Value = body
            .map(|b| serde_json::from_str(b).unwrap())
            .unwrap_or(Value::Null);
        if url == MONAD_RPC {
            return (200, rpc_reply(&body, |m, p| self.monad(m, p)).to_string());
        }
        if url == ROBINHOOD_RPC {
            return (
                200,
                rpc_reply(&body, |m, p| self.robinhood(m, p)).to_string(),
            );
        }
        let path = url
            .strip_prefix(GATEWAY)
            .expect("only the configured gateway is called")
            .to_string();
        self.paths.push(path.clone());
        let s = |v: &Value, k: &str| v[k].as_str().unwrap().to_string();
        let ok = |v: Value| (200, v.to_string());
        match path.as_str() {
            "/v1/swap/aurora/tokens" => ok(json!({"tokens": [
                {"assetId": SRC, "blockchain": "monad", "symbol": "USDC", "decimals": 6, "contractAddress": format!("{MONAD_USDC:#x}")},
                {"assetId": "nep141:eth-usdc", "blockchain": "eth", "symbol": "USDC", "decimals": 6, "contractAddress": format!("{MONAD_USDC:#x}")},
                {"assetId": DST, "blockchain": "hood", "symbol": "USDG", "decimals": 6, "contractAddress": format!("{ROBINHOOD_USDG:#x}")},
            ]})),
            "/v1/swap/monad/prepare-funding" => ok(self.prepare(
                evm::addr(&s(&body, "owner")).unwrap(),
                evm::addr(&s(&body, "recipient")).unwrap(),
                evm::decimal(&s(&body, "amount")).unwrap(),
                now,
            )),
            "/v1/swap/aurora/quote" => {
                let too_small = body["depositType"] == "ORIGIN_CHAIN"
                    && body["recipientType"] == "CONFIDENTIAL_INTENTS"
                    && body["originAsset"] == DST
                    && evm::decimal(body["amount"].as_str().unwrap()).unwrap() < self.bridge_min;
                if too_small {
                    return (
                        422,
                        json!({"code": "AURORA_REJECTED", "message": "Aurora quote rejected the request: Amount is too low for bridge, try at least 75000"}).to_string(),
                    );
                }
                ok(self.quote(body, now))
            }
            "/v1/swap/monad/submit" => {
                let hash = self.submit_operation(&body["userOperation"], now);
                if std::mem::take(&mut self.transient_submit_once) {
                    return (503, String::new());
                }
                ok(json!({"userOperationHash": format!("{hash:#x}")}))
            }
            "/v1/swap/monad/receipt" => ok(if self.credit_ready_ms.is_some() {
                json!({"found": true, "success": true, "transactionHash": "0x01"})
            } else {
                json!({"found": false})
            }),
            "/v1/swap/aurora/status" => {
                let deposit = s(&body, "depositAddress");
                let done = if let Some(t) = self.funded_at.get(&deposit) {
                    now >= *t
                } else if self.deposits.contains_key(&deposit) {
                    self.credited.contains(&deposit)
                } else {
                    self.credit_ready_ms.is_some_and(|t| now >= t)
                };
                if done
                    && self.credited.insert(deposit.clone())
                    && let Some((recipient, _, out, true)) = self.deposits.get(&deposit).cloned()
                {
                    *self.usdg.entry(recipient).or_default() += out;
                }
                ok(json!({"status": if done { "SUCCESS" } else { "PENDING_DEPOSIT" }}))
            }
            "/v1/swap/aurora/auth-salt" => ok(json!({"salt": "252812b3"})),
            "/v1/swap/aurora/authenticate" => {
                assert_eq!(
                    recover_aurora(&s(&body, "payload"), &s(&body, "signature")),
                    self.w.c
                );
                ok(json!({"accessToken": "token"}))
            }
            "/v1/swap/aurora/history" => {
                assert_eq!(body["accessToken"], "token");
                let deposit = body["depositAddress"].as_str().unwrap();
                let Some((request, quoted)) = self.inbound_quotes.get(deposit) else {
                    return ok(json!({"items":[]}));
                };
                let fills = self
                    .fills
                    .values()
                    .filter(|(_, _, _, _, to, _)| {
                        to.to_checksum(None).eq_ignore_ascii_case(deposit)
                    })
                    .collect::<Vec<_>>();
                let input = fills
                    .iter()
                    .fold(U256::ZERO, |sum, (_, _, _, amount, _, _)| sum + *amount);
                let output = input.saturating_sub(U256::from(20));
                ok(
                    json!({"items": if input.is_zero() { vec![] } else { vec![json!({
                    "depositAddress": deposit, "status":"SUCCESS", "depositType":"ORIGIN_CHAIN", "recipientType":"CONFIDENTIAL_INTENTS", "refundType":"ORIGIN_CHAIN",
                    "originAsset":DST, "destinationAsset":SRC, "recipient":request["recipient"], "refundTo":request["refundTo"], "depositMemo":null,
                    "createdAt":iso_string(*quoted), "amountInFormatted":usdc(input), "amountOutFormatted":usdc(output),
                    "quoteTransactions":fills.iter().map(|(hash,_,_,_,_,_)| json!({"sender":format!("{FUSION_SETTLEMENT:#x}"), "txHash":hash})).collect::<Vec<_>>()
                })] }}),
                )
            }
            "/v1/swap/aurora/balances" => ok(json!({"balances": [
                {"tokenId": SRC, "available": self.credit.to_string(), "source": "private"},
                {"tokenId": SRC, "available": "999", "source": "public"},
            ]})),
            "/v1/swap/aurora/generate-intent" => {
                let deposit = s(&body, "depositAddress");
                let (_, amount, _, _) = self.deposits[&deposit];
                let nonce =
                    base64::engine::general_purpose::STANDARD.encode(keccak256(deposit.as_bytes()));
                let payload = json!({
                    "signer_id": s(&body, "signerId"),
                    "verifying_contract": "intents.far",
                    "deadline": iso_string(now + 300_000),
                    "nonce": nonce,
                    "intents": [{"intent": "transfer", "receiver_id": deposit, "tokens": {format!("imt:{}:{SRC}", "ab".repeat(32)): amount.to_string()}}],
                });
                ok(json!({"intent": {"standard": "erc191", "payload": payload.to_string()}}))
            }
            "/v1/swap/aurora/submit-intent" => {
                let signed = &body["signedData"];
                let payload = s(signed, "payload");
                assert_eq!(recover_aurora(&payload, &s(signed, "signature")), self.w.c);
                let message: Value = serde_json::from_str(&payload).unwrap();
                let deposit = s(&message["intents"][0], "receiver_id");
                if self.credited.insert(deposit.clone()) {
                    self.intents += 1;
                    let (recipient, spent, out, dest_usdg) = self.deposits[&deposit];
                    if self.pool_credit {
                        assert!(spent <= self.credit, "a payout spent more than C holds");
                        self.credit -= spent;
                    }
                    if dest_usdg {
                        *self.usdg.entry(recipient).or_default() += out;
                    } else {
                        *self.monad_usdc.entry(recipient).or_default() += out;
                    }
                }
                ok(json!({"intentHash": format!("intent-{deposit}")}))
            }
            "/v1/swap/fusion/preview" => {
                let amount = evm::decimal(&s(&body, "amount")).unwrap();
                let src = body
                    .get("srcToken")
                    .and_then(Value::as_str)
                    .and_then(|t| evm::addr(t).ok())
                    .unwrap_or(ROBINHOOD_USDG);
                if src != ROBINHOOD_USDG && amount < self.dust_below {
                    return (
                        422,
                        json!({"code": "FUSION_REJECTED", "message": "1inch Fusion quote rejected: insufficient amount"}).to_string(),
                    );
                }
                let end = if src == ROBINHOOD_USDG {
                    amount * U256::from(WEI_PER_ATOM)
                } else {
                    amount / U256::from(WEI_PER_ATOM)
                };
                ok(
                    json!({"preset": "fast", "auctionStartAmount": "1", "auctionEndAmount": end.to_string(), "liquidity": {"impactBps": "12", "passes": true}}),
                )
            }
            "/v1/swap/fusion/permit-context" => {
                ok(json!({"name": "Global Dollar", "version": "1", "nonce": "0"}))
            }
            "/v1/swap/fusion/order" => ok(self.order(&body, now)),
            "/v1/swap/fusion/submit" => {
                self.fill(&body);
                (202, json!({"accepted": true}).to_string())
            }
            "/v1/swap/fusion/status" => {
                let hash: B256 = s(&body, "orderHash").parse().unwrap();
                match self.fills.get(&hash) {
                    Some((tx, _, making, _, _, _)) => ok(
                        json!({"status": "filled", "fills": [{"txHash": tx, "filledMakerAmount": making.to_string()}]}),
                    ),
                    None => (404, json!({"code": "FUSION_NOT_FOUND"}).to_string()),
                }
            }
            other => panic!("unexpected gateway path {other}"),
        }
    }

    fn monad(&self, method: &str, params: &Value) -> Value {
        match method {
            "eth_chainId" => json!("0x8f"),
            "eth_getCode" => json!("0x"),
            "eth_getTransactionCount" => json!("0x0"),
            "eth_call" => {
                let data = params[0]["data"].as_str().unwrap();
                if data.starts_with(&evm::encode_call("balanceOf(address)", &[])) {
                    let holder = Address::from_slice(&evm::hex_bytes(data).unwrap()[16..36]);
                    let value = if holder == self.w.f {
                        self.f_balance
                    } else {
                        self.monad_usdc.get(&holder).copied().unwrap_or_default()
                    };
                    json!(word(value))
                } else {
                    json!(word(U256::ZERO))
                }
            }
            _ => panic!("unexpected monad call {method}"),
        }
    }

    fn robinhood(&self, method: &str, params: &Value) -> Value {
        match method {
            "eth_chainId" => json!("0x1237"),
            "eth_getBalance" => json!("0x0"),
            "eth_call" => {
                let data = params[0]["data"].as_str().unwrap();
                let to = evm::addr(params[0]["to"].as_str().unwrap()).unwrap();
                if data == evm::encode_call("symbol()", &[]) {
                    let mut out = vec![];
                    out.extend_from_slice(&evm::word_u256(U256::from(32)));
                    out.extend_from_slice(&evm::word_u256(U256::from(4)));
                    let mut text = [0u8; 32];
                    text[..4].copy_from_slice(b"AMZN");
                    out.extend_from_slice(&text);
                    return json!(hex::encode_prefixed(out));
                }
                if data == evm::encode_call("decimals()", &[]) {
                    return json!(word(U256::from(18)));
                }
                let holder = Address::from_slice(&evm::hex_bytes(data).unwrap()[16..36]);
                let book = if to == ROBINHOOD_USDG {
                    &self.usdg
                } else {
                    &self.target
                };
                json!(word(book.get(&holder).copied().unwrap_or_default()))
            }
            "eth_getTransactionReceipt" => {
                let tx = params[0].as_str().unwrap();
                let (_, maker, making, taking, dest, sell) =
                    self.fills.values().find(|(t, ..)| t == tx).unwrap().clone();
                let topic = keccak256("Transfer(address,address,uint256)");
                let pad = |a: Address| format!("{:#x}", B256::from(evm::word_address(a)));
                if sell {
                    json!({"status": "0x1", "transactionHash":tx, "blockHash":format!("{:#x}", keccak256(b"canonical")), "blockNumber":"0x100", "logs": [
                        {"address": format!("{AMZN:#x}"), "topics": [format!("{topic:#x}"), pad(maker), pad(FUSION_SETTLEMENT)], "data": word(making)},
                        {"address": format!("{ROBINHOOD_USDG:#x}"), "topics": [format!("{topic:#x}"), pad(FUSION_SETTLEMENT), pad(dest)], "data": word(taking)},
                    ]})
                } else {
                    json!({"status": "0x1", "transactionHash":tx, "blockHash":format!("{:#x}", keccak256(b"canonical")), "blockNumber":"0x100", "logs": [
                        {"address": format!("{ROBINHOOD_USDG:#x}"), "topics": [format!("{topic:#x}"), pad(maker), pad(FUSION_SETTLEMENT)], "data": word(making)},
                        {"address": format!("{AMZN:#x}"), "topics": [format!("{topic:#x}"), pad(FUSION_SETTLEMENT), pad(maker)], "data": word(taking)},
                    ]})
                }
            }
            _ => panic!("unexpected robinhood call {method}"),
        }
    }

    fn prepare(&mut self, owner: Address, recipient: Address, amount: U256, now: u64) -> Value {
        self.last_deposit = Some(recipient.to_checksum(None));
        let recipient = if self.tamper == Tamper::FundingRecipient {
            address!("0x00000000000000000000000000000000000BAd00")
        } else {
            recipient
        };
        let mut data = vec![0u8; 182];
        data[0] = 0x02;
        data[2..8].copy_from_slice(&(now / 1000 + self.paymaster_valid_for).to_be_bytes()[2..]);
        data[8..14].copy_from_slice(&self.paymaster_valid_after.to_be_bytes()[2..]);
        data[14..34].copy_from_slice(MONAD_USDC.as_slice());
        data[50..82].copy_from_slice(&U256::from(100_000u64).to_be_bytes::<32>());
        let approve = evm::hex_bytes(&evm::encode_call(
            "approve(address,uint256)",
            &[
                evm::word_address(PIMLICO_ERC20_PAYMASTER),
                evm::word_u256(U256::from(
                    self.funding_fee.saturating_add_signed(self.approve_delta),
                )),
            ],
        ))
        .unwrap();
        let transfer = evm::hex_bytes(&evm::encode_call(
            "transfer(address,uint256)",
            &[evm::word_address(recipient), evm::word_u256(amount)],
        ))
        .unwrap();
        json!({
            "userOperation": {
                "sender": owner.to_checksum(None),
                "nonce": "0x0",
                "factory": "0x7702",
                "factoryData": "0x",
                "callData": hex::encode_prefixed(execute_batch(&[approve, transfer])),
                "callGasLimit": "0x186a0",
                "verificationGasLimit": "0xc350",
                "preVerificationGas": "0x186a0",
                "maxFeePerGas": format!("0x{:x}", self.funding_fee * 100_000_000_000 / FEE),
                "maxPriorityFeePerGas": "0x3b9aca00",
                "paymaster": PIMLICO_ERC20_PAYMASTER.to_checksum(None),
                "paymasterVerificationGasLimit": "0x61a8",
                "paymasterPostOpGasLimit": "0x61a8",
                "paymasterData": hex::encode_prefixed(data),
            },
            "authorization": {"chainId": 143, "address": SIMPLE_7702.to_checksum(None), "nonce": 0},
            "feeCapAtoms": self.funding_fee.to_string(),
        })
    }

    fn quote(&mut self, request: Value, now: u64) -> Value {
        let amount = evm::decimal(request["amount"].as_str().unwrap()).unwrap();
        let dest_usdg = request["destinationAsset"] == DST;
        let destination = request["recipientType"] == "DESTINATION_CHAIN";
        let (deposit, out) = if request["depositType"] == "ORIGIN_CHAIN" {
            let out = if destination {
                amount * U256::from(self.payout_rate_bps) / U256::from(10_000)
            } else {
                (amount - U256::from(20)) * U256::from(self.funding_credit_bps) / U256::from(10_000)
            };
            if self.pool_credit && !destination {
                self.credit += out;
            } else {
                self.credit = out;
            }
            let recipient = request["recipient"].as_str().unwrap_or_default();
            let refund = request["refundTo"].as_str().unwrap_or_default();
            let mut seed = amount.to_be_bytes::<32>().to_vec();
            seed.extend_from_slice(recipient.as_bytes());
            seed.extend_from_slice(refund.as_bytes());
            let deposit = Address::from_slice(&keccak256(&seed)[12..]).to_checksum(None);
            if let Ok(holder) = evm::addr(refund) {
                self.origin_deposit.insert(holder, deposit.clone());
            }
            if destination && let Ok(to) = evm::addr(recipient) {
                self.deposits
                    .insert(deposit.clone(), (to, amount, out, dest_usdg));
            }
            if request["originAsset"] == DST && request["recipientType"] == "CONFIDENTIAL_INTENTS" {
                self.inbound_quotes
                    .insert(deposit.clone(), (request.clone(), now));
            }
            (deposit, out)
        } else {
            let deposit = format!("payout-{}", self.deposits.len());
            let out = amount * U256::from(self.payout_rate_bps) / U256::from(10_000);
            self.deposits.insert(
                deposit.clone(),
                (
                    evm::addr(request["recipient"].as_str().unwrap()).unwrap(),
                    amount,
                    out,
                    dest_usdg,
                ),
            );
            (deposit, out)
        };
        let mut echoed = request.clone();
        if self.tamper == Tamper::QuoteRefund {
            echoed["refundTo"] = json!("0x00000000000000000000000000000000000BAd00");
        }
        // Mainnet shape: refunds start 15 minutes after the quote; the address stays open for 3 days.
        echoed["deadline"] = json!(iso_string(now + 15 * 60_000));
        json!({
            "quoteRequest": echoed,
            "signature": "ed25519:quote",
            "quote": {"depositAddress": deposit, "amountIn": amount.to_string(), "amountOut": out.to_string(), "minAmountOut": (out * U256::from(99) / U256::from(100)).to_string(), "deadline": iso_string(now + 3 * 86_400_000)},
        })
    }

    fn submit_operation(&mut self, rpc: &Value, now: u64) -> B256 {
        let mut fields = rpc.clone();
        let object = fields.as_object_mut().unwrap();
        let signature =
            evm::hex_bytes(object.remove("signature").unwrap().as_str().unwrap()).unwrap();
        let auth = object
            .remove("eip7702Auth")
            .expect("a fresh F needs its 7702 authorization");
        let op: UserOperation = serde_json::from_value(fields).unwrap();
        let unsigned = UnsignedAuthorization {
            chain_id: 143,
            address: SIMPLE_7702,
            nonce: 0,
        };
        let hash = funding::user_operation_hash(&op, Some(&unsigned)).unwrap();
        assert_eq!(
            recover_raw(hash, &signature[..64], signature[64] - 27),
            self.w.f
        );
        let word = |k: &str| evm::hex_bytes(auth[k].as_str().unwrap()).unwrap();
        let parity = word("yParity")[0];
        assert_eq!(
            recover_raw(
                evm::authorization_hash(143, SIMPLE_7702, 0),
                &[word("r"), word("s")].concat(),
                parity
            ),
            self.w.f
        );
        self.user_ops += 1;
        self.credit_ready_ms
            .get_or_insert(now + self.credit_delay_ms);
        if let Some(deposit) = self.last_deposit.clone() {
            self.funded_at
                .entry(deposit)
                .or_insert(now + self.credit_delay_ms);
        }
        hash
    }

    fn order(&mut self, body: &Value, now: u64) -> Value {
        let wallet = evm::addr(body["wallet"].as_str().unwrap()).unwrap();
        let amount = evm::decimal(body["amount"].as_str().unwrap()).unwrap();
        let permit = evm::hex_bytes(body["permit"].as_str().unwrap()).unwrap();
        let src = body
            .get("srcToken")
            .and_then(Value::as_str)
            .and_then(|t| evm::addr(t).ok())
            .unwrap_or(ROBINHOOD_USDG);
        let dst = evm::addr(body["dstToken"].as_str().unwrap()).unwrap();
        let sell = src != ROBINHOOD_USDG;
        let taking = if sell {
            amount / U256::from(WEI_PER_ATOM)
        } else {
            amount * U256::from(WEI_PER_ATOM)
        };
        let taking = if self.short_orders > 0 {
            self.short_orders -= 1;
            taking * U256::from(97) / U256::from(100)
        } else {
            taking
        };
        let receiver = if sell {
            // The provider only knows the request, not the engine's private quote state.
            let receiver = body
                .get("receiver")
                .and_then(Value::as_str)
                .expect("sell must send its bridge receiver");
            // Aurora sells deliver to the quoted deposit.
            if let Some(deposit) = self.origin_deposit.get(&wallet) {
                assert_eq!(evm::addr(receiver).unwrap(), evm::addr(deposit).unwrap());
            }
            if self.tamper == Tamper::OrderTopReceiver {
                format!(
                    "{:#x}",
                    address!("0x00000000000000000000000000000000000BAd00")
                )
            } else if self.tamper == Tamper::OrderReceiver {
                // The receiver is only named inside the post-interaction, and names someone else.
                format!("{FUSION_SETTLEMENT:#x}")
            } else {
                receiver.to_string()
            }
        } else {
            format!("{FUSION_SETTLEMENT:#x}")
        };
        let mut amount_data = FUSION_SETTLEMENT.as_slice().to_vec();
        amount_data.extend_from_slice(&[0x11; 8]);
        let mut permit_field = src.as_slice().to_vec();
        permit_field.extend_from_slice(&permit);
        let mut post = FUSION_SETTLEMENT.as_slice().to_vec();
        if self.tamper == Tamper::OrderReceiver {
            post.push(1);
            post.extend_from_slice(&[0; 40]);
            post.extend_from_slice(
                address!("0x00000000000000000000000000000000000BAd00").as_slice(),
            );
        } else {
            post.push(0);
            post.extend_from_slice(&[0; 40]);
        }
        post.extend_from_slice(&[0; 6 + 5 + 33]);
        let fields: [&[u8]; 8] = [
            &[],
            &[],
            &amount_data,
            &amount_data,
            &[],
            &permit_field,
            &[],
            &post,
        ];
        let (mut offsets, mut end, mut ext) = (U256::ZERO, 0u64, vec![]);
        for (i, f) in fields.iter().enumerate() {
            end += f.len() as u64;
            offsets |= U256::from(end) << (32 * i);
        }
        ext.extend_from_slice(&offsets.to_be_bytes::<32>());
        fields.iter().for_each(|f| ext.extend_from_slice(f));
        let mask = (U256::from(1) << 160) - U256::from(1);
        let salt: U256 =
            (U256::from(0x1234u64) << 160usize) | (U256::from_be_bytes(keccak256(&ext).0) & mask);
        let traits: U256 = (U256::from(1) << 249usize) | (U256::from(now / 1000 + 180) << 80usize);
        let order = LimitOrder {
            salt: salt.to_string(),
            maker: format!("{wallet:#x}"),
            receiver,
            maker_asset: format!("{src:#x}"),
            taker_asset: format!("{dst:#x}"),
            making_amount: amount.to_string(),
            taking_amount: taking.to_string(),
            maker_traits: traits.to_string(),
        };
        let hash = fusion::order_hash(&order).unwrap();
        self.permits.insert(hash, permit);
        json!({"orderHash": format!("{hash:#x}"), "quoteId": "quote-1", "order": order, "extension": hex::encode_prefixed(ext)})
    }

    fn fill(&mut self, body: &Value) {
        let order: LimitOrder = serde_json::from_value(body["order"].clone()).unwrap();
        let hash = fusion::order_hash(&order).unwrap();
        let maker = evm::addr(&order.maker).unwrap();
        let signature = evm::hex_bytes(body["signature"].as_str().unwrap()).unwrap();
        assert_eq!(
            recover_raw(hash, &signature[..64], signature[64] - 27),
            maker
        );
        let permit = &self.permits[&hash];
        let words = |i: usize| U256::from_be_slice(&permit[i * 32..i * 32 + 32]);
        let token = evm::addr(&order.maker_asset).unwrap();
        let digest = Permit {
            name: "Global Dollar".into(),
            version: "1".into(),
            token,
            owner: maker,
            value: words(2),
            nonce: U256::ZERO,
            deadline: words(3).to(),
        }
        .digest()
        .unwrap();
        assert_eq!(
            recover_raw(digest, &permit[160..224], words(4).to::<u8>() - 27),
            maker
        );
        let (mut making, mut taking) = (
            evm::decimal(&order.making_amount).unwrap(),
            evm::decimal(&order.taking_amount).unwrap(),
        );
        if token != ROBINHOOD_USDG && std::mem::take(&mut self.partial_fill_once) {
            making /= U256::from(2);
            taking /= U256::from(2);
        }
        let dest = evm::addr(&order.receiver).unwrap();
        let sell = token != ROBINHOOD_USDG;
        if !self.fills.contains_key(&hash) {
            self.orders += 1;
            if sell {
                *self.target.get_mut(&maker).unwrap() -= making;
                *self.delivered.entry(dest).or_default() += taking;
            } else {
                *self.usdg.get_mut(&maker).unwrap() -= making;
                *self.target.entry(maker).or_default() += taking;
            }
            self.fills.insert(
                hash,
                (
                    format!("{:#x}", keccak256(hash)),
                    maker,
                    making,
                    taking,
                    dest,
                    sell,
                ),
            );
        }
    }
}

fn word(v: U256) -> String {
    hex::encode_prefixed(v.to_be_bytes::<32>())
}

fn rpc_reply(batch: &Value, mut f: impl FnMut(&str, &Value) -> Value) -> Value {
    Value::Array(batch.as_array().unwrap().iter().map(|call| json!({"jsonrpc": "2.0", "id": call["id"], "result": f(call["method"].as_str().unwrap(), &call["params"])})).collect())
}

fn execute_batch(calls: &[Vec<u8>]) -> Vec<u8> {
    let mut out = evm::selector("executeBatch((address,uint256,bytes)[])").to_vec();
    out.extend_from_slice(&evm::word_u256(U256::from(32)));
    out.extend_from_slice(&evm::word_u256(U256::from(calls.len())));
    let tuples: Vec<Vec<u8>> = calls
        .iter()
        .map(|data| {
            let mut t = evm::word_address(MONAD_USDC).to_vec();
            t.extend_from_slice(&[0; 32]);
            t.extend_from_slice(&evm::word_u256(U256::from(96)));
            t.extend_from_slice(&evm::word_u256(U256::from(data.len())));
            t.extend_from_slice(data);
            t.resize(t.len().div_ceil(32) * 32, 0);
            t
        })
        .collect();
    let mut offset = 32 * calls.len();
    for t in &tuples {
        out.extend_from_slice(&evm::word_u256(U256::from(offset)));
        offset += t.len();
    }
    tuples.iter().for_each(|t| out.extend_from_slice(t));
    out
}

fn recover_raw(digest: B256, rs: &[u8], parity: u8) -> Address {
    evm::recover(
        digest,
        rs[..32].try_into().unwrap(),
        rs[32..64].try_into().unwrap(),
        parity,
    )
    .unwrap()
}

fn recover_aurora(payload: &str, signature: &str) -> Address {
    let raw = bs58::decode(signature.strip_prefix("secp256k1:").unwrap())
        .into_vec()
        .unwrap();
    recover_raw(evm::personal_hash(payload.as_bytes()), &raw[..64], raw[64])
}

fn plan(amount: Option<&str>) -> String {
    let mut p = json!({"kind": "confidentialSwap", "target": AMZN.to_checksum(None), "recipientIndices": [3, 4, 5]});
    if let Some(a) = amount {
        p["amountAtoms"] = json!(a);
    }
    p.to_string()
}

fn start(amount: Option<&str>) -> Arc<SwapOperation> {
    SwapOperation::start(plan(amount), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap()
}

#[test]
fn restored_review_requires_native_unlock_before_approval() {
    let op = start(None);
    let mut world = World::new();
    let mut now = T0;
    let original_review = review(&op, &mut world, &mut now);
    let restored = SwapOperation::restore(op.export_state().unwrap(), GATEWAY.into()).unwrap();
    assert_eq!(
        restored.next_step(now).unwrap(),
        SwapStep::Review {
            text: original_review
        }
    );
    assert!(
        restored.approve(now).is_err(),
        "restoring must not restore signing authority"
    );
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    restored.approve(now).unwrap();
    assert!(matches!(
        restored.next_step(now).unwrap(),
        SwapStep::Request { .. }
    ));
}

/// Runs requests and waits until the machine needs the user, finishes or pauses.
fn drive(op: &SwapOperation, world: &mut World, now: &mut u64) -> SwapStep {
    drive_until(op, world, now, |_| false)
}

fn drive_until(
    op: &SwapOperation,
    world: &mut World,
    now: &mut u64,
    stop: impl Fn(&str) -> bool,
) -> SwapStep {
    for _ in 0..20_000 {
        match op.next_step(*now).unwrap() {
            SwapStep::Request {
                id,
                method,
                url,
                body,
            } => {
                if stop(&url) {
                    return SwapStep::Request {
                        id,
                        method,
                        url,
                        body,
                    };
                }
                let (status, reply) = world.handle(&url, body.as_deref(), *now);
                *now += 250;
                let _ = op.on_response(id, status, reply, *now);
            }
            SwapStep::Wait { millis } => *now += millis,
            other => return other,
        }
    }
    panic!("the operation never settled");
}

fn review(op: &SwapOperation, world: &mut World, now: &mut u64) -> String {
    match drive(op, world, now) {
        SwapStep::Review { text } => text,
        other => panic!("expected the review, got {other:?}"),
    }
}

fn status(op: &SwapOperation) -> Value {
    serde_json::from_str(&op.public_status()).unwrap()
}

#[test]
fn plans_reviews_and_completes_the_whole_swap_with_the_expected_signers() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    let text = review(&op, &mut world, &mut now);
    assert!(text.contains("CONFIDENTIAL SWAP · MAINNET"));
    assert!(text.contains("PRIVACY"));
    assert!(text.contains("AMZN (18 decimals)"));
    assert!(text.contains(&world.w.f.to_checksum(None)));
    assert!(text.contains("Used now 1.997000 USDC + gas at most 0.003000 USDC"));
    assert_eq!(
        world.user_ops + world.intents + world.orders,
        0,
        "nothing is signed before approval"
    );
    assert_eq!(status(&op)["phase"], "REVIEW");

    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!((world.user_ops, world.intents, world.orders), (1, 3, 3));
    for a in world.w.a {
        assert!(world.usdg[&a].is_zero());
        assert!(!world.target[&a].is_zero());
    }
    // A buy funds C once; every USDG payout leaves from C, never through a public bridge.
    assert!(
        world.deposits.keys().all(|d| d.starts_with("payout-")),
        "a buy never quotes a public bridge"
    );

    let s = status(&op);
    assert_eq!(s["phase"], "COMPLETE");
    assert_eq!(s["ordersComplete"], 3);
    assert_eq!(s["targetSymbol"], "AMZN");
    let total: U256 = world
        .w
        .a
        .iter()
        .map(|a| world.target[a])
        .fold(U256::ZERO, |x, y| x + y);
    assert_eq!(s["receivedTargetAtoms"], total.to_string());
    let public = op.public_status().to_lowercase();
    for a in [
        world.w.f,
        world.w.c,
        world.w.a[0],
        world.w.a[1],
        world.w.a[2],
    ] {
        assert!(
            !public.contains(&format!("{a:#x}")[2..]),
            "public status leaks a wallet"
        );
    }
}

#[test]
fn rejects_invalid_plans_and_preserves_an_explicit_production_budget() {
    assert!(
        SwapOperation::start(
            plan(Some("18446744073709551616")),
            ENTROPY.to_vec(),
            GATEWAY.into(),
            T0
        )
        .is_err()
    );
    assert!(SwapOperation::start(plan(Some("0")), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
    let reused = plan(None).replace("[3,4,5]", "[3,3,5]");
    assert!(SwapOperation::start(reused, ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
    let app_account = plan(None).replace("[3,4,5]", "[0,4,5]");
    assert!(SwapOperation::start(app_account, ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
    assert!(
        SwapOperation::start(
            plan(None),
            ENTROPY.to_vec(),
            "http://gateway.test".into(),
            T0
        )
        .is_err()
    );

    let (mut world, mut now) = (World::new(), T0);
    world.f_balance = U256::from(50_000_000u64);
    let text = review(&start(Some("50000000")), &mut world, &mut now);
    assert!(text.contains("Used now 49.997000 USDC + gas at most 0.003000 USDC"));
}

#[test]
fn an_expired_authorization_asks_for_the_same_wallets_again() {
    let (mut world, mut now) = (World::new(), T0);
    world.credit_delay_ms = 20 * 60_000;
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Unlock);
    assert_eq!(status(&op)["phase"], "CREDITED");
    assert_eq!(world.user_ops, 1);
    assert!(
        op.unlock(vec![8; 32], now).is_err(),
        "another seed must not continue this plan"
    );
    op.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!((world.user_ops, world.intents, world.orders), (1, 3, 3));
}

#[test]
fn restores_without_a_seed_and_needs_an_unlock_before_approval() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    let state = op.export_state().unwrap();
    assert!(!state.contains("seed") && !state.contains("entropy"));

    let restored = SwapOperation::restore(state, GATEWAY.into()).unwrap();
    assert_eq!(restored.operation_id(), op.operation_id());
    assert!(matches!(
        restored.next_step(now).unwrap(),
        SwapStep::Review { .. }
    ));
    assert!(matches!(restored.approve(now), Err(SignerError::Expired)));
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    restored.approve(now).unwrap();
    assert!(restored.approve(now).is_err(), "approval is one-shot");
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
}

#[test]
fn a_lost_submission_is_looked_up_and_never_signed_again() {
    let (mut world, mut now) = (World::new(), T0);
    world.transient_submit_once = true;
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.user_ops, 1);
    assert_eq!(
        world
            .paths
            .iter()
            .filter(|p| *p == "/v1/swap/monad/submit")
            .count(),
        1
    );
}

#[test]
fn a_crash_after_sending_resumes_at_the_status_lookup() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    let SwapStep::Request { url, body, .. } = drive_until(&op, &mut world, &mut now, |u| {
        u.ends_with("/v1/swap/monad/submit")
    }) else {
        panic!()
    };
    world.handle(&url, body.as_deref(), now);
    let state = op.export_state().unwrap();

    let restored = SwapOperation::restore(state, GATEWAY.into()).unwrap();
    let SwapStep::Request { url, .. } = restored.next_step(now).unwrap() else {
        panic!()
    };
    assert!(url.ends_with("/v1/swap/monad/receipt"));
    restored.cancel();
    assert_eq!(
        restored.next_step(now).unwrap(),
        SwapStep::Paused {
            code: "CANCELLED".into()
        }
    );
    assert!(restored.unlock(ENTROPY.to_vec(), now).is_err());
}

#[test]
fn a_worse_payout_quote_needs_a_new_approval_and_uses_the_shown_quote() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    world.payout_rate_bps = 9_000;
    let SwapStep::Review { text } = drive(&op, &mut world, &mut now) else {
        panic!("expected a re-approval")
    };
    assert!(text.starts_with("QUOTE CHANGED OUTSIDE THE APPROVED LIMITS"));
    assert_eq!(status(&op)["phase"], "REVIEW");
    assert_eq!(world.intents, 0);
    let quotes = world.deposits.len();
    op.approve(now).unwrap();
    let SwapStep::Request { url, .. } = op.next_step(now).unwrap() else {
        panic!()
    };
    assert!(url.ends_with("/v1/swap/aurora/generate-intent"));
    assert_eq!(
        world.deposits.len(),
        quotes,
        "the approved quote is used, not a new one"
    );
}

#[test]
fn reapproved_quotes_carry_the_operation_to_completion() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    world.payout_rate_bps = 9_000;
    let mut reapprovals = 0;
    let last = loop {
        match drive(&op, &mut world, &mut now) {
            SwapStep::Review { .. } if reapprovals < 3 => {
                op.approve(now).unwrap();
                reapprovals += 1;
            }
            other => break other,
        }
    };
    assert_eq!(last, SwapStep::Finished);
    assert_eq!(reapprovals, 3);
    assert_eq!((world.intents, world.orders), (3, 3));
}

#[test]
fn a_funding_operation_that_pays_someone_else_is_never_signed() {
    let (mut world, mut now) = (World::new(), T0);
    world.tamper = Tamper::FundingRecipient;
    let op = start(Some("2000000"));
    let SwapStep::Paused { code } = drive(&op, &mut world, &mut now) else {
        panic!()
    };
    assert_eq!(code, "REJECTED_fundingPrepare");
    assert!(op.approve(now).is_err());
    assert_eq!(world.user_ops, 0);
}

#[test]
fn a_quote_with_a_foreign_refund_address_pauses_planning() {
    let (mut world, mut now) = (World::new(), T0);
    world.tamper = Tamper::QuoteRefund;
    let op = start(Some("2000000"));
    assert_eq!(
        drive(&op, &mut world, &mut now),
        SwapStep::Paused {
            code: "REJECTED_fundingQuote".into()
        }
    );
    assert_eq!(status(&op)["phase"], "PAUSED");
}

#[test]
fn a_fusion_order_paying_another_receiver_is_never_signed() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    world.tamper = Tamper::OrderReceiver;
    assert_eq!(
        drive(&op, &mut world, &mut now),
        SwapStep::Paused {
            code: "FUSION_1_ORDER_RECEIVER".into()
        }
    );
    assert_eq!((world.user_ops, world.intents, world.orders), (1, 3, 0));
    assert!(!world.paths.iter().any(|p| p == "/v1/swap/fusion/submit"));
}

#[test]
fn an_empty_funding_wallet_waits_for_a_deposit() {
    let (mut world, mut now) = (World::new(), T0);
    world.f_balance = U256::ZERO;
    let op = start(None);
    assert_eq!(
        drive(&op, &mut world, &mut now),
        SwapStep::Paused {
            code: "AWAITING_DEPOSIT".into()
        }
    );
    world.f_balance = U256::from(1_500_000u64);
    op.retry();
    let text = review(&op, &mut world, &mut now);
    assert!(text.contains("Used now 1.497000 USDC"));
}

fn sell_plan(holders: [u32; 3], recipients: [u32; 3]) -> String {
    json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None), "holderIndices": holders, "recipientIndices": recipients}).to_string()
}

#[test]
fn sell_rejects_reused_or_overlapping_indices() {
    assert!(
        SwapOperation::start(
            sell_plan([3, 4, 5], [3, 6, 7]),
            ENTROPY.to_vec(),
            GATEWAY.into(),
            T0
        )
        .is_err()
    );
    assert!(
        SwapOperation::start(
            sell_plan([3, 4, 5], [6, 7, 8]).replace("confidentialSell", "confidentialSwap"),
            ENTROPY.to_vec(),
            GATEWAY.into(),
            T0
        )
        .is_err()
    );
    assert!(
        SwapOperation::start(
            plan(Some("2000000")).replace("}", r#","holderIndices":[6,7,8]}"#),
            ENTROPY.to_vec(),
            GATEWAY.into(),
            T0
        )
        .is_err()
    );
    let op = SwapOperation::start(
        sell_plan([3, 4, 5], [6, 7, 8]),
        ENTROPY.to_vec(),
        GATEWAY.into(),
        T0,
    )
    .unwrap();
    assert_eq!(status(&op)["direction"], "sell");
}

#[test]
fn sells_stock_into_three_fresh_monad_wallets() {
    let (mut world, mut now) = (World::new(), T0);
    let buy = start(Some("2000000"));
    review(&buy, &mut world, &mut now);
    buy.approve(now).unwrap();
    assert_eq!(drive(&buy, &mut world, &mut now), SwapStep::Finished);
    assert!(world.w.a.iter().all(|a| !world.target[a].is_zero()));

    let op = SwapOperation::start(
        sell_plan([3, 4, 5], [6, 7, 8]),
        ENTROPY.to_vec(),
        GATEWAY.into(),
        T0,
    )
    .unwrap();
    let text = review(&op, &mut world, &mut now);
    assert!(text.contains("CONFIDENTIAL SELL · MAINNET"));
    assert!(text.contains("three new Monad USDC wallets"));
    let seed = seed_from_entropy(ENTROPY.to_vec()).unwrap();
    let ret = |i| evm::key_address(&derive_key(&seed, i).unwrap());
    for i in [6u32, 7, 8] {
        assert!(text.contains(&ret(i).to_checksum(None)));
    }
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(status(&op)["phase"], "COMPLETE");
    assert_eq!(status(&op)["direction"], "sell");
    assert_eq!(status(&op)["ordersComplete"], 3);
    for a in world.w.a {
        assert!(world.target[&a].is_zero());
    }
    for i in [6u32, 7, 8] {
        assert!(
            !world.monad_usdc[&ret(i)].is_zero(),
            "return wallet {i} stays empty"
        );
    }
}

#[test]
fn a_bounded_approval_above_the_final_fee_is_accepted() {
    for delta in [0i64, 4] {
        let (mut world, mut now) = (World::new(), T0);
        world.approve_delta = delta;
        let op = start(Some("2000000"));
        review(&op, &mut world, &mut now);
        op.approve(now).unwrap();
        assert_eq!(
            drive(&op, &mut world, &mut now),
            SwapStep::Finished,
            "approve off by {delta}"
        );
        assert_eq!(world.user_ops, 1);
    }
}

#[test]
fn an_approval_far_from_the_fee_is_never_signed() {
    for delta in [-1i64, -4, -(FEE as i64) / 10, FEE as i64 / 10] {
        let (mut world, mut now) = (World::new(), T0);
        world.approve_delta = delta;
        let op = start(Some("2000000"));
        assert_eq!(
            drive(&op, &mut world, &mut now),
            SwapStep::Paused {
                code: if delta < 0 {
                    "TOKEN_PAYMASTER_ALLOWANCE_LOW"
                } else {
                    "GAS_APPROVAL_UNSTABLE"
                }
                .into()
            },
            "approve off by {delta}"
        );
        assert_eq!(world.user_ops, 0);
    }
}

#[test]
fn a_funding_quote_near_its_refund_deadline_is_requoted_before_the_deposit() {
    let quotes = |world: &World| {
        world
            .paths
            .iter()
            .filter(|p| *p == "/v1/swap/aurora/quote")
            .count()
    };
    let (mut fresh, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut fresh, &mut now);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut fresh, &mut now), SwapStep::Finished);

    // The user takes six minutes to approve: the planning quote has nine of its fifteen left.
    let (mut slow, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut slow, &mut now);
    now += 6 * 60_000;
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut slow, &mut now), SwapStep::Finished);
    assert_eq!(
        quotes(&slow),
        quotes(&fresh) + 1,
        "the funding quote is renewed once"
    );
    assert_eq!(slow.user_ops, 1);
}

fn payout_plan() -> String {
    json!({"kind": "confidentialPayout", "target": AMZN.to_checksum(None), "recipientIndices": [3, 4, 5]}).to_string()
}

#[test]
fn public_funded_buy_preserves_existing_earn_private_cash() {
    let (mut world, mut now) = (World::new(), T0);
    let existing = U256::from(6_000_000u64);
    world.credit = existing;
    world.pool_credit = true;
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(
        world.credit,
        existing + U256::from(19_970u64),
        "existing cash plus execution surplus must stay private"
    );
}

#[test]
fn buys_from_an_existing_private_balance_without_touching_monad() {
    let (mut world, mut now) = (World::new(), T0);
    world.credit = U256::from(3_945_530u64);
    let op = SwapOperation::start(payout_plan(), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap();
    let text = review(&op, &mut world, &mut now);
    assert!(text.contains("CONFIDENTIAL BUY FROM PRIVATE BALANCE"));
    assert!(text.contains("Nothing is sent from Monad"));
    assert!(text.contains("Used now 3.945530 USDC"));
    assert!(text.contains(&world.w.c.to_checksum(None)));
    assert_eq!(status(&op)["phase"], "REVIEW");
    assert_eq!(
        world.user_ops + world.intents + world.orders,
        0,
        "only the ownership proof is signed before approval"
    );
    assert!(
        !world.paths.iter().any(|p| p.starts_with("/v1/swap/monad/")),
        "a payout never prepares Monad funding"
    );

    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!((world.user_ops, world.intents, world.orders), (0, 3, 3));
    assert!(!world.paths.iter().any(|p| p.starts_with("/v1/swap/monad/")));
    let sent: U256 = world
        .deposits
        .iter()
        .filter(|(d, _)| world.credited.contains(*d))
        .map(|(_, (_, amount, _, _))| *amount)
        .fold(U256::ZERO, |a, b| a + b);
    assert_eq!(
        sent,
        U256::from(3_945_530u64),
        "the three payouts split exactly the private balance"
    );
    for a in world.w.a {
        assert!(!world.target[&a].is_zero());
    }
    assert_eq!(status(&op)["phase"], "COMPLETE");
}

#[test]
fn a_payout_with_an_empty_private_balance_pauses_before_review() {
    let (mut world, mut now) = (World::new(), T0);
    let op = SwapOperation::start(payout_plan(), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap();
    assert_eq!(
        drive(&op, &mut world, &mut now),
        SwapStep::Paused {
            code: "NO_PRIVATE_BALANCE".into()
        }
    );
    assert_eq!(world.intents, 0);
}

#[test]
fn a_payout_plan_takes_no_amount_or_holders() {
    let with_amount = payout_plan().replace("}", r#","amountAtoms":"1000000"}"#);
    assert!(SwapOperation::start(with_amount, ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
    let with_holders = payout_plan().replace("}", r#","holderIndices":[6,7,8]}"#);
    assert!(SwapOperation::start(with_holders, ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
}

#[test]
fn an_order_under_the_minimum_is_previewed_again_and_never_signed_short() {
    let (mut world, mut now) = (World::new(), T0);
    world.short_orders = 2;
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 3, "every leg still fills once");
    let previews = world
        .paths
        .iter()
        .filter(|p| *p == "/v1/swap/fusion/preview")
        .count();
    assert_eq!(
        previews,
        1 + 3 + 2,
        "planning, one per leg, one per short draft"
    );
}

#[test]
fn an_order_that_stays_under_the_minimum_pauses_with_its_reason() {
    let (mut world, mut now) = (World::new(), T0);
    world.short_orders = u8::MAX;
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    assert_eq!(
        drive(&op, &mut world, &mut now),
        SwapStep::Paused {
            code: "FUSION_1_ORDER_BELOW_MINIMUM".into()
        }
    );
    assert_eq!(world.orders, 0);
    assert!(!world.paths.iter().any(|p| p == "/v1/swap/fusion/submit"));
}

fn recovery_plan(scan_to: u32) -> String {
    json!({"kind": "confidentialRecovery", "target": AMZN.to_checksum(None), "recipientIndices": [3, 4, 5], "scanTo": scan_to}).to_string()
}

#[test]
fn recovery_finishes_buys_for_wallets_an_earlier_operation_left_holding_usdg() {
    let (mut world, mut now) = (World::new(), T0);
    let seed = seed_from_entropy(ENTROPY.to_vec()).unwrap();
    let at = |i| evm::key_address(&derive_key(&seed, i).unwrap());
    // Indices 9-11 were one earlier operation: leg 1 filled, legs 2 and 3 still hold USDG.
    world.usdg.insert(at(10), U256::from(1_027_014u64));
    world.usdg.insert(at(11), U256::from(1_419_357u64));
    let op = SwapOperation::start(recovery_plan(15), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap();
    let text = review(&op, &mut world, &mut now);
    assert!(text.contains("FINISH UNFINISHED BUYS"));
    assert!(text.contains("Nothing is sent from Monad or from the confidential balance"));
    assert!(text.contains(&format!(
        "Wallet {}\n  1.027014 USDG → AMZN",
        at(10).to_checksum(None)
    )));
    assert!(text.contains(&format!(
        "Wallet {}\n  1.419357 USDG → AMZN",
        at(11).to_checksum(None)
    )));
    assert_eq!(world.orders, 0, "nothing is signed before approval");

    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!((world.user_ops, world.intents, world.orders), (0, 0, 2));
    for i in [10, 11] {
        assert!(world.usdg[&at(i)].is_zero());
        assert!(!world.target[&at(i)].is_zero());
    }
    assert!(!world.paths.iter().any(|p| p.starts_with("/v1/swap/monad/")
        || p.contains("aurora/quote")
        || p.contains("intent")));
    assert_eq!(status(&op)["phase"], "COMPLETE");
}

#[test]
fn recovery_with_nothing_left_pauses_before_review() {
    let (mut world, mut now) = (World::new(), T0);
    let op = SwapOperation::start(recovery_plan(15), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap();
    assert_eq!(
        drive(&op, &mut world, &mut now),
        SwapStep::Paused {
            code: "NOTHING_TO_RECOVER".into()
        }
    );
}

#[test]
fn only_recovery_scans_and_only_allocated_indices() {
    assert!(SwapOperation::start(recovery_plan(5), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
    assert!(
        SwapOperation::start(
            plan(None).replace("}", r#","scanTo":15}"#),
            ENTROPY.to_vec(),
            GATEWAY.into(),
            T0
        )
        .is_err()
    );
    let without = json!({"kind": "confidentialRecovery", "target": AMZN.to_checksum(None), "recipientIndices": [3, 4, 5]}).to_string();
    assert!(SwapOperation::start(without, ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
}

#[test]
fn a_paused_sell_receiver_mismatch_can_resume_without_repeating_the_buy() {
    let (mut world, mut now) = (World::new(), T0);
    let buy = start(Some("2000000"));
    review(&buy, &mut world, &mut now);
    buy.approve(now).unwrap();
    assert_eq!(drive(&buy, &mut world, &mut now), SwapStep::Finished);
    let sell = SwapOperation::start(
        sell_plan([3, 4, 5], [6, 7, 8]),
        ENTROPY.to_vec(),
        GATEWAY.into(),
        now,
    )
    .unwrap();
    review(&sell, &mut world, &mut now);
    sell.approve(now).unwrap();
    let SwapStep::Request { id, url, body, .. } = drive_until(&sell, &mut world, &mut now, |url| {
        url.ends_with("/fusion/order")
    }) else {
        panic!()
    };
    let (_, reply) = world.handle(&url, body.as_deref(), now);
    let mut bad: Value = serde_json::from_str(&reply).unwrap();
    bad["order"]["receiver"] = json!(format!("{:#x}", world.w.a[0]));
    sell.on_response(id, 200, bad.to_string(), now).unwrap();
    assert_eq!(status(&sell)["pausedCode"], "FUSION_1_ORDER_RECEIVER");
    assert_eq!(world.orders, 3, "only the earlier buy was submitted");
    let restored = SwapOperation::restore(sell.export_state().unwrap(), GATEWAY.into()).unwrap();
    restored.retry();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 6);
    assert_eq!(world.user_ops, 1, "resume must not fund another buy");
}

#[test]
fn funding_binds_selected_source_across_restore_unlock() {
    let mut p: Value = serde_json::from_str(&plan(Some("1000000"))).unwrap();
    p["sourceIndex"] = json!(0);
    let operation =
        SwapOperation::start(p.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap();
    let seed = seed_from_entropy(ENTROPY.to_vec()).unwrap();
    let expected = evm::key_address(&derive_key(&seed, 0).unwrap());
    {
        let e = operation.inner.lock().unwrap();
        assert_eq!(e.m.source, expected);
    }
    let restored =
        SwapOperation::restore(operation.export_state().unwrap(), GATEWAY.into()).unwrap();
    restored.unlock(ENTROPY.to_vec(), T0).unwrap();
    {
        let e = restored.inner.lock().unwrap();
        assert_eq!(e.m.source, expected);
    }
    p["sourceIndex"] = json!(2);
    assert!(SwapOperation::start(p.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
    p["sourceIndex"] = json!(3);
    assert!(SwapOperation::start(p.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
}
#[test]
fn requested_budget_above_source_balance_stops_instead_of_shrinking() {
    let op = start(Some("3000000"));
    let mut world = World::new();
    let mut now = T0;
    let result = drive(&op, &mut world, &mut now);
    assert!(!matches!(result, SwapStep::Review { .. }));
    assert_eq!(world.user_ops, 0);
    assert!(op.inner.lock().unwrap().m.data.funding_amount.is_zero());
}

#[test]
fn selected_account_zero_funds_the_entire_swap_with_its_own_signature() {
    let mut p: Value = serde_json::from_str(&plan(Some("2000000"))).unwrap();
    p["sourceIndex"] = json!(0);
    let op = SwapOperation::start(p.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap();
    let seed = seed_from_entropy(ENTROPY.to_vec()).unwrap();
    let mut world = World::new();
    world.w.f = evm::key_address(&derive_key(&seed, 0).unwrap());
    let mut now = T0;
    assert!(review(&op, &mut world, &mut now).contains(&world.w.f.to_checksum(None)));
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.user_ops, 1);
}

#[test]
fn explicit_fifteen_usdc_budget_is_supported_without_a_test_cap() {
    let op = start(Some("15000000"));
    let mut world = World::new();
    world.f_balance = U256::from(15000000u64);
    let mut now = T0;
    assert!(review(&op, &mut world, &mut now).contains("Used now 14.997000 USDC"));
}

fn addr(i: u32) -> Address {
    let seed = seed_from_entropy(ENTROPY.to_vec()).unwrap();
    evm::key_address(&derive_key(&seed, i).unwrap())
}

/// A buy of `amount` split over `n` fresh wallets starting at index `first`, optionally weighted.
fn legs_plan(first: u32, n: u32, weights: Option<Vec<u32>>) -> String {
    let mut p = json!({
        "kind": "confidentialSwap",
        "target": AMZN.to_checksum(None),
        "amountAtoms": "2000000",
        "recipientIndices": (first..first + n).collect::<Vec<_>>(),
    });
    if let Some(w) = weights {
        p["weights"] = json!(w);
    }
    p.to_string()
}

fn start_plan(plan: String) -> Arc<SwapOperation> {
    SwapOperation::start(plan, ENTROPY.to_vec(), GATEWAY.into(), T0).unwrap()
}

#[test]
fn a_buy_completes_with_any_supported_number_of_legs() {
    for n in 1..=MAX_LEGS as u32 {
        let (mut world, mut now) = (World::new(), T0);
        let op = start_plan(legs_plan(3, n, None));
        let text = review(&op, &mut world, &mut now);
        assert!(
            text.contains(&format!("Payout {n} of {n}")),
            "n={n}\n{text}"
        );
        assert!(text.contains(&format!("A1–A{n}")));
        assert!(text.contains(&format!("up to {} signatures", 3 * n + 3)));
        for i in 3..3 + n {
            assert!(
                text.contains(&addr(i).to_checksum(None)),
                "n={n} wallet {i}"
            );
        }
        assert_eq!(world.user_ops + world.intents + world.orders, 0);
        op.approve(now).unwrap();
        assert_eq!(
            drive(&op, &mut world, &mut now),
            SwapStep::Finished,
            "n={n}"
        );
        assert_eq!(
            (world.user_ops, world.intents, world.orders),
            (1, n as usize, n as usize),
            "n={n}"
        );
        let s = status(&op);
        assert_eq!(s["phase"], "COMPLETE");
        assert_eq!(s["ordersComplete"], n);
        assert_eq!(s["payoutsSubmitted"], n);
        for i in 3..3 + n {
            assert!(
                world.usdg[&addr(i)].is_zero(),
                "n={n} wallet {i} keeps USDG"
            );
            assert!(!world.target[&addr(i)].is_zero(), "n={n} wallet {i} empty");
        }
        // No wallet outside the plan was ever paid.
        assert!(world.target.get(&addr(3 + n)).is_none_or(|v| v.is_zero()));
    }
}

#[test]
fn explicit_weights_set_each_payout_and_the_review_shows_them() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start_plan(legs_plan(3, 4, Some(vec![1, 2, 3, 4])));
    let text = review(&op, &mut world, &mut now);
    assert!(text.contains("(10/20/30/40)"), "{text}");
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    // The payouts were 10/20/30/40 of the private credit, so larger shares bought more.
    let bought: Vec<U256> = (3..7).map(|i| world.target[&addr(i)]).collect();
    assert!(bought.windows(2).all(|w| w[0] < w[1]), "{bought:?}");
}

#[test]
fn the_default_split_for_three_legs_is_still_thirty_thirty_forty() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    assert!(review(&op, &mut world, &mut now).contains("(30/30/40)"));
}

#[test]
fn invalid_leg_plans_are_rejected_before_any_key_is_derived() {
    let bad = |plan: String| {
        assert!(
            SwapOperation::start(plan.clone(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err(),
            "{plan}"
        )
    };
    // Zero legs, more than the supported maximum, duplicates and reserved account indices.
    let mut p: Value = serde_json::from_str(&legs_plan(3, 3, None)).unwrap();
    p["recipientIndices"] = json!([]);
    bad(p.to_string());
    bad(legs_plan(3, MAX_LEGS as u32 + 1, None));
    p["recipientIndices"] = json!([3, 4, 4]);
    bad(p.to_string());
    p["recipientIndices"] = json!([2, 4, 5]);
    bad(p.to_string());
    p["recipientIndices"] = json!([1, 4, 5]);
    bad(p.to_string());
    // Weights: wrong count, a zero, or a sum beyond the bound.
    bad(legs_plan(3, 3, Some(vec![1, 2])));
    bad(legs_plan(3, 3, Some(vec![1, 2, 3, 4])));
    bad(legs_plan(3, 3, Some(vec![1, 0, 3])));
    bad(legs_plan(3, 3, Some(vec![5_000, 5_000, 1])));
    // Sell: holders and returns pair one to one and may not overlap.
    let sell = |holders: Vec<u32>, recipients: Vec<u32>| {
        json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None), "holderIndices": holders, "recipientIndices": recipients}).to_string()
    };
    bad(sell(vec![3, 4], vec![5, 6, 7]));
    bad(sell(vec![3, 4, 5], vec![5, 6, 7]));
    bad(sell(vec![3, 3], vec![5, 6]));
    // Weights on a recovery or payout plan are as bounded as on a buy.
    assert!(
        SwapOperation::start(
            sell(vec![3, 4], vec![5, 6]),
            ENTROPY.to_vec(),
            GATEWAY.into(),
            T0
        )
        .is_ok()
    );
}

#[test]
fn a_sell_of_any_leg_count_returns_to_that_many_fresh_wallets() {
    for n in [1u32, 2, 4, 5] {
        let (mut world, mut now) = (World::new(), T0);
        let buy = start_plan(legs_plan(3, n, None));
        review(&buy, &mut world, &mut now);
        buy.approve(now).unwrap();
        assert_eq!(
            drive(&buy, &mut world, &mut now),
            SwapStep::Finished,
            "buy n={n}"
        );

        let holders: Vec<u32> = (3..3 + n).collect();
        let returns: Vec<u32> = (3 + n..3 + 2 * n).collect();
        let op = start_plan(
            json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None), "holderIndices": holders, "recipientIndices": returns}).to_string(),
        );
        let text = review(&op, &mut world, &mut now);
        for r in &returns {
            assert!(
                text.contains(&addr(*r).to_checksum(None)),
                "n={n} return {r}"
            );
        }
        assert!(text.contains(&format!("Leg {n} of {n}")), "n={n}");
        op.approve(now).unwrap();
        assert_eq!(
            drive(&op, &mut world, &mut now),
            SwapStep::Finished,
            "sell n={n}"
        );
        assert_eq!(status(&op)["ordersComplete"], n);
        for h in &holders {
            assert!(
                world.target[&addr(*h)].is_zero(),
                "n={n} holder {h} still holds"
            );
        }
        for r in &returns {
            assert!(
                !world.monad_usdc[&addr(*r)].is_zero(),
                "n={n} return {r} empty"
            );
        }
    }
}

#[test]
fn a_four_leg_operation_restores_and_only_unlocks_with_the_same_wallets() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start_plan(legs_plan(3, 4, Some(vec![2, 3, 4, 1])));
    let shown = review(&op, &mut world, &mut now);
    let restored = SwapOperation::restore(op.export_state().unwrap(), GATEWAY.into()).unwrap();
    assert_eq!(
        restored.next_step(now).unwrap(),
        SwapStep::Review { text: shown }
    );
    assert!(restored.approve(now).is_err());
    assert!(
        restored.unlock(vec![8; 32], now).is_err(),
        "other wallet entropy"
    );
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    restored.approve(now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 4);
}

#[test]
fn a_state_saved_with_three_legs_loads_unchanged_and_omits_new_fields() {
    let op = start(Some("2000000"));
    let saved = op.export_state().unwrap();
    let value: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(value["plan"]["recipientIndices"], json!([3, 4, 5]));
    assert!(
        value["plan"].get("weights").is_none(),
        "older builds must still read it"
    );
    assert_eq!(value["recipients"].as_array().unwrap().len(), 3);
    assert_eq!(value["data"]["payouts"].as_array().unwrap().len(), 3);
    assert_eq!(value["data"]["orders"].as_array().unwrap().len(), 3);
    SwapOperation::restore(saved, GATEWAY.into()).unwrap();
}

#[test]
fn recovery_runs_for_a_plan_with_fewer_legs() {
    let (mut world, mut now) = (World::new(), T0);
    world.usdg.insert(addr(10), U256::from(1_027_014u64));
    world.usdg.insert(addr(11), U256::from(1_419_357u64));
    let plan = json!({"kind": "confidentialRecovery", "target": AMZN.to_checksum(None), "recipientIndices": [3, 4], "scanTo": 15}).to_string();
    let op = start_plan(plan);
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 2);
    for i in [10, 11] {
        assert!(!world.target[&addr(i)].is_zero());
    }
}

#[test]
fn a_small_chosen_plan_buys_and_sells_through_one_wallet() {
    use crate::swap::legs::choose_buy_legs;
    let (mut world, mut now) = (World::new(), T0);
    let choice = choose_buy_legs("2000000".into(), vec![1; 32]).unwrap();
    assert_eq!((choice.count, choice.weights.clone()), (1, vec![10_000]));
    let buy = start_plan(
        json!({
            "kind": "confidentialSwap", "target": AMZN.to_checksum(None), "amountAtoms": "2000000",
            "recipientIndices": [3], "weights": choice.weights,
        })
        .to_string(),
    );
    let text = review(&buy, &mut world, &mut now);
    assert!(text.contains("Payout 1 of 1 (100)"), "{text}");
    assert!(text.contains("up to 6 signatures"), "{text}");
    buy.approve(now).unwrap();
    assert_eq!(drive(&buy, &mut world, &mut now), SwapStep::Finished);
    assert_eq!((world.user_ops, world.intents, world.orders), (1, 1, 1));
    assert!(!world.target[&addr(3)].is_zero());

    let sell = start_plan(
        json!({
            "kind": "confidentialSell", "target": AMZN.to_checksum(None),
            "holderIndices": [3], "recipientIndices": [6],
        })
        .to_string(),
    );
    review(&sell, &mut world, &mut now);
    sell.approve(now).unwrap();
    assert_eq!(drive(&sell, &mut world, &mut now), SwapStep::Finished);
    assert!(world.target[&addr(3)].is_zero());
    assert!(!world.monad_usdc[&addr(6)].is_zero());
}

#[test]
fn a_sell_plan_never_carries_shares_it_would_ignore() {
    let plan = json!({
        "kind": "confidentialSell", "target": AMZN.to_checksum(None),
        "holderIndices": [3, 4], "recipientIndices": [5, 6], "weights": [4_000, 6_000],
    });
    assert!(SwapOperation::start(plan.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err());
}

#[test]
fn a_sell_group_with_an_empty_wallet_sells_only_the_real_legs() {
    let (mut world, mut now) = (World::new(), T0);
    // A two-wallet buy fills indices 3 and 4; index 5 is the unused rest of its block.
    let buy = start_plan(legs_plan(3, 2, None));
    review(&buy, &mut world, &mut now);
    buy.approve(now).unwrap();
    assert_eq!(drive(&buy, &mut world, &mut now), SwapStep::Finished);

    let sell = start_plan(
        json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
               "holderIndices": [3, 4, 5], "recipientIndices": [6, 7, 8]})
        .to_string(),
    );
    let text = review(&sell, &mut world, &mut now);
    assert!(text.contains("two new Monad USDC wallets"), "{text}");
    assert!(
        text.contains("Leg 2 of 2") && !text.contains("Leg 3"),
        "{text}"
    );
    assert!(
        !text.contains(&addr(5).to_checksum(None)),
        "the empty wallet is not shown"
    );
    sell.approve(now).unwrap();
    assert_eq!(drive(&sell, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(status(&sell)["ordersComplete"], 2);
    for r in [6, 7] {
        assert!(
            !world.monad_usdc[&addr(r)].is_zero(),
            "return {r} stays empty"
        );
    }
    assert!(
        world.monad_usdc.get(&addr(8)).is_none_or(|v| v.is_zero()),
        "unused return stays empty"
    );
}

#[test]
fn removed_debug_sweep_plans_and_destinations_are_refused() {
    let bad = |plan: Value| {
        assert!(
            SwapOperation::start(plan.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err(),
            "{plan}"
        )
    };
    let to = "0x4b4FC9122E79C06e279FD8E3c612056ea61c856F";
    bad(json!({
        "kind": "debugSweep", "target": AMZN.to_checksum(None),
        "holderIndices": [3, 4, 5], "recipientIndices": [3, 4, 5], "destination": to,
    }));
    // No plan may name an outside destination for its proceeds.
    for plan in [
        serde_json::from_str::<Value>(&plan(Some("2000000"))).unwrap(),
        serde_json::from_str::<Value>(&sell_plan([3, 4, 5], [6, 7, 8])).unwrap(),
    ] {
        let mut p = plan;
        p["destination"] = json!(to);
        bad(p);
    }
}

/// Holders 3, 4 and 5 hold tokens; the one at `dust_slot` holds far less than Fusion accepts.
fn dusty_world(dust_slot: usize) -> World {
    let mut world = World::new();
    world.dust_below = U256::from(100_000_000_000_000u64);
    // No earlier buy funded this world, so tell the fake Aurora that deposits are credited.
    world.credit_ready_ms = Some(T0);
    for (slot, i) in [3u32, 4, 5].into_iter().enumerate() {
        let amount = if slot == dust_slot {
            1_000_000_000_000u64
        } else {
            10_000_000_000_000_000u64
        };
        world.target.insert(addr(i), U256::from(amount));
    }
    world
}

#[test]
fn a_sale_skips_a_wallet_too_small_for_fusion_wherever_it_sits() {
    for slot in 0..3usize {
        let (mut world, mut now) = (dusty_world(slot), T0);
        let sell = start_plan(
            json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
                   "holderIndices": [3, 4, 5], "recipientIndices": [6, 7, 8]})
            .to_string(),
        );
        let text = drive(&sell, &mut world, &mut now);
        let SwapStep::Review { text } = text else {
            panic!("slot {slot}: {text:?}")
        };
        let dust = addr(3 + slot as u32).to_checksum(None);
        if slot == 0 {
            // The planning estimate already hit it, so the review says what is left behind.
            assert!(text.contains("TOO SMALL TO SELL"), "{text}");
            assert!(text.contains("two new Monad USDC wallets"), "{text}");
        }
        sell.approve(now).unwrap();
        assert_eq!(
            drive(&sell, &mut world, &mut now),
            SwapStep::Finished,
            "slot {slot}"
        );
        assert_eq!(status(&sell)["phase"], "COMPLETE");
        assert_eq!(status(&sell)["ordersComplete"], 2, "slot {slot}");
        assert_eq!(world.orders, 2);
        assert_eq!(
            world.target[&evm::addr(&dust).unwrap()],
            U256::from(1_000_000_000_000u64),
            "the dust stays in place"
        );
        let paid = (6..9u32)
            .filter(|i| {
                world
                    .monad_usdc
                    .get(&addr(*i))
                    .is_some_and(|v| !v.is_zero())
            })
            .count();
        assert_eq!(paid, 2, "slot {slot}: two return wallets are paid");
    }
}

#[test]
fn a_sale_where_every_wallet_is_too_small_stops_before_review_with_a_clear_code() {
    let mut world = dusty_world(0);
    world.dust_below = U256::from(u64::MAX);
    let (mut now, sell) = (
        T0,
        start_plan(
            json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
                   "holderIndices": [3, 4, 5], "recipientIndices": [6, 7, 8]})
            .to_string(),
        ),
    );
    assert_eq!(
        drive(&sell, &mut world, &mut now),
        SwapStep::Paused {
            code: "NOTHING_SELLABLE".into()
        }
    );
    assert_eq!(world.orders, 0);
}

#[test]
fn a_sale_skips_a_wallet_whose_proceeds_are_under_the_bridge_minimum() {
    for slot in 0..3usize {
        let mut world = dusty_world(9);
        // Fusion accepts every wallet; the small one would bring in less than Aurora takes.
        let small = U256::from(120_000_000_000_000u64);
        world.target.insert(addr(3 + slot as u32), small);
        world.bridge_min = U256::from(75_000u64);
        let mut now = T0;
        let sell = start_plan(
            json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
                   "holderIndices": [3, 4, 5], "recipientIndices": [6, 7, 8]})
            .to_string(),
        );
        review(&sell, &mut world, &mut now);
        sell.approve(now).unwrap();
        assert_eq!(
            drive(&sell, &mut world, &mut now),
            SwapStep::Finished,
            "slot {slot}"
        );
        assert_eq!(status(&sell)["ordersComplete"], 2, "slot {slot}");
        assert_eq!(
            world.target[&addr(3 + slot as u32)],
            small,
            "the small wallet is untouched"
        );
        assert_eq!(world.orders, 2);
    }
}

#[test]
fn a_sale_where_nothing_clears_the_bridge_minimum_stops_instead_of_completing_empty() {
    let mut world = dusty_world(9);
    world.bridge_min = U256::from(u64::MAX);
    let mut now = T0;
    let sell = start_plan(
        json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
               "holderIndices": [3, 4, 5], "recipientIndices": [6, 7, 8]})
        .to_string(),
    );
    review(&sell, &mut world, &mut now);
    sell.approve(now).unwrap();
    assert_eq!(
        drive(&sell, &mut world, &mut now),
        SwapStep::Paused {
            code: "NOTHING_SELLABLE".into()
        }
    );
    assert_eq!(world.orders, 0);
    assert_ne!(status(&sell)["phase"], "COMPLETE");
}

const RANDOM: &str = "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";

/// Holders 3, 4 and 5 hold `each` token wei; C pools credits like mainnet.
fn pooled_world(each: u64) -> World {
    let mut world = World::new();
    world.credit_ready_ms = Some(T0);
    world.pool_credit = true;
    for i in [3u32, 4, 5] {
        world.target.insert(addr(i), U256::from(each));
    }
    world
}

/// A sell from holders 3-5 that may pay out to up to five fresh wallets, 10-14.
fn pooled_plan(random: &str) -> String {
    json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
           "holderIndices": [3, 4, 5], "recipientIndices": [10, 11, 12, 13, 14],
           "legsRandom": random})
    .to_string()
}

#[test]
fn a_pooled_sell_sells_everything_first_then_splits_the_pool_over_random_wallets() {
    // 3 x 10 USDG of sales: the 20-100 USDC tier, so two or three payouts.
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let sell = start_plan(pooled_plan(RANDOM));
    let text = review(&sell, &mut world, &mut now);
    let n = status(&sell)["legs"].as_u64().unwrap() as u32;
    assert!((2..=3).contains(&n), "{n} payouts");
    assert_eq!(status(&sell)["holders"], 3);
    assert!(text.contains("All sales are pooled in C"), "{text}");
    assert!(text.contains(&format!("Payout {n} of {n}")), "{text}");
    assert!(!text.contains(&format!("Payout {} of", n + 1)));
    for i in 10..10 + n {
        assert!(
            text.contains(&addr(i).to_checksum(None)),
            "return {i} not shown"
        );
    }
    for i in 10 + n..15 {
        assert!(
            !text.contains(&addr(i).to_checksum(None)),
            "unused wallet {i} shown"
        );
    }
    assert_eq!(
        (world.orders, world.intents),
        (0, 0),
        "nothing is signed before approval"
    );

    sell.approve(now).unwrap();
    // Every sale is banked before the first payout is signed.
    let step = drive_until(&sell, &mut world, &mut now, |url| {
        url.contains("generate-intent")
    });
    assert!(matches!(step, SwapStep::Request { .. }));
    assert_eq!((world.orders, world.intents), (3, 0));
    let pooled = world.credit;

    assert_eq!(drive(&sell, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(status(&sell)["phase"], "COMPLETE");
    assert_eq!(status(&sell)["ordersComplete"], 3);
    assert_eq!(status(&sell)["payoutsSubmitted"], n);
    assert_eq!(world.intents, n as usize);
    for i in [3u32, 4, 5] {
        assert!(world.target[&addr(i)].is_zero(), "holder {i} still holds");
    }
    let paid: Vec<U256> = (10..10 + n).map(|i| world.monad_usdc[&addr(i)]).collect();
    assert!(paid.iter().all(|p| !p.is_zero()));
    for i in 10 + n..15 {
        assert!(world.monad_usdc.get(&addr(i)).is_none_or(|v| v.is_zero()));
    }
    // The whole pool was split and nothing is left behind in C.
    assert!(world.credit.is_zero(), "{} left in C", world.credit);
    assert!(paid.iter().fold(U256::ZERO, |a, b| a + *b) <= pooled);
    // Shares are not equal: the payouts differ.
    assert!(paid.windows(2).any(|w| w[0] != w[1]), "{paid:?}");
}

#[test]
fn a_small_pooled_sell_pays_one_wallet() {
    // 3 x 1 USDG: under 5 USDC, so one payout.
    let (mut world, mut now) = (pooled_world(4_000_000_000_000_000), T0);
    let sell = start_plan(pooled_plan(RANDOM));
    let text = review(&sell, &mut world, &mut now);
    assert_eq!(status(&sell)["legs"], 1);
    assert!(text.contains("Payout 1 of 1 (100)"), "{text}");
    sell.approve(now).unwrap();
    assert_eq!(drive(&sell, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.intents, 1);
    assert!(!world.monad_usdc[&addr(10)].is_zero());
}

#[test]
fn pooled_sells_draw_different_wallet_counts_from_different_random_bytes() {
    let mut counts = std::collections::HashSet::new();
    for seed in 0u8..16 {
        let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
        let random = hex::encode([seed; 32]);
        let sell = start_plan(pooled_plan(&random));
        review(&sell, &mut world, &mut now);
        counts.insert(status(&sell)["legs"].as_u64().unwrap());
    }
    assert_eq!(counts, [2u64, 3].into_iter().collect());
}

#[test]
fn a_pooled_sell_skips_a_dust_wallet_and_still_pays_out_the_rest() {
    let mut world = pooled_world(40_000_000_000_000_000);
    world.dust_below = U256::from(100_000_000_000_000u64);
    world
        .target
        .insert(addr(4), U256::from(1_000_000_000_000u64));
    let mut now = T0;
    let sell = start_plan(pooled_plan(RANDOM));
    let text = review(&sell, &mut world, &mut now);
    assert!(!text.contains("TOO SMALL") || text.contains(&addr(4).to_checksum(None)));
    sell.approve(now).unwrap();
    assert_eq!(drive(&sell, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(status(&sell)["ordersComplete"], 2);
    assert_eq!(world.target[&addr(4)], U256::from(1_000_000_000_000u64));
    assert!(world.credit.is_zero());
}

#[test]
fn a_pooled_sell_where_nothing_can_be_banked_stops_before_any_payout() {
    let mut world = pooled_world(40_000_000_000_000_000);
    world.bridge_min = U256::from(u64::MAX);
    let mut now = T0;
    let sell = start_plan(pooled_plan(RANDOM));
    review(&sell, &mut world, &mut now);
    sell.approve(now).unwrap();
    assert_eq!(
        drive(&sell, &mut world, &mut now),
        SwapStep::Paused {
            code: "NOTHING_SELLABLE".into()
        }
    );
    assert_eq!((world.orders, world.intents), (0, 0));
}

#[test]
fn a_pooled_sell_restored_between_sales_and_payouts_finishes_after_unlock() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let sell = start_plan(pooled_plan(RANDOM));
    review(&sell, &mut world, &mut now);
    sell.approve(now).unwrap();
    drive_until(&sell, &mut world, &mut now, |url| url.contains("auth-salt"));
    let n = status(&sell)["legs"].clone();
    let restored = SwapOperation::restore(sell.export_state().unwrap(), GATEWAY.into()).unwrap();
    assert_eq!(
        status(&restored)["legs"],
        n,
        "the drawn count survives a restore"
    );
    assert!(matches!(
        drive(&restored, &mut world, &mut now),
        SwapStep::Unlock
    ));
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 3, "no sale was repeated");
    assert!(world.credit.is_zero());
}

#[test]
fn sell_plans_validate_their_randomness_and_wallet_counts() {
    let bad = |plan: String| {
        assert!(
            SwapOperation::start(plan.clone(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err(),
            "{plan}"
        )
    };
    let mut p: Value = serde_json::from_str(&pooled_plan(RANDOM)).unwrap();
    p["legsRandom"] = json!("zz");
    bad(p.to_string());
    p["legsRandom"] = json!(&RANDOM[..62]);
    bad(p.to_string());
    // Randomness belongs to sells only.
    let mut buy: Value = serde_json::from_str(&plan(Some("2000000"))).unwrap();
    buy["legsRandom"] = json!(RANDOM);
    bad(buy.to_string());
    // Holders and return wallets may not overlap; shares are drawn by the engine, not given.
    let mut p: Value = serde_json::from_str(&pooled_plan(RANDOM)).unwrap();
    p["recipientIndices"] = json!([5, 11, 12]);
    bad(p.to_string());
    let mut p: Value = serde_json::from_str(&pooled_plan(RANDOM)).unwrap();
    p["weights"] = json!([1, 1, 1, 1, 1]);
    bad(p.to_string());
    // An older sell without randomness still needs one return wallet per holder.
    bad(
        json!({"kind": "confidentialSell", "target": AMZN.to_checksum(None),
               "holderIndices": [3, 4, 5], "recipientIndices": [10, 11]})
        .to_string(),
    );
    assert!(
        SwapOperation::start(pooled_plan(RANDOM), ENTROPY.to_vec(), GATEWAY.into(), T0).is_ok()
    );
}

fn confidential_sale_plan() -> String {
    json!({"kind":"confidentialSell", "completionTarget":"confidential", "target":AMZN.to_checksum(None),
        "holderIndices":[3,4,5], "recipientIndices":[3,4,5]}).to_string()
}

#[test]
fn a_confidential_sale_finishes_at_verified_credit_without_spending_existing_private_cash() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    world.credit = U256::from(900_000_000u64);
    let initial = world.credit;
    let sale = start_plan(confidential_sale_plan());
    let review = review(&sale, &mut world, &mut now);
    assert!(
        review.contains("stop at verified private USDC credit"),
        "{review}"
    );
    sale.approve(now).unwrap();
    assert_eq!(drive(&sale, &mut world, &mut now), SwapStep::Finished);
    let public = status(&sale);
    let credited = evm::decimal(public["privateCreditedAtoms"].as_str().unwrap()).unwrap();
    assert!(credited > U256::ZERO && credited < initial);
    assert_eq!(public["completionTarget"], "confidential");
    assert_eq!(public["payoutsSubmitted"], 0);
    assert_eq!(public["ordersComplete"], 3);
    assert_eq!(world.intents, 0);
    assert!(
        !world
            .paths
            .iter()
            .any(|p| p.ends_with("/balances") || p.contains("intent"))
    );
    assert!(world.monad_usdc.is_empty());
}

#[test]
fn confidential_sales_probe_authenticated_history_before_any_fusion_signature() {
    for failure in [404, 503] {
        let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
        let sale = start_plan(confidential_sale_plan());
        let step = drive_until(&sale, &mut world, &mut now, |url| {
            url.ends_with("/aurora/history")
        });
        assert_eq!(
            world.orders, 0,
            "missing history must be discovered before selling"
        );
        assert_eq!(status(&sale)["approved"], false);
        let SwapStep::Request { id, .. } = step else {
            panic!()
        };
        sale.on_response(id, failure, "{}".into(), now).unwrap();
        assert!(matches!(
            sale.next_step(now).unwrap(),
            SwapStep::Paused { .. }
        ));
        assert_eq!(world.orders, 0);
        let state: Value = serde_json::from_str(&sale.export_state().unwrap()).unwrap();
        assert!(
            state["data"]["orders"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["permit"].is_null() && row["signature"].is_null())
        );
    }
}

fn confidential_credit_request() -> (Arc<SwapOperation>, World, u64, SwapStep) {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let sale = start_plan(confidential_sale_plan());
    review(&sale, &mut world, &mut now);
    sale.approve(now).unwrap();
    let request = drive_until(&sale, &mut world, &mut now, |url| {
        url.ends_with("/aurora/history")
    });
    (sale, world, now, request)
}

#[test]
fn confidential_sale_rejects_foreign_duplicate_stale_or_malformed_credit() {
    for tamper in 0..14 {
        let (sale, mut world, now, request) = confidential_credit_request();
        let SwapStep::Request { id, url, body, .. } = request else {
            panic!()
        };
        let (_, response) = world.handle(&url, body.as_deref(), now);
        let mut value: Value = serde_json::from_str(&response).unwrap();
        match tamper {
            0 => value["items"][0]["recipient"] = json!(format!("{:#x}", addr(20))),
            1 => value["items"][0]["refundTo"] = json!(format!("{:#x}", addr(20))),
            2 => value["items"][0]["originAsset"] = json!(SRC),
            3 => value["items"][0]["destinationAsset"] = json!(DST),
            4 => value["items"][0]["amountInFormatted"] = json!("1000000"),
            5 => value["items"][0]["amountOutFormatted"] = json!("0.000001"),
            6 => value["items"][0]["createdAt"] = json!(iso_string(T0 - 60_000)),
            7 => value["items"][0]["createdAt"] = json!(iso_string(now + 60_000)),
            8 => {
                value["items"][0]["quoteTransactions"][0]["txHash"] =
                    json!(format!("{:#x}", keccak256(b"foreign")))
            }
            9 => {
                let duplicate = value["items"][0].clone();
                value["items"].as_array_mut().unwrap().push(duplicate);
            }
            10 => {
                let duplicate = value["items"][0]["quoteTransactions"][0].clone();
                value["items"][0]["quoteTransactions"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            11 => value["items"][0]["depositMemo"] = json!("foreign memo"),
            12 => value["items"][0]["status"] = json!("PENDING_DEPOSIT"),
            _ => value["items"][0]["amountOutFormatted"] = json!("1e6"),
        }
        assert!(
            sale.on_response(id, 200, value.to_string(), now).is_err(),
            "tamper {tamper}"
        );
        assert_ne!(status(&sale)["phase"], "COMPLETE");
        assert_eq!(status(&sale)["privateCreditedAtoms"], "0");
        assert_eq!(world.intents, 0);
    }
}

#[test]
fn missing_private_credit_stays_pending_across_restore_without_repeating_sale() {
    let (sale, mut world, mut now, request) = confidential_credit_request();
    let SwapStep::Request { id, .. } = request else {
        panic!()
    };
    sale.on_response(id, 200, json!({"items":[]}).to_string(), now)
        .unwrap();
    assert_ne!(status(&sale)["phase"], "COMPLETE");
    let restored = SwapOperation::restore(sale.export_state().unwrap(), GATEWAY.into()).unwrap();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 3);
    assert_eq!(world.intents, 0);
}

#[test]
fn private_credit_auth_failure_never_falls_back_to_route_minimum_or_account_balance() {
    let (sale, mut world, mut now, request) = confidential_credit_request();
    let SwapStep::Request { id, .. } = request else {
        panic!()
    };
    sale.on_response(id, 401, "{}".into(), now).unwrap();
    assert_eq!(status(&sale)["pausedCode"], "PRIVATE_CREDIT_AUTH_REQUIRED");
    assert_eq!(status(&sale)["privateCreditedAtoms"], "0");
    let restored = SwapOperation::restore(sale.export_state().unwrap(), GATEWAY.into()).unwrap();
    restored.retry();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    assert_eq!((world.orders, world.intents), (3, 0));
    assert!(!world.paths.iter().any(|path| path.ends_with("/balances")));
}

#[test]
fn a_refunded_confidential_sale_requires_recovery_without_payout_or_completion() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let sale = start_plan(confidential_sale_plan());
    review(&sale, &mut world, &mut now);
    sale.approve(now).unwrap();
    let SwapStep::Request { id, .. } = drive_until(&sale, &mut world, &mut now, |url| {
        url.ends_with("/aurora/status")
    }) else {
        panic!()
    };
    sale.on_response(id, 200, json!({"status":"REFUNDED"}).to_string(), now)
        .unwrap();
    assert_eq!(status(&sale)["pausedCode"], "SALE_CREDIT_REFUNDED");
    assert_ne!(status(&sale)["phase"], "COMPLETE");
    assert_eq!(world.intents, 0);
}

#[test]
fn confidential_policy_requires_existing_holder_slots_and_no_payout_randomness() {
    for field in [
        "recipientIndices",
        "legsRandom",
        "weights",
        "completionTarget",
        "kind",
    ] {
        let mut p: Value = serde_json::from_str(&confidential_sale_plan()).unwrap();
        p[field] = match field {
            "recipientIndices" => json!([6, 7, 8]),
            "legsRandom" => json!(RANDOM),
            "weights" => json!([3, 3, 4]),
            "completionTarget" => json!("future"),
            _ => json!("confidentialSwap"),
        };
        assert!(
            SwapOperation::start(p.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0).is_err(),
            "{field}"
        );
    }
}

#[test]
fn sub_usdc_sale_credit_is_verified_as_exact_six_decimal_atoms() {
    let (mut world, mut now) = (pooled_world(400_000_000_000_000), T0);
    let sale = start_plan(confidential_sale_plan());
    review(&sale, &mut world, &mut now);
    sale.approve(now).unwrap();
    assert_eq!(drive(&sale, &mut world, &mut now), SwapStep::Finished);
    assert!(
        evm::decimal(status(&sale)["privateCreditedAtoms"].as_str().unwrap()).unwrap()
            < U256::from(1_000_000)
    );
    assert_eq!(world.intents, 0);
}

#[test]
fn partial_confidential_sale_keeps_every_inbound_across_restart_and_never_rerolls() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    world.partial_fill_once = true;
    let sale = start_plan(confidential_sale_plan());
    review(&sale, &mut world, &mut now);
    sale.approve(now).unwrap();
    let SwapStep::Request { id, url, body, .. } = drive_until(&sale, &mut world, &mut now, |url| {
        url.ends_with("/aurora/history")
    }) else {
        panic!()
    };
    let (status, reply) = world.handle(&url, body.as_deref(), now);
    sale.on_response(id, status, reply, now).unwrap();
    let first: Value = serde_json::from_str(&sale.export_state().unwrap()).unwrap();
    assert_eq!(first["data"]["saleInbounds"].as_array().unwrap().len(), 1);
    assert_ne!(first["data"]["saleInbounds"][0]["credited"], json!("0x0"));
    assert_eq!(world.orders, 1);
    let restored = SwapOperation::restore(first.to_string(), GATEWAY.into()).unwrap();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    let last: Value = serde_json::from_str(&restored.export_state().unwrap()).unwrap();
    assert_eq!(last["plan"], first["plan"]);
    assert_eq!(last["data"]["saleInbounds"].as_array().unwrap().len(), 4);
    assert_eq!(
        last["data"]["saleInbounds"][0],
        first["data"]["saleInbounds"][0]
    );
    assert_eq!((world.orders, world.intents), (4, 0));
    assert_eq!(
        status_private_amount(&restored),
        last["data"]["saleInbounds"]
            .as_array()
            .unwrap()
            .iter()
            .fold(U256::ZERO, |sum, row| sum
                + evm::quantity(row["credited"].as_str().unwrap()).unwrap())
    );
}

fn status_private_amount(op: &SwapOperation) -> U256 {
    evm::decimal(status(op)["privateCreditedAtoms"].as_str().unwrap()).unwrap()
}

#[test]
fn confidential_sale_cancellation_never_discards_signed_or_credited_work() {
    let (sale, mut world, mut now, request) = confidential_credit_request();
    sale.cancel();
    assert_ne!(status(&sale)["phase"], "CANCELLED");
    assert_eq!(status(&sale)["pausedCode"], "SALE_PAUSED_SAVED_PROGRESS");
    let SwapStep::Request { id, url, body, .. } = request else {
        panic!()
    };
    let (_, reply) = world.handle(&url, body.as_deref(), now);
    // The paused journal retains the pending read and every signed order.
    sale.on_response(id, 200, reply, now).unwrap();
    let restored = SwapOperation::restore(sale.export_state().unwrap(), GATEWAY.into()).unwrap();
    restored.retry();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    let credit = status(&restored)["privateCreditedAtoms"].clone();
    restored.cancel();
    assert_eq!(status(&restored)["phase"], "COMPLETE");
    assert_eq!(status(&restored)["privateCreditedAtoms"], credit);
    assert_eq!(world.orders, 3);
}

#[test]
fn higher_source_fee_after_review_requires_another_review_before_funding() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    let original: Value = serde_json::from_str(&op.export_state().unwrap()).unwrap();
    assert_eq!(original["data"]["reviewLimits"]["version"], 1);
    world.funding_fee = 6_000;
    let changed = review(&op, &mut world, &mut now);
    assert!(changed.contains("FUNDING ECONOMICS CHANGED"));
    assert!(changed.contains("gas at most 0.006000 USDC"));
    assert_eq!(world.user_ops, 0);
    assert_eq!(status(&op)["approved"], false);
    op.approve(now).unwrap();
    assert_eq!(drive(&op, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.user_ops, 1);
}

#[test]
fn lower_private_credit_after_quote_refresh_requires_review_before_funding() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    now += 6 * 60_000;
    world.funding_credit_bps = 9_900;
    let changed = review(&op, &mut world, &mut now);
    assert!(changed.contains("FUNDING ECONOMICS CHANGED"));
    assert_eq!(world.user_ops, 0);
}

#[test]
fn historical_unsigned_approval_requires_a_fresh_review_with_the_same_identity() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    let mut state: Value = serde_json::from_str(&op.export_state().unwrap()).unwrap();
    state["data"]
        .as_object_mut()
        .unwrap()
        .remove("reviewLimits");
    let restored = SwapOperation::restore(state.to_string(), GATEWAY.into()).unwrap();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    let text = review(&restored, &mut world, &mut now);
    assert!(text.contains("FUNDING ECONOMICS CHANGED"));
    assert_eq!(restored.operation_id(), op.operation_id());
    assert_eq!(world.user_ops, 0);
    restored.approve(now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
}

#[test]
fn historical_signed_funding_keeps_exact_bytes_and_reconciles_without_review_limits() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    let SwapStep::Request { url, body, .. } = drive_until(&op, &mut world, &mut now, |u| {
        u.ends_with("/v1/swap/monad/submit")
    }) else {
        panic!()
    };
    world.handle(&url, body.as_deref(), now);
    let mut state: Value = serde_json::from_str(&op.export_state().unwrap()).unwrap();
    state["data"]
        .as_object_mut()
        .unwrap()
        .remove("reviewLimits");
    let signed = state["data"]["signedOperation"].clone();
    now += 11 * 60_000; // Old paymaster validity is irrelevant to reconciliation of saved bytes.
    let restored = SwapOperation::restore(state.to_string(), GATEWAY.into()).unwrap();
    let SwapStep::Request { url, .. } = restored.next_step(now).unwrap() else {
        panic!()
    };
    assert!(url.ends_with("/v1/swap/monad/receipt"));
    let after: Value = serde_json::from_str(&restored.export_state().unwrap()).unwrap();
    assert_eq!(after["data"]["signedOperation"], signed);
    assert_eq!(world.user_ops, 1);
}

#[test]
fn short_and_future_paymaster_windows_pause_before_review_or_signing() {
    for future in [false, true] {
        let (mut world, mut now) = (World::new(), T0);
        if future {
            world.paymaster_valid_after = now / 1000 + 60;
        } else {
            world.paymaster_valid_for = 10;
        }
        let op = start(Some("2000000"));
        let next = drive(&op, &mut world, &mut now);
        assert_eq!(
            next,
            SwapStep::Paused {
                code: if future {
                    "PAYMASTER_NOT_YET_VALID"
                } else {
                    "PAYMASTER_VALIDITY_TOO_SHORT"
                }
                .into()
            }
        );
        assert_eq!(world.user_ops, 0);
    }
}

#[test]
fn deterministic_gas_errors_are_preserved_even_from_a_gateway_5xx() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    let SwapStep::Request { id, .. } = drive_until(&op, &mut world, &mut now, |u| {
        u.ends_with("/v1/swap/monad/prepare-funding")
    }) else {
        panic!()
    };
    op.on_response(
        id,
        502,
        json!({"code":"TOKEN_PAYMASTER_ALLOWANCE_LOW", "stage":"prepare", "retryable":false})
            .to_string(),
        now,
    )
    .unwrap();
    assert_eq!(
        op.next_step(now).unwrap(),
        SwapStep::Paused {
            code: "TOKEN_PAYMASTER_ALLOWANCE_LOW".into()
        }
    );
    assert_eq!(world.user_ops, 0);
}

#[test]
fn funding_review_identity_cannot_be_reused_for_a_changed_plan() {
    let (mut world, mut now) = (World::new(), T0);
    let op = start(Some("2000000"));
    review(&op, &mut world, &mut now);
    op.approve(now).unwrap();
    let mut state: Value = serde_json::from_str(&op.export_state().unwrap()).unwrap();
    state["data"]["reviewLimits"]["identityDigest"] = json!(format!("{:#x}", B256::ZERO));
    let restored = SwapOperation::restore(state.to_string(), GATEWAY.into()).unwrap();
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    let text = review(&restored, &mut world, &mut now);
    assert!(text.contains("FUNDING ECONOMICS CHANGED"));
    assert_eq!(world.user_ops, 0);
    assert_eq!(restored.operation_id(), op.operation_id());
}

#[test]
fn gas_policy_swap_small_caps_and_full_balance_match_the_shared_backend_vectors() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../shared/gas-policy-v1.json"
    )))
    .unwrap();
    assert_eq!(fixture["version"], "gizu-gas-v1");
    let number = |value: &Value| evm::decimal(value.as_str().unwrap()).unwrap();
    for name in ["fractional-token-charge", "small-fractional-swap-charge"] {
        let vector = fixture["paymasterVectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"] == name)
            .unwrap();
        let balance_vector = fixture["balanceVectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["paymasterVector"] == name);
        let fee = number(&vector["floorAtoms"]);
        let balance = balance_vector
            .map(|value| number(&value["balanceAtoms"]))
            .unwrap_or(U256::from(1000));
        let principal = balance_vector
            .map(|value| number(&value["principalAtoms"]))
            .unwrap_or(balance - fee);
        let approved = number(&vector["swapApprovalAtoms"]);
        if let Some(expected) = balance_vector {
            assert_eq!(fee, number(&expected["maximumFeeAtoms"]));
            assert_eq!(approved, number(&expected["approvalAtoms"]));
        }
        assert_eq!(
            principal + fee,
            balance,
            "{name}: full balance must fund exactly"
        );
        assert!(
            number(&vector["ceilingAtoms"]) > fee,
            "fixture must exercise fractional protocol rounding"
        );
        let mut world = World::new();
        let (owner, recipient) = (world.w.f, world.w.a[0]);
        let prepared = world.prepare(owner, recipient, principal, T0);
        let mut op: UserOperation =
            serde_json::from_value(prepared["userOperation"].clone()).unwrap();
        let authorization: UnsignedAuthorization =
            serde_json::from_value(prepared["authorization"].clone()).unwrap();
        op.pre_verification_gas = format!("0x{:x}", number(&vector["gas"]["preVerificationGas"]));
        op.call_gas_limit = format!("0x{:x}", number(&vector["gas"]["callGasLimit"]));
        op.verification_gas_limit =
            format!("0x{:x}", number(&vector["gas"]["verificationGasLimit"]));
        op.paymaster_post_op_gas_limit =
            format!("0x{:x}", number(&vector["gas"]["paymasterPostOpGasLimit"]));
        op.paymaster_verification_gas_limit = format!(
            "0x{:x}",
            number(&vector["gas"]["paymasterVerificationGasLimit"])
        );
        op.max_fee_per_gas = format!("0x{:x}", number(&vector["maxFeePerGas"]));
        op.max_priority_fee_per_gas = op.max_fee_per_gas.clone();
        let mut paymaster_data = evm::hex_bytes(&op.paymaster_data).unwrap();
        paymaster_data[34..50]
            .copy_from_slice(&number(&vector["postOpGas"]).to_be_bytes::<32>()[16..]);
        paymaster_data[50..82]
            .copy_from_slice(&number(&vector["exchangeRate"]).to_be_bytes::<32>());
        op.paymaster_data = hex::encode_prefixed(paymaster_data);
        let call_data = |approval: U256| {
            let approve = evm::hex_bytes(&evm::encode_call(
                "approve(address,uint256)",
                &[
                    evm::word_address(PIMLICO_ERC20_PAYMASTER),
                    evm::word_u256(approval),
                ],
            ))
            .unwrap();
            let transfer = evm::hex_bytes(&evm::encode_call(
                "transfer(address,uint256)",
                &[evm::word_address(recipient), evm::word_u256(principal)],
            ))
            .unwrap();
            hex::encode_prefixed(execute_batch(&[approve, transfer]))
        };
        op.call_data = call_data(approved);
        let chain = FundingChain {
            code: vec![],
            transaction_count: 0,
            paymaster_allowance: U256::ZERO,
        };
        assert_eq!(funding::fee_cap(&op, T0 / 1000).unwrap(), fee, "{name}");
        assert_eq!(funding::readiness_code(&op, T0 / 1000).unwrap(), None);
        let validate = |candidate: &UserOperation, budget: U256| {
            funding::check_funding(
                candidate,
                Some(&authorization),
                owner,
                recipient,
                principal,
                budget,
                &chain,
                T0 / 1000,
            )
        };
        assert_eq!(validate(&op, balance).unwrap().fee_cap, fee, "{name}");
        assert!(
            validate(&op, balance - U256::from(1)).is_err(),
            "{name}: one atom less cannot cover the exact debit"
        );
        // Earn intentionally reserves its ceiling cap and allowance. Reusing that profile for
        // these small Swap caps must fail the existing native upper bound, never widen it.
        op.call_data = call_data(number(&vector["earnApprovalAtoms"]));
        assert!(
            validate(&op, balance).is_err(),
            "{name}: Earn allowance is not a compatible Swap preparation"
        );
    }
}

#[test]
fn all_wallet_sale_resumes_after_first_credit_and_sells_later_groups_once() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let holders: Vec<u32> = (3..11).collect();
    for i in [6u32, 7, 9, 10] {
        world
            .target
            .insert(addr(i), U256::from(40_000_000_000_000_000u64));
    }
    // Index 8 is empty; 9 and 10 form an incomplete final three-wallet group.
    let plan = json!({"kind":"confidentialSell", "completionTarget":"confidential", "target":AMZN.to_checksum(None),
        "holderIndices":holders, "recipientIndices":holders}).to_string();
    let sale = start_plan(plan);
    let text = review(&sale, &mut world, &mut now);
    assert!(
        text.contains(&addr(10).to_checksum(None)),
        "last wallet must be reviewed: {text}"
    );
    sale.approve(now).unwrap();
    let SwapStep::Request { id, url, body, .. } = drive_until(&sale, &mut world, &mut now, |url| {
        url.ends_with("/aurora/history")
    }) else {
        panic!()
    };
    let (code, reply) = world.handle(&url, body.as_deref(), now);
    sale.on_response(id, code, reply, now).unwrap();
    assert_eq!(world.orders, 1);
    let first = sale.export_state().unwrap();
    let restored = SwapOperation::restore(first.clone(), GATEWAY.into()).unwrap();
    assert_eq!(restored.operation_id(), sale.operation_id());
    restored.unlock(ENTROPY.to_vec(), now).unwrap();
    assert_eq!(drive(&restored, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(
        world.orders, 7,
        "one sale per funded wallet, without replaying the first"
    );
    assert_eq!(status(&restored)["ordersComplete"], 7);
    assert_eq!(status(&restored)["payoutsSubmitted"], 0);
    for i in [3u32, 4, 5, 6, 7, 9, 10] {
        assert_eq!(world.target[&addr(i)], U256::ZERO, "wallet {i}");
    }
    assert_eq!(world.intents, 0);
}

#[test]
fn all_wallet_balance_scan_is_bounded_resumable_and_compacts_empty_holders() {
    let (mut world, mut now) = (pooled_world(0), T0);
    for i in [3u32, 46] {
        world
            .target
            .insert(addr(i), U256::from(40_000_000_000_000_000u64));
    }
    let holders: Vec<u32> = (3..48).collect();
    let sale = start_plan(json!({"kind":"confidentialSell", "completionTarget":"confidential", "target":AMZN.to_checksum(None),
        "holderIndices":holders, "recipientIndices":holders}).to_string());
    let SwapStep::Request { id, url, body, .. } =
        drive_until(&sale, &mut world, &mut now, |url| url == ROBINHOOD_RPC)
    else {
        panic!()
    };
    // First Robinhood request is metadata, then the first balance chunk.
    let (code, reply) = world.handle(&url, body.as_deref(), now);
    sale.on_response(id, code, reply, now).unwrap();
    let SwapStep::Request { id, url, body, .. } =
        drive_until(&sale, &mut world, &mut now, |url| url == ROBINHOOD_RPC)
    else {
        panic!()
    };
    let calls: Value = serde_json::from_str(body.as_ref().unwrap()).unwrap();
    assert_eq!(calls.as_array().unwrap().len(), 40);
    let (code, mut reply) = world.handle(&url, body.as_deref(), now);
    // An unrelated zero-token wallet holding ETH must not block the token sale.
    let mut values: Value = serde_json::from_str(&reply).unwrap();
    values[3]["result"] = json!("0x1");
    reply = values.to_string();
    sale.on_response(id, code, reply, now).unwrap();
    let state = sale.export_state().unwrap();
    let resumed = SwapOperation::restore(state, GATEWAY.into()).unwrap();
    resumed.unlock(ENTROPY.to_vec(), now).unwrap();
    let SwapStep::Request { id, url, body, .. } = resumed.next_step(now).unwrap() else {
        panic!()
    };
    let calls: Value = serde_json::from_str(body.as_ref().unwrap()).unwrap();
    assert_eq!(calls.as_array().unwrap().len(), 40);
    assert!(
        body.as_ref().unwrap().contains(&addr(23).to_checksum(None)),
        "resume starts at the next chunk"
    );
    let (code, reply) = world.handle(&url, body.as_deref(), now);
    resumed.on_response(id, code, reply, now).unwrap();
    review(&resumed, &mut world, &mut now);
    let compact: Value = serde_json::from_str(&resumed.export_state().unwrap()).unwrap();
    assert_eq!(compact["plan"]["holderIndices"], json!([3, 46]));
    assert_eq!(compact["data"]["payouts"], json!([]));
    resumed.approve(now).unwrap();
    assert_eq!(drive(&resumed, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 2);
}

#[test]
fn an_approved_all_wallet_sale_can_renew_native_authorization_after_a_day() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let sale = start_plan(confidential_sale_plan());
    review(&sale, &mut world, &mut now);
    sale.approve(now).unwrap();
    let state = sale.export_state().unwrap();
    let resumed = SwapOperation::restore(state, GATEWAY.into()).unwrap();
    now += OPERATION_MS + 1;
    resumed
        .unlock(ENTROPY.to_vec(), now)
        .expect("a fresh native unlock resumes the same approved private sale");
    assert_eq!(resumed.operation_id(), sale.operation_id());
    assert_eq!(drive(&resumed, &mut world, &mut now), SwapStep::Finished);
    assert_eq!(world.orders, 3);
}

#[test]
fn private_sale_reapproval_after_a_day_uses_the_renewed_native_session() {
    let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
    let sale = start_plan(confidential_sale_plan());
    review(&sale, &mut world, &mut now);
    sale.approve(now).unwrap();
    // Restore a journal already awaiting native review of an updated quote.
    let mut state: Value = serde_json::from_str(&sale.export_state().unwrap()).unwrap();
    state["reapproval"] = json!("Review updated sale quote");
    state["step"] = json!({"step":"fusionPreview","index":0});
    let resumed = SwapOperation::restore(state.to_string(), GATEWAY.into()).unwrap();
    now += OPERATION_MS + 1;
    assert!(
        resumed.approve(now).is_err(),
        "restore alone cannot approve without native unlock"
    );
    resumed.unlock(ENTROPY.to_vec(), now).unwrap();
    assert!(matches!(
        resumed.next_step(now).unwrap(),
        SwapStep::Review { .. }
    ));
    resumed.approve(now).unwrap();
    assert_eq!(resumed.operation_id(), sale.operation_id());
    let after: Value = serde_json::from_str(&resumed.export_state().unwrap()).unwrap();
    assert_eq!(after["reapproval"], Value::Null);
    assert_eq!(after["plan"], state["plan"]);
    assert_eq!(world.orders, 0, "review changes never submit transactions");
}

#[test]
fn all_wallet_invalid_balance_replies_never_complete_a_partial_sale() {
    for malformed in ["empty", "short", "duplicate", "missing"] {
        let (mut world, mut now) = (pooled_world(40_000_000_000_000_000), T0);
        let sale = start_plan(confidential_sale_plan());
        for _ in 0..1 {
            let SwapStep::Request { id, url, body, .. } =
                drive_until(&sale, &mut world, &mut now, |url| url == ROBINHOOD_RPC)
            else {
                panic!()
            };
            let (code, reply) = world.handle(&url, body.as_deref(), now);
            sale.on_response(id, code, reply, now).unwrap();
        }
        let SwapStep::Request { id, url, body, .. } =
            drive_until(&sale, &mut world, &mut now, |url| url == ROBINHOOD_RPC)
        else {
            panic!()
        };
        let (code, reply) = world.handle(&url, body.as_deref(), now);
        let mut bad: Value = serde_json::from_str(&reply).unwrap();
        match malformed {
            "empty" => bad[0]["result"] = json!("0x"),
            "short" => bad[0]["result"] = json!("0x01"),
            "duplicate" => bad[1]["id"] = json!(0),
            "missing" => {
                bad.as_array_mut().unwrap().pop();
            }
            _ => unreachable!(),
        }
        assert!(
            sale.on_response(id, code, bad.to_string(), now).is_err(),
            "reject {malformed}"
        );
        assert_eq!(world.orders, 0);
        let state: Value = serde_json::from_str(&sale.export_state().unwrap()).unwrap();
        assert_eq!(state["data"]["holdingsCursor"], 0);
        assert_eq!(state["plan"]["holderIndices"], json!([3, 4, 5]));
        sale.retry();
        review(&sale, &mut world, &mut now);
        sale.approve(now).unwrap();
        assert_eq!(drive(&sale, &mut world, &mut now), SwapStep::Finished);
        assert_eq!(
            world.orders, 3,
            "the failed observation never drops a funded holder"
        );
    }
}

#[test]
fn a_new_buy_only_targets_a_curated_liquid_stock() {
    let other = address!("0x1111111111111111111111111111111111111111").to_checksum(None);
    let begin =
        |plan: Value| SwapOperation::start(plan.to_string(), ENTROPY.to_vec(), GATEWAY.into(), T0);
    for kind in ["confidentialSwap", "confidentialPayout"] {
        assert!(
            begin(json!({"kind": kind, "target": other, "recipientIndices": [3, 4, 5]})).is_err(),
            "{kind}"
        );
        assert!(begin(json!({"kind": kind, "target": AMZN.to_checksum(None), "recipientIndices": [3, 4, 5]})).is_ok(), "{kind}");
    }
    // A holding of a delisted stock stays sellable and a started buy stays recoverable.
    assert!(begin(json!({"kind": "confidentialSell", "target": other, "holderIndices": [3, 4, 5], "recipientIndices": [6, 7, 8]})).is_ok());
    assert!(begin(json!({"kind": "confidentialRecovery", "target": other, "recipientIndices": [3, 4, 5], "scanTo": 15})).is_ok());
}

#[test]
fn buy_targets_match_the_shared_liquidity_list() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../shared/swap-targets-v1.json"
    )))
    .unwrap();
    assert_eq!(fixture["version"], "gizu-swap-targets-v1");
    assert_eq!(fixture["chainId"], ROBINHOOD_CHAIN_ID);
    let shared: Vec<Address> = fixture["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["address"].as_str().unwrap().parse().unwrap())
        .collect();
    assert_eq!(shared, ROBINHOOD_BUY_TARGETS.to_vec());
    assert_eq!(shared.iter().collect::<HashSet<_>>().len(), shared.len());
    assert!(!shared.contains(&ROBINHOOD_USDG));
}
