<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { installEvent, isIos, isNative, isStandalone, online } from '../lib/pwa'
import logoColor from '../assets/logo-color.svg'

// `installable` is off on routes where a card would get in the way
// (login, the scanner, focused flows) — AppShell decides.
const props = defineProps<{ installable: boolean }>()

const { t } = useI18n()

// "Not now" snoozes the offer on this device for two weeks.
const SNOOZE_KEY = 'teremu-install-snoozed'
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000
const snoozedAt = ref(Number(localStorage.getItem(SNOOZE_KEY) ?? 0))

const iosHint = !isNative() && !isStandalone() && isIos()

const showInstall = computed(
  () =>
    props.installable &&
    (installEvent.value !== null || iosHint) &&
    Date.now() - snoozedAt.value > SNOOZE_MS,
)

function snooze(): void {
  snoozedAt.value = Date.now()
  localStorage.setItem(SNOOZE_KEY, String(snoozedAt.value))
}

async function install(): Promise<void> {
  const event = installEvent.value
  if (!event) return
  await event.prompt()
  const { outcome } = await event.userChoice
  // The event is single-use either way.
  installEvent.value = null
  if (outcome === 'dismissed') snooze()
}
</script>

<template>
  <div
    v-if="!online"
    class="pt-safe fixed inset-x-0 top-0 z-[200] flex justify-center px-3"
    role="status"
    aria-live="polite"
  >
    <p class="mt-3 rounded-full bg-ink px-4 py-2 text-center text-sm font-medium text-white shadow-lg">
      {{ t('pwa.offline') }}
    </p>
  </div>

  <div
    v-if="showInstall"
    class="pb-safe fixed inset-x-3 bottom-20 z-[56] mx-auto max-w-sm md:right-6 md:bottom-6 md:left-auto"
    role="dialog"
    :aria-label="t('pwa.install.title')"
  >
    <div class="flex items-start gap-3 rounded-2xl border border-ember-100 bg-white p-4 shadow-lg">
      <img :src="logoColor" alt="" aria-hidden="true" class="h-10 w-10 shrink-0" />
      <div class="min-w-0 flex-1">
        <p class="font-display font-bold text-ink">{{ t('pwa.install.title') }}</p>
        <p class="mt-0.5 text-sm text-smoke">
          {{ installEvent ? t('pwa.install.body') : t('pwa.install.iosBody') }}
        </p>
        <div class="mt-3 flex gap-2">
          <button
            v-if="installEvent"
            class="rounded-xl bg-ember px-4 py-2 text-sm font-semibold text-white active:scale-95"
            @click="install"
          >
            {{ t('pwa.install.action') }}
          </button>
          <button
            class="rounded-xl px-3 py-2 text-sm font-medium text-smoke hover:bg-gray-50 hover:text-ink"
            @click="snooze"
          >
            {{ t('pwa.install.dismiss') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
