import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth';
import { SiteFooter } from '../../components/site';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in?next=/dashboard');

  return (
    <>
      <header className="border-b border-line">
        <nav
          aria-label="Dashboard"
          className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
        >
          <Link href="/dashboard" className="font-semibold tracking-tight">
            MCP&nbsp;Upgrade
          </Link>
          <div className="flex flex-1 flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
            <Link href="/dashboard" className="hover:text-ink">Scans</Link>
            <Link href="/dashboard/billing" className="hover:text-ink">Billing</Link>
            <Link href="/coverage" className="hover:text-ink">Coverage</Link>
          </div>
          <span className="max-w-[16rem] truncate text-sm text-muted" title={user.email}>
            {user.email}
          </span>
          <form action="/api/auth/sign-out" method="post">
            <button type="submit" className="text-sm text-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      {!user.emailVerified ? (
        <div className="border-b border-line bg-warn-soft">
          <p className="mx-auto max-w-5xl px-5 py-3 text-sm text-warn">
            Confirm your email address before scanning. Check your inbox for the link we sent.
          </p>
        </div>
      ) : null}
      <main id="main" className="mx-auto max-w-5xl px-5 py-10">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
