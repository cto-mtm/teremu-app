import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { unitsForSystem, type UnitSystem } from '../lib/units'

/**
 * Local device preferences. The unit system filters which units the
 * dropdowns OFFER (metric by default) — it never converts stored data;
 * existing quantities keep the unit they were recorded in.
 */
export const useSettingsStore = defineStore('settings', () => {
  const stored = localStorage.getItem('teremu-units')
  const unitSystem = ref<UnitSystem>(stored === 'imperial' ? 'imperial' : 'metric')

  const unitChoices = computed(() => unitsForSystem(unitSystem.value))

  function setUnitSystem(system: UnitSystem): void {
    unitSystem.value = system
    localStorage.setItem('teremu-units', system)
  }

  return { unitSystem, unitChoices, setUnitSystem }
})
