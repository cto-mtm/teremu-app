import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { unitsForSystem, type UnitSystem } from '../lib/units'
import { useAuthStore } from './auth'

/**
 * Local device preferences. The unit system filters which units the
 * dropdowns OFFER — it never converts stored data; existing quantities
 * keep the unit they were recorded in. Until this device picks one, it
 * follows the restaurant's country pack (US → imperial, docs/us-market-
 * readiness.md A5); a pick is remembered here and wins thereafter.
 */
export const useSettingsStore = defineStore('settings', () => {
  const auth = useAuthStore()
  const stored = localStorage.getItem('teremu-units')
  const chosen = ref<UnitSystem | null>(stored === 'imperial' || stored === 'metric' ? stored : null)

  const unitSystem = computed<UnitSystem>(() => chosen.value ?? auth.defaultUnitSystem)
  const unitChoices = computed(() => unitsForSystem(unitSystem.value))

  function setUnitSystem(system: UnitSystem): void {
    chosen.value = system
    localStorage.setItem('teremu-units', system)
  }

  return { unitSystem, unitChoices, setUnitSystem }
})
