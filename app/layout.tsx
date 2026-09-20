import type { Metadata, Viewport } from 'next';
// Inter 4 with the optical-size axis: the same face tightens automatically at
// display sizes. Self-hosted (bundled by Next), so there is no runtime request
// to a font CDN that could fail or shift the layout during the demo.
import '@fontsource-variable/inter/opsz.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'GridPoint — Where should the warehouse go?',
  description:
    'Warehouse location optimisation. Weighted k-medians with a certified-optimal '
    + 'solver, a full Indian last-mile cost model, and an in-browser AI column mapper.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#09090b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
