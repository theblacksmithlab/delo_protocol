use wasm_bindgen::prelude::*;

pub mod deal;
pub mod reputation;

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Delo Protocol core is running.", name)
}

/// Calculate reputation stats for a user from their completed deal log.
///
/// Arguments (all strings, easy to call from JS):
///   deals_json   — JSON array of Deal objects (from /api/get-deal-log)
///   my_public_key — hex-encoded 32-byte public key of the user we're computing for
///   currency      — "usd" | "rub" | "btc" | "eur" | "usdt"
///
/// Returns a JS object:
///   { total_volume, positive_volume, negative_volume, success_rate,
///     deal_count, positive_count, neutral_count, negative_count }
/// Returns null if deals_json cannot be parsed.
#[wasm_bindgen]
pub fn calculate_reputation(deals_json: &str, my_public_key: &str, currency: &str) -> JsValue {
    let currency = match currency.to_lowercase().as_str() {
        "rub"  => deal::Currency::Rub,
        "btc"  => deal::Currency::Btc,
        "eur"  => deal::Currency::Eur,
        "usdt" => deal::Currency::Usdt,
        _      => deal::Currency::Usd, // default to USD
    };

    let deals: Vec<deal::Deal> = match serde_json::from_str(deals_json) {
        Ok(d)  => d,
        Err(_) => return JsValue::NULL,
    };

    let stats = reputation::compute_reputation(&deals, my_public_key, &currency);

    serde_wasm_bindgen::to_value(&stats).unwrap_or(JsValue::NULL)
}
