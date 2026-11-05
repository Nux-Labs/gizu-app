//! Immutable all-invest distribution policy. Native persisted-cycle validation
//! supplies this metadata; the bridge must never choose signing slots or weights.
use crate::{SignerError, address};
use alloy_primitives::U256;
use bip32::{DerivationPath, XPrv};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EarnDistribution {
    version: u32,
    weights_bps: Vec<u32>,
}
impl EarnDistribution {
    fn validate(&self) -> Result<(), SignerError> {
        if self.version != 1
            || !(1..=5).contains(&self.weights_bps.len())
            || self.weights_bps.iter().any(|w| *w == 0 || *w > 10000)
            || self.weights_bps.iter().map(|w| u64::from(*w)).sum::<u64>() != 10000
        {
            return Err(SignerError::InvalidInput);
        }
        Ok(())
    }
    pub(crate) fn review(&self) -> String {
        format!(
            "Distribution v1: all-invest weights [{}] in slot order",
            self.weights_bps
                .iter()
                .map(|w| format!("{w} bps"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
    pub(crate) fn slot(&self, leg: &str) -> Result<u32, SignerError> {
        self.validate()?;
        (0..self.weights_bps.len())
            .find(|slot| leg == format!("invest:{slot}"))
            .map(|slot| slot as u32)
            .ok_or(SignerError::InvalidInput)
    }
    fn cumulative(&self, total: U256) -> Vec<U256> {
        let base = U256::from(10000);
        let mut remaining = total;
        self.weights_bps
            .iter()
            .enumerate()
            .map(|(slot, weight)| {
                if slot + 1 == self.weights_bps.len() {
                    return remaining;
                }
                // Quotient/remainder avoids overflowing total * weight near U256::MAX.
                let weight = U256::from(*weight);
                let allocation = total / base * weight + (total % base * weight) / base;
                remaining -= allocation;
                allocation
            })
            .collect()
    }
    pub(crate) fn allocations(&self, credit: U256, offset: U256) -> Result<Vec<U256>, SignerError> {
        self.validate()?;
        let end = offset
            .checked_add(credit)
            .ok_or(SignerError::InvalidInput)?;
        self.cumulative(end)
            .into_iter()
            .zip(self.cumulative(offset))
            .map(|(after, before)| {
                after
                    .checked_sub(before)
                    .filter(|n| !n.is_zero())
                    .ok_or(SignerError::InvalidInput)
            })
            .collect()
    }
}
fn decimal(value: &str) -> Result<U256, SignerError> {
    if value.is_empty()
        || value.len() > 78
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(SignerError::InvalidInput);
    }
    U256::from_str_radix(value, 10).map_err(|_| SignerError::InvalidInput)
}
/// Exact per-source input allocations in persisted slot order. Rejects zero or
/// negative children; callers must never reroll or redistribute an invalid plan.
#[uniffi::export]
pub fn earn_distribution_allocations(
    distribution: String,
    credited_atoms: String,
    split_offset_atoms: String,
) -> Result<Vec<String>, SignerError> {
    if distribution.len() > 1024 {
        return Err(SignerError::InvalidInput);
    }
    let plan: EarnDistribution =
        serde_json::from_str(&distribution).map_err(|_| SignerError::InvalidInput)?;
    Ok(plan
        .allocations(decimal(&credited_atoms)?, decimal(&split_offset_atoms)?)?
        .iter()
        .map(ToString::to_string)
        .collect())
}

/// Public addresses only. The original entropy backup recovers all saved slots.
#[uniffi::export]
pub fn derive_earn_distribution_addresses(
    entropy: Vec<u8>,
    chain_id: u64,
    cycle_index: u32,
    count: u32,
) -> Result<Vec<String>, SignerError> {
    if !(1..=5).contains(&count) {
        return Err(SignerError::InvalidInput);
    }
    let seed = crate::roles::seed_from_entropy(entropy)?;
    (0..count)
        .map(|slot| {
            earn_investment_key(&seed, chain_id, cycle_index, Some(slot))
                .map(|key| address(key.private_key().verifying_key()))
        })
        .collect()
}

/// `None` is exactly the historical investment role. Slots select the separate
/// distribution domain, never a public funding or confidential identity.
pub(crate) fn earn_investment_key(
    seed: &[u8; 64],
    chain_id: u64,
    cycle_index: u32,
    slot: Option<u32>,
) -> Result<XPrv, SignerError> {
    let Some(slot) = slot else {
        return crate::earn_cycle_key(seed, chain_id, cycle_index, 1);
    };
    if ![1, 4663].contains(&chain_id) || slot > 4 {
        return Err(SignerError::InvalidInput);
    }
    let index = cycle_index
        .checked_mul(8)
        .and_then(|n| n.checked_add(slot))
        .filter(|n| *n <= 0x7fff_ffff)
        .ok_or(SignerError::InvalidInput)?;
    let path: DerivationPath = format!("m/44'/60'/145'/{chain_id}'/{index}")
        .parse()
        .map_err(|_| SignerError::InvalidInput)?;
    XPrv::derive_from_path(seed, &path).map_err(|_| SignerError::CryptoFailed)
}
