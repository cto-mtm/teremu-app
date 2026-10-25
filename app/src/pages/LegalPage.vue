<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { currentLocale } from '../i18n'
import { legalUrl, type LegalDocId } from '../lib/legal'
import { isNative } from '../lib/pwa'
import { useAuthStore } from '../stores/auth'

/**
 * /privacy and /terms forward to the one public copy on teremu.com
 * (src/lib/legal.ts), in the user's language. In the browser the tab
 * itself moves there; inside the native shells the system browser opens
 * and this page steps back, since navigating the webview away would
 * strand the app. The link stays visible as the fallback for a blocked
 * popup or a slow redirect.
 */
const props = defineProps<{ doc: LegalDocId }>()

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const url = computed(() => legalUrl(props.doc, currentLocale()))

onMounted(() => {
  if (isNative()) {
    window.open(url.value, '_blank', 'noopener')
    void router.replace(auth.user ? '/settings' : '/login')
  } else {
    window.location.replace(url.value)
  }
})
</script>

<template>
  <div class="flex flex-col items-center gap-4 py-20 text-center">
    <h1 class="text-xl font-bold">{{ t(doc === 'privacy' ? 'legal.linkPrivacy' : 'legal.linkTerms') }}</h1>
    <p class="text-sm text-smoke">{{ t('legal.redirecting') }}</p>
    <a :href="url" rel="noopener" class="btn-primary">{{ t('legal.openOnSite') }}</a>
  </div>
</template>
