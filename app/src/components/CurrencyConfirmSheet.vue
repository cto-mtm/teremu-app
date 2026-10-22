<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CURRENCIES, DEFAULT_CURRENCY, type Currency } from '@teremu/shared'
import { apiFetch } from '../lib/api'
import { currencyLabel, currencyOptionLabel } from '../i18n'
import { useAuthStore } from '../stores/auth'

/**
 * One-time prompt before the FIRST approval locks the restaurant's base
 * currency (docs/multi-currency.md — Principle 3). Until the owner picks
 * or confirms it, the currency is only inferred from the country, and
 * most people approve their first invoice long before visiting Settings.
 *
 * Owner: confirm (recorded as their pick → never asked again) and the
 * approval goes ahead, or pick another one and go back to the invoice.
 * Member: cannot change it — told so, and may approve anyway.
 * Emits `proceed` (approve now) or `changed` (base changed; re-review).
 */
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ proceed: []; changed: [] }>()

const { t } = useI18n()
const auth = useAuthStore()
const isOwner = computed(() => auth.profile?.role === 'owner')
const current = computed<Currency>(() => auth.profile?.currency ?? DEFAULT_CURRENCY)
const picked = ref<Currency>(current.value)
const busy = ref(false)
watch(open, (o) => {
  if (o) picked.value = current.value
})


async function save(): Promise<void> {
  const rid = auth.profile?.restaurantId
  if (!rid) return
  busy.value = true
  const changed = picked.value !== current.value
  // Re-sending the same code records it as the owner's own pick.
  const res = await apiFetch(`/restaurants/${rid}`, { method: 'PUT', body: JSON.stringify({ currency: picked.value }) })
  if (res.ok) await auth.reloadProfile()
  busy.value = false
  if (!res.ok) return alert(t('triage.currencyConfirm.failed'))
  open.value = false
  if (changed) {
    alert(t('triage.currencyConfirm.changedNote'))
    emit('changed')
  } else emit('proceed')
}

function memberContinue(): void {
  open.value = false
  emit('proceed')
}
</script>

<template>
  <Transition name="list">
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
      @click="open = false"
    >
      <div
        class="w-full space-y-4 rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
        role="dialog"
        :aria-label="t('triage.currencyConfirm.title')"
        @click.stop
      >
        <h2 class="text-lg font-bold">{{ t('triage.currencyConfirm.title') }}</h2>
        <p class="text-sm text-ink/80">
          {{ t('triage.currencyConfirm.body', { currency: currencyOptionLabel(isOwner ? picked : current) }) }}
        </p>

        <template v-if="isOwner">
          <label class="block space-y-1">
            <span class="text-xs text-smoke">{{ t('triage.currencyConfirm.pick') }}</span>
            <select v-model="picked" class="input">
              <option v-for="code in CURRENCIES" :key="code" :value="code">{{ currencyOptionLabel(code) }}</option>
            </select>
          </label>
          <button class="btn-herb w-full py-3" :disabled="busy" @click="save">
            {{
              picked === current
                ? t('triage.currencyConfirm.confirm', { currency: currencyLabel(current) })
                : t('triage.currencyConfirm.change', { currency: currencyLabel(picked) })
            }}
          </button>
        </template>
        <template v-else>
          <p class="text-xs text-smoke">{{ t('triage.currencyConfirm.memberNote') }}</p>
          <button class="btn-herb w-full py-3" @click="memberContinue">
            {{ t('triage.currencyConfirm.memberContinue') }}
          </button>
        </template>
        <button class="w-full text-xs text-smoke hover:text-ink" @click="open = false">
          {{ t('triage.currencyConfirm.cancel') }}
        </button>
      </div>
    </div>
  </Transition>
</template>
