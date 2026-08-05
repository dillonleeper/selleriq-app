export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div style={{ width: 220, height: 28, borderRadius: 8, background: 'var(--card)', marginBottom: 24 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 }}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} style={{ height: 112, borderRadius: 12, background: 'var(--card)' }} />
        ))}
      </div>
      <div style={{ height: 320, borderRadius: 12, background: 'var(--card)', marginTop: 20 }} />
    </div>
  )
}
