'use client'

type Props = {
  selected: string[]
  onChange: (markets: string[]) => void
}

const MARKETS = ['US', 'CA']

export default function MarketplaceFilter({ selected, onChange }: Props) {
  const toggle = (market: string) => {
    if (selected.includes(market)) {
      if (selected.length > 1) onChange(selected.filter(m => m !== market))
    } else {
      onChange([...selected, market])
    }
  }

  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-dim)', marginRight: '4px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Market
      </span>
      {MARKETS.map(market => {
        const active = selected.includes(market)
        return (
          <button
            key={market}
            onClick={() => toggle(market)}
            style={{
              padding: '4px 10px', borderRadius: '6px',
              border: active ? '1px solid var(--accent-border)' : '1px solid var(--border)',
              background: active ? 'var(--accent-light)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: '11px', fontWeight: 500, cursor: 'pointer',
              transition: 'all 0.12s ease',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {market}
          </button>
        )
      })}
    </div>
  )
}
