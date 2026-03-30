use wasm_bindgen::prelude::*;

// #[wasm_bindgen] exposes this function to JavaScript.
// String return type is automatically converted to JS string.
#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Trust Protocol core is running.", name)
}
