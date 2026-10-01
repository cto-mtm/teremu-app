<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, type SupportedLocale } from '../i18n'
import { useAuthStore } from '../stores/auth'

const { locale } = useI18n({ useScope: 'global' })
const auth = useAuthStore()

// Applies on this device and, signed in, saves it to the profile so it
// follows the person (and their emails). Signed out (LoginPage), the
// choice is applied now and saved on sign-in.
function setLocale(next: SupportedLocale): void {
  auth.chooseLocale(next)
}
</script>

<template>
  <div class="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs font-semibold">
    <button
      v-for="code in SUPPORTED_LOCALES"
      :key="code"
      class="px-3 py-1.5 uppercase"
      :class="locale === code ? 'bg-ink text-white' : 'bg-white text-smoke hover:bg-gray-50'"
      @click="setLocale(code)"
    >
      {{ code }}
    </button>
  </div>
</template>
