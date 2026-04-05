use serde::{Deserialize, Serialize};

// --- Enums ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Currency {
    Usd,
    Rub,
    Btc,
    Eur,
    Usdt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DealLevel {
    Handshake, // weight coefficient: 0.4
    Review,    // weight coefficient: 0.7
    Escrow,    // weight coefficient: 1.0 (Phase 2)
}

impl DealLevel {
    pub fn coefficient(&self) -> f64 {
        match self {
            DealLevel::Handshake => 0.4,
            DealLevel::Review => 0.7,
            DealLevel::Escrow => 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Positive,
    Neutral,
    Negative,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DealStatus {
    Initiated,               // initiator created the deal, awaiting delivery to counterparty
    PendingCounterparty,     // delivered, counterparty must fill their terms and respond
    PendingInitiator,        // counterparty responded, initiator must review and confirm
    InProgress,              // both parties confirmed, deal is executing
    Completed,               // deal closed, outcome recorded
    CancelledByInitiator,    // initiator cancelled before in_progress
    CancelledByCounterparty, // counterparty cancelled before in_progress
    Expired,                 // 24h window passed without reaching in_progress
    Disputed,                // one party contested the deal (Phase 2)
}

// --- Main struct ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deal {
    // Identity
    // Stored as hex strings in JSON (32-byte arrays are not valid JSON natively)
    #[serde(with = "hex_bytes_32")]
    pub id: [u8; 32],
    #[serde(with = "hex_bytes_32")]
    pub initiator_key: [u8; 32],
    #[serde(with = "hex_bytes_32")]
    pub counterparty_key: [u8; 32],

    // Timing
    pub timestamp: u64,   // unix seconds, set at creation
    pub expires_at: u64,  // timestamp + 86400 (24h), set at creation

    // Amount in original currency
    pub original_amount: f64,
    pub original_currency: Currency,

    // Equivalents frozen at deal creation time (from exchange rate oracle)
    pub amount_usd: f64,
    pub amount_rub: f64,
    pub amount_btc: f64,
    pub amount_eur: f64,
    pub amount_usdt: f64,

    // Deal metadata
    pub title: String,           // short human-readable name, e.g. "BMW wheels"
    pub level: DealLevel,
    pub status: DealStatus,
    pub outcome: Option<Outcome>, // None until status == Completed

    // Terms — what each party commits to do
    pub initiator_terms: String,             // filled at deal creation
    pub counterparty_terms: Option<String>,  // filled when counterparty responds

    // Review fields (only populated for DealLevel::Review)
    pub review_text: Option<String>,
    pub rating_quality: Option<u8>,       // 1–5
    pub rating_timing: Option<u8>,        // 1–5
    pub rating_communication: Option<u8>, // 1–5

    // Signatures (ed25519, 64 bytes each)
    #[serde(with = "hex_bytes_64_opt")]
    pub initiator_sig: Option<[u8; 64]>,
    #[serde(with = "hex_bytes_64_opt")]
    pub counterparty_sig: Option<[u8; 64]>,
}

impl Deal {
    /// Returns true if the deal has passed its expiry time.
    /// `now` is current unix timestamp in seconds (passed in from JS).
    pub fn is_expired(&self, now: u64) -> bool {
        now > self.expires_at
    }

    /// Returns the weighted contribution of this deal to the reputation score.
    /// Only meaningful when status == Completed.
    /// Positive: +amount * coefficient
    /// Neutral:  0
    /// Negative: -amount * coefficient * 1.5
    pub fn weighted_contribution(&self, currency: &Currency) -> f64 {
        let outcome = match &self.outcome {
            Some(o) => o,
            None => return 0.0,
        };

        let amount = match currency {
            Currency::Usd => self.amount_usd,
            Currency::Rub => self.amount_rub,
            Currency::Btc => self.amount_btc,
            Currency::Eur => self.amount_eur,
            Currency::Usdt => self.amount_usdt,
        };

        let coeff = self.level.coefficient();

        match outcome {
            Outcome::Positive => amount * coeff,
            Outcome::Neutral => 0.0,
            Outcome::Negative => -(amount * coeff * 1.5),
        }
    }
}

// --- Serde helpers for fixed-size byte arrays ---
//
// serde doesn't know how to encode [u8; 32] or [u8; 64] as hex strings by default.
// We define two small modules that tell serde: "encode as lowercase hex, decode from hex".
// Usage: #[serde(with = "hex_bytes_32")] on a [u8; 32] field.

mod hex_bytes_32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let hex_str = String::deserialize(d)?;
        let bytes = hex::decode(&hex_str).map_err(serde::de::Error::custom)?;
        bytes.try_into().map_err(|_| serde::de::Error::custom("expected 32 bytes"))
    }
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;

    // Builds a minimal Deal with sensible defaults for testing.
    // Fields not relevant to a specific test are set to zero/None.
    fn make_deal(level: DealLevel, outcome: Option<Outcome>, amount: f64) -> Deal {
        Deal {
            id: [1u8; 32],
            initiator_key: [2u8; 32],
            counterparty_key: [3u8; 32],
            timestamp: 1_000_000,
            expires_at: 1_086_400, // timestamp + 24h
            original_amount: amount,
            original_currency: Currency::Usd,
            amount_usd: amount,
            amount_rub: amount * 90.0,
            amount_btc: amount * 0.000015,
            amount_eur: amount * 0.92,
            amount_usdt: amount,
            title: "Test deal".to_string(),
            level,
            status: DealStatus::Completed,
            outcome,
            initiator_terms: "Deliver 10 units by Friday".to_string(),
            counterparty_terms: Some("Pay $100 on delivery".to_string()),
            review_text: None,
            rating_quality: None,
            rating_timing: None,
            rating_communication: None,
            initiator_sig: None,
            counterparty_sig: None,
        }
    }

    // --- is_expired ---

    #[test]
    fn not_expired_before_deadline() {
        let deal = make_deal(DealLevel::Handshake, None, 100.0);
        assert!(!deal.is_expired(1_000_001)); // one second after creation, still valid
    }

    #[test]
    fn expired_after_deadline() {
        let deal = make_deal(DealLevel::Handshake, None, 100.0);
        assert!(deal.is_expired(1_086_401)); // one second past expires_at
    }

    #[test]
    fn not_expired_exactly_at_deadline() {
        let deal = make_deal(DealLevel::Handshake, None, 100.0);
        // expires_at = 1_086_400, now = 1_086_400 → not expired (strictly greater)
        assert!(!deal.is_expired(1_086_400));
    }

    // --- weighted_contribution ---

    #[test]
    fn positive_handshake_contribution() {
        let deal = make_deal(DealLevel::Handshake, Some(Outcome::Positive), 100.0);
        // 100 * 0.4 = 40.0
        assert!((deal.weighted_contribution(&Currency::Usd) - 40.0).abs() < f64::EPSILON);
    }

    #[test]
    fn positive_review_contribution() {
        let deal = make_deal(DealLevel::Review, Some(Outcome::Positive), 100.0);
        // 100 * 0.7 = 70.0
        assert!((deal.weighted_contribution(&Currency::Usd) - 70.0).abs() < f64::EPSILON);
    }

    #[test]
    fn neutral_contributes_zero() {
        let deal = make_deal(DealLevel::Handshake, Some(Outcome::Neutral), 100.0);
        assert_eq!(deal.weighted_contribution(&Currency::Usd), 0.0);
    }

    #[test]
    fn negative_applies_penalty_multiplier() {
        let deal = make_deal(DealLevel::Handshake, Some(Outcome::Negative), 100.0);
        // -(100 * 0.4 * 1.5) = -60.0
        assert!((deal.weighted_contribution(&Currency::Usd) - (-60.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn no_outcome_contributes_zero() {
        let deal = make_deal(DealLevel::Handshake, None, 100.0);
        assert_eq!(deal.weighted_contribution(&Currency::Usd), 0.0);
    }

    #[test]
    fn contribution_uses_correct_currency_column() {
        let deal = make_deal(DealLevel::Handshake, Some(Outcome::Positive), 100.0);
        // amount_rub = 100 * 90 = 9000, contribution = 9000 * 0.4 = 3600
        assert!((deal.weighted_contribution(&Currency::Rub) - 3600.0).abs() < f64::EPSILON);
    }

    // --- serde round-trip ---

    #[test]
    fn serde_round_trip_no_signatures() {
        let original = make_deal(DealLevel::Review, Some(Outcome::Positive), 250.0);
        let json = serde_json::to_string(&original).expect("serialization failed");
        let restored: Deal = serde_json::from_str(&json).expect("deserialization failed");

        assert_eq!(restored.id, original.id);
        assert_eq!(restored.initiator_key, original.initiator_key);
        assert_eq!(restored.counterparty_key, original.counterparty_key);
        assert_eq!(restored.amount_usd, original.amount_usd);
        assert_eq!(restored.level, original.level);
        assert_eq!(restored.outcome, original.outcome);
        assert_eq!(restored.initiator_sig, None);
        assert_eq!(restored.counterparty_sig, None);
    }

    #[test]
    fn serde_round_trip_with_signatures() {
        let mut deal = make_deal(DealLevel::Handshake, Some(Outcome::Positive), 50.0);
        deal.initiator_sig = Some([0xABu8; 64]);
        deal.counterparty_sig = Some([0xCDu8; 64]);

        let json = serde_json::to_string(&deal).expect("serialization failed");
        let restored: Deal = serde_json::from_str(&json).expect("deserialization failed");

        assert_eq!(restored.initiator_sig, Some([0xABu8; 64]));
        assert_eq!(restored.counterparty_sig, Some([0xCDu8; 64]));
    }

    #[test]
    fn hex_keys_appear_in_json() {
        let deal = make_deal(DealLevel::Handshake, None, 10.0);
        let json = serde_json::to_string(&deal).expect("serialization failed");
        // id = [1u8; 32] → 64 hex chars of "01"
        assert!(json.contains("0101010101010101010101010101010101010101010101010101010101010101"));
    }

    #[test]
    fn enum_variants_serialized_as_lowercase() {
        let deal = make_deal(DealLevel::Review, Some(Outcome::Negative), 10.0);
        let json = serde_json::to_string(&deal).expect("serialization failed");
        assert!(json.contains("\"review\""));
        assert!(json.contains("\"negative\""));
        assert!(json.contains("\"completed\""));
    }

    #[test]
    fn pending_initiator_serializes_as_snake_case() {
        let mut deal = make_deal(DealLevel::Handshake, None, 50.0);
        deal.status = DealStatus::PendingInitiator;
        let json = serde_json::to_string(&deal).expect("serialization failed");
        assert!(json.contains("\"pending_initiator\""));
    }

    #[test]
    fn cancelled_and_expired_statuses_serialize_correctly() {
        let mut deal = make_deal(DealLevel::Handshake, None, 50.0);

        deal.status = DealStatus::CancelledByInitiator;
        let json = serde_json::to_string(&deal).unwrap();
        assert!(json.contains("\"cancelled_by_initiator\""));

        deal.status = DealStatus::CancelledByCounterparty;
        let json = serde_json::to_string(&deal).unwrap();
        assert!(json.contains("\"cancelled_by_counterparty\""));

        deal.status = DealStatus::Expired;
        let json = serde_json::to_string(&deal).unwrap();
        assert!(json.contains("\"expired\""));
    }
}

mod hex_bytes_64_opt {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(val: &Option<[u8; 64]>, s: S) -> Result<S::Ok, S::Error> {
        match val {
            Some(bytes) => s.serialize_some(&hex::encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<[u8; 64]>, D::Error> {
        let opt = Option::<String>::deserialize(d)?;
        match opt {
            None => Ok(None),
            Some(hex_str) => {
                let bytes = hex::decode(&hex_str).map_err(serde::de::Error::custom)?;
                let arr: [u8; 64] = bytes
                    .try_into()
                    .map_err(|_| serde::de::Error::custom("expected 64 bytes"))?;
                Ok(Some(arr))
            }
        }
    }
}
