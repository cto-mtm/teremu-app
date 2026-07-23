<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'herb' | 'ghost'
    disabled?: boolean
  }>(),
  { variant: 'primary', disabled: false },
)
</script>

<template>
  <button
    :class="variant === 'herb' ? 'btn-herb' : variant === 'ghost' ? 'btn-ghost' : 'btn-primary'"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>
