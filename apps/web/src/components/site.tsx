import Link from 'next/link';

export const GITHUB_URL = 'https://github.com/JacobRyan258/mcp-upgrade';

/**
 * The disclaimer is a product requirement and appears verbatim wherever a
 * result could be read as a guarantee. It is defined once so the wording cannot
 * drift between the report page, the downloads and the marketing copy.
 */
export const CLEAN_DISCLAIMER =
  'A clean report means that no implemented rule fired. It does not guarantee complete compatibility with the target MCP specification.';

export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="border-b border-line">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
      >
        <Link href="/" className="font-semibold tracking-tight text-ink">
          MCP&nbsp;Upgrade
        </Link>
        <div className="flex flex-1 flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
          <Link href="/how-it-works" className="hover:text-ink">How it works</Link>
          <Link href="/coverage" className="hover:text-ink">Coverage</Link>
          <Link href="/pricing" className="hover:text-ink">Pricing</Link>
          <Link href="/faq" className="hover:text-ink">FAQ</Link>
        </div>
        {signedIn ? (
          <Link href="/dashboard" className="text-sm font-medium text-accent hover:underline">
            Dashboard
          </Link>
        ) : (
          <div className="flex items-center gap-3">
            <Link href="/sign-in" className="text-sm text-muted hover:text-ink">Sign in</Link>
            <Link
              href="/sign-up"
              className="rounded-lg bg-ink px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Get started
            </Link>
          </div>
        )}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto max-w-5xl px-5 py-10 text-sm text-muted">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/coverage" className="hover:text-ink">Coverage</Link>
          <a href={GITHUB_URL} className="hover:text-ink" rel="noreferrer noopener">
            Open-source CLI
          </a>
        </div>
        <p className="mt-6 max-w-2xl leading-relaxed">{CLEAN_DISCLAIMER}</p>
        <p className="mt-3 max-w-2xl leading-relaxed">
          MCP Upgrade is an independent tool. It is not affiliated with or endorsed by the
          Model Context Protocol project.
        </p>
      </div>
    </footer>
  );
}

export function Prose({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-8 space-y-5 leading-relaxed text-ink [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-2">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
