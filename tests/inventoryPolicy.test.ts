import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateFbaShipment, roundShipmentUnits } from '../lib/inventoryPolicy'

test('rounds shipment recommendations to the nearest ten units', () => {
  assert.equal(roundShipmentUnits(456), 460)
  assert.equal(roundShipmentUnits(454), 450)
  assert.equal(roundShipmentUnits(4), 0)
})

test('uses the saved target and all usable FBA inventory in the recommendation', () => {
  const result = calculateFbaShipment({
    dailyRate: 238 / 30,
    available: 1,
    moving: 19,
    targetDays: 60,
  })
  assert.equal(result.targetUnits, 476)
  assert.equal(result.inventoryPosition, 20)
  assert.equal(result.rawUnitsToSend, 456)
  assert.equal(result.unitsToSend, 460)
})
