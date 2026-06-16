<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
import Modal from './Modal.vue'
import { DRIVERS, type ConnectionConfig, type DriverType } from '@shared/types'

const props = defineProps<{
  environmentId: string
  config?: ConnectionConfig
}>()
const emit = defineEmits<{ save: [environmentId: string, config: ConnectionConfig]; close: [] }>()

const isEdit = computed(() => !!props.config?.id)

const COLORS = ['#1fb6a6', '#5b8def', '#e0a14a', '#e5616a', '#9b7ede', '#3fcf8e', '#888f9c']

function blank(): ConnectionConfig {
  return {
    id: '',
    name: '',
    driver: 'postgres',
    color: COLORS[0],
    host: 'localhost',
    port: 5432,
    database: '',
    user: '',
    password: '',
    ssl: false,
    readOnly: false,
    production: false,
    sshEnabled: false,
    sshPort: 22,
    sshAuthMethod: 'key'
  }
}

const form = reactive<ConnectionConfig>({ ...blank(), ...(props.config ?? {}) })

// Track presence of stored secrets so we can show "unchanged" placeholders.
const hadPassword = ref(!!props.config?.hasPassword)
const hadToken = ref(!!props.config?.hasToken)
const hadSshPassword = ref(!!props.config?.hasSshPassword)
const hadSshPassphrase = ref(!!props.config?.hasSshPassphrase)

const isNetwork = computed(() => ['postgres', 'mysql', 'mssql'].includes(form.driver))
const canTunnel = computed(() => !['sqlite', 'mongodb'].includes(form.driver))

async function pickKey(): Promise<void> {
  const path = await window.api.pickFile()
  if (path) form.sshKeyPath = path
}

watch(
  () => form.driver,
  (driver: DriverType, prev) => {
    if (!prev) return
    const def = DRIVERS.find((d) => d.type === driver)
    if (def?.defaultPort) form.port = def.defaultPort
  }
)

const testState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle')
const testMsg = ref('')

async function test(): Promise<void> {
  testState.value = 'testing'
  testMsg.value = ''
  try {
    await window.api.db.test({ ...form })
    testState.value = 'ok'
    testMsg.value = 'Connection successful'
  } catch (e) {
    testState.value = 'fail'
    testMsg.value = e instanceof Error ? e.message : String(e)
  }
}

const canSave = computed(() => {
  if (!form.name.trim()) return false
  if (form.driver === 'sqlite') return !!form.filePath
  if (form.driver === 'influxdb') return !!form.url && !!form.org
  if (form.driver === 'mongodb') return !!form.url
  return !!form.host
})

function save(): void {
  emit('save', props.environmentId, { ...form })
}
</script>

<template>
  <Modal :title="isEdit ? 'Edit Connection' : 'New Connection'" wide @close="emit('close')">
    <div class="form-grid">
      <div class="field span2">
        <label>Display name</label>
        <input class="input" v-model="form.name" placeholder="e.g. Production primary" />
      </div>

      <div class="field">
        <label>Driver</label>
        <select class="select" v-model="form.driver">
          <option v-for="d in DRIVERS" :key="d.type" :value="d.type">{{ d.label }}</option>
        </select>
      </div>

      <div class="field">
        <label>Color</label>
        <div class="swatches">
          <button
            v-for="c in COLORS"
            :key="c"
            class="swatch"
            :class="{ on: form.color === c }"
            :style="{ background: c }"
            @click="form.color = c"
          />
        </div>
      </div>

      <label class="check span2 ro">
        <input type="checkbox" v-model="form.readOnly" />
        <span>🔒 Read-only (safe mode) — block edits, inserts/deletes, DDL, imports & mutating SQL</span>
      </label>
      <label class="check span2 ro">
        <input type="checkbox" v-model="form.production" />
        <span>⚠️ Production — show a prominent red banner when this connection is active</span>
      </label>

      <!-- Network drivers -->
      <template v-if="isNetwork">
        <div class="field span2-host">
          <label>Host</label>
          <input class="input" v-model="form.host" placeholder="localhost" />
        </div>
        <div class="field">
          <label>Port</label>
          <input class="input" type="number" v-model.number="form.port" />
        </div>
        <div class="field">
          <label>Database</label>
          <input class="input" v-model="form.database" placeholder="optional" />
        </div>
        <div class="field">
          <label>User</label>
          <input class="input" v-model="form.user" autocomplete="off" />
        </div>
        <div class="field">
          <label>Password</label>
          <input
            class="input"
            type="password"
            v-model="form.password"
            autocomplete="new-password"
            :placeholder="hadPassword ? '•••••• (unchanged)' : ''"
          />
        </div>
        <label class="check span2">
          <input type="checkbox" v-model="form.ssl" />
          <span>Use SSL / TLS (accept self-signed)</span>
        </label>
      </template>

      <!-- SQLite -->
      <template v-else-if="form.driver === 'sqlite'">
        <div class="field span2">
          <label>Database file path</label>
          <input class="input" v-model="form.filePath" placeholder="/path/to/database.sqlite" />
          <small class="hint">Absolute path to the .sqlite / .db file. It will be created if missing.</small>
        </div>
      </template>

      <!-- MongoDB -->
      <template v-else-if="form.driver === 'mongodb'">
        <div class="field span2">
          <label>Connection URI</label>
          <input
            class="input"
            v-model="form.url"
            placeholder="mongodb://localhost:27017 or mongodb+srv://user:pass@cluster.mongodb.net"
          />
          <small class="hint">A standard MongoDB URI. Atlas <code>mongodb+srv://</code> strings work too.</small>
        </div>
        <div class="field span2">
          <label>Database</label>
          <input class="input" v-model="form.database" placeholder="defaults to the URI's database" />
        </div>
      </template>

      <!-- InfluxDB -->
      <template v-else-if="form.driver === 'influxdb'">
        <div class="field span2">
          <label>URL</label>
          <input class="input" v-model="form.url" placeholder="http://localhost:8086" />
        </div>
        <div class="field span2">
          <label>Token</label>
          <input
            class="input"
            type="password"
            v-model="form.token"
            autocomplete="new-password"
            :placeholder="hadToken ? '•••••• (unchanged)' : ''"
          />
        </div>
        <div class="field">
          <label>Org</label>
          <input class="input" v-model="form.org" />
        </div>
        <div class="field">
          <label>Bucket</label>
          <input class="input" v-model="form.bucket" placeholder="default bucket" />
        </div>
      </template>
    </div>

    <!-- SSH tunnel -->
    <div v-if="canTunnel" class="ssh">
      <label class="ssh-toggle">
        <input type="checkbox" v-model="form.sshEnabled" />
        <span>Connect over SSH tunnel</span>
      </label>

      <div v-if="form.sshEnabled" class="form-grid ssh-grid">
        <div class="field span2-host">
          <label>SSH host</label>
          <input class="input" v-model="form.sshHost" placeholder="bastion.example.com" />
        </div>
        <div class="field">
          <label>SSH port</label>
          <input class="input" type="number" v-model.number="form.sshPort" />
        </div>
        <div class="field">
          <label>SSH user</label>
          <input class="input" v-model="form.sshUser" placeholder="ubuntu" />
        </div>
        <div class="field">
          <label>Authentication</label>
          <select class="select" v-model="form.sshAuthMethod">
            <option value="key">Private key</option>
            <option value="password">Password</option>
            <option value="agent">SSH agent</option>
          </select>
        </div>

        <template v-if="form.sshAuthMethod === 'key'">
          <div class="field span2">
            <label>Private key file</label>
            <div class="key-row">
              <input class="input" v-model="form.sshKeyPath" placeholder="~/.ssh/id_ed25519" />
              <button class="btn" type="button" @click="pickKey">Browse…</button>
            </div>
          </div>
          <div class="field span2">
            <label>Key passphrase</label>
            <input
              class="input"
              type="password"
              v-model="form.sshPassphrase"
              autocomplete="new-password"
              :placeholder="hadSshPassphrase ? '•••••• (unchanged)' : 'optional'"
            />
          </div>
        </template>

        <div v-else-if="form.sshAuthMethod === 'password'" class="field span2">
          <label>SSH password</label>
          <input
            class="input"
            type="password"
            v-model="form.sshPassword"
            autocomplete="new-password"
            :placeholder="hadSshPassword ? '•••••• (unchanged)' : ''"
          />
        </div>

        <p v-else class="ssh-note span2">Uses your running SSH agent (SSH_AUTH_SOCK).</p>

        <p class="ssh-note span2">
          The host/port above are reached <em>from the SSH server</em> — e.g. host
          <code>127.0.0.1</code> for a DB running on that server.
        </p>
      </div>
    </div>

    <div class="test-row" :class="testState" v-if="testState !== 'idle'">
      <span v-if="testState === 'testing'">Testing…</span>
      <span v-else>{{ testMsg }}</span>
    </div>

    <template #footer>
      <button class="btn" @click="test" :disabled="testState === 'testing' || !canSave">
        Test
      </button>
      <div style="flex: 1"></div>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canSave" @click="save">
        {{ isEdit ? 'Save' : 'Create' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.span2 {
  grid-column: 1 / -1;
}
.span2-host {
  grid-column: 1 / 2;
}
.hint {
  color: var(--text-faint);
  font-size: 11px;
}
.swatches {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 33px;
}
.swatch {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: transform 0.1s;
}
.swatch.on {
  border-color: var(--text);
  transform: scale(1.15);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
}
.ssh {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.ssh-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-weight: 500;
}
.ssh-grid {
  margin-top: 14px;
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row .input {
  flex: 1;
}
.ssh-note {
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.ssh-note code {
  font-family: var(--mono);
  background: var(--bg-elevated);
  padding: 1px 4px;
  border-radius: 3px;
}
.test-row {
  margin-top: 14px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  word-break: break-word;
}
.test-row.testing {
  background: var(--bg-elevated);
  color: var(--text-dim);
}
.test-row.ok {
  background: rgba(63, 207, 142, 0.13);
  color: var(--ok);
}
.test-row.fail {
  background: rgba(229, 97, 106, 0.13);
  color: var(--danger);
}
</style>
