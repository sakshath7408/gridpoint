import type { Metadata, Viewport } from 'next';
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
  themeColor: '#0a0a0f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
