import { mount } from 'svelte'
import './design/tokens.css'
import './design/ui.css'
import App from './App.svelte'
import { startClientLog } from './lib/clientLog'

startClientLog()

const app = mount(App, { target: document.getElementById('app')! })

export default app
