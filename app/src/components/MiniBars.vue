<script setup lang="ts">
import { computed } from 'vue'

/** Tiny SVG bar chart — sibling of Sparkline, same house rules. */
const props = withDefaults(
  defineProps<{
    values: number[]
    height?: number
    color?: string
  }>(),
  { height: 64, color: '#ff751f' },
)

const W = 300
const PAD = 4

const bars = computed(() => {
  const max = Math.max(1, ...props.values)
  const slot = (W - 2 * PAD) / Math.max(1, props.values.length)
  const barW = slot * 0.6
  return props.values.map((v, i) => {
    const h = ((props.height - 2 * PAD) * v) / max
    return {
      x: PAD + i * slot + (slot - barW) / 2,
      y: props.height - PAD - h,
      w: barW,
      h,
    }
  })
})
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${height}`" class="h-auto w-full" aria-hidden="true">
    <line :x1="PAD" :x2="W - PAD" :y1="height - PAD" :y2="height - PAD" stroke="#E5E7EB" />
    <rect v-for="(b, i) in bars" :key="i" :x="b.x" :y="b.y" :width="b.w" :height="Math.max(1, b.h)" :fill="color" rx="1.5" />
  </svg>
</template>
