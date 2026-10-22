<script setup lang="ts">
// The one loading spinner: a ring with a coloured top border, spun by
// Tailwind's animate-spin (a transform — docs/animations.md). Attributes
// fall through to the ring: pass aria-hidden="true" when a nearby element
// carries the state, or role="status" + aria-label when the ring is the
// only sign of it. Position it with a class on the component.
withDefaults(
  defineProps<{
    size?: 'xs' | 'sm' | 'md' | 'lg'
    tone?: 'ember' | 'soft' | 'muted' | 'ink' | 'light'
  }>(),
  { size: 'xs', tone: 'ember' },
)

// Full class strings, so Tailwind's scanner sees every one of them.
const SIZES = { xs: 'h-3.5 w-3.5', sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' } as const
const TONES = {
  ember: 'border-ember-200 border-t-ember-700',
  soft: 'border-ember-100 border-t-ember',
  muted: 'border-gray-200 border-t-smoke',
  ink: 'border-gray-300 border-t-ink',
  light: 'border-white/40 border-t-white',
} as const
</script>

<template>
  <span :class="['inline-block shrink-0 animate-spin rounded-full border-2', SIZES[size], TONES[tone]]" />
</template>
