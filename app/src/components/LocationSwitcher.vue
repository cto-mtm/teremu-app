<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { useLocationStore } from '../stores/location'

/**
 * Sidebar location switcher: shows the active restaurant's name + plan,
 * lists every location the caller belongs to (from GET /me), and lets
 * them switch or spin up a new one. See docs/multi-location-plan.md.
 */
const { t } = useI18n()
const auth = useAuthStore()
const location = useLocationStore()

const open = ref(false)
const adding = ref(false)
const newName = ref('')
const busy = ref(false)
const failed = ref(false)

const locations = computed(() => auth.profile?.locations ?? [])
const active = computed(
  () => locations.value.find((l) => l.rid === auth.profile?.restaurantId) ?? null,
)

/** "Free" / "Pro" / "Max · yr" — billing is per location (see
 * docs/business-model.md §3), so each one shows its own cadence. */
function planLabel(loc: { plan: 'free' | 'pro' | 'max'; interval: 'month' | 'year' | null }): string {
  const base = t('settings.plan.' + loc.plan)
  return loc.plan !== 'free' && loc.interval === 'year' ? `${base} · ${t('locations.yearly')}` : base
}

function toggle(): void {
  open.value = !open.value
  if (!open.value) closeAdd()
}

async function select(rid: string): Promise<void> {
  if (rid === active.value?.rid) {
    open.value = false
    return
  }
  busy.value = true
  await location.switchLocation(rid)
  busy.value = false
  open.value = false
}

function startAdd(): void {
  adding.value = true
  newName.value = ''
  failed.value = false
}

function closeAdd(): void {
  adding.value = false
}

async function createLocation(): Promise<void> {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  failed.value = false
  const ok = await location.addLocation(name)
  busy.value = false
  if (ok) {
    open.value = false
    closeAdd()
  } else {
    failed.value = true
  }
}
</script>

<template>
  <div v-if="active" class="relative px-2 pb-2">
    <button
      class="flex w-full items-center gap-2 rounded-xl border border-gray-100 bg-white/60 px-3 py-2 text-left text-sm hover:bg-gray-50"
      :aria-label="t('locations.current')"
      @click="toggle"
    >
      <span class="min-w-0 flex-1 truncate font-semibold">{{ active.name }}</span>
      <span :class="active.plan !== 'free' ? 'chip-down' : 'chip-up'">
        {{ planLabel(active) }}
      </span>
      <svg
        viewBox="0 0 24 24"
        class="h-4 w-4 shrink-0 text-smoke transition-transform"
        :class="open ? 'rotate-180' : ''"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <div v-if="open" class="fixed inset-0 z-40" @click="open = false" />

    <div
      v-if="open"
      class="glass absolute inset-x-2 top-full z-50 mt-1 space-y-1 rounded-xl p-2 shadow-card"
    >
      <button
        v-for="loc in locations"
        :key="loc.rid"
        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-50"
        :class="loc.rid === active.rid ? 'bg-ember-50 text-ember-700' : ''"
        :disabled="busy"
        @click="select(loc.rid)"
      >
        <span class="min-w-0 flex-1 truncate">{{ loc.name }}</span>
        <span class="shrink-0 text-[11px] text-smoke">
          {{ loc.role === 'owner' ? t('settings.members.owner') : t('settings.members.member') }}
        </span>
        <span class="shrink-0" :class="loc.plan !== 'free' ? 'chip-down' : 'chip-up'">
          {{ planLabel(loc) }}
        </span>
      </button>

      <div class="border-t border-gray-100 pt-1">
        <form v-if="adding" class="flex gap-1.5 p-1" @submit.prevent="createLocation">
          <input
            v-model="newName"
            class="input flex-1 py-1 text-xs"
            :placeholder="t('locations.namePlaceholder')"
            :disabled="busy"
            autofocus
          />
          <button class="btn-primary shrink-0 px-2.5 py-1 text-xs" :disabled="busy || !newName.trim()" type="submit">
            {{ busy ? t('locations.creating') : t('locations.create') }}
          </button>
        </form>
        <button
          v-else
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-ember-700 hover:bg-ember-50"
          @click="startAdd"
        >
          <span class="text-base leading-none">+</span>
          <span>{{ t('locations.add') }}</span>
        </button>
        <p v-if="failed" class="px-2 pt-1 text-[11px] text-coral-600">{{ t('locations.failed') }}</p>
      </div>
    </div>
  </div>
</template>
