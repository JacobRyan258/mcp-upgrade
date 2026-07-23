import Link from 'next/link';
import { PLANS, formatBytes } from '@mcp-upgrade/shared';
import { CLEAN_DISCLAIMER, GITHUB_URL, SiteFooter, SiteHeader } from '../components/site';

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto max-w-3xl px-5 pb-16 pt-20 text-center">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Check whether your MCP server is ready for the next protocol release.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted">
            Upload a ZIP file or paste a public GitHub repository. You get a plain-English
            report on what breaks, what is deprecated, and what to ask your developer to
            change. No command line required.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="rounded-lg bg-ink px-5 py-3 font-medium text-white hover:opacity-90"
            >
              Scan Your MCP Server
            </Link>
            <a
              href={GITHUB_URL}
              rel="noreferrer noopener"
              className="rounded-lg border border-line px-5 py-3 font-medium hover:border-ink"
            >
              View the Open-Source CLI
            </a>
          </div>
          <p className="mt-5 text-sm text-muted">
            Free plan includes {PLANS.free.scansPerPeriod} scans per month. No card required.
          </p>
        </section>

        <section className="mx-auto max-w-5xl px-5 pb-4">
          <div className="grid gap-5 sm:grid-cols-3">
            {[
              {
                title: 'Point us at your code',
                body: `Upload a ZIP up to ${formatBytes(PLANS.free.maxArchiveBytes)}, or paste a public GitHub repository address. We scan a specific commit so the result is reproducible.`,
              },
              {
                title: 'We read, never run',
                body: 'Your code is analysed statically. Nothing is executed, no dependencies are installed, and no package scripts run. Uploaded source is deleted as soon as the scan finishes.',
              },
              {
                title: 'Get an actionable report',
                body: 'A readiness score, what may stop working, and a checklist written for someone who does not know what MCP is — with the technical detail underneath for whoever does the work.',
              },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border border-line bg-white p-6">
                <h2 className="font-semibold">{card.title}</h2>
                <p className="mt-2.5 text-sm leading-relaxed text-muted">{card.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-5 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">What we look for</h2>
          <p className="mt-4 leading-relaxed text-muted">
            The upcoming protocol revision removes the connection handshake, drops session
            identifiers, redesigns long-running work, changes error codes and requires new
            request headers. Each of those is a way a working server quietly stops working.
            We check for all of them and explain what each one means for your product.
          </p>
          <div className="mt-8 rounded-xl border border-line bg-white p-6">
            <p className="text-sm leading-relaxed text-muted">
              <strong className="font-semibold text-ink">Read this before you rely on it. </strong>
              {CLEAN_DISCLAIMER}
            </p>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/sign-up"
              className="rounded-lg bg-ink px-5 py-3 font-medium text-white hover:opacity-90"
            >
              Scan Your MCP Server
            </Link>
            <Link
              href="/coverage"
              className="rounded-lg border border-line px-5 py-3 font-medium hover:border-ink"
            >
              See exactly what is checked
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
