<script setup lang="ts">
// Full-value viewer/editor for a single grid cell. Pretty-prints + tree-views
// JSON, shows long text/blobs word-wrapped, and (on editable tabs) edits the
// value and saves it back. Works for any engine since JSON arrives as a string.
import { ref, computed } from 'vue'
import Modal from './Modal.vue'
import JsonTree from './JsonTree.vue'

const props = defineProps<{ value: unknown; column: string; editable: boolean }>()
const emit = defineEmits<{ save: [value: string]; close: [] }>()

const isNull = computed(() => props.value === null || props.value === undefined)
const raw = computed(() => (isNull.value ? '' : String(props.value)))

// Treat the cell as JSON only when it actually parses to an object/array.
const parsed = computed<{ ok: boolean; data?: unknown }>(() => {
  const s = raw.value.trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return { ok: false }
  try {
    const d = JSON.parse(s)
    if (d !== null && typeof d === 'object') return { ok: true, data: d }
  } catch {
    /* not JSON */
  }
  return { ok: false }
})
const isJson = computed(() => parsed.value.ok)
const pretty = computed(() => (isJson.value ? JSON.stringify(parsed.value.data, null, 2) : raw.value))

const view = ref<'tree' | 'raw'>('tree')
const editing = ref(false)
const draft = ref('')
const editError = ref('')
const copied = ref(false)

function startEdit(): void {
  draft.value = isJson.value ? pretty.value : raw.value
  editError.value = ''
  editing.value = true
}
function save(): void {
  if (isJson.value) {
    try {
      JSON.parse(draft.value)
    } catch (e) {
      editError.value = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
      return
    }
  }
  emit('save', draft.value)
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(isJson.value ? pretty.value : raw.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <Modal :title="`${column}${isJson ? ' · JSON' : ''}`" wide @close="emit('close')">
    <div class="bar">
      <template v-if="isJson && !editing">
        <div class="seg">
          <button :class="{ on: view === 'tree' }" @click="view = 'tree'">Tree</button>
          <button :class="{ on: view === 'raw' }" @click="view = 'raw'">Raw</button>
        </div>
      </template>
      <span class="count">{{ raw.length.toLocaleString() }} chars</span>
      <div class="spacer" />
      <button class="btn btn-ghost sm" @click="copy">{{ copied ? 'Copied!' : 'Copy' }}</button>
      <button v-if="editable && !editing" class="btn btn-ghost sm" @click="startEdit">Edit</button>
    </div>

    <div class="content">
      <textarea v-if="editing" v-model="draft" class="editor" spellcheck="false"></textarea>
      <JsonTree v-else-if="isJson && view === 'tree'" :data="parsed.data" />
      <pre v-else class="raw" :class="{ null: isNull }">{{ isNull ? 'NULL' : pretty }}</pre>
    </div>
    <p v-if="editError" class="err">{{ editError }}</p>

    <template v-if="editing" #footer>
      <button class="btn" @click="editing = false">Cancel</button>
      <button class="btn btn-primary" @click="save">Save</button>
    </template>
  </Modal>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.count {
  font-size: 11px;
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.seg {
  display: inline-flex;
  padding: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
}
.seg button {
  padding: 3px 12px;
  font-size: 11.5px;
  border-radius: 999px;
  color: var(--text-dim);
}
.seg button.on {
  background: var(--bg-active);
  color: var(--accent);
}
.content {
  max-height: 56vh;
  overflow: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.raw {
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.raw.null {
  color: var(--text-faint);
  font-style: italic;
}
.editor {
  width: 100%;
  min-height: 320px;
  resize: vertical;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
}
.err {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--danger);
}
.sm {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
