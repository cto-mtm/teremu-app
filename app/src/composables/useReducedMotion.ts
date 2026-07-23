import { ref, onMounted, onUnmounted, type Ref } from 'vue'

/** Reactive prefers-reduced-motion media query. */
export function useReducedMotion(): Ref<boolean> {
  const query = matchMedia('(prefers-reduced-motion: reduce)')
  const reduced = ref(query.matches)
  const onChange = (e: MediaQueryListEvent): void => {
    reduced.value = e.matches
  }
  onMounted(() => query.addEventListener('change', onChange))
  onUnmounted(() => query.removeEventListener('change', onChange))
  return reduced
}
