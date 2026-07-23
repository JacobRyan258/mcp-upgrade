import Link from 'next/link';
import { PLANS, formatBytes } from '@mcp-upgrade/shared';
import { SiteFooter, SiteHeader } from '../../components/site';

export const metadata = { title: 'Pricing' };

const rows: Array<{ label: string; free: string; pro: string }> = [
  {
    label: 'Scans per month',
    free: String(PLANS.free.scansPerPeriod),
    pro: String(PLANS.pro.scansPerPeriod),
  },
  { label: 'ZIP upload', free: 'Yes', pro: 'Yes' },
  { label: 'Public GitHub repository', free: 'Yes', pro: 'Yes' },
  {
    label: 'Maximum project size',
    free: formatBytes(PLANS.free.maxArchiveBytes),
    pro: formatBytes(PLANS.pro.maxArchiveBytes),
  },
  {
    label: 'Scan history',
    free: `Last ${PLANS.free.historyLimit} scans`,
    pro: 'Unlimited',
  },
  { label: 'Report downloads (JSON, Markdown, printable)', free: 'No', pro: 'Yes' },
  { label: 'Queue priority', free: 'Standard', pro: 'Priority' },
];

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
        <p className="mt-4 leading-relaxed text-muted">
          The command-line scanner is free and open source, for ever. The hosted service
          exists for people who would rather not use a terminal.
        </p>

        <div className="mt-10 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Feature comparison between the Free and Pro plans</caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="py-3 pr-4 font-medium text-muted">Feature</th>
                <th scope="col" className="py-3 pr-4 font-semibold">Free</th>
                <th scope="col" className="py-3 font-semibold">Pro — $19/month</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-line">
                  <th scope="row" className="py-3 pr-4 text-left font-normal text-muted">
                    {row.label}
                  </th>
                  <td className="py-3 pr-4">{row.free}</td>
                  <td className="py-3">{row.pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/sign-up"
            className="rounded-lg bg-ink px-5 py-3 font-medium text-white hover:opacity-90"
          >
            Start free
          </Link>
        </div>
        <p className="mt-6 text-sm leading-relaxed text-muted">
          Subscriptions are billed monthly and can be cancelled at any time from the billing
          portal. Cancelling keeps Pro until the end of the period you have already paid for.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
