// =================================================================
// TO REVERT TO NORMAL HOMEPAGE BEHAVIOR:
// 1. Uncomment the redirect block below
// 2. Delete the SplashPage component and its default export
// 3. Save, commit, push
// 4. (Optional) move the routes back out of app/(app)/ if you want
//    to fully undo the route group, but the route group can stay —
//    it doesn't affect URLs. The splash revert alone is sufficient.
// =================================================================
//
// import { redirect } from 'next/navigation';
//
// export default function HomePage() {
//   redirect('/upload');
// }
//
// =================================================================

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Carnegie — Jonathan M. Kelly',
  description:
    'Carnegie — a cataloging system for personal libraries. Built by Jonathan M. Kelly.',
};

const NAVY = '#1B3A5C';

export default function SplashPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: NAVY,
        color: '#FFFFFF',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        fontFamily:
          '"Outfit", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <main
        style={{
          width: '100%',
          maxWidth: 620,
          textAlign: 'left',
          fontSize: 16,
          lineHeight: 1.55,
          color: 'rgba(255,255,255,0.9)',
        }}
      >
        <h1
          style={{
            fontSize: 36,
            fontWeight: 500,
            margin: 0,
            letterSpacing: 0,
          }}
        >
          Carnegie
        </h1>
        <p style={{ margin: '8px 0 0', fontSize: 16, color: 'rgba(255,255,255,0.7)' }}>
          A cataloging system for personal libraries
        </p>

        <div style={{ marginTop: 36 }}>
          <p style={{ margin: 0 }}>Built and developed by Jonathan M. Kelly.</p>
          <p style={{ margin: '4px 0 0' }}>
            In active development since April 2026.
          </p>
        </div>

        <p
          style={{
            marginTop: 28,
            color: 'rgba(255,255,255,0.65)',
          }}
        >
          Carnegie is an independent project I&rsquo;ve been building to help
          librarians and serious collectors catalog physical book collections
          through shelf photography. The application is currently under
          restricted access during a development phase. For inquiries about
          the project, contact Jonathan M. Kelly directly.
        </p>

        <p style={{ marginTop: 36, color: 'rgba(255,255,255,0.7)' }}>
          Repository:{' '}
          <a
            href="https://github.com/GonzoDuke/carnegie"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#FFFFFF', textDecoration: 'underline' }}
          >
            github.com/GonzoDuke/carnegie
          </a>
        </p>
      </main>
    </div>
  );
}
