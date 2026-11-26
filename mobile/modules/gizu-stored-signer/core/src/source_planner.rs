//! Allocation accepts only native-derived observations; platform owns address attestation.
use crate::SignerError;
use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    #[serde(default)]
    source_chain_id: Option<u64>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    decimals: Option<u32>,
    source_index: u32,
    address: String,
    balance_atoms: String,
    reserved_atoms: String,
    funding_fee_atoms: String,
    execution_reserve_atoms: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Leg {
    #[serde(skip_serializing_if = "Option::is_none")]
    source_chain_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decimals: Option<u32>,
    source_index: u32,
    address: String,
    budget_atoms: String,
    amount_atoms: String,
    fee_atoms: String,
    reserve_atoms: String,
}
fn atoms(s: &str) -> Result<U256, SignerError> {
    if s.is_empty()
        || s.len() > 78
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(SignerError::InvalidInput);
    }
    U256::from_str_radix(s, 10).map_err(|_| SignerError::InvalidInput)
}

/// Checked arithmetic only. The native parent must independently authenticate every credit
/// and persist consumption before passing its approved private contribution to this helper.
#[uniffi::export]
pub fn funded_private_amount(
    approved_existing_private_atoms: String,
    credits_json: String,
) -> Result<String, SignerError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Credit {
        source_id: String,
        operation_id: String,
        credited_atoms: String,
    }
    if credits_json.len() > 131072 {
        return Err(SignerError::InvalidInput);
    }
    let credits: Vec<Credit> =
        serde_json::from_str(&credits_json).map_err(|_| SignerError::InvalidInput)?;
    if credits.len() > 256 {
        return Err(SignerError::InvalidInput);
    }
    let mut sources = std::collections::HashSet::new();
    let mut operations = std::collections::HashSet::new();
    let mut total = atoms(&approved_existing_private_atoms)?;
    for credit in credits {
        if credit.source_id.is_empty()
            || credit.source_id.len() > 256
            || credit.operation_id.is_empty()
            || credit.operation_id.len() > 128
            || !sources.insert(credit.source_id)
            || !operations.insert(credit.operation_id)
        {
            return Err(SignerError::InvalidInput);
        }
        let amount = atoms(&credit.credited_atoms)?;
        if amount.is_zero() {
            return Err(SignerError::InvalidInput);
        }
        total = total.checked_add(amount).ok_or(SignerError::InvalidInput)?;
    }
    if total.is_zero() {
        return Err(SignerError::InvalidInput);
    }
    Ok(total.to_string())
}
#[uniffi::export]
pub fn plan_public_source_allocation(
    registry: String,
    requested_budget_atoms: String,
    sources_json: String,
) -> Result<String, SignerError> {
    if sources_json.len() > 131072 {
        return Err(SignerError::InvalidInput);
    }
    let requested = atoms(&requested_budget_atoms)?;
    if requested.is_zero() {
        return Err(SignerError::InvalidInput);
    }
    let sources: Vec<Source> =
        serde_json::from_str(&sources_json).map_err(|_| SignerError::InvalidInput)?;
    if sources.is_empty() || sources.len() > 256 {
        return Err(SignerError::InvalidInput);
    }
    let mut seen = std::collections::HashSet::new();
    let mut addresses = std::collections::HashSet::new();
    let mut available = Vec::new();
    for source in sources {
        crate::roles::eligible_public_source(&registry, source.source_index)?;
        let chain_id = source.source_chain_id.unwrap_or(143);
        if source.source_chain_id.is_some() || source.token.is_some() || source.decimals.is_some() {
            let config =
                crate::swap::pins::funding_source(chain_id).ok_or(SignerError::InvalidInput)?;
            let token = source
                .token
                .as_deref()
                .ok_or(SignerError::InvalidInput)?
                .parse::<Address>()
                .map_err(|_| SignerError::InvalidInput)?;
            if source.source_chain_id.is_none()
                || token != config.usdc
                || source.decimals != Some(6)
                || chain_id != 143 && source.source_index != 1
            {
                return Err(SignerError::InvalidInput);
            }
        }
        let address = source
            .address
            .parse::<Address>()
            .map_err(|_| SignerError::InvalidInput)?;
        if !seen.insert((chain_id, source.source_index)) || !addresses.insert((chain_id, address)) {
            return Err(SignerError::InvalidInput);
        }
        let capacity = atoms(&source.balance_atoms)?
            .checked_sub(atoms(&source.reserved_atoms)?)
            .ok_or(SignerError::InvalidInput)?;
        let fee = atoms(&source.funding_fee_atoms)?;
        let reserve = atoms(&source.execution_reserve_atoms)?;
        let overhead = fee.checked_add(reserve).ok_or(SignerError::InvalidInput)?;
        if capacity > overhead {
            available.push((source, capacity, fee, reserve, overhead));
        }
    }
    available.sort_by_key(|s| (s.0.source_index, s.0.source_chain_id.unwrap_or(143)));
    let chosen = available
        .iter()
        .enumerate()
        .filter(|(_, s)| s.1 >= requested && requested > s.4)
        .min_by_key(|(_, s)| (s.2, s.0.source_index))
        .map(|(i, _)| i);
    let selected: Vec<_> = if let Some(i) = chosen {
        vec![&available[i]]
    } else {
        let mut capacity = U256::ZERO;
        let mut overhead = U256::ZERO;
        let mut selected = Vec::new();
        for s in &available {
            capacity = capacity.checked_add(s.1).ok_or(SignerError::InvalidInput)?;
            overhead = overhead
                .checked_add(s.4)
                .and_then(|v| v.checked_add(U256::from(1)))
                .ok_or(SignerError::InvalidInput)?;
            selected.push(s);
            if capacity >= requested {
                break;
            }
        }
        if capacity < requested || overhead > requested {
            return Err(SignerError::InvalidInput);
        }
        selected
    };
    let mut remaining = requested;
    let mut total_amount = U256::ZERO;
    let mut total_fee = U256::ZERO;
    let mut total_reserve = U256::ZERO;
    let mut legs = Vec::new();
    for (i, s) in selected.iter().enumerate() {
        let tail_min = selected[i + 1..]
            .iter()
            .try_fold(U256::ZERO, |sum, t| {
                sum.checked_add(t.4)?.checked_add(U256::from(1))
            })
            .ok_or(SignerError::InvalidInput)?;
        let budget = s.1.min(
            remaining
                .checked_sub(tail_min)
                .ok_or(SignerError::InvalidInput)?,
        );
        let amount = budget
            .checked_sub(s.4)
            .filter(|a| !a.is_zero())
            .ok_or(SignerError::InvalidInput)?;
        remaining = remaining
            .checked_sub(budget)
            .ok_or(SignerError::InvalidInput)?;
        total_amount = total_amount
            .checked_add(amount)
            .ok_or(SignerError::InvalidInput)?;
        total_fee = total_fee
            .checked_add(s.2)
            .ok_or(SignerError::InvalidInput)?;
        total_reserve = total_reserve
            .checked_add(s.3)
            .ok_or(SignerError::InvalidInput)?;
        legs.push(Leg {
            source_chain_id: s.0.source_chain_id,
            token: s.0.token.clone(),
            decimals: s.0.decimals,
            source_index: s.0.source_index,
            address: s.0.address.clone(),
            budget_atoms: budget.to_string(),
            amount_atoms: amount.to_string(),
            fee_atoms: s.2.to_string(),
            reserve_atoms: s.3.to_string(),
        });
    }
    if !remaining.is_zero() {
        return Err(SignerError::InvalidInput);
    }
    Ok(serde_json::json!({"requestedBudgetAtoms":requested.to_string(),"totalAmountAtoms":total_amount.to_string(),"totalFeeAtoms":total_fee.to_string(),"totalReserveAtoms":total_reserve.to_string(),"legs":legs}).to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn source(index: u32, balance: &str, fee: &str, reserve: &str) -> Value {
        json!({"sourceIndex":index,"address":format!("0x{index:040x}"),"balanceAtoms":balance,"reservedAtoms":"0","fundingFeeAtoms":fee,"executionReserveAtoms":reserve})
    }
    fn plan(budget: &str, sources: Vec<Value>) -> Result<Value, SignerError> {
        plan_public_source_allocation(
            crate::role_registry_covering(5).unwrap(),
            budget.into(),
            json!(sources).to_string(),
        )
        .map(|s| serde_json::from_str(&s).unwrap())
    }
    #[test]
    fn single_capable_source_avoids_multiple_fees_and_uses_fee_then_index() {
        let p = plan(
            "10",
            vec![
                source(0, "7", "1", "1"),
                source(1, "20", "2", "1"),
                source(3, "20", "1", "1"),
            ],
        )
        .unwrap();
        assert_eq!(p["legs"].as_array().unwrap().len(), 1);
        assert_eq!(p["legs"][0]["sourceIndex"], 3);
        assert_eq!(p["legs"][0]["budgetAtoms"], "10");
        assert_eq!(p["totalAmountAtoms"], "8");
        assert_eq!(p["totalFeeAtoms"], "1");
        assert_eq!(p["totalReserveAtoms"], "1");
    }
    #[test]
    fn multi_source_uses_exact_budget_and_native_reservations() {
        let mut a = source(0, "9", "1", "1");
        a["reservedAtoms"] = json!("2");
        let p = plan("10", vec![source(1, "8", "1", "1"), a]).unwrap();
        assert_eq!(p["legs"][0]["budgetAtoms"], "7");
        assert_eq!(p["legs"][1]["budgetAtoms"], "3");
        assert_eq!(p["requestedBudgetAtoms"], "10");
        assert_eq!(p["totalAmountAtoms"], "6");
        assert_eq!(p["totalFeeAtoms"], "2");
        assert_eq!(p["totalReserveAtoms"], "2");
    }
    #[test]
    fn insufficiency_duplicate_and_ineligible_sources_are_rejected() {
        assert!(
            plan(
                "20",
                vec![source(0, "7", "1", "1"), source(1, "8", "1", "1")]
            )
            .is_err()
        );
        assert!(plan("2", vec![source(0, "7", "1", "1")]).is_err());
        for index in [2, 6, u32::MAX] {
            assert!(plan("4", vec![source(index, "7", "1", "1")]).is_err());
        }
        assert!(
            plan(
                "4",
                vec![source(0, "7", "1", "1"), source(0, "8", "1", "1")]
            )
            .is_err()
        );
        assert!(plan("0", vec![source(0, "7", "1", "1")]).is_err());
    }
    #[test]
    fn allocation_avoids_a_last_leg_that_cannot_pay_its_fee() {
        let p = plan(
            "8",
            vec![source(0, "7", "1", "1"), source(1, "7", "1", "1")],
        )
        .unwrap();
        assert_eq!(p["legs"][0]["budgetAtoms"], "5");
        assert_eq!(p["legs"][1]["budgetAtoms"], "3");
        assert_eq!(p["totalAmountAtoms"], "4");
    }

    fn network_source(chain: u64, token: &str) -> Value {
        let mut row = source(1, "10000000", "10000", "0");
        row["sourceChainId"] = json!(chain);
        row["token"] = json!(token);
        row["decimals"] = json!(6);
        row
    }

    #[test]
    fn same_funding_address_on_two_networks_can_budget_fifteen() {
        let monad = network_source(143, "0x754704bc059f8c67012fed69bc8a327a5aafb603");
        for (chain, token) in [
            (8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
            (42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
        ] {
            let result = plan(
                "15000000",
                vec![monad.clone(), network_source(chain, token)],
            )
            .unwrap();
            assert_eq!(result["requestedBudgetAtoms"], "15000000");
            assert_eq!(result["totalAmountAtoms"], "14980000");
            assert_eq!(result["totalFeeAtoms"], "20000");
            assert_eq!(result["legs"][0]["sourceChainId"], 143);
            assert_eq!(result["legs"][0]["budgetAtoms"], "10000000");
            assert_eq!(result["legs"][1]["sourceChainId"], chain);
            assert_eq!(result["legs"][1]["budgetAtoms"], "5000000");
        }
    }

    #[test]
    fn qualified_sources_reject_wrong_token_decimals_duplicates_and_nonfunding_accounts() {
        let base = network_source(8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
        assert!(plan("1000000", vec![base.clone()]).is_ok());
        assert!(plan("1000000", vec![base.clone(), base.clone()]).is_err());
        for (field, value) in [
            ("sourceChainId", json!(43114)),
            ("token", json!("0x754704bc059f8c67012fed69bc8a327a5aafb603")),
            ("decimals", json!(18)),
            ("sourceIndex", json!(3)),
        ] {
            let mut bad = base.clone();
            bad[field] = value;
            assert!(plan("1000000", vec![bad]).is_err(), "accepted {field}");
        }
    }

    #[test]
    fn combined_credit_amount_excludes_unapproved_private_cash_and_duplicates() {
        let credits = json!([
            {"sourceId":"143:account1", "operationId":"source_a", "creditedAtoms":"9900000"},
            {"sourceId":"8453:account1", "operationId":"source_b", "creditedAtoms":"4900000"}
        ]);
        assert_eq!(
            funded_private_amount("2000000".into(), credits.to_string()).unwrap(),
            "16800000"
        );
        let mut duplicate = credits.clone();
        duplicate[1]["operationId"] = duplicate[0]["operationId"].clone();
        assert!(funded_private_amount("2000000".into(), duplicate.to_string()).is_err());
        duplicate = credits.clone();
        duplicate[1]["sourceId"] = duplicate[0]["sourceId"].clone();
        assert!(funded_private_amount("0".into(), duplicate.to_string()).is_err());
        assert!(funded_private_amount(U256::MAX.to_string(), credits.to_string()).is_err());
        assert_eq!(
            funded_private_amount("15".into(), "[]".into()).unwrap(),
            "15"
        );
        assert!(funded_private_amount("0".into(), "[]".into()).is_err());
    }
}
