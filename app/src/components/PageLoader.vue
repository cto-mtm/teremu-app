<script setup lang="ts">
/**
 * Pulse-animated loading skeleton for page content.
 * Shows a configurable number of placeholder cards + an optional
 * chart/table block, matching the app's card layout.
 *
 * Usage:
 *   <PageLoader />                       — 4 stat cards + chart block
 *   <PageLoader :cards="0" :lines="6" /> — list skeleton (6 rows)
 *   <PageLoader :cards="3" :lines="0" /> — cards only
 */
withDefaults(
  defineProps<{
    /** Number of small stat-card placeholders (top row). */
    cards?: number
    /** Number of list-row placeholders (below the cards). */
    lines?: number
  }>(),
  { cards: 4, lines: 0 },
)
</script>

<template>
  <div class="space-y-4 animate-pulse">
    <!-- Stat card skeletons -->
    <div v-if="cards" class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div v-for="i in cards" :key="'c' + i" class="card">
        <div class="h-3 w-20 rounded bg-gray-200" />
        <div class="mt-3 h-7 w-24 rounded bg-gray-200" />
      </div>
    </div>

    <!-- List row skeletons -->
    <div v-if="lines" class="space-y-2">
      <div v-for="i in lines" :key="'l' + i" class="card flex items-center gap-3">
        <div class="h-5 w-5 rounded bg-gray-200" />
        <div class="flex-1 space-y-2">
          <div class="h-4 w-2/3 rounded bg-gray-200" />
          <div class="h-3 w-1/3 rounded bg-gray-200" />
        </div>
        <div class="h-6 w-16 rounded bg-gray-200" />
      </div>
    </div>
  </div>
</template>
