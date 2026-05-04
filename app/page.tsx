import { redirect } from 'next/navigation';

/**
 * Carnegie's root route is now a redirect to /stacks — the new library
 * landing page. The previous Upload page moved to /upload. Stacks
 * reframes the app from "tool I open to do work" to "place that knows
 * my library." Server-side redirect so deep-links to legacy bookmarks
 * land cleanly without a flash of empty client-state.
 */
export default function RootPage(): never {
  redirect('/stacks');
}
