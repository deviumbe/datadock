<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { useVault } from '../stores/vault'

const vault = useVault()

const passphrase = ref('')
const remember = ref(false)
const busy = ref(false)
const error = ref('')
const passInput = ref<HTMLInputElement | null>(null)

const status = computed(() => vault.status)
const fileName = computed(() => status.value?.path?.split('/').pop() ?? 'vault')
const touchId = computed(() => !!status.value?.touchIdEnabled)
const offerTouchId = computed(() => !!status.value?.touchIdAvailable && !touchId.value)

async function run(fn: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    passInput.value?.focus()
  } finally {
    busy.value = false
  }
}

const tryTouchId = (): Promise<void> =>
  run(async () => {
    await vault.unlockTouchId()
  })

const submit = (): Promise<void> =>
  run(async () => {
    if (!passphrase.value) return
    await vault.unlock(passphrase.value, remember.value)
    passphrase.value = ''
  })

onMounted(() => {
  if (touchId.value && status.value?.fileExists) void tryTouchId()
  else passInput.value?.focus()
})
</script>

<template>
  <div class="lock">
    <div class="drag" />
    <div class="card">
      <div class="glyph"><Icon name="lock" :size="26" /></div>
      <h1>DataDock is locked</h1>
      <p class="file" :title="status?.path">{{ fileName }}</p>

      <p v-if="vault.lockReason" class="reason">{{ vault.lockReason }}</p>
      <p v-if="status && !status.fileExists" class="reason">
        The vault file was not found. Is the synced folder mounted?
      </p>

      <button v-if="touchId" class="btn btn-primary wide" :disabled="busy" @click="tryTouchId">
        Unlock with Touch ID
      </button>

      <form class="pass" @submit.prevent="submit">
        <input
          ref="passInput"
          v-model="passphrase"
          class="input"
          type="password"
          autocomplete="current-password"
          :placeholder="touchId ? 'or type your passphrase' : 'Vault passphrase'"
          :disabled="busy"
        />
        <button class="btn" :class="{ 'btn-primary': !touchId }" type="submit" :disabled="busy || !passphrase">
          Unlock
        </button>
      </form>

      <label v-if="offerTouchId" class="check">
        <input v-model="remember" type="checkbox" />
        Unlock with Touch ID on this Mac
      </label>

      <p v-if="error" class="err">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.lock {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: var(--bg-app);
  display: flex;
  align-items: center;
  justify-content: center;
}
.drag {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 40px;
  -webkit-app-region: drag;
}
.card {
  width: 360px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 30px 28px 26px;
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  animation: lock-rise var(--dur-3) var(--ease-out);
}
@keyframes lock-rise {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
  }
}
.glyph {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}
h1 {
  font-size: 17px;
  font-weight: 600;
}
.file {
  color: var(--text-faint);
  font-size: 12px;
  margin-top: -8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reason {
  color: var(--warn);
  font-size: 12.5px;
  text-align: center;
  line-height: 1.45;
}
.wide {
  width: 100%;
  margin-top: 6px;
}
.pass {
  display: flex;
  gap: 8px;
  width: 100%;
}
.pass .input {
  flex: 1;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 12.5px;
  align-self: flex-start;
}
.err {
  color: var(--danger);
  font-size: 12.5px;
  text-align: center;
  line-height: 1.45;
}
</style>
