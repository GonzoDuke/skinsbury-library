import { StoreProvider } from '@/lib/store';
import { AppShell } from '@/components/AppShell';
import { UndoToast } from '@/components/UndoToast';

/**
 * AppShell-wrapping layout for the working app's routes
 * (/upload, /review, /export, /history, /ledger, /vocabulary, /about).
 *
 * The route group `(app)/` is invisible in URLs — Next.js treats it as
 * organizational only. All routes under this group inherit the
 * StoreProvider + AppShell + UndoToast scaffolding. The root layout
 * (`app/layout.tsx`) handles `<html>` / `<body>` / fonts / dark-mode
 * pre-script for both the splash at `/` and these app routes.
 */
export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <StoreProvider>
      <AppShell>{children}</AppShell>
      <UndoToast />
    </StoreProvider>
  );
}
