<script setup lang="ts">
import { computed } from 'vue'
import { useUpdates } from '../stores/updates'

const u = useUpdates()
const show = computed(() =>
  ['available', 'downloading', 'ready', 'failed', 'uptodate'].includes(u.status)
)
</script>

<template>
  <Transition name="toast">
    <div v-if="show" class="update-toast" :class="u.status">
      <!-- available -->
      <template v-if="u.status === 'available'">
        <div class="body">
          <div class="title">✨ Update available</div>
          <div class="sub">DataDock {{ u.version }} is ready to install.</div>
        </div>
        <div class="actions">
          <button class="btn-ghost" @click="u.dismiss()">Later</button>
          <button class="btn-primary" @click="u.download()">Update now</button>
        </div>
      </template>

      <!-- downloading -->
      <template v-else-if="u.status === 'downloading'">
        <div class="body">
          <div class="title">Downloading update…</div>
          <div class="bar"><div class="fill" :style="{ width: u.progress + '%' }" /></div>
        </div>
        <div class="actions"><span class="pct">{{ u.progress }}%</span></div>
      </template>

      <!-- ready -->
      <template v-else-if="u.status === 'ready'">
        <div class="body">
          <div class="title">✅ Update ready</div>
          <div class="sub">Restart to install DataDock {{ u.version }}.</div>
        </div>
        <div class="actions">
          <button class="btn-ghost" @click="u.dismiss()">Later</button>
          <button class="btn-primary" @click="u.install()">Restart &amp; install</button>
        </div>
      </template>

      <!-- failed (e.g. unsigned macOS) -->
      <template v-else-if="u.status === 'failed'">
        <div class="body">
          <div class="title">Couldn't install automatically</div>
          <div class="sub">Download the latest version from the releases page.</div>
        </div>
        <div class="actions">
          <button class="btn-ghost" @click="u.dismiss()">Dismiss</button>
          <button class="btn-primary" @click="u.openReleases()">Open downloads</button>
        </div>
      </template>

      <!-- up to date (manual check only) -->
      <template v-else-if="u.status === 'uptodate'">
        <div class="body">
          <div class="title">You're up to date</div>
          <div class="sub">DataDock is running the latest version.</div>
        </div>
        <div class="actions"><button class="btn-ghost" @click="u.dismiss()">OK</button></div>
      </template>
    </div>
  </Transition>
</template>

<style scoped>
.update-toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 300;
  width: 360px;
  max-width: calc(100vw - 36px);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-modal);
}
.body {
  flex: 1;
  min-width: 0;
}
.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.sub {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-top: 2px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.pct {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.bar {
  margin-top: 7px;
  height: 5px;
  background: var(--bg-panel);
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.2s ease;
}
.btn-ghost,
.btn-primary {
  font-size: 12px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
.btn-ghost {
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--border);
}
.btn-ghost:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.btn-primary {
  color: #fff;
  background: var(--accent);
  border: 1px solid var(--accent);
}
.btn-primary:hover {
  filter: brightness(1.08);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
