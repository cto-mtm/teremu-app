<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { MenuEngineeringPoint, Quadrant } from '../lib/domain'
import { QUADRANT_COLORS } from '../lib/palette'

/**
 * Menu-engineering matrix (popularity × margin), zoomable.
 *
 * The SVG is drawn at its real pixel size (ResizeObserver), so text stays
 * 12px on a phone instead of shrinking with a fixed viewBox. Zoom is a
 * window over the DATA domain, not a CSS/viewBox scale: dots spread apart
 * while labels keep their size, which is what lets a crowded menu
 * declutter. Pinch / drag on touch, ctrl+wheel (trackpad pinch) on
 * desktop, and +/− buttons everywhere. Labels that would collide are
 * dropped (popular dishes first); tapping a dot shows its detail card.
 * Zooming is direct manipulation, not an animation — nothing transitions.
 */
const props = defineProps<{ points: MenuEngineeringPoint[]; avgUnits: number; avgMargin: number }>()

const { t, n } = useI18n()
const router = useRouter()

const COLORS: Record<Quadrant, string> = QUADRANT_COLORS
const PAD = { l: 22, r: 10, t: 10, b: 24 }
const MAX_ZOOM = 8
const STEP = 1.6
const FONT = 12
const clipId = `menu-matrix-${useId()}`

// ── Size: real pixels ───────────────────────────────────────────
const wrap = ref<HTMLElement | null>(null)
const svg = ref<SVGSVGElement | null>(null)
const W = ref(640)
const H = computed(() => (W.value < 560 ? 360 : 300))
const plot = computed(() => ({ l: PAD.l, r: W.value - PAD.r, t: PAD.t, b: H.value - PAD.b }))
let ro: ResizeObserver | undefined

// ── Domain: the full extent, and the visible window over it ─────
type Win = { u0: number; u1: number; m0: number; m1: number }
// Margin is fitted to the menu (not 0–100 %): a scatter has no baseline,
// and real menus cluster in a narrow band that would otherwise waste most
// of a phone-sized plot.
const full = computed<Win>(() => {
  const pts = props.points
  const lo = Math.min(props.avgMargin, ...pts.map((p) => p.margin))
  const hi = Math.max(props.avgMargin, ...pts.map((p) => p.margin))
  const pad = Math.max(5, (hi - lo) * 0.12)
  return {
    u0: 0,
    u1: Math.max(1, ...pts.map((p) => p.units)) * 1.12,
    m0: lo - pad,
    m1: hi + pad,
  }
})
const win = ref<Win>({ ...full.value })
// Reset only when the extent really moves: the kitchen store re-emits the
// same menu on every live snapshot, which must not throw away the zoom.
watch(
  () => [full.value.u1, full.value.m0, full.value.m1].join(),
  () => (win.value = { ...full.value }),
)
const zoom = computed(() => (full.value.u1 - full.value.u0) / (win.value.u1 - win.value.u0))
const zoomed = computed(() => zoom.value > 1.001)

const x = (u: number) => plot.value.l + ((u - win.value.u0) / (win.value.u1 - win.value.u0)) * (plot.value.r - plot.value.l)
const y = (m: number) => plot.value.b - ((m - win.value.m0) / (win.value.m1 - win.value.m0)) * (plot.value.b - plot.value.t)

/** Keep a window of the given spans inside the full domain. */
function clampWin(u0: number, m0: number, su: number, sm: number): Win {
  const f = full.value
  u0 = Math.min(Math.max(u0, f.u0), f.u1 - su)
  m0 = Math.min(Math.max(m0, f.m0), f.m1 - sm)
  return { u0, u1: u0 + su, m0, m1: m0 + sm }
}

/** Zoom by `factor` keeping the data point under (px, py) fixed. */
function zoomAt(px: number, py: number, factor: number) {
  const f = full.value
  const w = win.value
  const p = plot.value
  const k = Math.min(MAX_ZOOM, Math.max(1, zoom.value * factor))
  const su = (f.u1 - f.u0) / k
  const sm = (f.m1 - f.m0) / k
  const fx = Math.min(1, Math.max(0, (px - p.l) / (p.r - p.l)))
  const fy = Math.min(1, Math.max(0, (p.b - py) / (p.b - p.t)))
  const u = w.u0 + fx * (w.u1 - w.u0)
  const m = w.m0 + fy * (w.m1 - w.m0)
  win.value = clampWin(u - fx * su, m - fy * sm, su, sm)
}

function panBy(dx: number, dy: number) {
  const w = win.value
  const p = plot.value
  const su = w.u1 - w.u0
  const sm = w.m1 - w.m0
  win.value = clampWin(w.u0 - (dx / (p.r - p.l)) * su, w.m0 + (dy / (p.b - p.t)) * sm, su, sm)
}

const center = () => ({ x: (plot.value.l + plot.value.r) / 2, y: (plot.value.t + plot.value.b) / 2 })
function zoomIn() {
  zoomAt(center().x, center().y, STEP)
}
function zoomOut() {
  zoomAt(center().x, center().y, 1 / STEP)
}
function reset() {
  win.value = { ...full.value }
}

// ── Gestures: one pointer pans (when zoomed), two pinch ─────────
// No pointer capture: it would retarget the click away from the dots.
const pointers = new Map<number, { x: number; y: number }>()
let last: { x: number; y: number; dist: number } | null = null
let travel = 0
const dragged = ref(false)

function local(e: MouseEvent) {
  const r = svg.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function snapshot() {
  const ps = [...pointers.values()]
  const a = ps[0]!
  const b = ps[1] ?? a
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) }
}
function onDown(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  if (pointers.size === 0) {
    travel = 0
    dragged.value = false
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  pointers.set(e.pointerId, local(e))
  last = snapshot()
}
function onMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId) || !last) return
  pointers.set(e.pointerId, local(e))
  const now = snapshot()
  const dx = now.x - last.x
  const dy = now.y - last.y
  travel += Math.hypot(dx, dy)
  if (pointers.size >= 2) {
    if (last.dist > 0 && now.dist > 0) zoomAt(now.x, now.y, now.dist / last.dist)
    panBy(dx, dy)
    dragged.value = true
  } else if (zoomed.value) {
    panBy(dx, dy)
    if (travel > 6) dragged.value = true
  }
  last = now
}
function onUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  last = pointers.size ? snapshot() : null
  if (!pointers.size) {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
}
// ctrl/⌘ + wheel is also what a trackpad pinch sends. A plain wheel
// keeps scrolling the page.
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  const p = local(e)
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.004))
}

onMounted(() => {
  ro = new ResizeObserver(([entry]) => {
    const w = Math.round(entry?.contentRect.width ?? 0)
    if (w > 0) W.value = w
  })
  if (wrap.value) ro.observe(wrap.value)
  svg.value?.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
  ro?.disconnect()
  svg.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
})

function onDblClick(e: MouseEvent) {
  const p = local(e)
  zoomAt(p.x, p.y, 2)
}

// ── Selection ───────────────────────────────────────────────────
const selectedId = ref<string | null>(null)
const selected = computed(() => props.points.find((p) => p.item.id === selectedId.value) ?? null)
function pick(id: string) {
  if (dragged.value) return
  selectedId.value = selectedId.value === id ? null : id
}
function onBackground() {
  if (!dragged.value) selectedId.value = null
}

// ── Label width, measured in the page's own font ────────────────
// Re-measured once the webfont lands: the fallback serif is narrower, and
// boxes measured with it let real labels overlap.
let ctx: CanvasRenderingContext2D | null = null
const fontEpoch = ref(0)
onMounted(() => document.fonts?.ready.then(() => fontEpoch.value++))
function textWidth(s: string, weight = 400, size = FONT): number {
  void fontEpoch.value
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx || !wrap.value) return s.length * size * 0.6
  ctx.font = `${weight} ${size}px ${getComputedStyle(wrap.value).fontFamily}`
  return ctx.measureText(s).width
}

// ── What to draw ────────────────────────────────────────────────
const dots = computed(() => {
  const p = plot.value
  return props.points
    .map((pt) => ({
      id: pt.item.id,
      name: pt.item.name,
      units: pt.units,
      margin: pt.margin,
      quadrant: pt.quadrant,
      cx: x(pt.units),
      cy: y(pt.margin),
      color: COLORS[pt.quadrant],
    }))
    .filter((d) => d.cx >= p.l - 12 && d.cx <= p.r + 12 && d.cy >= p.t - 12 && d.cy <= p.b + 12)
})

/** Greedy placement: selected, then most sold first. A label goes right
 *  of its dot, else left; if both sides hit another label or dot it is
 *  dropped (zoom in to bring it back, or tap the dot). */
const labels = computed(() => {
  type Box = { x0: number; x1: number; y0: number; y1: number }
  const p = plot.value
  const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
  // The quadrant corner labels are taken space too.
  const placed: Box[] = quadrants.value
    .filter((r) => r.label)
    .map((r) => {
      const w = textWidth(t(`pulse.quadrant.${r.q}`), 600, 11)
      const x0 = r.right ? r.lx - w : r.lx
      return { x0: x0 - 2, x1: x0 + w + 2, y0: r.ly - 12, y1: r.ly + 3 }
    })
  const dotBoxes = dots.value.map((d) => ({ id: d.id, x0: d.cx - 9, x1: d.cx + 9, y0: d.cy - 9, y1: d.cy + 9 }))
  const out: { id: string; text: string; x: number; y: number; anchor: 'start' | 'end' | 'middle' }[] = []
  const order = [...dots.value].sort((a, b) =>
    a.id === selectedId.value ? -1 : b.id === selectedId.value ? 1 : b.units - a.units,
  )
  for (const d of order) {
    if (d.cx < p.l || d.cx > p.r || d.cy < p.t || d.cy > p.b) continue
    const w = textWidth(d.name, d.id === selectedId.value ? 700 : 400)
    // Right, left, above, below — `y` is the text baseline.
    const sides = [
      { anchor: 'start' as const, x: d.cx + 13, x0: d.cx + 13, y: d.cy + 4 },
      { anchor: 'end' as const, x: d.cx - 13, x0: d.cx - 13 - w, y: d.cy + 4 },
      { anchor: 'middle' as const, x: d.cx, x0: d.cx - w / 2, y: d.cy - 13 },
      { anchor: 'middle' as const, x: d.cx, x0: d.cx - w / 2, y: d.cy + 23 },
    ]
    for (const s of sides) {
      const box = { x0: s.x0 - 2, x1: s.x0 + w + 2, y0: s.y - 13, y1: s.y + 2 }
      if (box.x0 < p.l || box.x1 > p.r || box.y0 < p.t || box.y1 > p.b) continue
      if (placed.some((b) => hits(box, b)) || dotBoxes.some((b) => b.id !== d.id && hits(box, b))) continue
      placed.push(box)
      out.push({ id: d.id, text: d.name, x: s.x, y: s.y, anchor: s.anchor })
      break
    }
  }
  return out
})

/** Quadrant regions, split at the menu averages and clipped to the plot,
 *  so a zoomed-in view still shows which group it is looking at. */
const quadrants = computed(() => {
  const p = plot.value
  const ax = Math.min(p.r, Math.max(p.l, x(props.avgUnits)))
  const ay = Math.min(p.b, Math.max(p.t, y(props.avgMargin)))
  const regions: { q: Quadrant; x0: number; x1: number; y0: number; y1: number; right: boolean; top: boolean }[] = [
    { q: 'puzzle', x0: p.l, x1: ax, y0: p.t, y1: ay, right: false, top: true },
    { q: 'star', x0: ax, x1: p.r, y0: p.t, y1: ay, right: true, top: true },
    { q: 'dog', x0: p.l, x1: ax, y0: ay, y1: p.b, right: false, top: false },
    { q: 'plowhorse', x0: ax, x1: p.r, y0: ay, y1: p.b, right: true, top: false },
  ]
  return regions
    .filter((r) => r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5)
    .map((r) => ({
      ...r,
      label: r.x1 - r.x0 > textWidth(t(`pulse.quadrant.${r.q}`), 600, 11) + 12 && r.y1 - r.y0 > 20,
      lx: r.right ? r.x1 - 6 : r.x0 + 6,
      ly: r.top ? r.y0 + 14 : r.y1 - 6,
    }))
})
const avgX = computed(() => x(props.avgUnits))
const avgY = computed(() => y(props.avgMargin))
</script>

<template>
  <div>
    <div class="mb-1 flex items-center justify-between gap-2 text-sm">
      <div class="flex min-w-0 items-center gap-1">
        <span class="truncate font-semibold">{{ t('pulse.matrixTitle') }}</span>
        <slot name="info" />
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          v-if="zoomed"
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-full text-smoke hover:bg-gray-100 hover:text-ink"
          :aria-label="t('pulse.matrix.zoomReset')"
          :title="t('pulse.matrix.zoomReset')"
          @click="reset"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
        </button>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 text-ink hover:bg-gray-50 disabled:opacity-40"
          :aria-label="t('pulse.matrix.zoomOut')"
          :disabled="!zoomed"
          @click="zoomOut"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12" /></svg>
        </button>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 text-ink hover:bg-gray-50 disabled:opacity-40"
          :aria-label="t('pulse.matrix.zoomIn')"
          :disabled="zoom >= MAX_ZOOM - 0.001"
          @click="zoomIn"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12M12 6v12" /></svg>
        </button>
      </div>
    </div>

    <div ref="wrap" class="relative select-none">
      <svg
        ref="svg"
        :height="H"
        :viewBox="`0 0 ${W} ${H}`"
        class="block w-full"
        :class="zoomed ? 'cursor-grab active:cursor-grabbing' : ''"
        :style="{ touchAction: zoomed ? 'none' : 'pan-y' }"
        role="img"
        :aria-label="t('pulse.matrixTitle')"
        @pointerdown="onDown"
      >
        <defs>
          <clipPath :id="clipId">
            <rect :x="plot.l" :y="plot.t" :width="plot.r - plot.l" :height="plot.b - plot.t" />
          </clipPath>
        </defs>

        <!-- Background: tinted quadrants, averages, axes -->
        <g @click="onBackground" @dblclick="onDblClick">
          <rect
            v-for="r in quadrants"
            :key="r.q"
            :x="r.x0"
            :y="r.y0"
            :width="r.x1 - r.x0"
            :height="r.y1 - r.y0"
            :fill="COLORS[r.q]"
            fill-opacity="0.05"
          />
        </g>
        <g :clip-path="`url(#${clipId})`" pointer-events="none">
          <line :x1="avgX" :x2="avgX" :y1="plot.t" :y2="plot.b" stroke="#D1D5DB" stroke-dasharray="4 4" />
          <line :x1="plot.l" :x2="plot.r" :y1="avgY" :y2="avgY" stroke="#D1D5DB" stroke-dasharray="4 4" />
        </g>
        <g pointer-events="none">
          <template v-for="r in quadrants" :key="`l-${r.q}`">
            <text v-if="r.label" :x="r.lx" :y="r.ly" :text-anchor="r.right ? 'end' : 'start'" font-size="11" font-weight="600" :fill="COLORS[r.q]">
              {{ t(`pulse.quadrant.${r.q}`) }}
            </text>
          </template>
          <line :x1="plot.l" :x2="plot.r" :y1="plot.b" :y2="plot.b" stroke="#E5E7EB" />
          <line :x1="plot.l" :x2="plot.l" :y1="plot.t" :y2="plot.b" stroke="#E5E7EB" />
          <text :x="(plot.l + plot.r) / 2" :y="H - 7" text-anchor="middle" font-size="10" fill="#7A6F66">{{ t('pulse.matrix.axisUnits') }}</text>
          <text :transform="`translate(${PAD.l - 8} ${(plot.t + plot.b) / 2}) rotate(-90)`" text-anchor="middle" font-size="10" fill="#7A6F66">
            {{ t('pulse.matrix.axisMargin') }}
          </text>
        </g>

        <!-- Dishes -->
        <g :clip-path="`url(#${clipId})`">
          <g
            v-for="dot in dots"
            :key="dot.id"
            class="cursor-pointer"
            tabindex="0"
            role="button"
            :aria-label="`${dot.name} · ${t('pulse.soldUnits', { n: dot.units })} · ${n(dot.margin / 100, 'percent')}`"
            @click="pick(dot.id)"
            @keydown.enter="pick(dot.id)"
          >
            <!-- Fat invisible hit target for fingers -->
            <circle :cx="dot.cx" :cy="dot.cy" r="18" fill="transparent" />
            <circle
              :cx="dot.cx"
              :cy="dot.cy"
              :r="dot.id === selectedId ? 10 : 8"
              :fill="dot.color"
              fill-opacity="0.9"
              :stroke="dot.id === selectedId ? '#1C1410' : '#fff'"
              :stroke-width="dot.id === selectedId ? 2 : 1.5"
            />
          </g>
          <text
            v-for="l in labels"
            :key="`t-${l.id}`"
            :x="l.x"
            :y="l.y"
            :text-anchor="l.anchor"
            :font-size="FONT"
            :font-weight="l.id === selectedId ? 700 : 400"
            fill="#1C1410"
            stroke="#fff"
            stroke-width="3"
            stroke-linejoin="round"
            paint-order="stroke"
            pointer-events="none"
          >
            {{ l.text }}
          </text>
        </g>
      </svg>
    </div>

    <!-- Detail of the tapped dish -->
    <div v-if="selected" class="mt-2 flex items-start gap-3 rounded-lg bg-gray-50 p-3">
      <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: COLORS[selected.quadrant] }" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{{ selected.item.name }}</div>
        <div class="text-xs text-smoke">
          {{ t(`pulse.quadrant.${selected.quadrant}`) }} · {{ t('pulse.soldUnits', { n: selected.units }) }} ·
          {{ t('pulse.matrix.margin', { pct: n(selected.margin / 100, 'percent') }) }}
        </div>
        <p class="mt-1 text-xs leading-relaxed text-ink">{{ t(`pulse.quadrantAdvice.${selected.quadrant}`) }}</p>
        <button type="button" class="btn-ghost mt-2 text-xs" @click="router.push(`/menu/${selected.item.id}`)">
          {{ t('pulse.matrix.editDish') }}
        </button>
      </div>
    </div>
    <div v-else class="mt-1 text-[11px] text-smoke">{{ t('pulse.matrixHint') }}</div>
  </div>
</template>
