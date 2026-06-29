<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue'
import { useTabs, type Tab } from '../stores/tabs'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'

const props = defineProps<{ tab: Tab }>()
const tabsStore = useTabs()
const settings = useSettings()
const ui = useUi()

const input = ref('')
const scroller = ref<HTMLElement>()

const messages = computed(() => props.tab.chatMessages ?? [])
const busy = computed(() => !!props.tab.chatBusy)
const activeProvider = computed(
  () => settings.providers.find((p) => p.provider === settings.activeProvider)
)

async function scrollDown(): Promise<void> {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}
watch(() => messages.value.length, scrollDown)
watch(busy, scrollDown)
watch(() => props.tab.chatStream, scrollDown)

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  await tabsStore.sendChat(props.tab, text)
}

const suggestions = [
  'How many rows are in each table?',
  'What are the largest tables?',
  'Show me 5 sample rows from the biggest table',
  'Which columns look like foreign keys?'
]
function useSuggestion(s: string): void {
  input.value = s
  void send()
}
</script>

<template>
  <div class="chat">
    <div v-if="!settings.aiReady" class="empty">
      <div class="empty-inner">
        <div class="logo">✨</div>
        <h2>Chat with your data</h2>
        <p>Ask questions in plain English — the assistant runs read-only queries and answers from the real results.</p>
        <p class="muted">No AI provider is configured yet.</p>
        <button class="btn btn-primary" @click="ui.settingsOpen = true">Open AI settings</button>
      </div>
    </div>

    <template v-else>
      <div ref="scroller" class="messages">
        <div v-if="!messages.length" class="welcome">
          <div class="logo">✨</div>
          <h2>Chat with your data</h2>
          <p>Ask anything about this database. The assistant can run read-only queries to answer.</p>
          <div class="suggestions">
            <button v-for="s in suggestions" :key="s" class="chip" @click="useSuggestion(s)">{{ s }}</button>
          </div>
        </div>

        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="avatar">{{ m.role === 'user' ? '🧑' : '✨' }}</div>
          <div class="bubble">
            <div class="content">{{ m.content }}</div>
            <details v-if="m.steps && m.steps.length" class="steps">
              <summary>{{ m.steps.length }} quer{{ m.steps.length === 1 ? 'y' : 'ies' }} run</summary>
              <div v-for="(s, j) in m.steps" :key="j" class="step">
                <pre class="sql">{{ s.sql }}</pre>
                <span v-if="s.error" class="step-err">{{ s.error }}</span>
                <span v-else class="step-ok">{{ s.rowCount }} row{{ s.rowCount === 1 ? '' : 's' }}</span>
              </div>
            </details>
          </div>
        </div>

        <div v-if="busy" class="msg assistant">
          <div class="avatar">✨</div>
          <div class="bubble">
            <div v-if="tab.chatStream" class="content">{{ tab.chatStream }}<span class="cursor" /></div>
            <div v-else class="typing"><span /><span /><span /></div>
          </div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-meta">
          <span class="prov">{{ activeProvider?.label }} · {{ activeProvider?.model }}</span>
          <button v-if="messages.length" class="link" @click="tabsStore.clearChat(tab)">Clear</button>
        </div>
        <div class="composer-row">
          <textarea
            v-model="input"
            class="input"
            rows="1"
            placeholder="Ask about your data…"
            :disabled="busy"
            @keydown.enter.exact.prevent="send"
          />
          <button class="btn btn-primary" :disabled="!input.trim() || busy" @click="send">Send</button>
        </div>
        <p class="disclaimer">Read-only — the assistant can only run SELECT-style queries. Results are sent to your AI provider.</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.empty,
.welcome {
  margin: auto;
  text-align: center;
  color: var(--text-dim);
  max-width: 440px;
}
.empty {
  display: flex;
  height: 100%;
}
.empty-inner {
  margin: auto;
}
.logo {
  font-size: 34px;
  margin-bottom: 10px;
}
.welcome h2,
.empty h2 {
  color: var(--text);
  font-size: 17px;
  margin-bottom: 8px;
}
.welcome p,
.empty p {
  font-size: 13px;
  line-height: 1.5;
}
.muted {
  color: var(--text-faint);
  margin-top: 6px;
}
.empty .btn {
  margin-top: 14px;
}
.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 16px;
}
.chip {
  font-size: 12px;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-dim);
}
.chip:hover {
  color: var(--text);
  border-color: var(--accent);
}
.msg {
  display: flex;
  gap: 10px;
  max-width: 80%;
}
.msg.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.avatar {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  font-size: 14px;
}
.bubble {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 11px 14px;
}
.msg.user .bubble {
  background: var(--accent-soft);
  border-color: transparent;
}
.content {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
/* Blinking caret shown at the end of streaming text. */
.cursor {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: cursorBlink 1s step-end infinite;
}
@keyframes cursorBlink {
  50% {
    opacity: 0;
  }
}
.steps {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.steps summary {
  font-size: 11.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.step {
  margin-top: 6px;
}
.sql {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.step-ok {
  font-size: 11px;
  color: var(--ok);
}
.step-err {
  font-size: 11px;
  color: var(--danger);
}
.typing {
  display: flex;
  gap: 4px;
}
.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  animation: blink 1.2s infinite both;
}
.typing span:nth-child(2) {
  animation-delay: 0.2s;
}
.typing span:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}
.composer {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  background: var(--bg-panel);
}
.composer-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.prov {
  font-size: 11px;
  color: var(--text-faint);
}
.link {
  font-size: 11.5px;
  color: var(--accent);
}
.composer-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.composer-row .input {
  flex: 1;
  resize: none;
  max-height: 140px;
  font-family: inherit;
}
.disclaimer {
  margin-top: 7px;
  font-size: 10.5px;
  color: var(--text-faint);
}
</style>
