<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import Modal from './Modal.vue'

type Mode = 'generate' | 'explain' | 'fix'

const props = defineProps<{
  driver: string
  schema: Record<string, string[]>
  sql?: string
  error?: string
  initialMode?: Mode
}>()
const emit = defineEmits<{ insert: [sql: string]; close: [] }>()

const ready = ref<boolean | null>(null) // null = checking, false = needs key
const keyInput = ref('')
const savingKey = ref(false)

const mode = ref<Mode>(props.initialMode ?? 'generate')
const prompt = ref('')
const busy = ref(false)
const error = ref('')
const result = ref<{ sql: string; notes: string } | null>(null)
const explanation = ref('')

const hasSql = computed(() => !!props.sql?.trim())
const hasError = computed(() => !!props.error?.trim())

onMounted(async () => {
  try {
    ready.value = await window.api.ai.hasKey()
  } catch {
    ready.value = false
  }
})

function reset(): void {
  error.value = ''
  result.value = null
  explanation.value = ''
}
function setMode(m: Mode): void {
  mode.value = m
  reset()
}

async function saveKey(): Promise<void> {
  if (!keyInput.value.trim()) return
  savingKey.value = true
  error.value = ''
  try {
    const ok = await window.api.ai.setKey(keyInput.value.trim())
    if (ok) {
      keyInput.value = ''
      ready.value = true
    } else {
      error.value = 'Could not save the key.'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingKey.value = false
  }
}

async function changeKey(): Promise<void> {
  await window.api.ai.clearKey()
  ready.value = false
  reset()
}

async function run(): Promise<void> {
  if (busy.value) return
  busy.value = true
  reset()
  const base = { driver: props.driver, schema: props.schema ?? {} }
  try {
    if (mode.value === 'generate') {
      if (!prompt.value.trim()) return
      result.value = await window.api.ai.generateSql({ ...base, prompt: prompt.value.trim() })
    } else if (mode.value === 'explain') {
      if (!hasSql.value) return
      explanation.value = await window.api.ai.explainQuery({ ...base, sql: props.sql!.trim() })
    } else {
      if (!hasSql.value || !hasError.value) return
      result.value = await window.api.ai.fixQuery({
        ...base,
        sql: props.sql!.trim(),
        error: props.error!.trim()
      })
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function insert(): void {
  if (result.value?.sql) emit('insert', result.value.sql)
}

const runLabel = computed(() => {
  if (busy.value) return 'Working…'
  return mode.value === 'generate' ? 'Generate SQL' : mode.value === 'explain' ? 'Explain query' : 'Suggest fix'
})
const canRun = computed(() => {
  if (mode.value === 'generate') return !!prompt.value.trim()
  if (mode.value === 'explain') return hasSql.value
  return hasSql.value && hasError.value
})
</script>

<template>
  <Modal title="✨ AI SQL Assistant" wide @close="emit('close')">
    <div v-if="ready === null" class="centered">Checking…</div>

    <!-- Key setup -->
    <div v-else-if="ready === false" class="key-setup">
      <p class="lead">Connect your Anthropic API key to use AI in DataDock.</p>
      <div class="field">
        <label>Anthropic API key</label>
        <input class="input" v-model="keyInput" type="password" placeholder="sk-ant-…" @keydown.enter="saveKey" />
      </div>
      <p class="hint">
        The key is encrypted with your OS keychain and stays on this machine — only the app's main
        process uses it to call the Anthropic API.
      </p>
      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <!-- Assistant -->
    <div v-else class="assistant">
      <div class="modes">
        <button :class="{ on: mode === 'generate' }" @click="setMode('generate')">Generate</button>
        <button :class="{ on: mode === 'explain' }" @click="setMode('explain')">Explain</button>
        <button :class="{ on: mode === 'fix' }" @click="setMode('fix')" :disabled="!hasError" title="Available after a query error">Fix error</button>
      </div>

      <!-- Generate -->
      <div v-if="mode === 'generate'" class="field">
        <label>Describe what you want</label>
        <textarea
          class="input prompt"
          v-model="prompt"
          rows="3"
          placeholder="e.g. top 10 customers by total order value in the last 30 days"
          @keydown.meta.enter="run"
          @keydown.ctrl.enter="run"
        />
      </div>

      <!-- Explain / Fix operate on the current editor query -->
      <div v-else class="field">
        <label>{{ mode === 'explain' ? 'Query to explain' : 'Failing query' }}</label>
        <pre v-if="hasSql" class="sql ctx">{{ props.sql }}</pre>
        <p v-else class="hint">Open a query tab and write some SQL first.</p>
        <p v-if="mode === 'fix' && hasError" class="ctx-err">{{ props.error }}</p>
      </div>

      <p v-if="error" class="err">{{ error }}</p>

      <div v-if="explanation" class="explanation">{{ explanation }}</div>

      <div v-if="result" class="result">
        <pre class="sql">{{ result.sql }}</pre>
        <p v-if="result.notes" class="notes">{{ result.notes }}</p>
      </div>
    </div>

    <template #footer>
      <template v-if="ready === false">
        <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="!keyInput.trim() || savingKey" @click="saveKey">
          {{ savingKey ? 'Saving…' : 'Save key' }}
        </button>
      </template>
      <template v-else-if="ready === true">
        <button class="btn btn-ghost change-key" @click="changeKey" title="Remove the stored key">Change key</button>
        <div class="spacer" />
        <button v-if="result" class="btn btn-ghost" @click="run" :disabled="busy">Regenerate</button>
        <button v-if="result" class="btn btn-primary" @click="insert">Insert into editor</button>
        <button v-else class="btn btn-primary" :disabled="!canRun || busy" @click="run">{{ runLabel }}</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.centered {
  text-align: center;
  color: var(--text-dim);
  padding: 24px;
}
.lead {
  margin-bottom: 14px;
  color: var(--text);
}
.hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.5;
}
.modes {
  display: inline-flex;
  padding: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  margin-bottom: 16px;
}
.modes button {
  padding: 5px 16px;
  font-size: 12px;
  font-weight: 500;
  border: none;
  background: transparent;
  border-radius: 999px;
  color: var(--text-dim);
}
.modes button:hover:not(:disabled) {
  color: var(--text);
}
.modes button.on {
  background: var(--bg-active);
  color: var(--accent);
}
.modes button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.prompt {
  resize: vertical;
  font-family: inherit;
}
.err {
  margin-top: 10px;
  color: var(--danger);
  font-size: 12px;
}
.sql {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.sql.ctx {
  max-height: 140px;
  opacity: 0.85;
}
.ctx-err {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--danger);
  white-space: pre-wrap;
}
.result {
  margin-top: 16px;
}
.explanation {
  margin-top: 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  max-height: 320px;
  overflow: auto;
}
.notes {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.change-key {
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
</style>
