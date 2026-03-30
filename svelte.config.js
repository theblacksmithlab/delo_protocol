import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  // vitePreprocess handles TypeScript inside <script lang="ts"> blocks
  preprocess: vitePreprocess()
}
