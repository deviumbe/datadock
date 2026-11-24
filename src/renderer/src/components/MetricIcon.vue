<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { metricIconName } from '../lib/metricIcons'

const props = defineProps<{ value: string; size?: number }>()
const name = computed(() => metricIconName(props.value))
</script>

<template>
  <Icon v-if="name" :name="name" :size="size ?? 18" />
  <template v-else>{{ value }}</template>
</template>
