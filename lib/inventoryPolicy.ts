export const FBA_TARGET_STORAGE_KEY = 'selleriq_fba_target'
export const FBA_LEAD_STORAGE_KEY = 'selleriq_fba_lead'
export const FBA_TARGET_DEFAULT = 60
export const FBA_LEAD_DEFAULT = 14

export function readPositiveStoredNumber(key: string, fallback: number) {
  if (typeof window === 'undefined') return fallback
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function roundShipmentUnits(value: number) {
  return Math.max(0, Math.round(value / 10) * 10)
}

export function calculateFbaShipment(input: {
  dailyRate: number
  available: number
  moving: number
  targetDays: number
}) {
  const { dailyRate, available, moving, targetDays } = input
  const targetUnits = dailyRate > 0 ? Math.ceil(targetDays * dailyRate) : 0
  const inventoryPosition = available + moving
  const rawUnitsToSend = Math.max(0, targetUnits - inventoryPosition)
  return {
    targetUnits,
    inventoryPosition,
    rawUnitsToSend,
    unitsToSend: roundShipmentUnits(rawUnitsToSend),
  }
}
