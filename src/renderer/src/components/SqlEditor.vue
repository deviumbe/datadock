<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql } from '@codemirror/lang-sql'
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  schema?: Record<string, string[]>
}>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; run: [] }>()

const host = ref<HTMLDivElement>()
let view: EditorView | undefined

// The SQL language (with schema-aware autocomplete) lives in a compartment so it
// can be reconfigured when the active connection's schema loads/changes.
const sqlConf = new Compartment()
const sqlExt = (): ReturnType<typeof sql> => sql({ schema: props.schema ?? {}, upperCaseKeywords: false })

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: '#5fc9e8', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: '#9bd17a' },
  { tag: [t.number, t.bool, t.null], color: '#e0a14a' },
  { tag: [t.lineComment, t.blockComment], color: '#6b7280', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#9b7ede' },
  { tag: t.variableName, color: '#e6e8ed' },
  { tag: [t.typeName, t.className], color: '#1fb6a6' },
  { tag: t.operator, color: '#9aa1ad' }
])

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
    '.cm-content': { fontFamily: 'var(--mono)', fontSize: '13px', padding: '10px 0' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-faint)',
      border: 'none'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(31,182,166,0.22)'
    },
    '&.cm-focused': { outline: 'none' }
  },
  { dark: true }
)

onMounted(() => {
  const runKey = keymap.of([
    {
      key: 'Mod-Enter',
      preventDefault: true,
      run: () => {
        emit('run')
        return true
      }
    }
  ])

  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(),
        sqlConf.of(sqlExt()),
        syntaxHighlighting(highlight),
        theme,
        cmPlaceholder(props.placeholder ?? ''),
        runKey,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        })
      ]
    })
  })
})

watch(
  () => props.modelValue,
  (val) => {
    if (view && val !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val } })
    }
  }
)

// Reconfigure autocomplete when the connection's schema arrives/changes.
watch(
  () => props.schema,
  () => {
    if (view) view.dispatch({ effects: sqlConf.reconfigure(sqlExt()) })
  }
)

onBeforeUnmount(() => view?.destroy())

defineExpose({ focus: () => view?.focus() })
</script>

<template>
  <div ref="host" class="editor" />
</template>

<style scoped>
.editor {
  height: 100%;
  overflow: auto;
}
</style>
