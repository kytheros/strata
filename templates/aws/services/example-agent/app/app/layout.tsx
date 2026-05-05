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
      <body>{children}</body>
    </html>
  );
}
