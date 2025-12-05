export const metadata = { title: "Burn-up", description: "Jira burn-up prototype" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, Arial", padding: 16 }}>{children}</body>
    </html>
  );
}
