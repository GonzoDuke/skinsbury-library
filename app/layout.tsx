import type { Metadata } from 'next';
import './globals.css';
import { StoreProvider } from '@/lib/store';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'The T.L. Skinsbury Library',
  description: 'Personal home library cataloging tool',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..700;1,8..60,300..700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script
          // Prevent dark-mode flash
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('skinsbury:dark');if(s===null){s=window.matchMedia('(prefers-color-scheme: dark)').matches?'1':'0';}if(s==='1')document.documentElement.classList.add('dark');}catch(e){}})();`,
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
