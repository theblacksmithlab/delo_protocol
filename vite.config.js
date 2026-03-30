import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  plugins: [
    // vite-plugin-wasm: handles .wasm imports as ES modules
    wasm(),
    // vite-plugin-top-level-await: allows await at module top level (needed for WASM init)
    topLevelAwait(),
    svelte()
  ],
  build: {
    // esnext target required for WASM and modern JS features
    target: 'esnext',
    outDir: 'dist'
  },
  // base: './' makes Vite emit relative asset paths (./assets/...)
  // instead of absolute (/assets/...) — required for file:// loading in Pear
  base: './'
})
