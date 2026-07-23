<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col items-center gap-4 py-20 text-center">
    <h1 class="text-xl font-bold">{{ t('notfound.title') }}</h1>
    <p class="text-sm text-smoke">{{ t('notfound.message') }}</p>
    <RouterLink to="/" class="btn-primary">{{ t('notfound.goHome') }}</RouterLink>
  </div>
</template>
