<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AnalyticsDashboard, ScheduledReport } from '@shared/types'
import Modal from './Modal.vue'

const props = defineProps<{
  connectionId: string
  dashboards: AnalyticsDashboard[]
  editing?: ScheduledReport | null
}>()
const emit = defineEmits<{ close: []; saved: [report: ScheduledReport] }>()

const PRESETS = [
  { v: 60, label: 'Every hour' },
  { v: 360, label: 'Every 6 hours' },
  { v: 720, label: 'Every 12 hours' },
  { v: 1440, label: 'Daily' },
  { v: 10080, label: 'Weekly' }
]

const name = ref(props.editing?.name ?? '')
const dashboardId = ref(props.editing?.dashboardId ?? props.dashboards[0]?.id ?? '')
const folder = ref(props.editing?.folder ?? '')
const everyMinutes = ref<number>(props.editing?.everyMinutes ?? 1440)
const custom = ref(!PRESETS.some((p) => p.v === everyMinutes.value))
const enabled = ref(props.editing?.enabled ?? true)
const saving = ref(false)

const canSave = computed(
  () => !!name.value.trim() && !!dashboardId.value && !!folder.value && everyMinutes.value >= 1
)

async function pick(): Promise<void> {
  const r = await window.api.io.pickFolder()
  if (!r.canceled && r.path) folder.value = r.path
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const report = await window.api.analytics.saveReport({
      id: props.editing?.id,
      connectionId: props.connectionId,
      name: name.value.trim(),
      dashboardId: dashboardId.value,
      folder: folder.value,
      everyMinutes: everyMinutes.value,
      format: 'xlsx',
      enabled: enabled.value
    })
    emit('saved', report)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal :title="editing ? 'Edit scheduled report' : 'Schedule a report'" @close="emit('close')">
    <div class="form">
      <label class="fld">
        <span>Name</span>
        <input v-model="name" class="input" placeholder="Weekly sales report" />
      </label>
      <label class="fld">
        <span>Dashboard</span>
        <select v-model="dashboardId" class="input">
          <option v-for="d in dashboards" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </label>
      <p v-if="!dashboards.length" class="warn">Create a dashboard first.</p>

      <label class="fld">
        <span>Save to folder</span>
        <div class="folder-row">
          <input v-model="folder" class="input" placeholder="Choose a destination folder…" readonly />
          <button class="btn btn-ghost" @click="pick">Browse…</button>
        </div>
      </label>

      <label class="fld">
        <span>Run</span>
        <select
          v-if="!custom"
          class="input"
          :value="everyMinutes"
          @change="(e) => {
            const v = Number((e.target as HTMLSelectElement).value)
            if (v === -1) { custom = true } else { everyMinutes = v }
          }"
        >
          <option v-for="p in PRESETS" :key="p.v" :value="p.v">{{ p.label }}</option>
          <option :value="-1">Custom…</option>
        </select>
        <div v-else class="folder-row">
          <input v-model.number="everyMinutes" type="number" min="1" class="input" />
          <span class="suffix">minutes</span>
          <button class="btn btn-ghost" @click="custom = false">Presets</button>
        </div>
      </label>

      <label class="check">
        <input v-model="enabled" type="checkbox" />
        <span>Enabled</span>
      </label>

      <p class="note">
        Exports the dashboard's data to an Excel workbook (one sheet per chart). Runs while DataDock
        is open and this connection is active; you'll get a notification each time one is written.
      </p>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canSave || saving" @click="save">
        {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create schedule' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-width: 420px;
}
.fld {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.fld > span {
  font-weight: 600;
}
.input {
  font-size: 13px;
  padding: 7px 9px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  outline: none;
  width: 100%;
}
.input:focus {
  border-color: var(--accent);
}
.folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.folder-row .input {
  flex: 1;
}
.suffix {
  font-size: 12px;
  color: var(--text-faint);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}
.warn {
  font-size: 11.5px;
  color: var(--danger);
  margin: 0;
}
.note {
  font-size: 11.5px;
  color: var(--text-faint);
  margin: 4px 0 0;
  line-height: 1.5;
}
</style>
