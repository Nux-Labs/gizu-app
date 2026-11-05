use crate::{SignerError, address};
use alloy_primitives::{Address, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;
const ASSET: &str = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    kind: String,
    profile_chain_id: u64,
    cycle_index: u32,
    address: String,
    amount_atoms: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    operation_id: String,
    amount_atoms: String,
    sources: Vec<Source>,
    recipient_indices: Vec<u32>,
    weights_bps: Vec<u32>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Child {
    source: usize,
    slot: usize,
    amount_atoms: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    proposal: Proposal,
    children: Vec<Child>,
}
fn amount(s: &str) -> Result<u64, SignerError> {
    if s.is_empty() || s.starts_with('0') || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Err(SignerError::InvalidInput);
    }
    s.parse().map_err(|_| SignerError::InvalidInput)
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
fn matrix(p: &Proposal) -> Result<Vec<Child>, SignerError> {
    let total = amount(&p.amount_atoms)?;
    if p.operation_id.is_empty()
        || p.operation_id.len() > 96
        || !p
            .operation_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || p.sources.is_empty()
        || p.sources.len() > 32
        || p.weights_bps.is_empty()
        || p.weights_bps.len() > 5
        || p.weights_bps.len() != p.recipient_indices.len()
        || p.weights_bps.contains(&0)
        || p.weights_bps.iter().map(|v| u64::from(*v)).sum::<u64>() != 10000
    {
        return invalid();
    }
    let mut seen = std::collections::HashSet::new();
    let mut sum = 0u64;
    for source in &p.sources {
        if !seen.insert(source.address.to_lowercase())
            || !(source.kind == "swap" && source.profile_chain_id == 0 && source.cycle_index == 0
                || source.kind == "earn" && [1, 4663].contains(&source.profile_chain_id))
        {
            return invalid();
        }
        sum = sum
            .checked_add(amount(&source.amount_atoms)?)
            .ok_or(SignerError::InvalidInput)?;
    }
    if sum != total
        || p.recipient_indices.iter().any(|i| *i < 3)
        || p.recipient_indices
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != p.recipient_indices.len()
    {
        return invalid();
    }
    let mut budgets = Vec::new();
    let mut remaining = total;
    for (i, w) in p.weights_bps.iter().enumerate() {
        let v = if i + 1 == p.weights_bps.len() {
            remaining
        } else {
            (u128::from(total) * u128::from(*w) / 10000) as u64
        };
        if v == 0 {
            return invalid();
        }
        budgets.push(v);
        remaining -= v;
    }
    let mut result = Vec::new();
    let mut slot = 0;
    for (source, row) in p.sources.iter().enumerate() {
        let mut left = amount(&row.amount_atoms)?;
        while left > 0 {
            let debit = left.min(budgets[slot]);
            result.push(Child {
                source,
                slot,
                amount_atoms: debit.to_string(),
            });
            left -= debit;
            budgets[slot] -= debit;
            if budgets[slot] == 0 {
                slot += 1;
            }
        }
    }
    Ok(result)
}
#[uniffi::export]
pub fn confidential_withdrawal_plan(proposal: String) -> Result<String, SignerError> {
    let proposal: Proposal = parse(&proposal)?;
    let children = matrix(&proposal)?;
    serde_json::to_string(&Plan { proposal, children }).map_err(|_| SignerError::InvalidInput)
}
fn clock() -> Result<u64, SignerError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| SignerError::InvalidInput)?
        .as_millis()
        .try_into()
        .map_err(|_| SignerError::InvalidInput)
}
fn addr(v: &str) -> Result<Address, SignerError> {
    v.parse().map_err(|_| SignerError::InvalidInput)
}
fn source_key(seed: &[u8; 64], s: &Source) -> Result<bip32::XPrv, SignerError> {
    if s.kind == "swap" {
        crate::roles::derive_key(seed, 2)
    } else {
        crate::earn_cycle_key(seed, s.profile_chain_id, s.cycle_index, 2)
    }
}
struct State {
    seed: Option<Zeroizing<[u8; 64]>>,
    plan: Plan,
    child: Child,
    recipient: Address,
    payload: Option<String>,
    nonce: Option<String>,
    evidence: Option<String>,
    review_hash: Option<String>,
    expires: u64,
    approved: bool,
    signed: bool,
}
#[derive(uniffi::Object)]
pub struct ConfidentialWithdrawalOperation {
    state: Mutex<State>,
}
#[uniffi::export]
impl ConfidentialWithdrawalOperation {
    #[uniffi::constructor]
    pub fn new(
        plan_json: String,
        child_index: u32,
        entropy: Vec<u8>,
        registry: String,
    ) -> Result<Arc<Self>, SignerError> {
        let plan: Plan = parse(&plan_json)?;
        if matrix(&plan.proposal)? != plan.children {
            return invalid();
        }
        let child = plan
            .children
            .get(child_index as usize)
            .ok_or(SignerError::InvalidInput)?
            .clone();
        let seed = crate::roles::seed_from_entropy(entropy)?;
        for s in &plan.proposal.sources {
            if addr(&s.address)?
                != addr(&address(
                    source_key(&seed, s)?.private_key().verifying_key(),
                ))?
            {
                return invalid();
            }
        }
        for i in &plan.proposal.recipient_indices {
            crate::roles::eligible_public_source(&registry, *i)?;
        }
        let recipient = addr(&address(
            crate::roles::derive_key(&seed, plan.proposal.recipient_indices[child.slot])?
                .private_key()
                .verifying_key(),
        ))?;
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                seed: Some(seed),
                plan,
                child,
                recipient,
                payload: None,
                nonce: None,
                evidence: None,
                review_hash: None,
                expires: clock()? + 900000,
                approved: false,
                signed: false,
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
        let now = clock()?;
        if s.signed || s.payload.is_some() || now >= s.expires {
            return invalid();
        }
        let p: Value = parse(&prepared_json)?;
        let b: Value = parse(&balance_json)?;
        let j: Value = parse(&journal_evidence)?;
        let source = &s.plan.proposal.sources[s.child.source];
        let c = addr(&source.address)?;
        let debit = amount(&s.child.amount_atoms)?;
        let text = |v: &Value, k: &str| {
            v[k].as_str()
                .map(str::to_string)
                .ok_or(SignerError::InvalidInput)
        };
        if addr(&text(&b, "confidentialAddress")?)? != c
            || b["assetId"] != ASSET
            || b["authenticated"] != true
            || b["operationScoped"] != false
            || b["timestampMs"]
                .as_u64()
                .is_none_or(|t| t > now + 5000 || now.saturating_sub(t) > 60000)
            || text(&b, "available")?
                .parse::<U256>()
                .map_err(|_| SignerError::InvalidInput)?
                < U256::from(debit)
        {
            return invalid();
        }
        if p["operationId"]
            != format!(
                "{}_{}",
                s.plan.proposal.operation_id,
                s.plan
                    .children
                    .iter()
                    .position(|v| v == &s.child)
                    .ok_or(SignerError::InvalidInput)?
            )
            || addr(&text(&p, "confidentialAccount")?)? != c
            || addr(&text(&p, "destinationRecipient")?)? != s.recipient
            || p["amountAtoms"] != s.child.amount_atoms
            || p["assetId"] != ASSET
            || p["destinationChainId"] != 143
            || addr(&text(&p, "destinationToken")?)?
                != addr("0x754704Bc059F8C67012fEd69BC8A327a5aafb603")?
            || p["observedAtMs"]
                .as_u64()
                .is_none_or(|t| t > now || now - t > 60000)
        {
            return invalid();
        }
        let request: crate::swap::aurora::QuoteRequest =
            serde_json::from_value(p["quoteRequest"].clone())
                .map_err(|_| SignerError::InvalidInput)?;
        let expected = crate::swap::aurora::QuoteRequest::payout(
            c,
            s.recipient,
            ASSET,
            ASSET,
            U256::from(debit),
        );
        if request != expected {
            return invalid();
        }
        let quote = crate::swap::aurora::check_quote(&request, &p["quoteResponse"], now)?;
        if quote.amount_in != U256::from(debit)
            || quote.min_amount_out > U256::from(debit)
            || p["minimumDestinationAtoms"] != quote.min_amount_out.to_string()
        {
            return invalid();
        }
        let payload = text(&p["intent"], "payload")?;
        let token = crate::swap::aurora::private_token_id(&payload, ASSET)?;
        let nonce = crate::earn_payout::strict_private_transfer(
            &payload,
            &source.address,
            &quote.deposit_address,
            &token,
            &s.child.amount_atoms,
            p["expiresAtMs"].as_u64().ok_or(SignerError::InvalidInput)?,
            now,
        )?;
        let hash = format!("{:#x}", keccak256(payload.as_bytes()));
        if j["nonce"] != nonce
            || j["payloadHash"] != hash
            || j["unresolved"] != false
            || text(&j, "reservationId")?.len() != 66
            || text(&j, "reservedAtoms")?
                .parse::<U256>()
                .map_err(|_| SignerError::InvalidInput)?
                < U256::from(debit)
        {
            return invalid();
        }
        let review = format!(
            "WITHDRAW FROM GIZU\nExact private USDC input budget {} atoms across {} sources\n{} fresh public Monad receiving wallets · weights {:?}\nThis child: source {} · receiver {} · input {} atoms\nGuaranteed minimum {} atoms; maximum route fees/deduction {} atoms. Fees are inside the input budget.\nAdvanced confidentiality · exact ERC191 payload {}\nThe saved plan, receivers and signed bytes cannot be rerolled. Unknown children remain reserved.",
            s.plan.proposal.amount_atoms,
            s.plan.proposal.sources.len(),
            s.plan.proposal.recipient_indices.len(),
            s.plan.proposal.weights_bps,
            source.address,
            s.recipient,
            s.child.amount_atoms,
            quote.min_amount_out,
            U256::from(debit) - quote.min_amount_out,
            hash
        );
        s.review_hash = Some(format!(
            "{:#x}",
            keccak256(
                [
                    review.as_bytes(),
                    plan_bytes(&s.plan)?.as_slice(),
                    journal_evidence.as_bytes()
                ]
                .concat()
            )
        ));
        s.expires = s
            .expires
            .min(quote.deadline_ms)
            .min(p["expiresAtMs"].as_u64().ok_or(SignerError::InvalidInput)?)
            .min(now + 60000);
        s.payload = Some(payload);
        s.nonce = Some(nonce);
        s.evidence = Some(journal_evidence);
        Ok(review)
    }
    pub fn review_hash(&self) -> Result<String, SignerError> {
        self.state
            .lock()
            .map_err(|_| SignerError::CryptoFailed)?
            .review_hash
            .clone()
            .ok_or(SignerError::InvalidInput)
    }
    pub fn approve(&self, review_hash: String) -> Result<(), SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        if s.review_hash.as_ref() != Some(&review_hash) || clock()? >= s.expires || s.signed {
            return invalid();
        }
        s.approved = true;
        Ok(())
    }
    pub fn sign(&self, journal_evidence: String) -> Result<String, SignerError> {
        let mut s = self.state.lock().map_err(|_| SignerError::CryptoFailed)?;
        if !s.approved
            || s.signed
            || clock()? >= s.expires
            || s.evidence.as_ref() != Some(&journal_evidence)
        {
            return invalid();
        }
        let key = source_key(
            s.seed.as_ref().ok_or(SignerError::Expired)?,
            &s.plan.proposal.sources[s.child.source],
        )?;
        let payload = s.payload.as_ref().ok_or(SignerError::InvalidInput)?;
        let sig =
            crate::swap::evm::sign(&key, crate::swap::evm::personal_hash(payload.as_bytes()))?;
        let result=json!({"standard":"erc191","payload":payload,"signature":crate::swap::aurora::encode_signature(&sig)}).to_string();
        s.signed = true;
        s.approved = false;
        s.seed = None;
        Ok(result)
    }
    pub fn invalidate(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.seed = None;
            s.approved = false;
        }
    }
}
fn plan_bytes(p: &Plan) -> Result<Vec<u8>, SignerError> {
    serde_json::to_vec(p).map_err(|_| SignerError::InvalidInput)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn multisource_matrix_conserves_exact_input_and_rounding() {
        let proposal = json!({"operationId":"cash1","amountAtoms":"10000001","sources":[{"kind":"swap","profileChainId":0,"cycleIndex":0,"address":"0x1111111111111111111111111111111111111111","amountAtoms":"4000000"},{"kind":"earn","profileChainId":4663,"cycleIndex":3,"address":"0x2222222222222222222222222222222222222222","amountAtoms":"6000001"}],"recipientIndices":[3,4,5],"weightsBps":[3333,3333,3334]});
        let plan: serde_json::Value =
            serde_json::from_str(&confidential_withdrawal_plan(proposal.to_string()).unwrap())
                .unwrap();
        let children = plan["children"].as_array().unwrap();
        assert_eq!(
            children
                .iter()
                .map(|c| c["amountAtoms"].as_str().unwrap().parse::<u64>().unwrap())
                .sum::<u64>(),
            10000001
        );
        let totals = (0..3)
            .map(|slot| {
                children
                    .iter()
                    .filter(|c| c["slot"] == slot)
                    .map(|c| c["amountAtoms"].as_str().unwrap().parse::<u64>().unwrap())
                    .sum::<u64>()
            })
            .collect::<Vec<_>>();
        assert_eq!(totals, vec![3333000, 3333000, 3334001]);
        assert!(children.len() <= 4);
    }
    fn signer_fixture() -> (Arc<ConfidentialWithdrawalOperation>, Value, Value, String) {
        use base64::Engine;
        let seed = crate::roles::seed_from_entropy(vec![0; 32]).unwrap();
        let c = address(
            crate::roles::derive_key(&seed, 2)
                .unwrap()
                .private_key()
                .verifying_key(),
        );
        let r = address(
            crate::roles::derive_key(&seed, 3)
                .unwrap()
                .private_key()
                .verifying_key(),
        );
        let plan=confidential_withdrawal_plan(json!({"operationId":"cash1","amountAtoms":"1000000","sources":[{"kind":"swap","profileChainId":0,"cycleIndex":0,"address":c,"amountAtoms":"1000000"}],"recipientIndices":[3],"weightsBps":[10000]}).to_string()).unwrap();
        let op = ConfidentialWithdrawalOperation::new(
            plan,
            0,
            vec![0; 32],
            r#"{"version":1,"nextRecipient":6}"#.into(),
        )
        .unwrap();
        let now = clock().unwrap();
        let expiry = now + 30000;
        let deadline = chrono::DateTime::from_timestamp_millis(expiry as i64)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let nonce = base64::engine::general_purpose::STANDARD.encode([9; 32]);
        let token = format!("imt:{}:{}", "a".repeat(64), ASSET);
        let payload=json!({"signer_id":c.to_lowercase(),"verifying_contract":"intents.far","nonce":nonce,"deadline":deadline,"intents":[{"intent":"transfer","receiver_id":"deposit","tokens":{token:"1000000"}}]}).to_string();
        let req = crate::swap::aurora::QuoteRequest::payout(
            c.parse().unwrap(),
            r.parse().unwrap(),
            ASSET,
            ASSET,
            U256::from(1000000),
        );
        let prepared = json!({"operationId":"cash1_0","confidentialAccount":c,"destinationRecipient":r,"destinationToken":"0x754704Bc059F8C67012fEd69BC8A327a5aafb603","destinationChainId":143,"assetId":ASSET,"amountAtoms":"1000000","minimumDestinationAtoms":"980000","observedAtMs":now,"expiresAtMs":expiry,"quoteRequest":req,"quoteResponse":{"quoteRequest":req,"signature":"provider","quote":{"depositAddress":"deposit","amountIn":"1000000","amountOut":"990000","minAmountOut":"980000","deadline":deadline}},"intent":{"standard":"erc191","payload":payload}});
        let balance = json!({"confidentialAddress":c,"assetId":ASSET,"available":"2000000","timestampMs":now,"authenticated":true,"operationScoped":false});
        let j=json!({"nonce":nonce,"payloadHash":format!("{:#x}",keccak256(payload.as_bytes())),"reservationId":format!("0x{}","b".repeat(64)),"reservedAtoms":"1000000","unresolved":false}).to_string();
        (op, prepared, balance, j)
    }
    #[test]
    fn exact_native_approval_required_and_signed_payload_is_single_use() {
        let (op, p, b, j) = signer_fixture();
        assert!(op.sign(j.clone()).is_err());
        let review = op.prepare(p.to_string(), b.to_string(), j.clone()).unwrap();
        assert!(review.contains("1000000"));
        assert!(op.approve("foreign review".into()).is_err());
        op.approve(op.review_hash().unwrap()).unwrap();
        assert!(op.sign(format!("{j} ")).is_err());
        let signed: Value = serde_json::from_str(&op.sign(j.clone()).unwrap()).unwrap();
        assert_eq!(signed["payload"], p["intent"]["payload"]);
        assert!(
            signed["signature"]
                .as_str()
                .unwrap()
                .starts_with("secp256k1:")
        );
        assert!(op.sign(j).is_err());
    }
    #[test]
    fn stale_foreign_and_ambiguous_payload_evidence_never_reaches_review() {
        for kind in ["stale", "foreign", "amount", "duplicate", "unresolved"] {
            let (op, mut p, mut b, j) = signer_fixture();
            let mut evidence: Value = serde_json::from_str(&j).unwrap();
            match kind {
                "stale" => b["timestampMs"] = json!(clock().unwrap() - 60001),
                "foreign" => {
                    p["destinationRecipient"] = json!("0x1111111111111111111111111111111111111111")
                }
                "amount" => p["amountAtoms"] = json!("1000001"),
                "duplicate" => {
                    let payload = p["intent"]["payload"].as_str().unwrap();
                    p["intent"]["payload"] =
                        json!(payload.replace("\"1000000\"}", "\"1000000\",\"extra\":\"1\"}"));
                }
                _ => evidence["unresolved"] = json!(true),
            }
            assert!(
                op.prepare(p.to_string(), b.to_string(), evidence.to_string())
                    .is_err(),
                "{kind}"
            );
        }
    }
    #[test]
    fn all_receiving_wallet_counts_preserve_exact_global_budget() {
        for count in 1..=5 {
            let mut weights = vec![10000 / count; count as usize];
            *weights.last_mut().unwrap() += 10000 - weights.iter().sum::<u32>();
            let p = json!({"operationId":"cash1","amountAtoms":"10000001","sources":[{"kind":"earn","profileChainId":1,"cycleIndex":2,"address":"0x1111111111111111111111111111111111111111","amountAtoms":"10000001"}],"recipientIndices":(3..3+count).collect::<Vec<_>>(),"weightsBps":weights});
            let result: Value =
                serde_json::from_str(&confidential_withdrawal_plan(p.to_string()).unwrap())
                    .unwrap();
            assert_eq!(
                result["children"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c["amountAtoms"].as_str().unwrap().parse::<u64>().unwrap())
                    .sum::<u64>(),
                10000001
            );
        }
    }
    #[test]
    fn malformed_and_zero_or_inexact_plans_are_rejected() {
        for amount in ["0", "01", "-1", "18446744073709551616"] {
            assert!(confidential_withdrawal_plan(json!({"operationId":"cash1","amountAtoms":amount,"sources":[],"recipientIndices":[3],"weightsBps":[10000]}).to_string()).is_err());
        }
    }
}
