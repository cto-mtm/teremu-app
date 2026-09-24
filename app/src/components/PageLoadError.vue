<script setup lang="ts">
/**
 * Shown when a page's code fails to load (router `page()` errorComponent).
 * In practice that is a deploy: the hashed files this tab was built
 * against no longer exist. A full reload fetches the new index.html and
 * with it the new files — so reload once automatically, and only if that
 * already happened in the last minute stop and offer a manual retry
 * (never a reload loop, e.g. when genuinely offline).
 */
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseButton from './BaseButton.vue'

const { t } = useI18n()
const KEY = 'teremu-page-reload-at'

function reload(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* storage blocked — reload anyway */
  }
  location.reload()
}

onMounted(() => {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(KEY)) || 0
  } catch {
    /* storage blocked — treat as never reloaded */
  }
  if (Date.now() - last > 60_000) reload()
})
</script>

<template>
  <div class="card space-y-3 py-10 text-center text-sm text-smoke" role="alert">
    <p>{{ t('common.pageLoadFailed') }}</p>
    <BaseButton variant="ghost" @click="reload">{{ t('common.action.retry') }}</BaseButton>
  </div>
</template>
