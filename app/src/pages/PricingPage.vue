<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '../lib/api'
import { billingUrlSchema } from '../lib/schemas'
import { useAuthStore } from '../stores/auth'
import BaseButton from '../components/BaseButton.vue'

/**
 * In-app plan comparison. Copy mirrors PLAN_LIMITS on the server and
 * docs/business-model.md — if limits change there, update pricing.ts
 * (both locales) here. The upgrade CTA opens Stripe Checkout for the
 * chosen billing interval; the plan only flips once the webhook fires.
 */
const { t } = useI18n()
const auth = useAuthStore()

const isOwner = computed(() => auth.profile?.role === 'owner')
const plan = computed(() => auth.profile?.plan)

const interval = ref<'month' | 'year'>('month')
const busy = ref(false)

const FREE_ITEMS = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9'] as const
const PRO_ITEMS = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10'] as const
const MAX_ITEMS = ['i1', 'i2'] as const

async function upgrade(toPlan: 'pro' | 'max'): Promise<void> {
  busy.value = true
  const res = await apiFetch(
    '/billing/checkout',
    { method: 'POST', body: JSON.stringify({ plan: toPlan, interval: interval.value }) },
    billingUrlSchema,
  )
  busy.value = false
  // Success → hand off to Stripe's hosted checkout page.
  if (res.ok) window.location.href = res.data.url
  else alert(t('settings.plan.checkoutPlaceholder'))
}

/** Already subscribed → plan changes go through the Stripe portal
 * (a second checkout would create a second, parallel subscription). */
async function changePlan(): Promise<void> {
  busy.value = true
  const res = await apiFetch('/billing/portal', { method: 'POST' }, billingUrlSchema)
  busy.value = false
  if (res.ok) window.location.href = res.data.url
  else alert(t('settings.plan.checkoutPlaceholder'))
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <div class="space-y-2 text-center">
      <h1 class="text-2xl font-bold">{{ t('pricing.title') }}</h1>
      <p class="mx-auto max-w-xl text-sm leading-relaxed text-smoke">{{ t('pricing.subtitle') }}</p>
    </div>

    <!-- Billing interval toggle -->
    <div class="flex items-center justify-center">
      <div class="inline-flex items-center gap-1 rounded-full bg-gray-100 p-1 text-sm">
        <button
          class="rounded-full px-4 py-1.5 font-medium transition-colors"
          :class="interval === 'month' ? 'bg-white text-ink shadow-sm' : 'text-smoke'"
          @click="interval = 'month'"
        >
          {{ t('pricing.billing.month') }}
        </button>
        <button
          class="flex items-center gap-1.5 rounded-full px-4 py-1.5 font-medium transition-colors"
          :class="interval === 'year' ? 'bg-white text-ink shadow-sm' : 'text-smoke'"
          @click="interval = 'year'"
        >
          {{ t('pricing.billing.year') }}
          <span class="rounded-full bg-herb-50 px-1.5 py-0.5 text-[10px] font-semibold text-herb-700">
            {{ t('pricing.billing.saveBadge') }}
          </span>
        </button>
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <!-- Free -->
      <div class="card space-y-4" :class="plan === 'free' ? 'border-ember/50' : ''">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold">{{ t('pricing.free.name') }}</div>
          <span v-if="plan === 'free'" class="chip-up">{{ t('pricing.current') }}</span>
        </div>
        <div>
          <span class="text-3xl font-bold">{{ t('pricing.free.price') }}</span>
          <span class="ml-1 text-xs text-smoke">{{ t('pricing.free.period') }}</span>
        </div>
        <p class="text-xs text-smoke">{{ t('pricing.free.tagline') }}</p>
        <ul class="space-y-2 text-sm">
          <li v-for="k in FREE_ITEMS" :key="k" class="flex gap-2">
            <span class="text-herb-600" aria-hidden="true">✓</span>
            <span>{{ t(`pricing.free.${k}`) }}</span>
          </li>
        </ul>
      </div>

      <!-- Pro -->
      <div
        class="card relative space-y-4 overflow-hidden"
        :class="plan === 'pro' ? 'border-herb/60' : 'border-ember/40'"
      >
        <div class="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full bg-ember/10 blur-2xl" aria-hidden="true" />
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold text-gradient">{{ t('pricing.pro.name') }}</div>
          <span v-if="plan === 'pro'" class="chip-down">{{ t('pricing.current') }}</span>
        </div>
        <div>
          <span class="text-3xl font-bold">
            {{ interval === 'year' ? t('pricing.pro.priceYear') : t('pricing.pro.priceMonth') }}
          </span>
          <span class="ml-1 text-xs text-smoke">
            {{ interval === 'year' ? t('pricing.pro.periodYear') : t('pricing.pro.periodMonth') }}
          </span>
          <div v-if="interval === 'year'" class="mt-0.5 text-xs text-herb-700">{{ t('pricing.pro.yearlyEquiv') }}</div>
        </div>
        <p class="text-xs text-smoke">{{ t('pricing.pro.tagline') }}</p>
        <p class="text-xs font-semibold text-ink">{{ t('pricing.pro.includes') }}</p>
        <ul class="space-y-2 text-sm">
          <li v-for="k in PRO_ITEMS" :key="k" class="flex gap-2">
            <span class="text-herb-600" aria-hidden="true">✓</span>
            <span>{{ t(`pricing.pro.${k}`) }}</span>
          </li>
        </ul>
        <BaseButton v-if="isOwner && plan === 'free'" class="w-full" :disabled="busy" @click="upgrade('pro')">
          {{ busy ? t('common.action.saving') : t('pricing.upgradeCta') }}
        </BaseButton>
      </div>

      <!-- Max -->
      <div
        class="card relative space-y-4 overflow-hidden"
        :class="plan === 'max' ? 'border-herb/60' : ''"
      >
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold">{{ t('pricing.max.name') }}</div>
          <span v-if="plan === 'max'" class="chip-down">{{ t('pricing.current') }}</span>
        </div>
        <div>
          <span class="text-3xl font-bold">
            {{ interval === 'year' ? t('pricing.max.priceYear') : t('pricing.max.priceMonth') }}
          </span>
          <span class="ml-1 text-xs text-smoke">
            {{ interval === 'year' ? t('pricing.max.periodYear') : t('pricing.max.periodMonth') }}
          </span>
          <div v-if="interval === 'year'" class="mt-0.5 text-xs text-herb-700">{{ t('pricing.max.yearlyEquiv') }}</div>
        </div>
        <p class="text-xs text-smoke">{{ t('pricing.max.tagline') }}</p>
        <p class="text-xs font-semibold text-ink">{{ t('pricing.max.includes') }}</p>
        <ul class="space-y-2 text-sm">
          <li v-for="k in MAX_ITEMS" :key="k" class="flex gap-2">
            <span class="text-herb-600" aria-hidden="true">✓</span>
            <span>{{ t(`pricing.max.${k}`) }}</span>
          </li>
        </ul>
        <BaseButton v-if="isOwner && plan === 'free'" class="w-full" :disabled="busy" @click="upgrade('max')">
          {{ busy ? t('common.action.saving') : t('pricing.upgradeCtaMax') }}
        </BaseButton>
        <BaseButton v-else-if="isOwner && plan === 'pro'" variant="ghost" class="w-full" :disabled="busy" @click="changePlan">
          {{ busy ? t('common.action.saving') : t('pricing.changeCta') }}
        </BaseButton>
      </div>
    </div>

    <!-- Grupo — roadmap, not yet purchasable -->
    <div class="card flex flex-col items-center gap-1 py-4 text-center sm:flex-row sm:justify-center sm:gap-2">
      <span class="text-sm text-smoke">{{ t('pricing.grupo.note') }}</span>
      <a href="mailto:hola@teremu.app" class="text-sm font-medium text-ember-700 hover:underline">
        {{ t('pricing.grupo.cta') }}
      </a>
    </div>

    <p class="text-center text-xs text-smoke">{{ t('pricing.vat') }}</p>
  </div>
</template>
