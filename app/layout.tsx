import type { Metadata, Viewport } from 'next';
import './globals.css';
import { StoreProvider } from '@/lib/store';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Carnegie',
  description: 'Personal home library cataloging tool',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'Carnegie',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

// Next 14 routes themeColor through the viewport export (separate from metadata).
// Carnegie navy — matches the sidebar accent so the mobile status bar /
// PWA chrome blends with the app chrome in standalone mode.
export const viewport: Viewport = {
  themeColor: '#1B3A5C',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Inter:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..700;1,8..60,300..700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script
          // Prevent dark-mode flash
          dangerouslySetInnerHTML={{
            // Default to LIGHT on first visit. Only flip to dark when the
            // user has explicitly chosen it via the toggle (stored under
            // 'carnegie:dark' === '1'). We don't read prefers-color-scheme.
            __html: `(function(){try{if(localStorage.getItem('carnegie:dark')==='1')document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
        <script
          // Register the service worker so the browser surfaces the
          // "Add to Home Screen" prompt. The SW is intentionally a no-op
          // (network-only) — we just need its presence for installability.
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`,
          }}
        />
      </head>
      <body>
        <StoreProvider>
          <AppShell>{children}</AppShell>
        </StoreProvider>
      </body>
    </html>
  );
}
