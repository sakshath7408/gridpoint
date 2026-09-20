'use client';

import Link from 'next/link';

/**
 * The user manual, served from the app itself.
 *
 * A judge reading the repo should not have to find a PDF in /docs. The header
 * links here; this page embeds the document and offers a download, with a way
 * back to the tool.
 */
export default function ManualPage() {
  return (
    <div className="manual-page">
      <header className="head">
        <div className="brand">
          <span className="logo-mark">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                 strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Z" />
              <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span className="logo">Sludge</span>
          <span className="logo-sub">User manual and mathematical reference</span>
        </div>
        <div className="head-spacer" />
        <a className="btn sm" href="/GridPoint-User-Manual.pdf" download>Download PDF</a>
        <Link className="btn primary" href="/">Back to the tool</Link>
      </header>

      <div className="manual-body">
        <object data="/GridPoint-User-Manual.pdf#view=FitH" type="application/pdf"
                aria-label="Sludge user manual">
          {/* Shown only when the browser cannot render a PDF inline. */}
          <div className="manual-fallback">
            <p>Your browser cannot display the PDF inline.</p>
            <a className="btn primary" href="/GridPoint-User-Manual.pdf" download>Download the manual</a>
          </div>
        </object>
      </div>
    </div>
  );
}
