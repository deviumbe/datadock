<script setup lang="ts">
// One semantic icon name, rendered from whichever icon set the theme selects.
// Glyph markup per set lives in lib/icons (generated). `set`/`weight`
// props override the theme so previews can show every set side by side.
import { computed } from 'vue'
import type { IconWeight } from '@shared/types'
import { DEFAULT_ICON_SET, ICON_SETS, iconVariants } from '../lib/iconSets'
import { useTheme } from '../stores/theme'

const props = withDefaults(
  defineProps<{ name: string; size?: number | string; set?: string; weight?: IconWeight }>(),
  { size: 16 }
)

const theme = useTheme()
// Until a lazily loaded set arrives, draw the bundled default instead of nothing.
const setId = computed(() => {
  const wanted = props.set ?? theme.settings.iconSet
  return ICON_SETS[wanted] && iconVariants(wanted) ? wanted : DEFAULT_ICON_SET
})
const def = computed(() => ICON_SETS[setId.value])
const variants = computed(() => iconVariants(setId.value)!)
const weight = computed(() => props.weight ?? theme.settings.iconWeight)
const variant = computed(() => variants.value[weight.value] ?? variants.value.regular)
const markup = computed(() => variant.value.glyphs[props.name] ?? '')
const strokeWidth = computed(() => def.value.strokeWidths?.[weight.value] ?? 2)
</script>

<template>
  <svg
    class="dd-icon"
    :width="size"
    :height="size"
    :viewBox="variant.viewBox"
    :fill="def.fill ? 'currentColor' : 'none'"
    :stroke="def.fill ? 'none' : 'currentColor'"
    :stroke-width="def.fill ? undefined : strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="markup"
  />
</template>

<style scoped>
.dd-icon {
  display: inline-block;
  flex: none;
  vertical-align: -0.18em;
}
</style>
