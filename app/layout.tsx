import type { Metadata } from 'next'
import './globals.css'
import Sidebar from '@/components/Sidebar'
import { ThemeProvider } from '@/context/ThemeContext'

export const metadata: Metadata = {
  title: 'SellerIQ',
  description: 'Ecommerce Analytics Platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          <div style={{ display: 'flex', minHeight: '100vh' }}>
            <Sidebar />
            <main style={{
              flex: 1,
              marginLeft: '220px',
              padding: '32px 40px',
              minHeight: '100vh',
              background: 'var(--bg)',
            }}>
              <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
                {children}
              </div>
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  )
}
