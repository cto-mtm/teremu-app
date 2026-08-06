<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import logoColor from '../assets/logo-color.svg'

const { t } = useI18n()
</script>

<template>
  <div
    class="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-cream"
    role="status"
    :aria-label="t('common.loading')"
  >
    <!-- Pulsing logo -->
    <img
      :src="logoColor"
      alt=""
      aria-hidden="true"
      class="h-16 w-16 animate-pulse-logo"
    />
    <!-- Brand text -->
    <p class="font-display text-2xl font-extrabold tracking-tight">
      <span class="text-gradient">Teremu</span><span class="text-ember">.</span>
    </p>
    <!-- Subtle loading bar -->
    <div class="h-1 w-40 overflow-hidden rounded-full bg-ember-100">
      <div class="h-full w-full animate-slide-x rounded-full bg-ember" />
    </div>
  </div>
</template>

<style scoped>
@keyframes pulse-logo {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(0.95);
  }
}

@keyframes slide-x {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

.animate-pulse-logo {
  animation: pulse-logo 2s ease-in-out infinite;
}

.animate-slide-x {
  animation: slide-x 1.2s ease-in-out infinite;
}
</style>
