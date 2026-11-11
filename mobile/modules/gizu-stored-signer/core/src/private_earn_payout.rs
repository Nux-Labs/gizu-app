//! Separate authorization for investing existing private Monad USDC. Platform
//! code supplies authenticated balance evidence and an encrypted journal
//! reservation; neither evidence is accepted directly from JavaScript.
use crate::{SignerError, address, earn_distribution::EarnDistribution};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const SOURCE_ASSET: &str = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
const DESTINATION_ASSET: &str = "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near";
const DESTINATION_TOKEN: &str = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    kind: String,
    profile_chain_id: u64,
    cycle_index: u32,
    address: String,
    amount_atoms: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    kind: String,
    operation_id: String,
    revision: u64,
    profile_chain_id: u64,
    cycle_index: u32,
    distribution: EarnDistribution,
    leg: String,
    split_offset_atoms: String,
    credited_atoms: String,
    amount_atoms: String,
    expected_signer: String,
    expected_recipient: String,
    minimum_destination_atoms: String,
    source: Source,
    deadline_ms: u64,
}
fn invalid<T>() -> Result<T, SignerError> {
    Err(SignerError::InvalidInput)
}
fn parse<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, SignerError> {
    if s.len() > 262144 {
        return invalid();
    }
    serde_json::from_str(s).map_err(|_| SignerError::InvalidInput)
}
fn decimal(s: &str) -> Result<U256, SignerError> {
    if s.is_empty()
        || s.len() > 78
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|c| c.is_ascii_digit())
    {
        return invalid();
    }
    U256::from_str_radix(s, 10).map_err(|_| SignerError::InvalidInput)
}
fn clock() -> Result<u64, SignerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SignerError::InvalidInput)?
        .as_millis()
        .try_into()
        .map_err(|_| SignerError::InvalidInput)
}
fn addr(s: &str) -> Result<Address, SignerError> {
    s.parse().map_err(|_| SignerError::InvalidInput)
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, SignerError> {
    v[k].as_str().ok_or(SignerError::InvalidInput)
}
fn timestamp(v: &Value, k: &str) -> Result<u64, SignerError> {
    v[k].as_u64().ok_or(SignerError::InvalidInput)
}
fn source_key(seed: &[u8; 64], source: &Source) -> Result<bip32::XPrv, SignerError> {
    match source.kind.as_str() {
        "swap" if source.profile_chain_id == 0 && source.cycle_index == 0 => {
            crate::roles::derive_key(seed, 2)
        }
        "earn" => crate::earn_cycle_key(seed, source.profile_chain_id, source.cycle_index, 2),
        _ => invalid(),
    }
}
// Quote providers may append fee metadata, but this route permits no app fee.
fn no_application_fees(v: &Value) -> Result<(), SignerError> {
    if let Some(fees) = v.get("appFees") {
        if fees.as_array().is_none_or(|fees| !fees.is_empty()) {
            return invalid();
        }
    }
    for field in [
        "integratorFeeBps",
        "applicationFeeAtoms",
        "feeBps",
        "integratorFee",
        "integratorFeeShare",
    ] {
        if let Some(fee) = v.get(field) {
            if fee != &json!(0) && fee != &json!("0") {
                return invalid();
            }
        }
    }
    Ok(())
}
fn private_route_fees(prepared: &Value) -> Result<String, SignerError> {
    let rows = [
        prepared,
        &prepared["quoteResponse"],
        &prepared["quoteResponse"]["quote"],
        &prepared["quoteResponse"]["quoteRequest"],
    ];
    let Some(policy) = prepared.get("feePolicy") else {
        for row in rows {
            no_application_fees(row)?;
        }
        if prepared
            .get("providerFeeBps")
            .is_some_and(|v| v != &json!(0))
        {
            return invalid();
        }
        return Ok("Provider fee 0 bps. Gizu/integrator fee 0.".into());
    };
    let total = prepared["providerFeeBps"]
        .as_u64()
        .filter(|v| *v <= 100)
        .ok_or(SignerError::InvalidInput)? as u32;
    let review =
        crate::earn_fees::review(Some(&policy.to_string()), "payoutRobinhood", Some(total))?;
    let sorted = |value: &Value| -> Result<Vec<Value>, SignerError> {
        let mut fees = value.as_array().ok_or(SignerError::InvalidInput)?.clone();
        fees.sort_by_key(|fee| fee["recipient"].as_str().unwrap_or_default().to_string());
        Ok(fees)
    };
    let expected = sorted(&policy["appFees"])?;
    let echo = &prepared["quoteResponse"]["quoteRequest"];
    if sorted(echo.get("appFees").unwrap_or(&json!([])))? != expected
        || echo.get("referral").unwrap_or(&Value::Null) != &policy["referral"]
    {
        return invalid();
    }
    for row in rows {
        if let Some(fees) = row.get("appFees") {
            if sorted(fees)? != expected {
                return invalid();
            }
        }
        if row.get("feeBps").is_some_and(|v| v != &json!(total)) {
            return invalid();
        }
        for field in [
            "integratorFeeBps",
            "applicationFeeAtoms",
            "integratorFee",
            "integratorFeeShare",
        ] {
            if row
                .get(field)
                .is_some_and(|v| v != &json!(0) && v != &json!("0"))
            {
                return invalid();
            }
        }
    }
    Ok(review)
}
struct State {
    proposal: Proposal,
    proposal_hash: B256,
    slot: u32,
    recipient: Address,
    seed: Option<Zeroizing<[u8; 64]>>,
    started: Instant,
    lifetime: Duration,
    expires: u64,
    payload: Option<String>,
    evidence: Option<String>,
    review_hash: Option<String>,
    approved: bool,
}
fn live(s: &mut State) -> Result<(), SignerError> {
    if s.seed.is_none() || s.started.elapsed() >= s.lifetime || clock()? >= s.expires {
        s.seed = None;
        s.approved = false;
        return Err(SignerError::Expired);
    }
    Ok(())
}
#[derive(uniffi::Object)]
pub struct PrivateEarnPayoutOperation {
    state: Mutex<State>,
}
#[uniffi::export]
impl PrivateEarnPayoutOperation {
    #[uniffi::constructor]
    pub fn new(proposal: String, entropy: Vec<u8>) -> Result<Arc<Self>, SignerError> {
        let p: Proposal = parse(&proposal)?;
        let now = clock()?;
        if p.kind != "privateEarnPayout"
            || p.revision == 0
            || p.profile_chain_id != 4663
            || p.operation_id.is_empty()
            || p.operation_id.len() > 96
            || !p
                .operation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || p.deadline_ms <= now
            || p.deadline_ms > now + 60000
        {
            return invalid();
        }
        let slot = p.distribution.slot(&p.leg)?;
        let credit = decimal(&p.credited_atoms)?;
        let debit = decimal(&p.amount_atoms)?;
        if credit.is_zero()
            || decimal(&p.minimum_destination_atoms)?.is_zero()
            || decimal(&p.minimum_destination_atoms)? > debit
            || decimal(&p.source.amount_atoms)? != credit
            || p.distribution
                .allocations(credit, decimal(&p.split_offset_atoms)?)?[slot as usize]
                != debit
        {
            return invalid();
        }
        let seed = crate::roles::seed_from_entropy(entropy)?;
        let signer = addr(&address(
            source_key(&seed, &p.source)?.private_key().verifying_key(),
        ))?;
        let recipient = addr(&address(
            crate::earn_distribution::earn_investment_key(
                &seed,
                p.profile_chain_id,
                p.cycle_index,
                Some(slot),
            )?
            .private_key()
            .verifying_key(),
        ))?;
        if addr(&p.source.address)? != signer
            || addr(&p.expected_signer)? != signer
            || addr(&p.expected_recipient)? != recipient
        {
            return invalid();
        }
        let expires = p.deadline_ms;
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                proposal: p,
                proposal_hash: keccak256(proposal.as_bytes()),
                slot,
                recipient,
                seed: Some(seed),
                started: Instant::now(),
                lifetime: Duration::from_millis(expires - now),
                expires,
                payload: None,
                evidence: None,
                review_hash: None,
                approved: false,
            }),
        }))
    }
    pub fn prepare(
        &self,
        prepared_json: String,
        balance_json: String,
        journal_evidence: String,
    ) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        if s.payload.is_some() {
            return invalid();
        }
        let now = clock()?;
        let p: Value = parse(&prepared_json)?;
        let b: Value = parse(&balance_json)?;
        let j: Value = parse(&journal_evidence)?;
        let c = addr(&s.proposal.source.address)?;
        let debit = decimal(&s.proposal.amount_atoms)?;
        let balance_time = timestamp(&b, "timestampMs")?;
        if addr(text(&b, "confidentialAddress")?)? != c
            || b["assetId"] != SOURCE_ASSET
            || b["authenticated"] != true
            || b["operationScoped"] != false
            || balance_time > now + 5000
            || now.saturating_sub(balance_time) > 60000
            || decimal(text(&b, "available")?)? < debit
        {
            return invalid();
        }
        let observed = timestamp(&p, "observedAtMs")?;
        let expires = timestamp(&p, "expiresAtMs")?;
        if p["operationId"] != format!("{}_{}", s.proposal.operation_id, s.slot)
            || addr(text(&p, "confidentialAccount")?)? != c
            || addr(text(&p, "destinationRecipient")?)? != s.recipient
            || p["amountAtoms"] != s.proposal.amount_atoms
            || p["assetId"] != SOURCE_ASSET
            || p["destinationAssetId"] != DESTINATION_ASSET
            || p["destinationChainId"] != 4663
            || addr(text(&p, "destinationToken")?)? != addr(DESTINATION_TOKEN)?
            || observed > now
            || now - observed > 60000
            || expires <= now
            || expires > now + 60000
            || p["intent"]["standard"] != "erc191"
        {
            return invalid();
        }
        let fee_review = private_route_fees(&p)?;
        let request: crate::swap::aurora::QuoteRequest =
            serde_json::from_value(p["quoteRequest"].clone())
                .map_err(|_| SignerError::InvalidInput)?;
        let expected = crate::swap::aurora::QuoteRequest::payout(
            c,
            s.recipient,
            SOURCE_ASSET,
            DESTINATION_ASSET,
            debit,
        );
        if request != expected {
            return invalid();
        }
        let echoed = &p["quoteResponse"]["quoteRequest"];
        if echoed["dry"] != false || echoed["slippageTolerance"] != 100 {
            return invalid();
        }
        let quote = crate::swap::aurora::check_quote(&request, &p["quoteResponse"], now)?;
        if quote.amount_in != debit
            || quote.min_amount_out > debit
            || quote.min_amount_out < decimal(&s.proposal.minimum_destination_atoms)?
            || p["minimumDestinationAtoms"] != quote.min_amount_out.to_string()
        {
            return invalid();
        }
        let payload = text(&p["intent"], "payload")?.to_string();
        if payload.len() > 8000 {
            return invalid();
        }
        let token = crate::swap::aurora::private_token_id(&payload, SOURCE_ASSET)?;
        let nonce = crate::earn_payout::strict_private_transfer(
            &payload,
            &s.proposal.source.address,
            &quote.deposit_address,
            &token,
            &s.proposal.amount_atoms,
            expires.min(s.expires).min(quote.deadline_ms),
            now,
        )?;
        let message: Value = parse(&payload)?;
        let payload_deadline = chrono::DateTime::parse_from_rfc3339(text(&message, "deadline")?)
            .map_err(|_| SignerError::InvalidInput)?
            .timestamp_millis() as u64;
        let hash = format!("{:#x}", keccak256(payload.as_bytes()));
        let reservation = text(&j, "reservationId")?;
        if j["nonce"] != nonce
            || j["payloadHash"] != hash
            || j["unresolved"] != false
            || reservation.len() != 66
            || !reservation.starts_with("0x")
            || !reservation[2..].bytes().all(|b| b.is_ascii_hexdigit())
            || decimal(text(&j, "reservedAtoms")?)? < debit
        {
            return invalid();
        }
        let review = format!(
            "INVEST EXISTING PRIVATE FUNDS IN EARN\nFunding operation {} · revision {}\nExisting private Monad USDC source {} · {} chain {} cycle {} · selected budget {} atoms\nTarget Robinhood chain 4663 · vault investment wallets in cycle {}\n{}\nExact {} allocation {} atoms · prior source offset {} atoms\nDestination investment wallet {} · USDG {}\nGuaranteed minimum {} atoms; maximum route deduction {} atoms, inside the private input budget.\n{}\nAdvanced confidentiality · exact ERC191 payload {} · local nonce reservation {}\nSigning authorizes this private investment payout; it does not confirm destination receipt or vault deposit. Uncertain submissions stay reserved.",
            s.proposal.operation_id,
            s.proposal.revision,
            s.proposal.source.address,
            s.proposal.source.kind,
            s.proposal.source.profile_chain_id,
            s.proposal.source.cycle_index,
            s.proposal.credited_atoms,
            s.proposal.cycle_index,
            s.proposal.distribution.review(),
            s.proposal.leg,
            s.proposal.amount_atoms,
            s.proposal.split_offset_atoms,
            s.recipient,
            DESTINATION_TOKEN,
            quote.min_amount_out,
            debit - quote.min_amount_out,
            fee_review,
            hash,
            reservation
        );
        s.review_hash = Some(format!(
            "{:#x}",
            keccak256(
                [
                    review.as_bytes(),
                    s.proposal_hash.as_slice(),
                    prepared_json.as_bytes(),
                    balance_json.as_bytes(),
                    journal_evidence.as_bytes()
                ]
                .concat()
            )
        ));
        s.expires = s
            .expires
            .min(expires)
            .min(quote.deadline_ms)
            .min(payload_deadline)
            .min(balance_time + 60000)
            .min(observed + 60000);
        s.payload = Some(payload);
        s.evidence = Some(journal_evidence);
        Ok(review)
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        s.review_hash.clone().ok_or(SignerError::InvalidInput)
    }
    pub fn approve(&self, review_hash: String) -> Result<(), SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        if s.approved || s.review_hash.as_ref() != Some(&review_hash) {
            return invalid();
        }
        s.approved = true;
        Ok(())
    }
    pub fn sign(&self, journal_evidence: String) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        live(&mut s)?;
        if !s.approved || s.evidence.as_ref() != Some(&journal_evidence) {
            return invalid();
        }
        let seed = s.seed.take().ok_or(SignerError::Expired)?;
        s.approved = false;
        let key = source_key(&seed, &s.proposal.source)?;
        let payload = s.payload.as_ref().ok_or(SignerError::InvalidInput)?;
        let signature =
            crate::swap::evm::sign(&key, crate::swap::evm::personal_hash(payload.as_bytes()))?;
        Ok(json!({"standard":"erc191","payload":payload,"signature":crate::swap::aurora::encode_signature(&signature)}).to_string())
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.seed = None;
            s.approved = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    fn fixture(kind: &str, chain: u64, cycle: u32) -> (Value, Value, Value, Value) {
        let seed = crate::roles::seed_from_entropy(vec![0; 32]).unwrap();
        let source = Source {
            kind: kind.into(),
            profile_chain_id: chain,
            cycle_index: cycle,
            address: String::new(),
            amount_atoms: "1000001".into(),
        };
        let c = address(
            source_key(&seed, &source)
                .unwrap()
                .private_key()
                .verifying_key(),
        );
        let r =
            crate::derive_earn_distribution_addresses(vec![0; 32], 4663, 7, 2).unwrap()[0].clone();
        let now = clock().unwrap();
        let expiry = now + 30000;
        let deadline = crate::swap::aurora::iso_string(expiry);
        let nonce = STANDARD.encode([9; 32]);
        let token = format!("imt:{}:{SOURCE_ASSET}", "ab".repeat(32));
        let payload = json!({"signer_id":c.to_lowercase(),"verifying_contract":"intents.far","nonce":nonce,"deadline":deadline,"intents":[{"intent":"transfer","receiver_id":"deposit","tokens":{token:"370001"}}]}).to_string();
        let proposal = json!({"kind":"privateEarnPayout","operationId":"private_source_1","revision":1,"profileChainId":4663,"cycleIndex":7,"distribution":{"version":1,"weightsBps":[3700,6300]},"leg":"invest:0","splitOffsetAtoms":"2","creditedAtoms":"1000001","amountAtoms":"370001","expectedSigner":c,"expectedRecipient":r,"minimumDestinationAtoms":"350000","source":{"kind":kind,"profileChainId":chain,"cycleIndex":cycle,"address":c,"amountAtoms":"1000001"},"deadlineMs":now+45000});
        let req = crate::swap::aurora::QuoteRequest::payout(
            c.parse().unwrap(),
            r.parse().unwrap(),
            SOURCE_ASSET,
            DESTINATION_ASSET,
            U256::from(370001),
        );
        let prepared = json!({"operationId":"private_source_1_0","confidentialAccount":c,"destinationRecipient":r,"destinationToken":DESTINATION_TOKEN,"destinationChainId":4663,"assetId":SOURCE_ASSET,"destinationAssetId":DESTINATION_ASSET,"amountAtoms":"370001","minimumDestinationAtoms":"350000","observedAtMs":now,"expiresAtMs":expiry,"quoteRequest":req,"quoteResponse":{"quoteRequest":req,"signature":"provider","quote":{"depositAddress":"deposit","amountIn":"370001","amountOut":"360000","minAmountOut":"350000","deadline":deadline}},"intent":{"standard":"erc191","payload":payload}});
        let balance = json!({"confidentialAddress":c,"assetId":SOURCE_ASSET,"available":"1000001","timestampMs":now,"authenticated":true,"operationScoped":false});
        let journal = json!({"nonce":nonce,"payloadHash":format!("{:#x}",keccak256(payload.as_bytes())),"reservationId":format!("0x{}","b".repeat(64)),"reservedAtoms":"370001","unresolved":false});
        (proposal, prepared, balance, journal)
    }
    fn operation(p: &Value) -> Arc<PrivateEarnPayoutOperation> {
        PrivateEarnPayoutOperation::new(p.to_string(), vec![0; 32]).unwrap()
    }
    #[test]
    fn qualified_provider_fees_are_bound_to_the_exact_quote_and_review() {
        let (p, mut prepared, balance, journal) = fixture("swap", 0, 0);
        let fees = json!([
            {"recipient":"widget_collect.sputnik-dao.near","fee":25},
            {"recipient":"service.near","fee":20}
        ]);
        prepared["providerFeeBps"] = json!(45);
        prepared["feePolicy"] = json!({"version":"qualified","route":"payoutRobinhood","totalBps":45,"appFees":fees,"referral":"aurora-qualified","integratorFeeBps":0,"applicationFeeAtoms":"0"});
        prepared["quoteResponse"]["quoteRequest"]["appFees"] = fees;
        prepared["quoteResponse"]["quoteRequest"]["referral"] = json!("aurora-qualified");
        let review = operation(&p)
            .prepare(
                prepared.to_string(),
                balance.to_string(),
                journal.to_string(),
            )
            .unwrap();
        assert!(review.contains("total 45 bps"));
        assert!(review.contains("Gizu/integrator fee 0"));
        for mutation in 0..8 {
            let mut changed = prepared.clone();
            match mutation {
                0 => {
                    changed.as_object_mut().unwrap().remove("feePolicy");
                }
                1 => changed["providerFeeBps"] = json!(44),
                2 => changed["feePolicy"]["route"] = json!("withdrawal"),
                3 => changed["feePolicy"]["integratorFeeBps"] = json!(1),
                4 => changed["quoteResponse"]["quoteRequest"]["appFees"][0]["fee"] = json!(24),
                5 => changed["quoteResponse"]["quoteRequest"]["referral"] = json!("other"),
                6 => {
                    changed["quoteResponse"]["quote"]["appFees"] =
                        json!([{"recipient":"extra","fee":1}])
                }
                _ => changed["quoteResponse"]["quote"]["applicationFeeAtoms"] = json!("1"),
            }
            assert!(
                operation(&p)
                    .prepare(
                        changed.to_string(),
                        balance.to_string(),
                        journal.to_string()
                    )
                    .is_err(),
                "mutation {mutation}"
            );
        }
    }
    #[test]
    fn existing_swap_and_earn_funds_sign_the_exact_investment_payload_once() {
        for (kind, chain, cycle) in [("swap", 0, 0), ("earn", 1, 0), ("earn", 4663, 3)] {
            let (p, prepared, balance, journal) = fixture(kind, chain, cycle);
            let op = operation(&p);
            assert!(op.sign(journal.to_string()).is_err());
            let review = op
                .prepare(
                    prepared.to_string(),
                    balance.to_string(),
                    journal.to_string(),
                )
                .unwrap();
            assert!(review.contains("INVEST EXISTING PRIVATE FUNDS"));
            assert!(review.contains("3700 bps"));
            assert!(review.contains("cycle 7"));
            assert!(!review.contains("WITHDRAW"));
            assert!(op.approve("another review".into()).is_err());
            let hash = op.review_hash().unwrap();
            op.approve(hash.clone()).unwrap();
            assert!(op.approve(hash).is_err());
            assert!(
                op.prepare(
                    prepared.to_string(),
                    balance.to_string(),
                    journal.to_string()
                )
                .is_err()
            );
            assert!(op.sign(format!("{journal} ")).is_err());
            let signed: Value = parse(&op.sign(journal.to_string()).unwrap()).unwrap();
            assert_eq!(signed["payload"], prepared["intent"]["payload"]);
            assert_eq!(signed["standard"], "erc191");
            let signature = bs58::decode(
                signed["signature"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("secp256k1:")
                    .unwrap(),
            )
            .into_vec()
            .unwrap();
            let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
                crate::swap::evm::personal_hash(signed["payload"].as_str().unwrap().as_bytes())
                    .as_slice(),
                &k256::ecdsa::Signature::from_slice(&signature[..64]).unwrap(),
                k256::ecdsa::RecoveryId::from_byte(signature[64]).unwrap(),
            )
            .unwrap();
            assert_eq!(address(&recovered), p["source"]["address"]);
            assert!(op.sign(journal.to_string()).is_err());
            assert!(op.review_hash().is_err());
        }
    }
    #[test]
    fn proposal_derivation_distribution_and_budget_mutations_fail_closed() {
        let (p, _, _, _) = fixture("swap", 0, 0);
        for mutation in 0..20 {
            let mut p = p.clone();
            match mutation {
                0 => p["kind"] = json!("confidentialPayout"),
                1 => p["revision"] = json!(0),
                2 => p["profileChainId"] = json!(1),
                3 => p["cycleIndex"] = json!(8),
                4 => p["source"]["cycleIndex"] = json!(1),
                5 => p["source"]["profileChainId"] = json!(4663),
                6 => p["source"]["kind"] = json!("other"),
                7 => p["source"]["address"] = p["expectedRecipient"].clone(),
                8 => p["expectedSigner"] = p["expectedRecipient"].clone(),
                9 => p["expectedRecipient"] = p["expectedSigner"].clone(),
                10 => p["source"]["amountAtoms"] = json!("1000000"),
                11 => p["amountAtoms"] = json!("370000"),
                12 => p["splitOffsetAtoms"] = json!("0"),
                13 => p["distribution"]["weightsBps"] = json!([5000, 5000]),
                14 => p["distribution"]["weightsBps"] = json!([3700, 6200]),
                15 => p["leg"] = json!("invest:1"),
                16 => p["deadlineMs"] = json!(clock().unwrap() + 120000),
                17 => p["minimumDestinationAtoms"] = json!("0"),
                18 => p["minimumDestinationAtoms"] = json!("370002"),
                _ => p["quoteId"] = json!("unrecognized"),
            }
            assert!(
                PrivateEarnPayoutOperation::new(p.to_string(), vec![0; 32]).is_err(),
                "mutation {mutation}"
            );
        }
        for (chain, cycle) in [(0, 0), (143, 0), (4663, u32::MAX)] {
            let mut bad = p.clone();
            bad["source"]["kind"] = json!("earn");
            bad["source"]["profileChainId"] = json!(chain);
            bad["source"]["cycleIndex"] = json!(cycle);
            assert!(PrivateEarnPayoutOperation::new(bad.to_string(), vec![0; 32]).is_err());
        }
    }
    #[test]
    fn authenticated_balance_quote_and_journal_mutations_cannot_reach_review() {
        let (p, prepared, balance, journal) = fixture("earn", 4663, 2);
        for mutation in 0..32 {
            let op = operation(&p);
            let (mut q, mut b, mut j) = (prepared.clone(), balance.clone(), journal.clone());
            match mutation {
                0 => b["timestampMs"] = json!(clock().unwrap() - 60001),
                1 => b["authenticated"] = json!(false),
                2 => b["operationScoped"] = json!(true),
                3 => b["assetId"] = json!(DESTINATION_ASSET),
                4 => b["available"] = json!("370000"),
                5 => b["confidentialAddress"] = p["expectedRecipient"].clone(),
                6 => q["operationId"] = json!("private_source_1_1"),
                7 => q["destinationRecipient"] = p["expectedSigner"].clone(),
                8 => q["destinationToken"] = json!("0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
                9 => q["destinationChainId"] = json!(1),
                10 => q["destinationAssetId"] = json!(SOURCE_ASSET),
                11 => q["assetId"] = json!(DESTINATION_ASSET),
                12 => q["amountAtoms"] = json!("370002"),
                13 => q["observedAtMs"] = json!(clock().unwrap() - 60001),
                14 => q["expiresAtMs"] = json!(clock().unwrap() + 120000),
                15 => q["quoteRequest"]["refundTo"] = p["expectedRecipient"].clone(),
                16 => q["quoteResponse"]["quoteRequest"]["amount"] = json!("370002"),
                17 => q["quoteResponse"]["quote"]["minAmountOut"] = json!("370002"),
                18 => {
                    q["quoteResponse"]["quote"]["minAmountOut"] = json!("349999");
                    q["minimumDestinationAtoms"] = json!("349999");
                }
                19 => {
                    q["quoteResponse"]["quoteRequest"]["appFees"] =
                        json!([{"recipient":"fee","fee":1}])
                }
                20 => q["quoteResponse"]["quote"]["integratorFeeBps"] = json!(1),
                21 => q["intent"]["standard"] = json!("other"),
                22 => j["nonce"] = json!(STANDARD.encode([8; 32])),
                23 => j["payloadHash"] = json!(format!("0x{}", "c".repeat(64))),
                24 => j["reservedAtoms"] = json!("370000"),
                25 => j["reservationId"] = json!(format!("0x{}", "g".repeat(64))),
                26 => j["unresolved"] = json!(true),
                27 => q["quoteResponse"]["quoteRequest"]["slippageTolerance"] = json!(1000),
                _ => {
                    let mut message: Value =
                        parse(q["intent"]["payload"].as_str().unwrap()).unwrap();
                    match mutation {
                        28 => message["signer_id"] = p["expectedRecipient"].clone(),
                        29 => message["nonce"] = json!(STANDARD.encode([0; 32])),
                        30 => message["intents"][0]["receiver_id"] = json!("foreign"),
                        _ => {
                            message["intents"][0]["tokens"] = json!({format!("imt:{}:{DESTINATION_ASSET}", "ab".repeat(32)):"370001"})
                        }
                    }
                    let payload = message.to_string();
                    j["payloadHash"] = json!(format!("{:#x}", keccak256(payload.as_bytes())));
                    q["intent"]["payload"] = json!(payload);
                }
            }
            assert!(
                op.prepare(q.to_string(), b.to_string(), j.to_string())
                    .is_err(),
                "mutation {mutation}"
            );
            assert!(op.review_hash().is_err());
            assert!(op.sign(j.to_string()).is_err());
        }
    }
    #[test]
    fn duplicate_tokens_expiry_invalidation_and_concurrent_signing_are_bounded() {
        let (p, mut q, b, mut j) = fixture("swap", 0, 0);
        let payload = q["intent"]["payload"]
            .as_str()
            .unwrap()
            .replace("\"370001\"}", "\"370001\",\"extra\":\"1\"}");
        q["intent"]["payload"] = json!(payload);
        j["payloadHash"] = json!(format!("{:#x}", keccak256(payload.as_bytes())));
        assert!(
            operation(&p)
                .prepare(q.to_string(), b.to_string(), j.to_string())
                .is_err()
        );
        let (p, q, b, j) = fixture("swap", 0, 0);
        let op = operation(&p);
        op.prepare(q.to_string(), b.to_string(), j.to_string())
            .unwrap();
        op.approve(op.review_hash().unwrap()).unwrap();
        let handles = (0..2)
            .map(|_| {
                let op = op.clone();
                let j = j.to_string();
                std::thread::spawn(move || op.sign(j))
            })
            .collect::<Vec<_>>();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| u8::from(h.join().unwrap().is_ok()))
                .sum::<u8>(),
            1
        );
        let op = operation(&p);
        op.invalidate();
        assert!(
            op.prepare(q.to_string(), b.to_string(), j.to_string())
                .is_err()
        );
        let op = operation(&p);
        op.state.lock().unwrap().lifetime = Duration::ZERO;
        assert!(op.review_hash().is_err());
    }
}
