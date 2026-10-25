<script setup lang="ts">
/**
 * The app's picker sheet: a bottom sheet on phones, a centered card from
 * `sm` up. Tapping the backdrop closes it. Content goes in the slot.
 */
defineProps<{ label: string }>()
const open = defineModel<boolean>({ required: true })
</script>

<template>
  <Transition name="list">
    <div
      v-if="open"
      class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 backdrop-blur-sm sm:items-center"
      @click="open = false"
    >
      <div
        class="max-h-[85vh] w-full space-y-4 overflow-auto rounded-t-2xl bg-white/95 p-5 backdrop-blur-md sm:max-w-md sm:rounded-2xl"
        role="dialog"
        :aria-label="label"
        @click.stop
      >
        <slot />
      </div>
    </div>
  </Transition>
</template>
