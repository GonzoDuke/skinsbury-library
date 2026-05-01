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
      <header className="bg-accent dark:bg-fern sticky top-0 z-10 shadow-sm">
        <div className="max-w-[1600px] mx-auto px-8 lg:px-12 py-5 flex items-center gap-8">
          <div className="flex flex-col">
            <div
              className="font-display text-2xl leading-tight text-limestone"
              style={{ letterSpacing: '2px' }}
            >
              The T.L. Skinsbury Library
            </div>
            <div className="text-xs text-brass tracking-wide mt-0.5">
              Personal catalog
            </div>
          </div>

          <nav className="flex gap-1 ml-6">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-5 py-2.5 rounded-md text-base transition-all duration-200 ease-gentle ${
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

          <div className="flex-1" />

          <button
            onClick={() => {
              const next = !isDark;
              setDark(next);
              setIsDark(next);
            }}
            className="text-base px-4 py-2 rounded-md border border-limestone/30 text-limestone hover:bg-fern transition"
            aria-label="Toggle dark mode"
          >
            {isDark ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-8 lg:px-12 py-10">{children}</main>
      <footer className="border-t border-cream-300 dark:border-ink-soft py-5 text-sm text-center text-ink/40 dark:text-cream-300/40">
        The T.L. Skinsbury Library — personal use · No data leaves your machine without your approval
      </footer>
    </div>
  );
}
