import { analyzeRecommendationSeries, type DiagnosticPoint } from '../lib/recommendationDiagnostics'

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`)
}

function series(conversions: number[], options?: { sessions?: number[]; inventory?: number[]; buyBox?: number[] }): DiagnosticPoint[] {
  return conversions.map((conversion, index) => {
    const sessions = options?.sessions?.[index] ?? 100
    return {
      d: `2026-${String(Math.floor(index / 28) + 6).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      sessions,
      units: sessions * conversion / 100,
      revenue: sessions * conversion,
      conv_rate: conversion,
      buy_box_pct: options?.buyBox?.[index] ?? 100,
      selected_market_count: 1,
      sales_market_count: 1,
      inventory_market_count: 1,
      available_quantity: options?.inventory?.[index] ?? 100,
    }
  })
}

const baseline = Array(62).fill(10)

equal(analyzeRecommendationSeries(series([...baseline, ...Array(28).fill(5)]))?.state, 'persistent')
equal(analyzeRecommendationSeries(series([...Array(76).fill(10), ...Array(14).fill(5)]))?.state, 'recent_deterioration')
equal(analyzeRecommendationSeries(series([...baseline, ...Array(14).fill(5), ...Array(14).fill(9)]))?.state, 'recovering')

const outlierConversions = [...Array(89).fill(10), 0]
const outlierSessions = [...Array(89).fill(100), 1500]
equal(analyzeRecommendationSeries(series(outlierConversions, { sessions: outlierSessions }))?.state, 'outlier_driven')

const trafficConversions = [...Array(84).fill(10), ...Array(3).fill(2), ...Array(3).fill(5)]
const trafficSessions = [...Array(84).fill(100), ...Array(3).fill(1000), ...Array(3).fill(100)]
equal(analyzeRecommendationSeries(series(trafficConversions, { sessions: trafficSessions }))?.association, 'traffic_dilution')

const inventory = [...Array(73).fill(100), ...Array(3).fill(0), ...Array(14).fill(100)]
const inventoryConversions = [...Array(73).fill(10), ...Array(3).fill(0), ...Array(14).fill(5)]
equal(analyzeRecommendationSeries(series(inventoryConversions, { inventory }))?.association, 'inventory')

const buyBox = [...Array(73).fill(100), ...Array(3).fill(50), ...Array(14).fill(100)]
equal(analyzeRecommendationSeries(series(inventoryConversions, { buyBox }))?.association, 'buy_box')

equal(analyzeRecommendationSeries(series([...Array(76).fill(10), ...Array(14).fill(5)]))?.association, 'unexplained')
equal(analyzeRecommendationSeries(series(Array(90).fill(10))), null)

console.log('recommendation diagnostics: all classification checks passed')
