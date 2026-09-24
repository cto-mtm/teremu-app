<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/** Inline SVG donut — sibling of Sparkline/MiniBars, same house rules.
 * Purely presentational: the parent aggregates, caps, colors and labels
 * the slices; clicking a slice emits its key. */
export interface PieSlice {
  key: string
  label: string
  value: number
  color: string
  clickable?: boolean
}

const { n } = useI18n()

const props = withDefaults(
  defineProps<{
    slices: PieSlice[]
    /** Two-line center text (e.g. a total) — formatted by the caller. */
    centerLabel?: string
    centerValue?: string
    ariaLabel?: string
  }>(),
  { centerLabel: '', centerValue: '', ariaLabel: '' },
)

const emit = defineEmits<{ select: [key: string] }>()

const SIZE = 200
const C = SIZE / 2
const R = 92 // outer radius
const r = 56 // inner radius (donut hole)
const GAP = 0.02 // radians shaved off each side of a slice

const pt = (radius: number, a: number): string =>
  `${(C + radius * Math.cos(a)).toFixed(2)} ${(C + radius * Math.sin(a)).toFixed(2)}`

/** Annular sector from angle a0 to a1 (radians, clockwise from 12 o'clock). */
function arcPath(a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0
  return (
    `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} ` +
    `L ${pt(r, a1)} A ${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`
  )
}

const arcs = computed(() => {
  const visible = props.slices.filter((s) => s.value > 0)
  const sum = visible.reduce((s, x) => s + x.value, 0)
  if (sum <= 0) return []
  let angle = -Math.PI / 2 // start at 12 o'clock
  return visible.map((s) => {
    // Clamp just below 2π: a full 360° SVG arc collapses to nothing, so
    // a 100% slice renders as a ring with an invisible ~0.1° notch.
    const sweep = Math.min((s.value / sum) * 2 * Math.PI, 2 * Math.PI - 0.002)
    const gap = visible.length > 1 ? Math.min(GAP, sweep / 4) : 0
    const d = arcPath(angle + gap, angle + sweep - gap)
    angle += (s.value / sum) * 2 * Math.PI
    return { slice: s, d, pct: (s.value / sum) * 100 }
  })
})
</script>

<template>
  <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="mx-auto block h-auto w-full max-w-56" role="img" :aria-label="ariaLabel">
    <path
      v-for="a in arcs"
      :key="a.slice.key"
      :d="a.d"
      :fill="a.slice.color"
      class="transition-opacity duration-200"
      :class="a.slice.clickable ? 'cursor-pointer hover:opacity-75' : ''"
      @click="a.slice.clickable && emit('select', a.slice.key)"
    >
      <title>{{ a.slice.label }} · {{ n(a.pct / 100, 'percent') }}</title>
    </path>
    <text v-if="centerValue" :x="C" :y="C - 2" text-anchor="middle" font-size="17" font-weight="700" fill="#1C1410">
      {{ centerValue }}
    </text>
    <text v-if="centerLabel" :x="C" :y="C + 15" text-anchor="middle" font-size="9.5" fill="#7A6F66">
      {{ centerLabel }}
    </text>
  </svg>
</template>
