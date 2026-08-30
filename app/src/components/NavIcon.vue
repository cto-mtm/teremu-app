<script setup lang="ts">
/**
 * The one home for the nav glyph set — a single 24×24 stroke icon keyed
 * by name, shared by the sidebar (AppShell) and the mobile launcher so
 * the two can never draw a route with different icons. Add a glyph here
 * once; both surfaces get it. Purely presentational; size/color come
 * from the parent's classes on this component.
 */
defineProps<{
  name: 'pulse' | 'scan' | 'triage' | 'menu' | 'pantry' | 'vendors' | 'settings' | 'assistant' | 'signout'
}>()
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'pulse'">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </template>
    <template v-else-if="name === 'scan'">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="3.5" />
    </template>
    <template v-else-if="name === 'triage'">
      <path d="M4 4h16v12l-4 4H8l-4-4z" />
      <path d="M4 13h5l1.5 2h3L15 13h5" />
    </template>
    <template v-else-if="name === 'menu'">
      <path d="M3 11h18M5 11a7 7 0 0 1 14 0M8 19h8M12 19v-3" />
    </template>
    <template v-else-if="name === 'pantry'">
      <path d="M4 8h16v12H4zM4 8l2-4h12l2 4M12 12v4" />
    </template>
    <template v-else-if="name === 'vendors'">
      <path d="M1 5h14v11H1zM15 9h4l4 4v3h-8z" />
      <circle cx="6" cy="18.5" r="1.8" />
      <circle cx="18" cy="18.5" r="1.8" />
    </template>
    <template v-else-if="name === 'assistant'">
      <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
      <path d="M19 15l.6 1.9L21.5 17.5l-1.9.6L19 20l-.6-1.9L16.5 17.5l1.9-.6L19 15Z" />
    </template>
    <template v-else-if="name === 'signout'">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </template>
    <template v-else>
      <!-- settings -->
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
    </template>
  </svg>
</template>
