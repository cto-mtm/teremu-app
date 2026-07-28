<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import AssistantSheet from './AssistantSheet.vue'
import LocationSwitcher from './LocationSwitcher.vue'
import OnboardingWizard from './OnboardingWizard.vue'
import logoColor from '../assets/logo-color.svg'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const invoicesStore = useInvoicesStore()
const kitchenStore = useKitchenStore()
const authStore = useAuthStore()

// Chromeless routes: the scanner owns the viewport, login has no nav.
const bare = computed(() => route.name === 'scan' || route.name === 'login')

// Mobile: the sidebar is an off-canvas drawer toggled by the hamburger;
// from md up it's always visible and this flag is ignored.
const navOpen = ref(false)
watch(() => route.path, () => (navOpen.value = false))

// Stateless AI assistant, available to every member (context filtered
// server-side by their perms).
const assistantOpen = ref(false)

// First-login tour: per DEVICE (localStorage, keyed by uid so shared
// tablets behave). Skipping counts as seen; closing it marks it seen.
const onboardingOpen = ref(false)
const onboardingKey = (uid: string) => `teremu-onboarded:${uid}`
watch(
  () => [authStore.profile, authStore.user] as const,
  ([profile, user]) => {
    if (profile && user && !localStorage.getItem(onboardingKey(user.uid))) {
      onboardingOpen.value = true
    }
  },
  { immediate: true },
)
watch(onboardingOpen, (isOpen) => {
  if (!isOpen && authStore.user) {
    localStorage.setItem(onboardingKey(authStore.user.uid), '1')
  }
})

// Nav filtered by the member's granular perms (server enforces too).
const tabs = computed(() =>
  [
    { to: '/', label: t('shell.tab.pulse'), icon: 'pulse', show: authStore.can('finance') },
    { to: '/scan', label: t('shell.tab.scan'), icon: 'scan', show: authStore.can('scan') },
    { to: '/triage', label: t('shell.tab.triage'), icon: 'triage', badge: invoicesStore.triageCount, show: authStore.can('triage') },
    { to: '/menu', label: t('shell.tab.menu'), icon: 'menu', show: authStore.can('menu') },
    { to: '/pantry', label: t('shell.tab.pantry'), icon: 'pantry', show: authStore.can('pantry') },
    { to: '/vendors', label: t('shell.tab.vendors'), icon: 'vendors', show: authStore.can('vendors') },
  ].filter((tab) => tab.show),
)

// Section-aware active state so /triage/:id still highlights Triage.
const isActive = (to: string): boolean =>
  to === '/' ? route.path === '/' : route.path.startsWith(to)

// Load the member's data once their profile (and perms) is known; only
// hit endpoints they can read. Bounce to /login on sign-out (the route
// guard only runs on navigation, not on auth-state changes).
watch(
  () => [authStore.ready, authStore.user, authStore.profile] as const,
  ([ready, user, profile]) => {
    if (!ready) return
    if (user && profile) {
      if (authStore.can('triage') || authStore.can('finance') || authStore.can('vendors')) {
        void invoicesStore.refresh()
      }
      void kitchenStore.refresh({
        ingredients: authStore.can('pantry') || authStore.can('menu'),
        menu: authStore.can('menu') || authStore.can('finance') || authStore.can('pantry'),
        revenue: authStore.can('finance'),
        expenses: authStore.can('finance') || authStore.can('vendors'),
        contacts: authStore.can('pantry') || authStore.can('vendors'),
      })
    } else if (ready && !user && route.name !== 'login') {
      void router.replace({ name: 'login' })
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex min-h-screen">
    <!-- Mobile hamburger (md+ has the persistent sidebar instead) -->
    <button
      v-if="authStore.user && !bare"
      class="glass fixed top-3 left-3 z-30 flex h-10 w-10 items-center justify-center rounded-xl shadow-card md:hidden"
      :aria-label="t('shell.openNav')"
      @click="navOpen = true"
    >
      <svg viewBox="0 0 24 24" class="h-5 w-5 text-ink" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>

    <!-- Backdrop for the mobile drawer -->
    <div
      v-if="navOpen"
      class="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm md:hidden"
      aria-hidden="true"
      @click="navOpen = false"
    />

    <!-- Left nav: off-canvas drawer on mobile, sticky sidebar from md up -->
    <aside
      v-if="authStore.user && !bare"
      class="pt-safe pb-safe glass fixed inset-y-0 left-0 z-50 flex h-screen w-[280px] max-w-[85vw] shrink-0 flex-col border-y-0 border-l-0 transition-transform duration-200 md:sticky md:top-0 md:z-auto md:w-56 md:max-w-none md:translate-x-0"
      :class="navOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
    >
      <div class="flex items-center justify-between px-4 py-4 md:px-3 md:py-5">
        <RouterLink
          to="/"
          class="font-display flex items-center gap-2 text-lg font-extrabold tracking-tight"
        >
          <img :src="logoColor" alt="" aria-hidden="true" class="h-8 w-8 shrink-0" />
          <span><span class="text-gradient">Teremu</span><span class="text-ember">.</span></span>
        </RouterLink>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-smoke hover:bg-gray-100 hover:text-ink md:hidden"
          :aria-label="t('shell.closeNav')"
          @click="navOpen = false"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <LocationSwitcher v-if="authStore.profile" />

      <nav class="flex-1 space-y-1 px-3 md:px-2">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.to"
          :to="tab.to"
          class="relative flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium md:py-2.5"
          :class="isActive(tab.to) ? 'bg-ember-50 text-ember-700' : 'text-smoke hover:bg-gray-50 hover:text-ink'"
          :aria-label="tab.label"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <template v-if="tab.icon === 'pulse'">
              <path d="M3 12h4l3-8 4 16 3-8h4" />
            </template>
            <template v-else-if="tab.icon === 'scan'">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
              <circle cx="12" cy="12" r="3.5" />
            </template>
            <template v-else-if="tab.icon === 'triage'">
              <path d="M4 4h16v12l-4 4H8l-4-4z" />
              <path d="M4 13h5l1.5 2h3L15 13h5" />
            </template>
            <template v-else-if="tab.icon === 'menu'">
              <path d="M3 11h18M5 11a7 7 0 0 1 14 0M8 19h8M12 19v-3" />
            </template>
            <template v-else-if="tab.icon === 'vendors'">
              <path d="M1 5h14v11H1zM15 9h4l4 4v3h-8z" />
              <circle cx="6" cy="18.5" r="1.8" />
              <circle cx="18" cy="18.5" r="1.8" />
            </template>
            <template v-else>
              <path d="M4 8h16v12H4zM4 8l2-4h12l2 4M12 12v4" />
            </template>
          </svg>
          <span>{{ tab.label }}</span>
          <span
            v-if="tab.badge"
            class="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-coral px-1 text-[10px] font-bold text-white"
          >
            {{ tab.badge }}
          </span>
        </RouterLink>
      </nav>

      <div class="space-y-1 px-3 pb-5 md:px-2 md:pb-4">
        <button
          class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-smoke hover:bg-gray-50 hover:text-ink md:py-2.5"
          :aria-label="t('assistant.open')"
          @click="assistantOpen = true"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
            <path d="M19 15l.6 1.9L21.5 17.5l-1.9.6L19 20l-.6-1.9L16.5 17.5l1.9-.6L19 15Z" />
          </svg>
          <span>{{ t('assistant.title') }}</span>
        </button>
        <RouterLink
          to="/settings"
          class="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium md:py-2.5"
          :class="isActive('/settings') ? 'bg-ember-50 text-ember-700' : 'text-smoke hover:bg-gray-50 hover:text-ink'"
          :aria-label="t('shell.settings')"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
          </svg>
          <span>{{ t('shell.settings') }}</span>
        </RouterLink>
        <button
          class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-smoke hover:bg-gray-50 hover:text-ink md:py-2.5"
          :aria-label="t('auth.signOut')"
          @click="authStore.signOut"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          <span>{{ t('auth.signOut') }}</span>
        </button>
      </div>
    </aside>

    <!-- pt-14 on mobile clears the floating hamburger -->
    <main :class="bare ? 'flex-1' : 'min-w-0 flex-1 px-4 pt-14 pb-6 md:px-8 md:py-6'">
      <!-- The auth guard holds navigation until the auth state is known,
           so the slot is empty during that first beat. -->
      <div v-if="!authStore.ready" class="py-20 text-center text-sm text-smoke">
        {{ t('common.loading') }}
      </div>
      <div v-else :class="bare ? '' : 'mx-auto w-full max-w-4xl'">
        <slot />
      </div>
    </main>

    <!-- Keyed on the active location: it reasons over one restaurant's
         data, so switching locations must remount it (fresh transcript)
         rather than carry the old one across (see multi-location-plan.md). -->
    <AssistantSheet
      v-if="authStore.user"
      :key="authStore.profile?.restaurantId"
      v-model="assistantOpen"
    />
    <OnboardingWizard v-if="authStore.user" v-model="onboardingOpen" />
  </div>
</template>
