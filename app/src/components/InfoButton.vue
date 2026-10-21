<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The small ⓘ next to a title that opens a "what does this mean" card —
 * the Triage explainer pattern, reusable. The body is the default slot.
 */
defineProps<{ title: string }>()

const { t } = useI18n()
const open = ref(false)

// Esc closes it wherever focus is (the card does not grab focus).
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') open.value = false
}
watch(open, (v) => (v ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <button
    type="button"
    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-smoke hover:bg-gray-100 hover:text-ink"
    :class="open ? 'bg-ember-50 text-ember-700' : ''"
    :aria-label="t('common.action.info')"
    @click="open = !open"
  >
    <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.01" />
    </svg>
  </button>

  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        @click.self="open = false"
      >
        <div class="w-full max-w-sm space-y-3 rounded-xl bg-white p-5 shadow-lg" role="dialog" aria-modal="true" :aria-label="title">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold text-ink">{{ title }}</h2>
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-smoke hover:bg-gray-100 hover:text-ink"
              :aria-label="t('common.action.close')"
              @click="open = false"
            >
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div class="space-y-2 text-sm leading-relaxed text-smoke">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
