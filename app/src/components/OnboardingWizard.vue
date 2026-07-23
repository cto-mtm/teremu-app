<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import BaseButton from './BaseButton.vue'
import logoColor from '../assets/logo-color.svg'

/**
 * First-login tour: four beats of what the app does + the plans. Shown
 * once per device (AppShell persists dismissal in localStorage) —
 * skipping counts as done, no nagging.
 */
const { t } = useI18n()
const auth = useAuthStore()
const open = defineModel<boolean>({ required: true })

const STEPS = ['welcome', 'scan', 'margins', 'team', 'plans'] as const
const ICONS: Record<(typeof STEPS)[number], string> = {
  welcome: '', // logo instead
  scan: '📷',
  margins: '📈',
  team: '👥',
  plans: '✨',
}
const step = ref(0)
const current = computed(() => STEPS[step.value])
const last = computed(() => step.value === STEPS.length - 1)

function finish(): void {
  // AppShell persists the dismissal (localStorage) when this closes.
  open.value = false
}
</script>

<template>
  <Transition name="list">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div class="flex min-h-[26rem] w-full max-w-md flex-col rounded-2xl bg-white/95 p-6 backdrop-blur-md">
        <!-- Skip -->
        <div class="flex justify-end">
          <button class="text-xs font-medium text-smoke hover:text-ink" @click="finish">
            {{ t('onboarding.skip') }}
          </button>
        </div>

        <!-- Step content -->
        <div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <Transition name="step" mode="out-in">
            <div :key="current" class="flex flex-col items-center gap-4">
              <img v-if="current === 'welcome'" :src="logoColor" alt="" aria-hidden="true" class="h-20 w-20" />
              <span v-else class="text-5xl" aria-hidden="true">{{ ICONS[current] }}</span>

              <h2 class="text-2xl font-bold">{{ t(`onboarding.steps.${current}.title`) }}</h2>
              <p class="max-w-sm text-sm leading-relaxed text-smoke">
                {{ t(`onboarding.steps.${current}.body`) }}
              </p>

              <!-- Plans comparison on the final step -->
              <div v-if="current === 'plans'" class="w-full space-y-2 text-left">
                <div
                  class="rounded-xl border p-3"
                  :class="auth.profile?.plan === 'free' ? 'border-ember bg-ember-50' : 'border-gray-100'"
                >
                  <div class="flex items-center justify-between text-sm font-semibold">
                    {{ t('onboarding.steps.plans.freeTitle') }}
                    <span v-if="auth.profile?.plan === 'free'" class="text-[10px] font-bold text-ember-700 uppercase">
                      {{ t('onboarding.steps.plans.current') }}
                    </span>
                  </div>
                  <div class="mt-1 text-xs text-smoke">{{ t('onboarding.steps.plans.freeItems') }}</div>
                </div>
                <div
                  class="rounded-xl border p-3"
                  :class="auth.profile?.plan === 'pro' ? 'border-herb bg-herb-50' : 'border-gray-100'"
                >
                  <div class="flex items-center justify-between text-sm font-semibold">
                    {{ t('onboarding.steps.plans.proTitle') }}
                    <span v-if="auth.profile?.plan === 'pro'" class="text-[10px] font-bold text-herb-700 uppercase">
                      {{ t('onboarding.steps.plans.current') }}
                    </span>
                  </div>
                  <div class="mt-1 text-xs text-smoke">{{ t('onboarding.steps.plans.proItems') }}</div>
                </div>
              </div>
            </div>
          </Transition>
        </div>

        <!-- Dots + navigation -->
        <div class="mt-4 flex items-center justify-between">
          <button
            class="text-xs font-medium text-smoke hover:text-ink disabled:invisible"
            :disabled="step === 0"
            @click="step -= 1"
          >
            {{ t('onboarding.back') }}
          </button>
          <div class="flex gap-1.5" aria-hidden="true">
            <span
              v-for="(s, i) in STEPS"
              :key="s"
              class="h-1.5 rounded-full transition-all duration-300"
              :class="i === step ? 'w-5 bg-ember' : 'w-1.5 bg-gray-200'"
            />
          </div>
          <BaseButton v-if="!last" @click="step += 1">{{ t('onboarding.next') }}</BaseButton>
          <BaseButton v-else variant="herb" @click="finish">{{ t('onboarding.start') }}</BaseButton>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Step swap — transform & opacity only (house rules) */
.step-enter-active,
.step-leave-active {
  transition:
    transform 240ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 240ms cubic-bezier(0.4, 0, 0.2, 1);
}
.step-enter-from {
  transform: translateX(24px);
  opacity: 0;
}
.step-leave-to {
  transform: translateX(-24px);
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .step-enter-active,
  .step-leave-active {
    transition: none;
  }
}
</style>
