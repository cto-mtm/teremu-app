<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useInvoicesStore } from '../stores/invoices'
import { useKitchenStore } from '../stores/kitchen'
import { useAuthStore } from '../stores/auth'
import AssistantSheet from './AssistantSheet.vue'
import BootLoader from './BootLoader.vue'
import LocationSwitcher from './LocationSwitcher.vue'
import MobileLauncher from './MobileLauncher.vue'
import NavIcon from './NavIcon.vue'
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

// Mobile launcher (full-screen hub). Auto-opens ONCE per app session on
// phones — the "land on the menu, then dive into pages" flow — then
// it's reopened on demand via the bottom-right FAB. sessionStorage (not
// localStorage) so it re-greets on a fresh launch but never nags across
// in-app navigations. Never on desktop (the sidebar is always visible),
// and it yields to the first-login onboarding tour: a brand-new user
// sees the tour, and the launcher waits for their next session / the FAB
// (checking onboarding's own localStorage key rather than its ref, which
// is declared below).
const launcherOpen = ref(false)
const LAUNCHER_SEEN = 'teremu-launcher-seen'
watch(
  () => [authStore.ready, authStore.user, authStore.profile] as const,
  ([ready, user, profile]) => {
    if (!ready || !user || !profile) return
    const isMobile = matchMedia('(max-width: 767px)').matches
    const onboardingPending = !localStorage.getItem(`teremu-onboarded:${user.uid}`)
    if (isMobile && !onboardingPending && !sessionStorage.getItem(LAUNCHER_SEEN)) {
      launcherOpen.value = true
      sessionStorage.setItem(LAUNCHER_SEEN, '1')
    }
  },
  { immediate: true },
)

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
    { to: '/', label: t('shell.tab.pulse'), icon: 'pulse' as const, show: authStore.can('finance') },
    { to: '/scan', label: t('shell.tab.scan'), icon: 'scan' as const, show: authStore.can('scan') },
    { to: '/triage', label: t('shell.tab.triage'), icon: 'triage' as const, badge: invoicesStore.triageCount, show: authStore.can('triage') },
    { to: '/menu', label: t('shell.tab.menu'), icon: 'menu' as const, show: authStore.can('menu') },
    { to: '/pantry', label: t('shell.tab.pantry'), icon: 'pantry' as const, show: authStore.can('pantry') },
    { to: '/vendors', label: t('shell.tab.vendors'), icon: 'vendors' as const, show: authStore.can('vendors') },
  ].filter((tab) => tab.show),
)

// Section-aware active state so /triage/:id still highlights Triage.
const isActive = (to: string): boolean =>
  to === '/' ? route.path === '/' : route.path.startsWith(to)

// Load the member's data when WHO/WHERE they are changes — the location,
// role or perms — and only hit endpoints they can read. Keyed on that
// scope rather than the profile object: /me returns a fresh object on
// every reloadProfile() (currency/plan/rename saves), and refetching
// every dataset — invoices alone ~220 KB — for a label change is waste.
const dataScope = computed(() => {
  const p = authStore.profile
  return authStore.ready && authStore.user && p ? `${p.restaurantId}|${p.role}|${JSON.stringify(p.perms)}` : null
})
watch(
  dataScope,
  (scope) => {
    if (!scope) return
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
  },
  { immediate: true },
)

// Bounce to /login on sign-out (the route guard only runs on
// navigation, not on auth-state changes).
watch(
  () => [authStore.ready, authStore.user] as const,
  ([ready, user]) => {
    if (ready && !user && route.name !== 'login') {
      if (import.meta.env.DEV) {
        console.warn('[AppShell] redirecting to login — user is null, current route:', route.name)
      }
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
          <NavIcon :name="tab.icon" class="h-5 w-5 shrink-0" />
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
          <NavIcon name="assistant" class="h-5 w-5 shrink-0" />
          <span>{{ t('assistant.title') }}</span>
        </button>
        <RouterLink
          to="/settings"
          class="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium md:py-2.5"
          :class="isActive('/settings') ? 'bg-ember-50 text-ember-700' : 'text-smoke hover:bg-gray-50 hover:text-ink'"
          :aria-label="t('shell.settings')"
        >
          <NavIcon name="settings" class="h-5 w-5 shrink-0" />
          <span>{{ t('shell.settings') }}</span>
        </RouterLink>
        <button
          class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-smoke hover:bg-gray-50 hover:text-ink md:py-2.5"
          :aria-label="t('auth.signOut')"
          @click="authStore.signOut"
        >
          <NavIcon name="signout" class="h-5 w-5 shrink-0" />
          <span>{{ t('auth.signOut') }}</span>
        </button>
      </div>
    </aside>

    <!-- pt-14 on mobile clears the floating hamburger -->
    <main :class="bare ? 'flex-1' : 'min-w-0 flex-1 px-4 pt-14 pb-6 md:px-8 md:py-6'">
      <!-- The auth guard holds navigation until the auth state is known,
           so the slot is empty during that first beat. -->
      <div v-if="!authStore.ready || (authStore.user && !authStore.profile)" class="hidden" />
      <div v-else :class="bare ? '' : 'mx-auto w-full max-w-4xl'">
        <slot />
      </div>
    </main>

    <!-- Full-screen loader shown right after login while the profile loads -->
    <BootLoader v-if="!authStore.ready || (authStore.user && !authStore.profile)" />

    <!-- Keyed on the active location: it reasons over one restaurant's
         data, so switching locations must remount it (fresh transcript)
         rather than carry the old one across (see multi-location-plan.md). -->
    <AssistantSheet
      v-if="authStore.user"
      :key="authStore.profile?.restaurantId"
      v-model="assistantOpen"
    />

    <!-- Mobile launcher: full-screen hub + its bottom-right FAB. Both
         phone-only (md:hidden); desktop uses the sidebar. Hidden on bare
         routes (the scanner owns the viewport). -->
    <template v-if="authStore.user && authStore.profile && !bare">
      <button
        class="pb-safe fixed right-4 bottom-4 z-[55] flex h-14 w-14 items-center justify-center rounded-full bg-ember text-white shadow-lg transition-transform active:scale-90 md:hidden"
        :aria-label="t('shell.launcher.open')"
        @click="launcherOpen = true"
      >
        <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      </button>
      <MobileLauncher v-model="launcherOpen" />
    </template>

    <OnboardingWizard v-if="authStore.user" v-model="onboardingOpen" />
  </div>
</template>
