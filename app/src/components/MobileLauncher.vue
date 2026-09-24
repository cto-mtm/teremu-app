<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { useInvoicesStore } from '../stores/invoices'
import NavIcon from './NavIcon.vue'

/**
 * Full-screen mobile launcher (modal). A 3-per-row grid of page tiles
 * plus two big Scan / Upload actions pinned at the bottom — the "hub"
 * a phone user lands on and can reopen from the bottom-right FAB
 * (AppShell owns the FAB + auto-open-once-per-session; this component
 * is purely the modal). Mobile-only by construction: AppShell renders
 * it under `md:hidden`. Desktop keeps the persistent sidebar.
 *
 * Upload reuses the scanner's exact path (invoicesStore.capture →
 * compress → POST /invoices), so an uploaded image rides the same OCR
 * pipeline as a camera shot. Image files only for now — PDF invoices
 * need the server-side rasterization pipeline (docs/email-ingestion.md),
 * which isn't built yet; the file input's accept list reflects that.
 */
const model = defineModel<boolean>({ required: true })

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const invoices = useInvoicesStore()

// Same perm-gated set the sidebar shows, plus Settings — but as a grid
// of tiles. Kept in sync with AppShell's `tabs` by mirroring its perm
// checks (the server enforces regardless).
const tiles = computed(() =>
  [
    { to: '/', label: t('shell.tab.pulse'), icon: 'pulse' as const, show: auth.can('finance') },
    { to: '/triage', label: t('shell.tab.triage'), icon: 'triage' as const, badge: invoices.triageCount, show: auth.can('triage') },
    { to: '/menu', label: t('shell.tab.menu'), icon: 'menu' as const, show: auth.can('menu') },
    { to: '/pantry', label: t('shell.tab.pantry'), icon: 'pantry' as const, show: auth.can('pantry') },
    { to: '/vendors', label: t('shell.tab.vendors'), icon: 'vendors' as const, show: auth.can('vendors') },
    { to: '/settings', label: t('shell.settings'), icon: 'settings' as const, show: true },
  ].filter((tile) => tile.show),
)

function go(to: string): void {
  model.value = false
  void router.push(to)
}

// ── Scan / Upload actions ───────────────────────────────────────
const canScan = computed(() => auth.can('scan'))

function goScan(): void {
  model.value = false
  void router.push('/scan')
}

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadError = ref<string | null>(null)

function pickFile(): void {
  uploadError.value = null
  fileInput.value?.click()
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // let the same file be re-picked after an error
  if (!file) return
  // Image-only for now (createImageBitmap can't rasterize a PDF).
  if (!file.type.startsWith('image/')) {
    uploadError.value = t('shell.launcher.uploadInvalid')
    return
  }
  uploading.value = true
  uploadError.value = null
  const ok = await invoices.capture(file)
  uploading.value = false
  if (ok) {
    model.value = false
    void router.push('/triage')
    return
  }
  // Out of scans → send them to plans (same as the scanner's limit CTA),
  // not a generic "upload failed" that hides the real reason.
  if (invoices.error?.includes('scan_limit')) {
    model.value = false
    void router.push('/pricing')
    return
  }
  uploadError.value = t('shell.launcher.uploadFailed')
}
</script>

<template>
  <Transition name="fade">
    <div
      v-if="model"
      class="pt-safe pb-safe fixed inset-0 z-[60] flex flex-col bg-white md:hidden"
      role="dialog"
      aria-modal="true"
      :aria-label="t('shell.launcher.title')"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 pt-4 pb-2">
        <h2 class="font-display text-xl font-extrabold tracking-tight">
          {{ t('shell.launcher.title') }}
        </h2>
        <button
          class="flex h-10 w-10 items-center justify-center rounded-xl text-smoke hover:bg-gray-100 hover:text-ink"
          :aria-label="t('shell.launcher.close')"
          @click="model = false"
        >
          <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Page tiles: 3 per row -->
      <div class="flex-1 overflow-y-auto px-5 py-2">
        <div class="grid grid-cols-3 gap-3">
          <button
            v-for="tile in tiles"
            :key="tile.to"
            class="relative flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl bg-gray-50 p-2 text-center transition-colors hover:bg-ember-50 active:bg-ember-50"
            @click="go(tile.to)"
          >
            <span
              v-if="tile.badge"
              class="absolute top-2 right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-coral px-1 text-[10px] font-bold text-white"
            >
              {{ tile.badge }}
            </span>
            <NavIcon :name="tile.icon" class="h-8 w-8 text-ember-700" />
            <span class="text-xs font-semibold text-ink">{{ tile.label }}</span>
          </button>
        </div>
      </div>

      <!-- Scan / Upload: the two big actions, pinned bottom -->
      <div class="border-t border-gray-100 px-5 pt-3 pb-4">
        <p v-if="uploadError" class="mb-2 text-center text-xs font-medium text-coral">
          {{ uploadError }}
        </p>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-if="canScan"
            class="flex flex-col items-center justify-center gap-1.5 rounded-2xl bg-ember px-4 py-5 font-bold text-white shadow-card transition-transform active:scale-95"
            @click="goScan"
          >
            <svg viewBox="0 0 24 24" class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
              <circle cx="12" cy="12" r="3.5" />
            </svg>
            <span>{{ t('shell.launcher.scan') }}</span>
            <span class="text-[11px] font-medium text-white/80">{{ t('shell.launcher.scanHint') }}</span>
          </button>

          <button
            v-if="canScan"
            class="flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-ember bg-white px-4 py-5 font-bold text-ember-700 transition-transform active:scale-95 disabled:opacity-60"
            :disabled="uploading"
            @click="pickFile"
          >
            <svg v-if="!uploading" viewBox="0 0 24 24" class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 16V4M8 8l4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <svg v-else viewBox="0 0 24 24" class="h-7 w-7 animate-spin" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round" />
            </svg>
            <span>{{ uploading ? t('shell.launcher.uploading') : t('shell.launcher.upload') }}</span>
            <span class="text-[11px] font-medium text-smoke">{{ t('shell.launcher.uploadHint') }}</span>
          </button>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          class="hidden"
          @change="onFile"
        />
      </div>
    </div>
  </Transition>
</template>
