<script setup lang="ts">
import { computed } from 'vue'

/**
 * Tiny inline SVG line — no chart library, per the house rules.
 * `stretch` makes it fill its parent (width/height become the viewBox
 * only) — use for full-width charts that must scale on mobile.
 */
const props = withDefaults(
  defineProps<{
    values: number[]
    width?: number
    height?: number
    stroke?: string
    stretch?: boolean
  }>(),
  { width: 120, height: 32, stroke: '#ff751f', stretch: false },
)

const points = computed(() => {
  const vals = props.values
  if (vals.length === 0) return ''
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const pad = 2
  const w = props.width - pad * 2
  const h = props.height - pad * 2
  if (vals.length === 1) {
    const y = pad + h / 2
    return `${pad},${y} ${pad + w},${y}`
  }
  return vals
    .map((v, i) => {
      const x = pad + (i * w) / (vals.length - 1)
      const y = pad + h - ((v - min) / span) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${width} ${height}`"
    :width="stretch ? undefined : width"
    :height="stretch ? undefined : height"
    :class="stretch ? 'h-full w-full' : ''"
    :preserveAspectRatio="stretch ? 'none' : 'xMidYMid meet'"
    aria-hidden="true"
  >
    <polyline :points="points" fill="none" :stroke="stroke" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>
</template>
