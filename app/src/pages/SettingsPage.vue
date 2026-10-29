<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import type { z } from 'zod'
import { useI18n } from 'vue-i18n'
import { currencyOptionLabel, currencySymbol, type SupportedLocale } from '../i18n'
import { legalUrl } from '../lib/legal'
import { CURRENCIES, DEFAULT_CURRENCY, SETTINGS_CARDS, type Currency } from '@teremu/shared'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi'
import { apiFetch } from '../lib/api'
import { COUNTRY_CODES, countryName, timezoneOptions } from '../lib/regions'
import { billingUrlSchema, healthSchema, membersResponseSchema } from '../lib/schemas'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { useLocationStore } from '../stores/location'
import type { PermArea, Perms } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'
import IntegrationsCard from '../components/IntegrationsCard.vue'
import EmailCard from '../components/EmailCard.vue'
import ListingCard from '../components/ListingCard.vue'
import LocaleSwitcher from '../components/LocaleSwitcher.vue'
import { useQueryAction } from '../composables/useQueryAction'

// Settings. The health check proves the app → Cloud Function wiring end
// to end (against the emulator in local dev). Custom per-page transition
// example: the root carries view-transition-name: settings-page (see
// docs/animations.md §2).
const { t, d, locale } = useI18n()
const settings = useSettingsStore()
const auth = useAuthStore()
const location = useLocationStore()
const router = useRouter()
const route = useRoute()
const { data, error, loading, execute } = useApi('/health', undefined, healthSchema)

onMounted(() => {
  void execute()
  if (isOwner.value) void loadMembers()
  // Returning from Stripe Checkout — the webhook may have already flipped
  // the plan; re-read the profile so the UI reflects it, then clean the URL
  // (only `billing`: a `card` deep link scrolls to its card on its own).
  if (route.query.billing === 'success') {
    void reloadUntilPaid()
    void router.replace({ query: { ...route.query, billing: undefined } })
  }
})

/** The webhook can land after the browser does: read the profile again a
 * couple of times while it still says Free, then stop. The email card
 * notices the plan change and imports what was waiting. */
async function reloadUntilPaid(): Promise<void> {
  for (const wait of [0, 3000, 10_000]) {
    await new Promise((r) => setTimeout(r, wait))
    await auth.reloadProfile()
    if (auth.profile?.plan !== 'free') return
  }
}

// Deep link (the assistant's openScreen handoff): /settings?card=tax scrolls
// to that card and rings it for a moment. The guard has the profile before
// this page mounts, so the cards are there after one render; owner-only
// ones are absent for a member (main.ts tells them before navigating).
const focusedCard = ref<string | null>(null)
async function focusCard(name: string): Promise<void> {
  // After the render AND the router's own scroll reset (a frame after the
  // route commits), or the reset would undo the scroll.
  await nextTick()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const el = document.getElementById(`card-${name}`)
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  focusedCard.value = name
  window.setTimeout(() => (focusedCard.value = null), 2500)
}
useQueryAction('card', Object.fromEntries(SETTINGS_CARDS.map((name) => [name, () => focusCard(name)])))
const cardClass = (name: string) => (focusedCard.value === name ? 'ring-2 ring-ember-700/40' : '')

// ── Plan & billing ──────────────────────────────────────────────
const isDev = import.meta.env.DEV
const billingBusy = ref(false)

// Upgrade lives on the pricing page (monthly/yearly choice + full plan
// comparison) rather than a bare checkout button here.
function upgrade(): void {
  void router.push('/pricing')
}

/** Stripe customer portal: change card, switch interval, or cancel. */
async function manageBilling(): Promise<void> {
  billingBusy.value = true
  const res = await apiFetch('/billing/portal', { method: 'POST' }, billingUrlSchema)
  billingBusy.value = false
  if (res.ok) window.location.href = res.data.url
  else alert(t('settings.plan.checkoutPlaceholder'))
}

async function togglePlan(): Promise<void> {
  // Dev-only cycle through every tier: free → pro → max → free.
  const cycle = { free: 'pro', pro: 'max', max: 'free' } as const
  const next = cycle[auth.profile?.plan ?? 'free']
  const res = await apiFetch('/billing/plan', { method: 'PUT', body: JSON.stringify({ plan: next }) })
  if (res.ok) await auth.reloadProfile()
}

// ── Base currency (owner only, restaurant-level) ────────────────
// The restaurant's "UTC" (docs/multi-currency.md): every aggregated
// amount is in it, so the API locks it once any invoice is approved.
// Saves on change, like the unit toggle.
const currencyBusy = ref(false)
const currencySaved = ref(false)
const currencyLocked = computed(() => auth.profile?.currencyLocked ?? false)

async function saveCurrency(event: Event): Promise<void> {
  const rid = auth.profile?.restaurantId
  const code = (event.target as HTMLSelectElement).value as Currency
  if (!rid) return
  currencyBusy.value = true
  currencySaved.value = false
  const res = await apiFetch(`/restaurants/${rid}`, { method: 'PUT', body: JSON.stringify({ currency: code }) })
  if (res.ok) {
    await auth.reloadProfile() // → setCurrency(): every amount re-renders
    currencySaved.value = true
  } else {
    // The select already shows the new choice — put it back to what's saved.
    ;(event.target as HTMLSelectElement).value = auth.profile?.currency ?? DEFAULT_CURRENCY
    alert(res.error.includes('currency_locked') ? t('settings.currency.locked') : t('common.action.saveFailed'))
  }
  currencyBusy.value = false
}

// ── Country & timezone (owner only) ─────────────────────────────
// Prefilled from the device region by the auth store on first sign-in;
// here the owner sees and corrects it. The country selects the API's
// country pack — the app only ever renders its serialized profile.
const countryInput = ref('')
const timezoneInput = ref('')
const regionBusy = ref(false)
const regionSaved = ref(false)
const timezones = timezoneOptions()
const countryOptions = computed(() => {
  const codes = new Set<string>(COUNTRY_CODES)
  if (countryInput.value) codes.add(countryInput.value) // keep an off-list saved value selectable
  return [...codes]
    .map((code) => ({ code, name: countryName(code, locale.value) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale.value))
})

onMounted(() => {
  countryInput.value = auth.profile?.country ?? ''
  timezoneInput.value = auth.profile?.timezone ?? ''
  loadTax()
})

async function saveRegion(): Promise<void> {
  const rid = auth.profile?.restaurantId
  if (!rid) return
  const patch: Record<string, string> = {}
  if (countryInput.value) patch.country = countryInput.value
  if (timezoneInput.value.trim()) patch.timezone = timezoneInput.value.trim()
  if (Object.keys(patch).length === 0) return
  // The owner's own choice — an imported listing never overwrites it.
  patch.regionSource = 'owner'
  regionBusy.value = true
  regionSaved.value = false
  const res = await apiFetch(`/restaurants/${rid}`, { method: 'PUT', body: JSON.stringify(patch) })
  if (res.ok) {
    await auth.reloadProfile() // the country may have prefilled the base currency
    regionSaved.value = true
  } else {
    alert(t('common.action.saveFailed'))
  }
  regionBusy.value = false
}

// ── Labor rate (owner only, restaurant-level) ───────────────────
// Kitchen labor per hour, in the restaurant's currency. When set, every dish's plate cost adds
// prepMinutes × this rate — see plateCost in lib/domain.ts.
const laborRateInput = ref('')
const laborBusy = ref(false)
const laborSaved = ref(false)

// ── Menu-price tax (owner only; docs/us-market-readiness.md A6) ──
// The country pack's default is what the margins use until the owner
// overrides it here; "reset" clears the override (null on the API).
const taxInclusive = ref(false)
const taxRateInput = ref('')
const taxBusy = ref(false)
const taxSaved = ref(false)
const packTax = computed(() => auth.profile?.countryProfile)
const taxOverridden = computed(() => auth.profile?.pricesIncludeTax != null || auth.profile?.salesTaxRate != null)
const packTaxLabel = computed(() => {
  const p = packTax.value
  if (!p?.pricesIncludeTax) return t('settings.tax.exclusive')
  return `${t('settings.tax.inclusive')}${p.salesTaxRate ? ` · ${Math.round(p.salesTaxRate * 100)} %` : ''}`
})
function loadTax(): void {
  taxInclusive.value = auth.tax.pricesIncludeTax
  // Two decimals of a percent (8.25 %), as US rates are written.
  taxRateInput.value = auth.tax.rate > 0 ? String(Math.round(auth.tax.rate * 10000) / 100) : ''
}
async function saveTax(reset = false): Promise<void> {
  const rid = auth.profile?.restaurantId
  if (!rid) return
  const rate = Number(taxRateInput.value.replace(',', '.'))
  const body = reset
    ? { pricesIncludeTax: null, salesTaxRate: null }
    : {
        pricesIncludeTax: taxInclusive.value,
        salesTaxRate: taxInclusive.value && Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 10000 : null,
      }
  taxBusy.value = true
  taxSaved.value = false
  const res = await apiFetch(`/restaurants/${rid}`, { method: 'PUT', body: JSON.stringify(body) })
  if (res.ok) {
    await auth.reloadProfile()
    loadTax()
    taxSaved.value = true
  } else {
    alert(t('common.action.saveFailed'))
  }
  taxBusy.value = false
}

onMounted(() => {
  const rate = auth.profile?.laborRatePerHour
  laborRateInput.value = rate != null && rate > 0 ? String(rate) : ''
})

async function saveLaborRate(): Promise<void> {
  const rid = auth.profile?.restaurantId
  if (!rid) return
  laborBusy.value = true
  laborSaved.value = false
  const rate = Number(laborRateInput.value)
  const res = await apiFetch(`/restaurants/${rid}`, {
    method: 'PUT',
    body: JSON.stringify({ laborRatePerHour: Number.isFinite(rate) && rate > 0 ? rate : null }),
  })
  if (res.ok) {
    await auth.reloadProfile()
    laborSaved.value = true
  } else {
    alert(t('common.action.saveFailed'))
  }
  laborBusy.value = false
}

// ── Location name (owner only) ──────────────────────────────────
const locationNameInput = ref('')
const locationNameBusy = ref(false)
const locationNameSaved = ref(false)

onMounted(() => {
  const active = auth.profile?.locations.find((l) => l.rid === auth.profile?.restaurantId)
  locationNameInput.value = active?.name ?? ''
})

async function saveLocationName(): Promise<void> {
  const name = locationNameInput.value.trim()
  if (!name) return
  locationNameBusy.value = true
  locationNameSaved.value = false
  const ok = await location.renameLocation(name)
  locationNameBusy.value = false
  if (ok) {
    locationNameSaved.value = true
  } else {
    alert(t('common.action.saveFailed'))
  }
}

// ── Team management (owner only) ────────────────────────────────
type MembersResponse = z.infer<typeof membersResponseSchema>
const isOwner = computed(() => auth.profile?.role === 'owner')
const team = ref<MembersResponse | null>(null)
const teamBusy = ref(false)

// Leveled areas get a select; scan is a simple yes/no toggle.
const LEVELED: Exclude<PermArea, 'scan' | 'vendors'>[] = ['triage', 'menu', 'pantry', 'finance', 'integrations']
const DEFAULT_PERMS: Perms = {
  scan: true,
  triage: 'none',
  menu: 'none',
  pantry: 'none',
  finance: 'none',
  vendors: 'none',
  integrations: 'none',
}

const inviteEmail = ref('')
const invitePerms = reactive<Perms>({ ...DEFAULT_PERMS })

async function loadMembers(): Promise<void> {
  const res = await apiFetch<MembersResponse>('/members', undefined, membersResponseSchema)
  if (res.ok) team.value = res.data
}

async function sendInvite(): Promise<void> {
  teamBusy.value = true
  const res = await apiFetch('/members', {
    method: 'POST',
    body: JSON.stringify({ email: inviteEmail.value.trim(), perms: { ...invitePerms } }),
  })
  teamBusy.value = false
  if (res.ok) {
    inviteEmail.value = ''
    Object.assign(invitePerms, DEFAULT_PERMS)
    void loadMembers()
  } else {
    alert(res.error.includes('member_limit') ? t('settings.members.limit') : t('common.action.saveFailed'))
  }
}

async function saveMemberPerms(uid: string, perms: Perms): Promise<void> {
  const res = await apiFetch(`/members/${uid}`, {
    method: 'PUT',
    body: JSON.stringify({ perms }),
  })
  if (!res.ok) {
    alert(t('common.action.saveFailed'))
    void loadMembers()
  }
}

async function removeMember(uid: string): Promise<void> {
  if (!confirm(t('common.action.confirmDelete'))) return
  const res = await apiFetch(`/members/${uid}`, { method: 'DELETE' })
  if (res.ok) void loadMembers()
}

async function cancelInvite(emailKey: string): Promise<void> {
  const res = await apiFetch(`/invites/${emailKey}`, { method: 'DELETE' })
  if (res.ok) void loadMembers()
}
</script>

<template>
  <div class="space-y-4" style="view-transition-name: settings-page">
    <h1 class="text-xl font-bold">{{ t('settings.title') }}</h1>

    <!-- Plan & usage -->
    <div v-if="auth.profile" id="card-plan" class="card space-y-3" :class="cardClass('plan')">
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold">{{ t('settings.plan.title') }}</div>
        <span :class="auth.profile.plan !== 'free' ? 'chip-down' : 'chip-up'">
          {{ t('settings.plan.' + auth.profile.plan) }}
        </span>
      </div>
      <div>
        <div class="mb-1 text-xs text-smoke">
          {{ t('settings.plan.scansUsed', { used: auth.profile.usage.scans, limit: auth.profile.usage.scanLimit }) }}
        </div>
        <div class="h-2 rounded-full bg-gray-100">
          <div
            class="h-2 rounded-full"
            :class="auth.profile.usage.scans / auth.profile.usage.scanLimit > 0.8 ? 'bg-coral' : 'bg-ember'"
            :style="{ width: Math.min(100, (auth.profile.usage.scans / auth.profile.usage.scanLimit) * 100) + '%' }"
          />
        </div>
      </div>
      <p v-if="auth.profile.emailWaiting > 0" class="text-xs text-coral-600">
        {{ t('settings.plan.emailWaiting', auth.profile.emailWaiting) }}
        <a
          v-if="auth.can('integrations')"
          href="#card-email"
          class="font-medium text-ember-700 hover:underline"
          @click.prevent="focusCard('email')"
        >
          {{ t('settings.plan.emailWaitingLink') }}
        </a>
      </p>
      <p v-if="isOwner && auth.profile.billing.status === 'past_due'" class="text-xs font-medium text-coral-600" role="alert">
        {{ t('settings.plan.paymentProblem') }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="isOwner">
          <BaseButton v-if="auth.profile.plan === 'free'" @click="upgrade">
            {{ t('settings.plan.upgrade') }}
          </BaseButton>
          <BaseButton
            v-else
            variant="ghost"
            :disabled="billingBusy"
            @click="manageBilling"
          >
            {{ t('settings.plan.manage') }}
          </BaseButton>
          <BaseButton v-if="isDev" variant="ghost" @click="togglePlan">
            {{ t('settings.plan.devToggle') }}
          </BaseButton>
        </template>
        <RouterLink to="/pricing" class="text-xs font-medium text-ember-700 hover:underline">
          {{ t('pricing.seePlans') }}
        </RouterLink>
      </div>
    </div>

    <!-- Location name (owner only) -->
    <div v-if="isOwner" id="card-location" class="card space-y-3" :class="cardClass('location')">
      <div class="text-sm font-semibold">{{ t('settings.location.title') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.location.desc') }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="locationNameInput"
          type="text"
          maxlength="80"
          class="input w-56"
          :placeholder="t('settings.location.placeholder')"
          @input="locationNameSaved = false"
        />
        <BaseButton variant="ghost" :disabled="locationNameBusy || !locationNameInput.trim()" @click="saveLocationName">
          {{ locationNameBusy ? t('common.action.saving') : t('common.action.save') }}
        </BaseButton>
        <span v-if="locationNameSaved" class="chip-down">{{ t('settings.location.saved') }}</span>
      </div>
    </div>

    <div v-if="isOwner" id="card-listing" class="rounded-2xl" :class="cardClass('listing')">
      <ListingCard :key="auth.profile?.restaurantId" />
    </div>

    <div id="card-language" class="card space-y-3" :class="cardClass('language')">
      <div class="text-sm font-semibold">{{ t('settings.language') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.languageDesc') }}</p>
      <LocaleSwitcher />
    </div>

    <div id="card-units" class="card space-y-3" :class="cardClass('units')">
      <div class="text-sm font-semibold">{{ t('settings.units') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.unitsDesc') }}</p>
      <div class="inline-flex overflow-hidden rounded-lg border border-gray-200 text-xs font-semibold">
        <button
          v-for="system in ['metric', 'imperial'] as const"
          :key="system"
          class="px-3 py-1.5"
          :class="settings.unitSystem === system ? 'bg-ink text-white' : 'bg-white text-smoke hover:bg-gray-50'"
          @click="settings.setUnitSystem(system)"
        >
          {{ t('settings.' + system) }}
        </button>
      </div>
    </div>

    <!-- Country & timezone (owner only) — device-region defaults, editable -->
    <div v-if="isOwner" id="card-region" class="card space-y-3" :class="cardClass('region')">
      <div class="text-sm font-semibold">{{ t('settings.region.title') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.region.desc') }}</p>
      <div class="flex flex-wrap items-end gap-2">
        <label class="space-y-1 text-sm">
          <span class="text-xs text-smoke">{{ t('settings.region.country') }}</span>
          <select v-model="countryInput" class="input w-auto" @change="regionSaved = false">
            <option value="">—</option>
            <option v-for="c in countryOptions" :key="c.code" :value="c.code">{{ c.name }} ({{ c.code }})</option>
          </select>
        </label>
        <label class="space-y-1 text-sm">
          <span class="text-xs text-smoke">{{ t('settings.region.timezone') }}</span>
          <select v-if="timezones.length" v-model="timezoneInput" class="input w-auto max-w-56" @change="regionSaved = false">
            <option value="">—</option>
            <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
          </select>
          <input v-else v-model="timezoneInput" type="text" class="input w-56" @input="regionSaved = false" />
        </label>
        <BaseButton variant="ghost" :disabled="regionBusy" @click="saveRegion">
          {{ regionBusy ? t('common.action.saving') : t('common.action.save') }}
        </BaseButton>
        <span v-if="regionSaved" class="chip-down">{{ t('settings.region.saved') }}</span>
      </div>
    </div>

    <!-- Base currency of every aggregated amount (owner only; locks once used) -->
    <div v-if="isOwner" id="card-currency" class="card space-y-3" :class="cardClass('currency')">
      <div class="text-sm font-semibold">{{ t('settings.currency.title') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.currency.desc') }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <select
          class="input w-auto"
          :aria-label="t('settings.currency.title')"
          :value="auth.profile?.currency ?? DEFAULT_CURRENCY"
          :disabled="currencyBusy || currencyLocked"
          :title="currencyLocked ? t('settings.currency.locked') : undefined"
          @change="saveCurrency"
        >
          <option v-for="code in CURRENCIES" :key="code" :value="code">{{ currencyOptionLabel(code) }}</option>
        </select>
        <span v-if="currencySaved" class="chip-down">{{ t('common.action.saved') }}</span>
        <span v-else-if="currencyLocked" class="text-xs text-smoke">{{ t('settings.currency.locked') }}</span>
      </div>
    </div>

    <!-- Menu-price tax → margins on the net price (owner only; A6) -->
    <div v-if="isOwner" id="card-tax" class="card space-y-3" :class="cardClass('tax')">
      <div class="text-sm font-semibold">{{ t('settings.tax.title') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.tax.desc') }}</p>
      <div class="space-y-2 text-sm">
        <label class="flex items-center gap-2">
          <input v-model="taxInclusive" type="radio" :value="true" @change="taxSaved = false" />
          <span>{{ t('settings.tax.inclusive') }}</span>
        </label>
        <label v-if="taxInclusive" class="ml-6 flex items-center gap-2">
          <span class="text-xs text-smoke">{{ t('settings.tax.rate') }}</span>
          <input v-model="taxRateInput" type="number" inputmode="decimal" min="0" max="50" step="0.5" class="input w-24" @input="taxSaved = false" />
        </label>
        <label class="flex items-center gap-2">
          <input v-model="taxInclusive" type="radio" :value="false" @change="taxSaved = false" />
          <span>{{ t('settings.tax.exclusive') }}</span>
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <BaseButton variant="ghost" :disabled="taxBusy" @click="saveTax()">
          {{ taxBusy ? t('common.action.saving') : t('common.action.save') }}
        </BaseButton>
        <button v-if="taxOverridden" class="text-xs text-smoke underline" :disabled="taxBusy" @click="saveTax(true)">
          {{ t('settings.tax.reset') }}
        </button>
        <span v-if="taxSaved" class="chip-down">{{ t('settings.tax.saved') }}</span>
        <span v-else class="text-xs text-smoke">{{ t('settings.tax.packDefault', { value: packTaxLabel }) }}</span>
      </div>
    </div>

    <!-- Kitchen labor rate → prep-time plate costing (owner only) -->
    <div v-if="isOwner" id="card-labor" class="card space-y-3" :class="cardClass('labor')">
      <div class="text-sm font-semibold">{{ t('settings.labor.title') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.labor.desc') }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-2 text-sm">
          <input
            v-model="laborRateInput"
            type="number"
            inputmode="decimal"
            min="0"
            step="0.5"
            class="input w-28"
            :placeholder="t('settings.labor.placeholder')"
            @input="laborSaved = false"
          />
          <span class="text-xs text-smoke">{{ t('settings.labor.unit', { symbol: currencySymbol }) }}</span>
        </label>
        <BaseButton variant="ghost" :disabled="laborBusy" @click="saveLaborRate">
          {{ laborBusy ? t('common.action.saving') : t('common.action.save') }}
        </BaseButton>
        <span v-if="laborSaved" class="chip-down">{{ t('settings.labor.saved') }}</span>
      </div>
    </div>

    <!-- POS connections (integrations area; owners always) -->
    <div v-if="auth.can('integrations')" id="card-integrations" class="rounded-2xl" :class="cardClass('integrations')">
      <IntegrationsCard />
    </div>

    <!-- Email inboxes (same integrations area). Keyed on the location like
         ListingCard: a switch remounts it, which also stops a check still
         running for the previous location's inbox. -->
    <div v-if="auth.can('integrations')" id="card-email" class="rounded-2xl" :class="cardClass('email')">
      <EmailCard :key="auth.profile?.restaurantId" />
    </div>

    <!-- Team & granular permissions (owner only) -->
    <div v-if="isOwner" id="card-team" class="card space-y-4" :class="cardClass('team')">
      <div>
        <div class="text-sm font-semibold">{{ t('settings.members.title') }}</div>
        <p class="mt-0.5 text-xs text-smoke">{{ t('settings.members.desc') }}</p>
      </div>

      <div v-if="team" class="space-y-3">
        <div
          v-for="m in team.members"
          :key="m.uid"
          class="space-y-2 rounded-xl border border-gray-100 p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">{{ m.email }}</div>
              <div class="text-[11px] text-smoke">
                {{ m.role === 'owner' ? t('settings.members.owner') : t('settings.members.member') }}
              </div>
            </div>
            <button
              v-if="m.role !== 'owner'"
              class="shrink-0 text-xs font-medium text-smoke hover:text-coral-600"
              @click="removeMember(m.uid)"
            >
              {{ t('settings.members.remove') }}
            </button>
          </div>
          <div v-if="m.role !== 'owner'" class="flex flex-wrap gap-2">
            <label class="flex items-center gap-1.5 text-xs">
              <input v-model="m.perms.scan" type="checkbox" @change="saveMemberPerms(m.uid, m.perms)" />
              {{ t('settings.members.area.scan') }}
            </label>
            <label v-for="area in LEVELED" :key="area" class="flex items-center gap-1 text-xs">
              <span class="text-smoke">{{ t('settings.members.area.' + area) }}</span>
              <select v-model="m.perms[area]" class="input w-auto px-1.5 py-1 text-xs" @change="saveMemberPerms(m.uid, m.perms)">
                <option value="none">{{ t('settings.members.level.none') }}</option>
                <option value="read">{{ t('settings.members.level.read') }}</option>
                <option value="edit">{{ t('settings.members.level.edit') }}</option>
              </select>
            </label>
            <label class="flex items-center gap-1 text-xs">
              <span class="text-smoke">{{ t('settings.members.area.vendors') }}</span>
              <select v-model="m.perms.vendors" class="input w-auto px-1.5 py-1 text-xs" @change="saveMemberPerms(m.uid, m.perms)">
                <option value="none">{{ t('settings.members.level.none') }}</option>
                <option value="read">{{ t('settings.members.level.read') }}</option>
              </select>
            </label>
          </div>
        </div>

        <div
          v-for="inv in team.invites"
          :key="inv.emailKey"
          class="flex items-center justify-between gap-2 rounded-xl border border-dashed border-gray-200 p-3"
        >
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{{ inv.email }}</div>
            <div class="text-[11px] text-smoke">{{ t('settings.members.pending') }}</div>
          </div>
          <button class="shrink-0 text-xs font-medium text-smoke hover:text-coral-600" @click="cancelInvite(inv.emailKey)">
            {{ t('settings.members.remove') }}
          </button>
        </div>
      </div>

      <!-- Invite form -->
      <div class="space-y-2 border-t border-gray-100 pt-3">
        <input v-model="inviteEmail" type="email" class="input" :placeholder="t('settings.members.email')" />
        <div class="flex flex-wrap gap-2">
          <label class="flex items-center gap-1.5 text-xs">
            <input v-model="invitePerms.scan" type="checkbox" />
            {{ t('settings.members.area.scan') }}
          </label>
          <label v-for="area in LEVELED" :key="area" class="flex items-center gap-1 text-xs">
            <span class="text-smoke">{{ t('settings.members.area.' + area) }}</span>
            <select v-model="invitePerms[area]" class="input w-auto px-1.5 py-1 text-xs">
              <option value="none">{{ t('settings.members.level.none') }}</option>
              <option value="read">{{ t('settings.members.level.read') }}</option>
              <option value="edit">{{ t('settings.members.level.edit') }}</option>
            </select>
          </label>
          <label class="flex items-center gap-1 text-xs">
            <span class="text-smoke">{{ t('settings.members.area.vendors') }}</span>
            <select v-model="invitePerms.vendors" class="input w-auto px-1.5 py-1 text-xs">
              <option value="none">{{ t('settings.members.level.none') }}</option>
              <option value="read">{{ t('settings.members.level.read') }}</option>
            </select>
          </label>
        </div>
        <BaseButton :disabled="teamBusy || !inviteEmail.includes('@')" @click="sendInvite">
          {{ teamBusy ? t('common.action.saving') : t('settings.members.invite') }}
        </BaseButton>
      </div>
    </div>

    <div class="card space-y-2">
      <div class="text-sm font-semibold">{{ t('legal.settingsTitle') }}</div>
      <p class="text-xs text-smoke">{{ t('legal.settingsDesc') }}</p>
      <div class="flex flex-wrap gap-4 text-sm">
        <a :href="legalUrl('privacy', locale as SupportedLocale)" target="_blank" rel="noopener" class="underline">{{ t('legal.linkPrivacy') }}</a>
        <a :href="legalUrl('terms', locale as SupportedLocale)" target="_blank" rel="noopener" class="underline">{{ t('legal.linkTerms') }}</a>
      </div>
    </div>

    <div class="card space-y-3">
      <div class="text-sm font-semibold">{{ t('settings.healthTitle') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.healthDesc') }}</p>
      <div class="flex items-center gap-3">
        <BaseButton variant="ghost" :disabled="loading" @click="execute">
          {{ loading ? t('common.loading') : t('settings.check') }}
        </BaseButton>
        <span v-if="data?.ok" class="chip-down">
          {{ t('settings.ok', { ts: d(new Date(data.ts), 'short') }) }}
        </span>
        <span v-else-if="error" class="chip-up">{{ error }}</span>
      </div>
    </div>
  </div>
</template>
