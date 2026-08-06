<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { z } from 'zod'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi'
import { apiFetch } from '../lib/api'
import { billingUrlSchema, healthSchema, membersResponseSchema } from '../lib/schemas'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { useLocationStore } from '../stores/location'
import type { PermArea, Perms } from '../lib/types'
import BaseButton from '../components/BaseButton.vue'
import LocaleSwitcher from '../components/LocaleSwitcher.vue'

// Settings. The health check proves the app → Cloud Function wiring end
// to end (against the emulator in local dev). Custom per-page transition
// example: the root carries view-transition-name: settings-page (see
// docs/animations.md §2).
const { t, d } = useI18n()
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
  // the plan; re-read the profile so the UI reflects it, then clean the URL.
  if (route.query.billing === 'success') {
    void auth.reloadProfile()
    void router.replace({ query: {} })
  }
})

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

// ── Labor rate (owner only, restaurant-level) ───────────────────
// €/hour of kitchen labor. When set, every dish's plate cost adds
// prepMinutes × this rate — see plateCost in lib/domain.ts.
const laborRateInput = ref('')
const laborBusy = ref(false)
const laborSaved = ref(false)

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
const LEVELED: Exclude<PermArea, 'scan' | 'vendors'>[] = ['triage', 'menu', 'pantry', 'finance']
const DEFAULT_PERMS: Perms = {
  scan: true,
  triage: 'none',
  menu: 'none',
  pantry: 'none',
  finance: 'none',
  vendors: 'none',
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
    <div v-if="auth.profile" class="card space-y-3">
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
    <div v-if="isOwner" class="card space-y-3">
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

    <div class="card space-y-3">
      <div class="text-sm font-semibold">{{ t('settings.language') }}</div>
      <p class="text-xs text-smoke">{{ t('settings.languageDesc') }}</p>
      <LocaleSwitcher />
    </div>

    <div class="card space-y-3">
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

    <!-- Kitchen labor rate → prep-time plate costing (owner only) -->
    <div v-if="isOwner" class="card space-y-3">
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
          <span class="text-xs text-smoke">{{ t('settings.labor.unit') }}</span>
        </label>
        <BaseButton variant="ghost" :disabled="laborBusy" @click="saveLaborRate">
          {{ laborBusy ? t('common.action.saving') : t('common.action.save') }}
        </BaseButton>
        <span v-if="laborSaved" class="chip-down">{{ t('settings.labor.saved') }}</span>
      </div>
    </div>

    <!-- Team & granular permissions (owner only) -->
    <div v-if="isOwner" class="card space-y-4">
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
