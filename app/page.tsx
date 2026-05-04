import { redirect } from 'next/navigation';

/**
 * Carnegie's root route is a redirect to /upload — the workflow's
 * front door. Server-side redirect so deep-links to legacy bookmarks
 * land cleanly without a flash of empty client-state.
 */
export default function RootPage(): never {
  redirect('/upload');
}
