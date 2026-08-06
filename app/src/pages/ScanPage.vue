<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import logoWhite from '../assets/logo-white.svg'

/**
 * Continuous Invoice Capture. Snap → brief flash confirmation → the
 * camera stays live for the next receipt. Upload + OCR run in the
 * background; nothing blocks the operator.
 * Target: 15 crinkled invoices in 60 seconds.
 */
const { t } = useI18n()
const router = useRouter()
const store = useInvoicesStore()

const video = ref<HTMLVideoElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const cameraOk = ref<boolean | null>(null)
const count = ref(0)
const flash = ref(0)
const uploading = ref(0)
// Non-blocking upload-failure notice — an alert() would freeze the
// camera mid-batch, the one thing this screen must never do. Holds the
// specific message (network vs monthly scan limit).
const uploadError = ref<string | null>(null)
let errorTimer: ReturnType<typeof setTimeout> | null = null
const lastThumb = ref<string | null>(null)
// Multi-page mode: every capture becomes another PAGE of the same
// invoice (long vendor invoices) instead of a new invoice per shot.
// "Finish" closes the document and runs one OCR over all its pages.
const multiPage = ref(false)
// Quality gate: when a capture looks blurry/dark we hold it here and
// ask, instead of silently feeding the OCR a photo it will misread.
const qualityIssue = ref<'blur' | 'dark' | null>(null)
let pendingCanvas: HTMLCanvasElement | null = null
let stream: MediaStream | null = null
let thumbIsObjectUrl = false

onMounted(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
      audio: false,
    })
    // Flip the flag first so the <video v-if> renders, THEN attach the
    // stream on the next tick — the element doesn't exist before that,
    // and assigning early leaves a silent black screen.
    cameraOk.value = true
    await nextTick()
    if (video.value) video.value.srcObject = stream
  } catch {
    cameraOk.value = false
  }
})

onUnmounted(() => {
  stream?.getTracks().forEach((track) => track.stop())
  releaseThumb()
  // Never leave a half-uploaded multi-page invoice behind — closing the
  // scanner finishes it with whatever pages it has.
  void store.finishMultipage()
})

function toggleMultiPage(): void {
  multiPage.value = !multiPage.value
  if (!multiPage.value) void store.finishMultipage()
}

async function finishInvoice(): Promise<void> {
  if (uploading.value > 0) return // a page is still in flight
  await store.finishMultipage()
}

function releaseThumb(): void {
  if (thumbIsObjectUrl && lastThumb.value) URL.revokeObjectURL(lastThumb.value)
  thumbIsObjectUrl = false
}

function setThumbFromCanvas(canvas: HTMLCanvasElement): void {
  releaseThumb()
  const scale = 160 / Math.max(canvas.width, canvas.height)
  const small = document.createElement('canvas')
  small.width = Math.round(canvas.width * scale)
  small.height = Math.round(canvas.height * scale)
  small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height)
  lastThumb.value = small.toDataURL('image/jpeg', 0.6)
}

/**
 * Cheap on-device quality check (~5ms on a 240px copy):
 * - brightness = mean luminance; receipts are paper, they should be bright
 * - sharpness = variance of a 4-neighbor Laplacian; blur flattens it
 * Deliberately conservative thresholds — a false "looks fine" is better
 * than nagging on every capture.
 */
function checkQuality(source: HTMLCanvasElement): 'blur' | 'dark' | null {
  const w = 240
  const h = Math.round((source.height / source.width) * w)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.drawImage(source, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  const luma = new Float32Array(w * h)
  let sum = 0
  for (let i = 0; i < w * h; i++) {
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    luma[i] = l
    sum += l
  }
  const brightness = sum / (w * h)
  if (brightness < 45) return 'dark'

  let lapSum = 0
  let lapSqSum = 0
  const count = (w - 2) * (h - 2)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w]
      lapSum += lap
      lapSqSum += lap * lap
    }
  }
  const mean = lapSum / count
  const variance = lapSqSum / count - mean * mean
  if (variance < 40) return 'blur'

  return null
}

function commitCanvas(canvas: HTMLCanvasElement): void {
  setThumbFromCanvas(canvas)
  // The canvas goes straight to the compressor — one JPEG encode total.
  void send(canvas)
}

function useAnyway(): void {
  if (pendingCanvas) commitCanvas(pendingCanvas)
  pendingCanvas = null
  qualityIssue.value = null
}

function retake(): void {
  pendingCanvas = null
  qualityIssue.value = null
}

async function send(source: Blob | HTMLCanvasElement): Promise<void> {
  // In multi-page mode only a NEW invoice bumps the invoice counter —
  // additional pages count in the page badge instead.
  const newInvoice = !multiPage.value || !store.multipageId
  if (newInvoice) count.value += 1
  flash.value += 1 // retriggers the confirmation flash overlay
  navigator.vibrate?.(30)
  uploading.value += 1
  const ok = multiPage.value ? await store.capturePage(source) : await store.capture(source)
  uploading.value -= 1
  if (!ok) {
    if (newInvoice) count.value -= 1
    navigator.vibrate?.([60, 40, 60])
    const limit = store.error?.includes('scan_limit')
    uploadError.value = limit ? t('scan.limitReached') : t('scan.uploadFailed')
    if (errorTimer) clearTimeout(errorTimer)
    // The paywall message sticks longer — it's actionable, not transient.
    errorTimer = setTimeout(() => (uploadError.value = null), limit ? 8000 : 4000)
  }
}

function snap(): void {
  const el = video.value
  if (!el || !el.videoWidth || qualityIssue.value) return
  const canvas = document.createElement('canvas')
  canvas.width = el.videoWidth
  canvas.height = el.videoHeight
  canvas.getContext('2d')!.drawImage(el, 0, 0)

  const issue = checkQuality(canvas)
  if (issue) {
    pendingCanvas = canvas
    qualityIssue.value = issue
    navigator.vibrate?.([20, 40, 20])
    return
  }
  commitCanvas(canvas)
}

function onFiles(event: Event): void {
  const files = (event.target as HTMLInputElement).files
  if (!files || files.length === 0) return
  releaseThumb()
  lastThumb.value = URL.createObjectURL(files[files.length - 1])
  thumbIsObjectUrl = true
  const picked = Array.from(files)
  if (multiPage.value) {
    // Pages of ONE invoice — upload sequentially so page order holds.
    void (async () => {
      for (const f of picked) await send(f)
    })()
  } else {
    picked.forEach((f) => void send(f))
  }
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <div class="fixed inset-0 z-30 flex flex-col bg-black">
    <!-- Camera -->
    <div class="relative flex-1 overflow-hidden">
      <video
        v-if="cameraOk"
        ref="video"
        autoplay
        playsinline
        muted
        class="absolute inset-0 h-full w-full object-cover"
      />

      <!-- Soft vignette so the white chrome always has contrast -->
      <div
        class="pointer-events-none absolute inset-0"
        style="background: radial-gradient(140% 100% at 50% 45%, transparent 55%, rgba(0, 0, 0, 0.45) 100%)"
      />

      <!-- Receipt framing guide: four corner brackets, portrait aspect -->
      <div
        v-if="cameraOk"
        class="pointer-events-none absolute top-1/2 left-1/2 aspect-[3/4] w-[72%] max-w-sm -translate-x-1/2 -translate-y-1/2"
        aria-hidden="true"
      >
        <span class="absolute top-0 left-0 h-7 w-7 rounded-tl-xl border-t-[3px] border-l-[3px] border-white/90" />
        <span class="absolute top-0 right-0 h-7 w-7 rounded-tr-xl border-t-[3px] border-r-[3px] border-white/90" />
        <span class="absolute bottom-0 left-0 h-7 w-7 rounded-bl-xl border-b-[3px] border-l-[3px] border-white/90" />
        <span class="absolute right-0 bottom-0 h-7 w-7 rounded-br-xl border-r-[3px] border-b-[3px] border-white/90" />
      </div>

      <!-- Camera unavailable fallback -->
      <div
        v-if="cameraOk === false"
        class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center text-sm text-white/80"
      >
        <img :src="logoWhite" alt="" aria-hidden="true" class="h-14 w-14 opacity-80" />
        <p>{{ t('scan.cameraUnavailable') }}</p>
        <button class="btn-primary" @click="fileInput?.click()">{{ t('scan.choosePhotos') }}</button>
      </div>

      <!-- Top chrome: glass pills over the viewfinder -->
      <div class="pt-safe absolute inset-x-0 top-0 flex items-center justify-between p-4">
        <button
          class="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-md"
          :aria-label="t('scan.close')"
          @click="router.back()"
        >
          ✕
        </button>
        <div class="flex items-center gap-2 rounded-full bg-black/40 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md">
          {{
            multiPage && store.multipageCount > 0
              ? t('scan.pageCount', { n: store.multipageCount })
              : count > 0
                ? t('scan.captured', { n: count })
                : t('scan.title')
          }}
          <span
            v-if="uploading > 0"
            class="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white"
            role="status"
            :aria-label="t('scan.uploading')"
          />
        </div>
        <div class="flex items-center gap-2">
          <!-- Multi-page mode: each shot = another page of ONE invoice -->
          <button
            class="flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-md"
            :class="multiPage ? 'bg-white text-ink' : 'bg-black/40 text-white'"
            :aria-label="t('scan.multiPage')"
            :aria-pressed="multiPage"
            @click="toggleMultiPage"
          >
            <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 3h8a2 2 0 0 1 2 2v12" />
              <rect x="5" y="7" width="11" height="14" rx="2" />
            </svg>
          </button>
          <button
            class="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-md"
            :aria-label="t('scan.addFromLibrary')"
            @click="fileInput?.click()"
          >
            <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="9" cy="9" r="1.8" />
              <path d="M21 15l-5-5-8 8" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Capture confirmation flash: keyed so each snap re-runs it -->
      <div :key="flash" :class="flash ? 'flash-confirm absolute inset-0 bg-white' : 'hidden'" />

      <!-- Upload failure: transient coral chip, camera stays live -->
      <Transition name="pop">
        <div
          v-if="uploadError"
          class="absolute top-20 right-8 left-8 mx-auto max-w-sm rounded-2xl bg-coral px-4 py-2 text-center text-xs font-bold text-white shadow-lg"
          role="alert"
        >
          {{ uploadError }}
        </div>
      </Transition>

      <!-- Quality gate: capture held, operator decides -->
      <Transition name="pop">
        <div
          v-if="qualityIssue"
          class="absolute inset-x-6 bottom-16 mx-auto max-w-sm space-y-3 rounded-2xl bg-black/70 p-4 text-center backdrop-blur-md"
        >
          <p class="text-sm font-semibold text-white">
            {{ qualityIssue === 'dark' ? t('scan.qualityDark') : t('scan.qualityBlur') }}
          </p>
          <div class="flex justify-center gap-2">
            <button class="rounded-full bg-white px-4 py-2 text-xs font-bold text-ink" @click="retake">
              {{ t('scan.retake') }}
            </button>
            <button class="rounded-full bg-white/20 px-4 py-2 text-xs font-semibold text-white" @click="useAnyway">
              {{ t('scan.useAnyway') }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- Finish button (multi-page) / encouragement / first-time hint -->
      <div class="absolute inset-x-0 bottom-4 flex justify-center px-8">
        <Transition name="pop" mode="out-in">
          <button
            v-if="multiPage && store.multipageCount > 0"
            key="finish"
            class="rounded-full bg-white px-5 py-2 text-xs font-bold text-ink shadow-lg disabled:opacity-50"
            :disabled="uploading > 0"
            @click="finishInvoice"
          >
            {{ t('scan.finishInvoice', { n: store.multipageCount }) }}
          </button>
          <p
            v-else-if="multiPage"
            key="multiHint"
            class="max-w-xs text-center text-xs leading-relaxed text-white/75"
          >
            {{ t('scan.multiPageHint') }}
          </p>
          <div
            v-else-if="count > 0"
            key="going"
            class="flex items-center gap-1.5 rounded-full bg-ember px-4 py-1.5 text-xs font-bold text-white shadow-lg"
          >
            ⚡ {{ t('scan.keepGoing') }}
          </div>
          <p
            v-else-if="cameraOk"
            key="hint"
            class="max-w-xs text-center text-xs leading-relaxed text-white/75"
          >
            {{ t('scan.hint') }}
          </p>
        </Transition>
      </div>
    </div>

    <!-- Bottom controls: last-capture thumbnail · shutter · review pill -->
    <div class="pb-safe flex items-center justify-between gap-4 bg-black px-8 py-5">
      <div class="flex w-20 justify-start">
        <Transition name="pop">
          <button
            v-if="lastThumb"
            class="relative h-14 w-14 overflow-hidden rounded-xl border-2 border-white/60"
            :aria-label="t('scan.review', { n: count })"
            @click="router.push('/triage')"
          >
            <img :src="lastThumb" :alt="t('scan.lastCaptureAlt')" class="h-full w-full object-cover" />
            <span
              v-if="count > 0"
              class="absolute right-0.5 bottom-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-ember px-1 text-[10px] font-bold text-white"
            >
              {{ count }}
            </span>
          </button>
        </Transition>
      </div>

      <button
        class="rounded-full border-4 border-white/90 p-1.5 transition active:scale-90 disabled:opacity-30"
        style="width: 76px; height: 76px"
        :disabled="!cameraOk"
        :aria-label="t('scan.capture')"
        @click="snap"
      >
        <div class="h-full w-full rounded-full bg-white transition hover:bg-ember-50" />
      </button>

      <div class="flex w-20 justify-end">
        <button
          class="rounded-full px-4 py-2 text-xs font-semibold whitespace-nowrap"
          :class="count > 0 ? 'bg-white text-ink' : 'text-white/80'"
          @click="router.push('/triage')"
        >
          {{ count > 0 ? t('scan.review', { n: count }) : t('scan.done') }}
        </button>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      capture="environment"
      multiple
      hidden
      @change="onFiles"
    />
  </div>
</template>

<style scoped>
@keyframes flash-confirm {
  0% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
  }
}
.flash-confirm {
  animation: flash-confirm 0.45s ease-out forwards;
}

/* Thumbnail / chip entrance — transform & opacity only (house rules) */
.pop-enter-active {
  transition:
    transform 250ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 250ms cubic-bezier(0.4, 0, 0.2, 1);
}
.pop-leave-active {
  transition:
    transform 200ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
.pop-enter-from,
.pop-leave-to {
  transform: scale(0.6);
  opacity: 0;
}
</style>
