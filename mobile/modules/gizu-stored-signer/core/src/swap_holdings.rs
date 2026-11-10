//! Public holdings arithmetic and owned batch selection; never accepts signing material.
use crate::{SignerError, decode_portfolio_balance, portfolio_account_indices};
use alloy_primitives::{U256, hex};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, uniffi::Record)]
pub struct SwapHoldingSelection {
    pub target: String,
    pub indices: Vec<u32>,
}

#[uniffi::export]
pub fn swap_holding_indices(registry: String, excluded: Vec<u32>) -> Result<Vec<u32>, SignerError> {
    let allocated = portfolio_account_indices(registry)?;
    let excluded: HashSet<_> = excluded.into_iter().collect();
    if excluded.iter().any(|i| *i < 3 || !allocated.contains(i)) {
        return Err(SignerError::InvalidInput);
    }
    Ok(allocated
        .into_iter()
        .filter(|i| *i >= 3 && !excluded.contains(i))
        .collect())
}

fn target(value: &str) -> Result<(), SignerError> {
    if value.len() != 42
        || !value.starts_with("0x")
        || !value[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(SignerError::InvalidInput);
    }
    Ok(())
}

#[uniffi::export]
pub fn select_swap_holding(
    id: String,
    registry: String,
    excluded: Vec<u32>,
    tracked: Vec<String>,
) -> Result<SwapHoldingSelection, SignerError> {
    let (token, first) = id.split_once(':').ok_or(SignerError::InvalidInput)?;
    target(token)?;
    if first == "all" {
        if !tracked.iter().any(|t| t == token) {
            return Err(SignerError::InvalidInput);
        }
        let indices = swap_holding_indices(registry, excluded)?;
        if indices.is_empty() {
            return Err(SignerError::InvalidInput);
        }
        return Ok(SwapHoldingSelection {
            target: token.into(),
            indices,
        });
    }
    let first: u32 = first.parse().map_err(|_| SignerError::InvalidInput)?;
    if id != format!("{token}:{first}") || !tracked.iter().any(|t| t == token) {
        return Err(SignerError::InvalidInput);
    }
    let indices = swap_holding_indices(registry, excluded)?;
    let batch = indices
        .chunks(3)
        .find(|b| b.len() == 3 && b[0] == first)
        .ok_or(SignerError::InvalidInput)?;
    Ok(SwapHoldingSelection {
        target: token.into(),
        indices: batch.to_vec(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Batch {
    id: String,
    balance_atoms: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Holding {
    token: String,
    chain_id: u64,
    symbol: String,
    decimals: u32,
    balance_atoms: String,
    batches: Vec<Batch>,
}

/// One ABI observation per selected account, in selected order. Null means no holdings.
#[uniffi::export]
pub fn build_swap_holding(
    target_address: String,
    indices: Vec<u32>,
    balances: Vec<String>,
    symbol_abi: String,
    decimals_abi: String,
) -> Result<String, SignerError> {
    target(&target_address)?;
    if indices.len() != balances.len()
        || indices.len() > 8189
        || indices.iter().any(|i| *i < 3 || *i >= 8192)
        || indices.windows(2).any(|w| w[0] >= w[1])
    {
        return Err(SignerError::InvalidInput);
    }
    let decimals: u32 = decode_portfolio_balance(decimals_abi)?
        .parse()
        .map_err(|_| SignerError::InvalidInput)?;
    if decimals > 36 {
        return Err(SignerError::InvalidInput);
    }
    let symbol = decode_swap_symbol(symbol_abi)?;
    let amounts = balances
        .into_iter()
        .map(|b| {
            U256::from_str_radix(&decode_portfolio_balance(b)?, 10)
                .map_err(|_| SignerError::InvalidInput)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let sum = |values: &[U256]| {
        values.iter().try_fold(U256::ZERO, |a, b| {
            a.checked_add(*b).ok_or(SignerError::InvalidInput)
        })
    };
    let total = sum(&amounts)?;
    let batches = amounts
        .chunks(3)
        .enumerate()
        .map(|(i, b)| {
            let amount = sum(b)?;
            Ok((amount != U256::ZERO && b.len() == 3).then(|| Batch {
                id: format!("{}:{}", target_address, indices[i * 3]),
                balance_atoms: amount.to_string(),
            }))
        })
        .collect::<Result<Vec<_>, SignerError>>()?
        .into_iter()
        .flatten()
        .collect();
    if total == U256::ZERO {
        return Ok("null".into());
    }
    serde_json::to_string(&Holding {
        token: target_address,
        chain_id: 4663,
        symbol,
        decimals,
        balance_atoms: total.to_string(),
        batches,
    })
    .map_err(|_| SignerError::InvalidInput)
}

#[uniffi::export]
pub fn decode_swap_symbol(value: String) -> Result<String, SignerError> {
    if !value.starts_with("0x") || value.len() > 258 {
        return Err(SignerError::InvalidInput);
    }
    let bytes = hex::decode(&value[2..]).map_err(|_| SignerError::InvalidInput)?;
    if bytes.len() < 64 || U256::from_be_slice(&bytes[..32]) != U256::from(32) {
        return Err(SignerError::InvalidInput);
    }
    let size = U256::from_be_slice(&bytes[32..64]);
    if size == U256::ZERO || size > U256::from(64) {
        return Err(SignerError::InvalidInput);
    }
    let size = size.to::<usize>();
    if bytes.len() < 64 + size {
        return Err(SignerError::InvalidInput);
    }
    let symbol =
        std::str::from_utf8(&bytes[64..64 + size]).map_err(|_| SignerError::InvalidInput)?;
    if symbol.chars().any(char::is_control) {
        return Err(SignerError::InvalidInput);
    }
    Ok(symbol.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "0x1111111111111111111111111111111111111111";
    #[test]
    fn shared_fixture_matches_native_adapters() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../ios/Tests/Fixtures/swap-holdings.json"))
                .unwrap();
        let indices =
            swap_holding_indices(f["registry"].as_str().unwrap().into(), vec![6]).unwrap();
        let actual = build_swap_holding(
            f["token"].as_str().unwrap().into(),
            indices,
            serde_json::from_value(f["balances"].clone()).unwrap(),
            f["symbolAbi"].as_str().unwrap().into(),
            f["decimalsAbi"].as_str().unwrap().into(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&actual).unwrap(),
            f["expected"]
        );
    }
    #[test]
    fn selections_exclude_earn_recipients_and_reject_forged_ids() {
        let registry = r#"{"version":1,"nextRecipient":10}"#;
        assert_eq!(
            swap_holding_indices(registry.into(), vec![6]).unwrap(),
            vec![3, 4, 5, 7, 8, 9]
        );
        let selected = select_swap_holding(
            format!("{TOKEN}:7"),
            registry.into(),
            vec![6],
            vec![TOKEN.into()],
        )
        .unwrap();
        assert_eq!(selected.indices, vec![7, 8, 9]);
        for i in ["0", "2", "4", "6", "10", "03"] {
            assert!(
                select_swap_holding(
                    format!("{TOKEN}:{i}"),
                    registry.into(),
                    vec![6],
                    vec![TOKEN.into()]
                )
                .is_err()
            );
        }
        assert!(
            select_swap_holding(format!("{TOKEN}:3"), registry.into(), vec![], vec![]).is_err()
        );
        assert!(swap_holding_indices(registry.into(), vec![10]).is_err());
    }
    #[test]
    fn all_selection_includes_later_and_partial_groups_but_excludes_earn() {
        let selected = select_swap_holding(
            format!("{TOKEN}:all"),
            r#"{"version":1,"nextRecipient":12}"#.into(),
            vec![6],
            vec![TOKEN.into()],
        )
        .unwrap();
        assert_eq!(selected.indices, vec![3, 4, 5, 7, 8, 9, 10, 11]);
        assert!(
            select_swap_holding(
                format!("{TOKEN}:all"),
                r#"{"version":1,"nextRecipient":12}"#.into(),
                vec![],
                vec![]
            )
            .is_err()
        );
    }
    #[test]
    fn exact_abi_amounts_zero_batches_and_overflow() {
        let abi = |v: U256| format!("0x{v:064x}");
        let symbol = format!(
            "0x{:064x}{:064x}{}{}",
            32,
            5,
            hex::encode("GOOGL"),
            "0".repeat(54)
        );
        let build = |balances: Vec<String>| {
            build_swap_holding(
                TOKEN.into(),
                vec![3, 4, 5],
                balances,
                symbol.clone(),
                abi(U256::from(18)),
            )
        };
        let result: serde_json::Value = serde_json::from_str(
            &build(vec![
                abi(U256::from(9007199254740993u64)),
                abi(U256::from(1)),
                abi(U256::ZERO),
            ])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["balanceAtoms"], "9007199254740994");
        assert_eq!(result["symbol"], "GOOGL");
        assert_eq!(result["batches"][0]["id"], format!("{TOKEN}:3"));
        assert_eq!(build(vec![abi(U256::ZERO); 3]).unwrap(), "null");
        assert!(build(vec![abi(U256::MAX), abi(U256::from(1)), abi(U256::ZERO)]).is_err());
        assert!(build(vec!["0x0".into(); 3]).is_err());
        let incomplete: serde_json::Value = serde_json::from_str(
            &build_swap_holding(
                TOKEN.into(),
                vec![3, 4],
                vec![abi(U256::from(1)); 2],
                symbol,
                abi(U256::from(18)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(incomplete["balanceAtoms"], "2");
        assert_eq!(incomplete["batches"], serde_json::json!([]));
    }
}
