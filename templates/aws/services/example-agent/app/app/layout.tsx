import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Strata Example Agent',
  description:
    'AWS-introspection chat surface backed by Strata-on-AWS. Cognito-federated, allowlist-gated.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* System font stack falls back gracefully; pull Inter+JetBrains Mono
            from Google Fonts when network allows for sharper hierarchy. The
            <link> form (vs. next/font) keeps the Docker build network-free. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
