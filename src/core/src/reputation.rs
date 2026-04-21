use std::collections::HashSet;
use serde::Serialize;
use crate::deal::{Currency, Deal, DealStatus, Outcome};

// ─── Result struct ────────────────────────────────────────────────────────────

/// Aggregated reputation stats for one user across all their completed deals.
/// Returned by `compute_reputation` and serialized to JSON for the WebView.
#[derive(Debug, Serialize)]
pub struct ReputationStats {
    /// Raw sum of all completed deal amounts (positive + neutral + negative).
    /// No coefficients applied — the actual economic value that passed through this user.
    pub total_volume: f64,

    /// Sum of raw amounts from positively-rated deals (no coefficients).
    pub positive_volume: f64,

    /// Sum of raw amounts from negatively-rated deals (no coefficients, always ≥ 0).
    pub negative_volume: f64,

    /// Success rate 0..100: positive_count / (positive_count + negative_count) × 100.
    /// Count-based (not volume-based). None when no non-neutral deals exist.
    pub success_rate: Option<f64>,

    /// Color sentiment: 0.0 = fully red, 0.5 = neutral/white, 1.0 = fully green.
    /// Geometric mean of count_ratio and amount_ratio — both factors must be good
    /// to reach green. Used by the UI to tint the trust volume number.
    pub sentiment: f64,

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

    let mut total_volume:    f64 = 0.0;
    let mut positive_volume: f64 = 0.0;
    let mut negative_volume: f64 = 0.0;
    let mut deal_count     = 0usize;
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

        // The peer's outcome field rates us.
        let our_outcome = match subject {
            "initiator"    => deal.counterparty_outcome.as_ref(),
            "counterparty" => deal.initiator_outcome.as_ref(),
            _              => None,
        };

        // Skip if outcome not set — shouldn't happen for Completed deals.
        let Some(outcome) = our_outcome else { continue };

        deal_count += 1;

        // Track the other party's key for unique counterparty count.
        let peer_key = match subject {
            "initiator"    => deal.counterparty_key,
            "counterparty" => deal.initiator_key,
            _              => unreachable!(),
        };
        counterparty_keys.insert(peer_key);

        // Raw deal amount in the viewer's preferred currency (no coefficients).
        let amount = match currency {
            Currency::Usd  => deal.amount_usd,
            Currency::Rub  => deal.amount_rub,
            Currency::Btc  => deal.amount_btc,
            Currency::Eur  => deal.amount_eur,
            Currency::Usdt => deal.amount_usdt,
        };

        // All deals (including neutral) contribute to total volume.
        total_volume += amount;

        match outcome {
            Outcome::Positive => { positive_volume += amount; positive_count += 1; }
            Outcome::Neutral  => { neutral_count += 1; }
            Outcome::Negative => { negative_volume += amount; negative_count += 1; }
        }
    }

    // Count-based success rate — neutral deals are excluded.
    // None when there are no rated (non-neutral) deals.
    let success_rate = if positive_count + negative_count > 0 {
        Some(positive_count as f64 / (positive_count + negative_count) as f64 * 100.0)
    } else {
        None
    };

    // Sentiment: geometric mean of count_ratio and amount_ratio.
    // 0.0 = all negative (red), 0.5 = balanced/neutral (white), 1.0 = all positive (green).
    // Both factors must be good to reach green — if either is bad, it pulls the result down.
    // 0.5 is returned when there are no rated deals (neutral color for new users).
    let sentiment = if positive_count + negative_count == 0 {
        0.5
    } else {
        let count_ratio = positive_count as f64 / (positive_count + negative_count) as f64;
        let amount_ratio = if positive_volume + negative_volume > 0.0 {
            positive_volume / (positive_volume + negative_volume)
        } else {
            0.5
        };
        (count_ratio * amount_ratio).sqrt()
    };

    ReputationStats {
        total_volume,
        positive_volume,
        negative_volume,
        success_rate,
        sentiment,
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
        // raw amount, no coefficients
        assert_eq!(stats.positive_volume, 100.0);
        assert_eq!(stats.total_volume, 100.0);
        assert_eq!(stats.positive_count, 1);
        assert_eq!(stats.success_rate, Some(100.0));
        // fully positive → sentiment = sqrt(1.0 * 1.0) = 1.0
        assert!((stats.sentiment - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn initiator_negative_outcome() {
        // counterparty rates initiator as Negative
        let deal = make_deal(None, Some(Outcome::Negative), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[deal], INITIATOR_KEY, &Currency::Usd);
        // raw amount, no penalty multiplier
        assert_eq!(stats.negative_volume, 100.0);
        assert_eq!(stats.total_volume, 100.0);
        assert_eq!(stats.negative_count, 1);
        assert_eq!(stats.success_rate, Some(0.0));
        // fully negative → sentiment = sqrt(0.0 * 0.0) = 0.0
        assert!((stats.sentiment - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn neutral_outcome_counts_in_total_volume() {
        let deal = make_deal(None, Some(Outcome::Neutral), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[deal], INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.deal_count, 1);
        // neutral deals still add to total_volume
        assert_eq!(stats.total_volume, 100.0);
        assert_eq!(stats.positive_volume, 0.0);
        assert_eq!(stats.negative_volume, 0.0);
        assert_eq!(stats.neutral_count, 1);
        assert!(stats.success_rate.is_none()); // no positive or negative — None
        // no rated deals → sentiment defaults to 0.5
        assert!((stats.sentiment - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn success_rate_mixed_outcomes() {
        // count-based: 1 positive + 1 negative → 50%
        let d1 = make_deal(None, Some(Outcome::Positive), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let d2 = make_deal(None, Some(Outcome::Negative), 100.0, DealLevel::Handshake, DealStatus::Completed);
        let stats = compute_reputation(&[d1, d2], INITIATOR_KEY, &Currency::Usd);
        assert!((stats.success_rate.unwrap() - 50.0).abs() < 0.001);
        // equal amounts, equal counts → sentiment = sqrt(0.5 * 0.5) = 0.5
        assert!((stats.sentiment - 0.5).abs() < 0.001);
    }

    #[test]
    fn sentiment_big_positive_many_small_negatives() {
        // 1 positive $1000, 10 negative $1 each
        // count_ratio  = 1/11 ≈ 0.0909
        // amount_ratio = 1000/1010 ≈ 0.9901
        // sentiment    = sqrt(0.0909 * 0.9901) ≈ 0.300 → reddish
        let pos = make_deal(None, Some(Outcome::Positive), 1000.0, DealLevel::Handshake, DealStatus::Completed);
        let mut deals = vec![pos];
        for _ in 0..10 {
            deals.push(make_deal(None, Some(Outcome::Negative), 1.0, DealLevel::Handshake, DealStatus::Completed));
        }
        let stats = compute_reputation(&deals, INITIATOR_KEY, &Currency::Usd);
        assert_eq!(stats.total_volume, 1010.0);
        assert_eq!(stats.positive_count, 1);
        assert_eq!(stats.negative_count, 10);
        assert!((stats.sentiment - 0.300).abs() < 0.01); // reddish
    }

    #[test]
    fn sentiment_big_negative_many_small_positives() {
        // 10 positive $1, 1 negative $1000
        // count_ratio  = 10/11 ≈ 0.909
        // amount_ratio = 10/1010 ≈ 0.0099
        // sentiment    = sqrt(0.909 * 0.0099) ≈ 0.095 → very red
        let neg = make_deal(None, Some(Outcome::Negative), 1000.0, DealLevel::Handshake, DealStatus::Completed);
        let mut deals = vec![neg];
        for _ in 0..10 {
            deals.push(make_deal(None, Some(Outcome::Positive), 1.0, DealLevel::Handshake, DealStatus::Completed));
        }
        let stats = compute_reputation(&deals, INITIATOR_KEY, &Currency::Usd);
        assert!(stats.sentiment < 0.15); // very red
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
        // raw amount, no coefficient — deal level doesn't affect volume display
        assert_eq!(stats.positive_volume, 100.0);
        assert_eq!(stats.total_volume, 100.0);
    }
}
