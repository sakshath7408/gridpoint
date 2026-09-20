import type { Metadata, Viewport } from 'next';
// Inter 4 with the optical-size axis: the same face tightens automatically at
// display sizes. Self-hosted (bundled by Next), so there is no runtime request
// to a font CDN that could fail or shift the layout during the demo.
import '@fontsource-variable/inter/opsz.css';
import './globals.css';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'GridPoint — Where should the warehouse go?',
  description:
    'Warehouse location optimisation. Weighted k-medians with a certified-optimal '
    + 'solver, a full Indian last-mile cost model, and an in-browser AI column mapper.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0e0e11' },
    { media: '(prefers-color-scheme: light)', color: '#0e0e11' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script below rewrites data-theme on
    // <html> before React hydrates, so server and client markup differ here by
    // design. Without it React logs a hydration mismatch every load.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint — no flash of the wrong one. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
