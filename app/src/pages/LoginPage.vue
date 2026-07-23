<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import LocaleSwitcher from '../components/LocaleSwitcher.vue'
import logoColor from '../assets/logo-color.svg'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// Once signed in, continue to wherever the guard interrupted.
watch(
  () => auth.user,
  (user) => {
    if (user) {
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
      void router.replace(redirect)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex min-h-[85vh] w-full flex-col items-center justify-center gap-5 px-6 text-center">
    <img :src="logoColor" alt="" aria-hidden="true" class="h-20 w-20" />
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">{{ t('auth.title') }}</h1>
      <p class="max-w-sm text-sm text-smoke">{{ t('auth.subtitle') }}</p>
    </div>
    <!-- Google-branded sign-in button (per Google identity guidelines:
         neutral surface, official multicolor G, no brand-colored fill) -->
    <button
      class="flex items-center gap-3 rounded-full border border-gray-300 bg-white px-6 py-3 text-sm font-semibold text-ink shadow-card transition hover:bg-gray-50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
      :disabled="auth.busy"
      @click="auth.signIn"
    >
      <svg viewBox="0 0 48 48" class="h-5 w-5 shrink-0" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
      {{ auth.busy ? t('common.loading') : t('auth.google') }}
    </button>
    <p v-if="auth.error" class="text-xs text-coral-600">{{ t('auth.error') }}</p>
    <div class="mt-2">
      <LocaleSwitcher />
    </div>
  </div>
</template>
