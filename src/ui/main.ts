import { mount } from 'svelte'
import App from './App.svelte'

// Mount the Svelte app into <div id="app"> in index.html
const app = mount(App, { target: document.getElementById('app')! })

export default app
