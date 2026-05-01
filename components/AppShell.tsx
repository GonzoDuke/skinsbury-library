'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useDarkMode } from '@/lib/store';

const NAV = [
  { href: '/', label: 'Upload' },
  { href: '/review', label: 'Review' },
  { href: '/export', label: 'Export' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { setDark } = useDarkMode();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-accent dark:bg-green-deep sticky top-0 z-10 shadow-sm">
        {/* Three-zone grid with EQUAL-FRACTION side tracks
            (1fr_auto_1fr). This forces the auto-sized nav column to sit on
            true viewport center even when the wordmark and toggle are
            different widths — without this the nav drifts toward whichever
            side is narrower. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6 py-5 pl-7 pr-6 lg:pl-8 lg:pr-8">
          {/* Left anchor — engraved-plaque wordmark. Both lines are centered
              on each other; the cap-letter wordmark is sized so its tracked
              width visually matches "PERSONAL CATALOGING SYSTEM" beneath it.
              The whole block links home. */}
          <Link
            href="/"
            className="justify-self-start flex flex-col items-center leading-none group"
            aria-label="Carnegie — go to upload"
          >
            <span
              className="font-display text-limestone group-hover:text-brass transition-colors uppercase"
              style={{ fontSize: '42px', fontWeight: 500, letterSpacing: '5px', lineHeight: 1 }}
            >
              Carnegie
            </span>
            <span
              className="text-[10px] uppercase text-brass mt-2"
              style={{ letterSpacing: '2.5px' }}
            >
              Personal Cataloging System
            </span>
          </Link>

          {/* Centered nav block. Wrapped in a subtle pill-rail container so
              the three nav links read as a single deliberate hero element,
              not three floating buttons. The container's background gives
              the zone presence; pills are bumped to text-base / px-6 to
              hold their own next to the 42px wordmark. */}
          <nav className="flex gap-1 p-1 rounded-full bg-fern/30 border border-limestone/15 shadow-inner">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-6 py-2.5 rounded-full text-base transition-all duration-200 ease-gentle ${
                    active
                      ? 'bg-brass text-accent-deep font-medium shadow-sm'
                      : 'text-limestone/85 hover:bg-fern hover:text-limestone'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Right anchor — light/dark toggle. Bumped slightly so it doesn't
              get dwarfed by the new nav rail. */}
          <button
            onClick={() => {
              const next = !isDark;
              setDark(next);
              setIsDark(next);
            }}
            className="justify-self-end flex-shrink-0 text-sm px-4 py-2 rounded-md border border-limestone/40 text-limestone bg-fern/40 hover:bg-fern transition"
            aria-label="Toggle dark mode"
          >
            {isDark ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </header>
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-8 lg:px-12 py-10">{children}</main>
      <footer className="border-t border-cream-300 dark:border-ink-soft py-5 text-sm text-center text-ink/40 dark:text-cream-300/40">
        Carnegie — personal use · No data leaves your machine without your approval
      </footer>
    </div>
  );
}
