use std::collections::HashSet;
use serde::Serialize;
use crate::deal::{Currency, Deal, DealStatus, Outcome};

// ─── Result struct ────────────────────────────────────────────────────────────

/// Aggregated reputation stats for one user across all their completed deals.
/// Returned by `compute_reputation` and serialized to JSON for the WebView.
#[derive(Debug, Serialize)]
pub struct ReputationStats {
    /// Net weighted volume: positive_volume − negative_volume.
    /// The single number that represents economic trust earned.
    pub total_volume: f64,

    /// Sum of weighted contributions from positively-rated deals.
    pub positive_volume: f64,

    /// Sum of absolute weighted contributions from negatively-rated deals (always ≥ 0).
    /// Stored as a positive number so the UI can display "penalty" separately.
    pub negative_volume: f64,

    /// Success rate 0..100: positive_volume / (positive_volume + negative_volume) × 100.
    /// None when there are no deals with a non-neutral outcome (avoid division by zero).
    pub success_rate: Option<f64>,

    /// Total number of Completed deals (regardless of outcome).
    pub deal_count: usize,

    /// Breakdown by outcome type.
    pub positive_count: usize,
    pub neutral_count: usize,
    pub negative_count: usize,

    /// Number of unique counterparties across all completed deals.
    /// Stored for anti-sybil analysis (Phase 2) — detects reputation farming
    /// via repeated deals with a small circle of colluding peers.
    pub unique_counterparties: usize,
}

// ─── Core calculation ─────────────────────────────────────────────────────────

/// Compute reputation stats for the user identified by `my_public_key` (hex string)
/// from the given slice of deals.
///
/// Only `Completed` deals contribute. Deals where `my_public_key` matches neither
/// party are silently skipped (shouldn't happen in practice, but safe to ignore).
///
/// `currency` controls which frozen amount column is used for weighting
/// (USD, RUB, BTC, EUR, USDT — all recorded at deal creation time).
pub fn compute_reputation(deals: &[Deal], my_public_key: &str, currency: &Currency) -> ReputationStats {
    // Decode my public key once — if invalid hex, no deals will match and we return zeroes.
    let my_key: Option<[u8; 32]> = hex::decode(my_public_key)
        .ok()
        .and_then(|b| b.try_into().ok());

    let mut positive_volume: f64 = 0.0;
    let mut negative_volume: f64 = 0.0;
    let mut deal_count    = 0usize;
    let mut positive_count = 0usize;
    let mut neutral_count  = 0usize;
    let mut negative_count = 0usize;
    let mut counterparty_keys: HashSet<[u8; 32]> = HashSet::new();

    for deal in deals {
        // Only completed deals affect reputation.
        if deal.status != DealStatus::Completed {
            continue;
        }

        // Determine our role by comparing public keys.
        let subject = match &my_key {
            Some(k) if *k == deal.initiator_key    => "initiator",
            Some(k) if *k == deal.counterparty_key => "counterparty",
            _ => continue, // not our deal — skip
        };

        deal_count += 1;

        // Track the other party's key for unique counterparty count.
        let peer_key = match subject {
            "initiator"    => deal.counterparty_key,
            "counterparty" => deal.initiator_key,
            _              => unreachable!(),
        };
        counterparty_keys.insert(peer_key);

        // The peer's outcome field rates us — same convention as weighted_contribution.
        let our_outcome = match subject {
            "initiator"    => deal.counterparty_outcome.as_ref(),
            "counterparty" => deal.initiator_outcome.as_ref(),
            _              => None,
        };

        match our_outcome {
            Some(Outcome::Positive) => {
                let contrib = deal.weighted_contribution(subject, currency);
                positive_volume += contrib;
                positive_count  += 1;
            }
            Some(Outcome::Neutral) => {
                neutral_count += 1;
                // neutral contributes 0 to volume — counted but not weighted
            }
            Some(Outcome::Negative) => {
                let contrib = deal.weighted_contribution(subject, currency);
                // weighted_contribution returns a negative number for Negative outcomes
                negative_volume += -contrib; // store as positive magnitude
                negative_count  += 1;
            }
            None => {
                // outcome not yet set — shouldn't happen for Completed deals, skip
            }
        }
    }

    let total_volume = positive_volume - negative_volume;

    // success_rate is None when there's nothing to compute (avoids showing "0%" for new users)
    let success_rate = if positive_volume + negative_volume > 0.0 {
        Some(positive_volume / (positive_volume + negative_volume) * 100.0)
    } else {
        None
    };

    ReputationStats {
        total_volume,
        positive_volume,
        negative_volume,
        success_rate,
        deal_count,
        positive_count,
        neutral_count,
        negative_count,
        unique_counterparties: counterparty_keys.len(),
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deal::{DealLevel, DealStatus, Outcome};

    const INITIATOR_KEY: &str = "0202020202020202020202020202020202020202020202020202020202020202";
    const COUNTERPARTY_KEY: &str = "0303030303030303030303030303030303030303030303030303030303030303";

    fn make_deal(
        initiator_outcome: Option<Outcome>,
        counterparty_outcome: Option<Outcome>,
        amount_usd: f64,
        level: DealLevel,
        status: DealStatus,
    ) -> Deal {
        Deal {
            id: [1u8; 32],
            initiator_key: [2u8; 32],
            counterparty_key: [3u8; 32],
            timestamp: 1_000_000,
            expires_at: 1_086_400,
            original_amount: amount_usd,
            original_currency: Currency::Usd,
            amount_usd,
            amount_rub: amount_usd * 90.0,
            amount_btc: amount_usd * 0.000015,
            amount_eur: amount_usd * 0.92,
            amount_usdt: amount_usd,
            title: "Test".to_string(),
            level,
            status,
            initiator_outcome,
            counterparty_outcome,
            initiator_outcome_comment: None,
            counterparty_outcome_comment: None,
            initiator_terms: "Do X".to_string(),
            counterparty_terms: Some("Do Y".to_string()),
            review_text: None,
            rating_quality: None,
            rating_timing: None,
            rating_communication: None,
            initiator_sig: None,
            counterparty_sig: None,
        }
    }

    #[test]
    fn no_deals_returns_zeroes() {
        let stats = compute_reputation(&[], INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.deal_count, 0);
        assert_eq!(stats.total_volume, 0.0);
        assert!(stats.success_rate.is_none());
    }

    #[test]
    fn non_completed_deals_are_ignored() {
        let deal = make_deal(Some(Outcome::Positive), Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::InProgress);
        let stats = compute_reputation(&[deal], INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.deal_count, 0);
    }

    #[test]
    fn initiator_positive_outcome() {
        // counterparty_outcome rates the initiator → Positive
        let deal = make_deal(Some(Outcome::Positive), Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[deal], INITIATOR_KEY, &Currency::Usd);
        // initiator's contribution = counterparty_outcome = Positive → 100 * 0.4 = 40
        assert_eq!(stats.positive_volume, 40.0);
        assert_eq!(stats.total_volume, 40.0);
        assert_eq!(stats.positive_count, 1);
        assert_eq!(stats.success_rate, Some(100.0));
    }

    #[test]
    fn initiator_negative_outcome() {
        // counterparty rates initiator as Negative
        let deal = make_deal(None, Some(Outcome::Negative), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[deal], INITIATOR_KEY, &Currency::Usd);
        // negative contribution = -(100 * 0.4 * 1.5) = -60 → negative_volume = 60
        assert_eq!(stats.negative_volume, 60.0);
        assert_eq!(stats.total_volume, -60.0);
        assert_eq!(stats.negative_count, 1);
        assert_eq!(stats.success_rate, Some(0.0));
    }

    #[test]
    fn neutral_outcome_does_not_affect_volume() {
        let deal = make_deal(None, Some(Outcome::Neutral), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[deal], INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.deal_count, 1);
        assert_eq!(stats.total_volume, 0.0);
        assert_eq!(stats.neutral_count, 1);
        assert!(stats.success_rate.is_none()); // no positive or negative — None
    }

    #[test]
    fn success_rate_mixed_outcomes() {
        // positive: 100 * 0.4 = 40
        // negative: 100 * 0.4 * 1.5 = 60 → negative_volume = 60
        // success_rate = 40 / (40 + 60) = 40%
        let d1 = make_deal(None, Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let d2 = make_deal(None, Some(Outcome::Negative), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[d1, d2], INITIATOR_KEY, &Currency::Usd);
        assert!((stats.success_rate.unwrap() - 40.0).abs() < 0.001);
    }

    #[test]
    fn unknown_key_gets_zero_stats() {
        let deal = make_deal(Some(Outcome::Positive), Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let unknown_key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let stats = compute_reputation(&[deal], unknown_key, &Currency::Usd);
        assert_eq!(stats.deal_count, 0);
    }

    #[test]
    fn unique_counterparties_counted() {
        // Two deals with different counterparties → 2 unique
        let d1 = make_deal(None, Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        // d2: initiator_key stays [2u8;32], but counterparty_key = [4u8;32] — different peer
        let mut d2 = make_deal(None, Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        d2.counterparty_key = [4u8; 32];
        let stats = compute_reputation(&[d1, d2], INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.unique_counterparties, 2);
    }

    #[test]
    fn same_counterparty_counted_once() {
        let d1 = make_deal(None, Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let d2 = make_deal(None, Some(Outcome::Positive), 50.0, DealLevel::Handshake, DealStatus::Completed);
        // both deals have the same counterparty_key = [3u8;32]
        let stats = compute_reputation(&[d1, d2], INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.unique_counterparties, 1);
    }

    #[test]
    fn counterparty_perspective() {
        // initiator_outcome rates the counterparty → Positive
        let deal = make_deal(Some(Outcome::Positive), None, 100.0, DealLevel::Review, DealStatus::Completed);
        let stats = compute_reputation(&[deal], COUNTERPARTY_KEY, &Currency::Usd);
        // counterparty's contribution = initiator_outcome = Positive → 100 * 0.7 = 70
        assert_eq!(stats.positive_volume, 70.0);
    }
}
