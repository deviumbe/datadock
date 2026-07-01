<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'
import type { AiProvider } from '@shared/types'
import deviumLogo from '../assets/devium-logo.png'

const settings = useSettings()
const ui = useUi()
const emit = defineEmits<{ close: [] }>()

type Section = 'ai' | 'appearance' | 'mcp' | 'about'
const section = ref<Section>('ai')

const appVersion = ref('0.1.0')
onMounted(async () => {
  if (!settings.loaded) void settings.load()
  void settings.loadMcp()
  try {
    appVersion.value = await window.api.getVersion()
  } catch {
    /* keep fallback */
  }
})

// Per-provider draft inputs (key never comes back from main, so it starts blank).
const keyDraft = reactive<Record<string, string>>({})
const modelDraft = reactive<Record<string, string>>({})
const urlDraft = reactive<Record<string, string>>({})
const testState = reactive<Record<string, 'idle' | 'testing' | 'ok' | 'fail'>>({})
const testMsg = reactive<Record<string, string>>({})
// Auto-detected model lists per provider (populated by the "Detect" button).
const models = reactive<Record<string, string[]>>({})
const detectState = reactive<Record<string, 'idle' | 'loading' | 'fail'>>({})
const detectMsg = reactive<Record<string, string>>({})

// Turn raw provider/SDK errors into something a human can act on.
function humanizeAiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(msg))
    return 'Rate limit / quota exceeded (429). Wait a moment, or check your plan & quota with the provider.'
  if (/\b401\b|unauthor|invalid.*key|api key/i.test(msg))
    return 'Unauthorized (401) — the API key looks invalid or lacks access.'
  if (/\b403\b|permission|forbidden/i.test(msg))
    return 'Forbidden (403) — the key is valid but not permitted for this model/endpoint.'
  if (/\b404\b/.test(msg) || (/not.?found/i.test(msg) && /model/i.test(msg)))
    return 'Model not found (404) — pick a different model (try Detect).'
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(msg))
    return 'Could not reach the provider — check your connection (or that Ollama is running).'
  return msg
}

async function detectModels(p: AiProvider): Promise<void> {
  detectState[p] = 'loading'
  detectMsg[p] = ''
  try {
    models[p] = await settings.listModels(p)
    detectState[p] = 'idle'
    if (!models[p].length) detectMsg[p] = 'No models returned for this provider.'
  } catch (e) {
    detectState[p] = 'fail'
    detectMsg[p] = humanizeAiError(e)
  }
}

const providers = computed(() => settings.providers)

async function saveKey(p: AiProvider): Promise<void> {
  const v = keyDraft[p]?.trim()
  if (!v) return
  await settings.setProviderKey(p, v)
  keyDraft[p] = ''
}
async function clearKey(p: AiProvider): Promise<void> {
  await settings.clearProviderKey(p)
}
async function saveModel(p: AiProvider): Promise<void> {
  if (modelDraft[p] !== undefined) await settings.setProviderConfig(p, { model: modelDraft[p] })
}
async function saveUrl(p: AiProvider): Promise<void> {
  if (urlDraft[p] !== undefined) await settings.setProviderConfig(p, { baseUrl: urlDraft[p] })
}
async function makeActive(p: AiProvider): Promise<void> {
  await settings.setActiveProvider(p)
}
async function test(p: AiProvider): Promise<void> {
  testState[p] = 'testing'
  testMsg[p] = ''
  try {
    await settings.testProvider(p)
    testState[p] = 'ok'
    testMsg[p] = 'Connection OK'
  } catch (e) {
    testState[p] = 'fail'
    testMsg[p] = humanizeAiError(e)
  }
}

// Appearance
const scalePct = computed({
  get: () => Math.round(settings.appearance.fontScale * 100),
  set: (v: number) => void settings.setAppearance({ fontScale: v / 100 })
})
function setDensity(d: 'comfortable' | 'compact'): void {
  void settings.setAppearance({ density: d })
}
function setPageSize(n: number): void {
  void settings.setAppearance({ pageSize: n })
}

// MCP server
const mcp = computed(() => settings.mcp)
const portDraft = ref<number | null>(null)
const tokenShown = ref(false)
const copied = ref('')

const mcpCommand = computed(() => {
  const m = mcp.value
  if (!m) return ''
  return (
    `claude mcp add --transport http datadock ` +
    `http://127.0.0.1:${m.port}/mcp ` +
    `--header "Authorization: Bearer ${m.token}"`
  )
})

async function toggleMcp(): Promise<void> {
  await settings.setMcpEnabled(!mcp.value?.enabled)
}
async function saveMcpPort(): Promise<void> {
  if (portDraft.value && portDraft.value !== mcp.value?.port) {
    await settings.setMcpConfig({ port: portDraft.value })
  }
  portDraft.value = null
}
async function toggleMcpWrites(): Promise<void> {
  await settings.setMcpConfig({ allowWrites: !mcp.value?.allowWrites })
}
async function regenMcpToken(): Promise<void> {
  await settings.regenerateMcpToken()
}
async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = what
    setTimeout(() => (copied.value = ''), 1500)
  } catch {
    /* clipboard unavailable */
  }
}

</script>

<template>
  <Teleport to="body">
    <div class="overlay" @mousedown.self="emit('close')">
      <div class="settings">
        <nav class="nav">
          <div class="nav-title">Settings</div>
          <button :class="{ on: section === 'ai' }" @click="section = 'ai'">✨ AI Providers</button>
          <button :class="{ on: section === 'appearance' }" @click="section = 'appearance'">🎨 Appearance</button>
          <button :class="{ on: section === 'mcp' }" @click="section = 'mcp'">🔌 MCP Server</button>
          <button :class="{ on: section === 'about' }" @click="section = 'about'">ℹ️ About</button>
          <div class="nav-spacer" />
          <button class="close-x" @click="emit('close')">Close ✕</button>
        </nav>

        <div class="panel">
          <!-- AI providers -->
          <section v-if="section === 'ai'">
            <h2>AI Providers</h2>
            <p class="lead">
              Pick the provider that powers the AI assistant and data chat. Keys are encrypted with
              your OS keychain and never leave this machine except to call the provider you choose.
            </p>

            <div v-for="p in providers" :key="p.provider" class="provider" :class="{ active: p.provider === settings.activeProvider }">
              <div class="prov-head">
                <label class="radio">
                  <input
                    type="radio"
                    :checked="p.provider === settings.activeProvider"
                    @change="makeActive(p.provider)"
                  />
                  <span class="prov-name">{{ p.label }}</span>
                </label>
                <span v-if="p.provider === settings.activeProvider" class="badge-active">Active</span>
                <span v-if="!p.needsKey" class="badge-local">no key needed</span>
                <span v-else-if="p.hasKey" class="badge-set">key set</span>
              </div>

              <div class="prov-body">
                <div class="row" v-if="p.needsKey">
                  <label>API key</label>
                  <div class="row-inputs">
                    <input
                      class="input"
                      type="password"
                      v-model="keyDraft[p.provider]"
                      :placeholder="p.hasKey ? '•••••••• (stored)' : 'paste key…'"
                      @keydown.enter="saveKey(p.provider)"
                    />
                    <button class="btn" :disabled="!keyDraft[p.provider]?.trim()" @click="saveKey(p.provider)">Save</button>
                    <button v-if="p.hasKey" class="btn btn-ghost" @click="clearKey(p.provider)">Remove</button>
                  </div>
                </div>

                <div class="row" v-if="p.provider === 'ollama'">
                  <label>Server URL</label>
                  <div class="row-inputs">
                    <input
                      class="input"
                      :value="urlDraft[p.provider] ?? p.baseUrl"
                      @input="urlDraft[p.provider] = ($event.target as HTMLInputElement).value"
                      placeholder="http://localhost:11434"
                      @blur="saveUrl(p.provider)"
                    />
                  </div>
                </div>

                <div class="row">
                  <label>Model</label>
                  <div class="row-inputs">
                    <input
                      class="input"
                      :list="'models-' + p.provider"
                      :value="modelDraft[p.provider] ?? p.model"
                      @input="modelDraft[p.provider] = ($event.target as HTMLInputElement).value"
                      @change="saveModel(p.provider)"
                      :placeholder="p.defaultModel"
                      @blur="saveModel(p.provider)"
                    />
                    <datalist :id="'models-' + p.provider">
                      <option v-for="m in models[p.provider] || []" :key="m" :value="m" />
                    </datalist>
                    <button
                      class="btn"
                      @click="detectModels(p.provider)"
                      :disabled="detectState[p.provider] === 'loading'"
                      title="Fetch the models this provider currently offers"
                    >
                      {{ detectState[p.provider] === 'loading' ? 'Detecting…' : 'Detect' }}
                    </button>
                    <button class="btn" @click="test(p.provider)" :disabled="testState[p.provider] === 'testing'">
                      {{ testState[p.provider] === 'testing' ? 'Testing…' : 'Test' }}
                    </button>
                  </div>
                  <p v-if="(models[p.provider]?.length ?? 0) > 0" class="hint-models">
                    {{ models[p.provider].length }} models detected — pick one from the field's dropdown.
                  </p>
                  <p v-else-if="detectState[p.provider] === 'fail'" class="test fail">{{ detectMsg[p.provider] }}</p>
                </div>

                <p
                  v-if="testState[p.provider] && testState[p.provider] !== 'idle' && testState[p.provider] !== 'testing'"
                  class="test"
                  :class="testState[p.provider]"
                >{{ testMsg[p.provider] }}</p>
              </div>
            </div>
          </section>

          <!-- Appearance -->
          <section v-else-if="section === 'appearance'">
            <h2>Appearance</h2>
            <p class="lead">Tune how DataDock looks and feels.</p>

            <div class="setting">
              <div class="setting-label">
                <span>Interface scale</span>
                <small>Zoom the whole UI in or out.</small>
              </div>
              <div class="setting-control range">
                <input type="range" min="80" max="150" step="5" v-model.number="scalePct" />
                <span class="val">{{ scalePct }}%</span>
              </div>
            </div>

            <div class="setting">
              <div class="setting-label">
                <span>Theme</span>
                <small>Light or dark.</small>
              </div>
              <div class="setting-control">
                <div class="seg">
                  <button :class="{ on: ui.theme === 'dark' }" @click="ui.theme !== 'dark' && ui.toggleTheme()">Dark</button>
                  <button :class="{ on: ui.theme === 'light' }" @click="ui.theme !== 'light' && ui.toggleTheme()">Light</button>
                </div>
              </div>
            </div>

            <div class="setting">
              <div class="setting-label">
                <span>Row density</span>
                <small>Compact fits more rows on screen.</small>
              </div>
              <div class="setting-control">
                <div class="seg">
                  <button :class="{ on: settings.appearance.density === 'comfortable' }" @click="setDensity('comfortable')">Comfortable</button>
                  <button :class="{ on: settings.appearance.density === 'compact' }" @click="setDensity('compact')">Compact</button>
                </div>
              </div>
            </div>

            <div class="setting">
              <div class="setting-label">
                <span>Default page size</span>
                <small>Rows loaded per page in table view.</small>
              </div>
              <div class="setting-control">
                <select class="select" :value="settings.appearance.pageSize" @change="setPageSize(Number(($event.target as HTMLSelectElement).value))">
                  <option :value="100">100</option>
                  <option :value="200">200</option>
                  <option :value="500">500</option>
                  <option :value="1000">1000</option>
                </select>
              </div>
            </div>
          </section>

          <!-- MCP server -->
          <section v-else-if="section === 'mcp'">
            <h2>MCP Server</h2>
            <p class="lead">
              Let an external AI agent (like Claude Code) discover and query your databases through
              the <strong>Model Context Protocol</strong>. The server runs locally on
              <code>127.0.0.1</code> only and requires the token below on every request. It's
              <strong>off by default</strong> — the switch is a hard kill-switch that fully closes
              the port.
            </p>

            <div class="setting">
              <div class="setting-label">
                <span>Enable MCP access</span>
                <small>Master switch. When off, no MCP communication is possible at all.</small>
              </div>
              <div class="setting-control">
                <button
                  class="toggle"
                  :class="{ on: mcp?.enabled }"
                  role="switch"
                  :aria-checked="!!mcp?.enabled"
                  @click="toggleMcp"
                >
                  <span class="knob" />
                </button>
              </div>
            </div>

            <p v-if="mcp?.enabled" class="status" :class="{ ok: mcp?.running, bad: !mcp?.running }">
              <template v-if="mcp?.running">● Listening on http://127.0.0.1:{{ mcp?.port }}/mcp</template>
              <template v-else>● Not running{{ mcp?.error ? ` — ${mcp.error}` : '' }}</template>
            </p>

            <template v-if="mcp?.enabled">
              <div class="setting">
                <div class="setting-label">
                  <span>Port</span>
                  <small>Loopback TCP port for the MCP endpoint.</small>
                </div>
                <div class="setting-control">
                  <input
                    class="input port"
                    type="number"
                    :value="portDraft ?? mcp?.port"
                    @input="portDraft = Number(($event.target as HTMLInputElement).value)"
                    @blur="saveMcpPort"
                    @keydown.enter="saveMcpPort"
                  />
                </div>
              </div>

              <div class="setting">
                <div class="setting-label">
                  <span>Allow writes</span>
                  <small>Off = read-only (SELECT/SHOW/EXPLAIN). Writes never touch read-only or production connections.</small>
                </div>
                <div class="setting-control">
                  <button
                    class="toggle"
                    :class="{ on: mcp?.allowWrites, warn: mcp?.allowWrites }"
                    role="switch"
                    :aria-checked="!!mcp?.allowWrites"
                    @click="toggleMcpWrites"
                  >
                    <span class="knob" />
                  </button>
                </div>
              </div>

              <div class="row mcp-field">
                <label>Access token</label>
                <div class="row-inputs">
                  <input class="input mono" :type="tokenShown ? 'text' : 'password'" :value="mcp?.token" readonly />
                  <button class="btn btn-ghost" @click="tokenShown = !tokenShown">{{ tokenShown ? 'Hide' : 'Show' }}</button>
                  <button class="btn" @click="copy(mcp?.token ?? '', 'token')">{{ copied === 'token' ? 'Copied!' : 'Copy' }}</button>
                  <button class="btn btn-ghost" @click="regenMcpToken">Regenerate</button>
                </div>
              </div>

              <div class="row mcp-field">
                <label>Connect Claude Code</label>
                <p class="hint">Run this once in your project, then the agent can use the DataDock tools:</p>
                <div class="cmd">
                  <code>{{ mcpCommand }}</code>
                  <button class="btn" @click="copy(mcpCommand, 'cmd')">{{ copied === 'cmd' ? 'Copied!' : 'Copy' }}</button>
                </div>
                <p class="hint">
                  Tools exposed: <code>list_connections</code>, <code>list_tables</code>,
                  <code>describe_table</code>, <code>run_query</code>. A connection can be hidden from
                  MCP via “Disable discovery from MCP” in its connection settings.
                </p>
              </div>
            </template>
          </section>

          <!-- About -->
          <section v-else class="about">
            <img :src="deviumLogo" alt="Devium" class="dev-logo" />
            <h2>DataDock</h2>
            <p class="ver">Version {{ appVersion }}</p>
            <p class="tag">Built with a smile for everybody. 🙂</p>
            <p class="by">
              A free product by <a href="https://devium.be/" target="_blank" rel="noreferrer">Devium</a> —
              made with care, given away for nothing.
            </p>
            <a class="btn btn-primary" href="https://devium.be/" target="_blank" rel="noreferrer">Visit devium.be</a>
            <p class="legal">© {{ new Date().getFullYear() }} Devium · MIT licensed</p>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
}
.settings {
  width: 760px;
  max-width: 94vw;
  height: 560px;
  max-height: 90vh;
  display: flex;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
.nav {
  width: 188px;
  flex: none;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  padding: 4px 10px 10px;
}
.nav button {
  text-align: left;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-dim);
}
.nav button:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nav button.on {
  background: var(--bg-active);
  color: var(--text);
}
.nav-spacer {
  flex: 1;
}
.close-x {
  color: var(--text-faint);
  font-size: 12px;
}
.panel {
  flex: 1;
  overflow-y: auto;
  padding: 24px 26px;
}
h2 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.lead {
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.5;
  margin-bottom: 18px;
}
.provider {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 12px;
  background: var(--bg-elevated);
}
.provider.active {
  border-color: var(--accent);
}
.prov-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.radio {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.prov-name {
  font-weight: 600;
  font-size: 13.5px;
}
.badge-active,
.badge-set,
.badge-local {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
}
.badge-active {
  background: var(--accent-soft);
  color: var(--accent);
}
.badge-set {
  background: rgba(74, 222, 128, 0.14);
  color: var(--ok);
}
.badge-local {
  background: var(--bg-active);
  color: var(--text-faint);
}
.prov-body {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.row > label {
  font-size: 11.5px;
  color: var(--text-dim);
}
.row-inputs {
  display: flex;
  gap: 7px;
}
.row-inputs .input {
  flex: 1;
}
.test {
  font-size: 11.5px;
  margin-top: 2px;
}
.test.ok {
  color: var(--ok);
}
.test.fail {
  color: var(--danger);
}
.hint-models {
  font-size: 11.5px;
  margin-top: 4px;
  color: var(--text-dim);
}
.setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.setting-label span {
  font-size: 13px;
  display: block;
}
.setting-label small {
  font-size: 11.5px;
  color: var(--text-faint);
}
.setting-control.range {
  display: flex;
  align-items: center;
  gap: 10px;
}
.setting-control .val {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
  width: 42px;
  text-align: right;
}
.seg {
  display: inline-flex;
  padding: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
}
.seg button {
  padding: 5px 14px;
  font-size: 12px;
  border-radius: 999px;
  color: var(--text-dim);
}
.seg button.on {
  background: var(--bg-active);
  color: var(--accent);
}
/* MCP toggle + fields */
.toggle {
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: var(--bg-active);
  border: 1px solid var(--border-strong);
  position: relative;
  transition: background 0.15s;
}
.toggle .knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--text-dim);
  transition: transform 0.15s, background 0.15s;
}
.toggle.on {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.toggle.on .knob {
  transform: translateX(18px);
  background: var(--accent);
}
.toggle.on.warn {
  background: rgba(229, 97, 106, 0.18);
  border-color: var(--danger);
}
.toggle.on.warn .knob {
  background: var(--danger);
}
.status {
  font-size: 12px;
  font-family: var(--mono);
  margin: 4px 0 8px;
}
.status.ok {
  color: var(--ok);
}
.status.bad {
  color: var(--text-faint);
}
.input.port {
  width: 96px;
}
.input.mono {
  font-family: var(--mono);
  font-size: 12px;
}
.mcp-field {
  margin-top: 16px;
}
.mcp-field > label {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.hint {
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.5;
  margin: 4px 0;
}
.cmd {
  display: flex;
  align-items: stretch;
  gap: 7px;
  margin: 4px 0;
}
.cmd code {
  flex: 1;
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  word-break: break-all;
  user-select: all;
}
.about {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
}
.dev-logo {
  height: 56px;
  width: auto;
  margin-bottom: 16px;
  object-fit: contain;
}
.about h2 {
  font-size: 22px;
}
.ver {
  color: var(--text-faint);
  font-size: 12px;
  margin-top: 2px;
}
.tag {
  margin-top: 14px;
  font-size: 14px;
  color: var(--text);
}
.by {
  margin: 10px auto 18px;
  max-width: 360px;
  font-size: 12.5px;
  color: var(--text-dim);
  line-height: 1.5;
}
.by a {
  color: var(--accent);
}
.legal {
  margin-top: 18px;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
