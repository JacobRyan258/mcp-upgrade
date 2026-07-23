import { Prose } from '../../components/site';

export const metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <Prose title="Privacy Policy">
      <p className="text-sm text-muted">Last updated 22 July 2026.</p>
      <p>
        This page describes what the MCP Upgrade hosted service does with data. It describes
        the behaviour the software actually implements, not an aspiration.
      </p>

      <h2>Source code you submit</h2>
      <p>By uploading a ZIP file or submitting a public repository address, the following happens:</p>
      <ul>
        <li>
          An uploaded archive is written to private object storage under a key derived from
          your account. It is not publicly readable.
        </li>
        <li>
          A scanning worker downloads it, unpacks it into a temporary directory that exists
          only for that one scan, and reads the source files.
        </li>
        <li>
          The archive is deleted from storage once the worker has consumed it, and the
          temporary directory is deleted when the scan finishes. Both happen on success, on
          failure and on timeout.
        </li>
        <li>
          Files the scanner does not read — images, binaries, dependency folders, build
          output — are never unpacked at all.
        </li>
      </ul>
      <p>
        We do not retain your source code after a scan completes. We do retain the resulting
        report, which contains file paths, line numbers and short excerpts of the matched
        source.
      </p>

      <h2>Excerpts in reports</h2>
      <p>
        A report includes a short excerpt of each matched line so the finding is
        intelligible. Those excerpts pass through credential redaction before they are
        stored: recognised token shapes, private keys and credential-shaped assignments are
        replaced. Redaction is pattern-based and is not a guarantee. Treat a report as
        containing fragments of your source, and do not upload code whose fragments you would
        not be willing to store.
      </p>

      <h2>Public repositories</h2>
      <p>
        When you submit a public GitHub repository we resolve it to a specific commit and
        download that commit&rsquo;s archive over HTTPS. We store the normalised repository
        address, the owner and repository name, and the commit identifier. We do not run
        <code> git clone</code>, do not fetch submodules, do not download large-file-storage
        objects and do not execute repository hooks.
      </p>

      <h2>Account data</h2>
      <p>
        We store your email address, an optional display name, and timestamps. Authentication
        is handled by Supabase. Your password, if you use one, is never visible to this
        application.
      </p>

      <h2>Billing data</h2>
      <p>
        Payments are processed by Stripe. Card details never reach our servers. We store the
        Stripe customer and subscription identifiers, the price identifier, the subscription
        status and the current billing period, so we know which plan you are on.
      </p>

      <h2>Logs</h2>
      <p>
        We keep structured operational logs containing job identifiers, timing, error
        categories and counts. Logs are filtered to exclude source code, report excerpts,
        credentials, storage keys and absolute file paths.
      </p>

      <h2>Security limitations</h2>
      <p>
        This is a young service operated by an individual. It has been built with the
        specific threats of handling untrusted archives in mind and is tested against them,
        but it has not undergone an independent security audit, and we do not claim
        compliance with SOC 2, ISO 27001, HIPAA, or any other certification scheme.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Deleting your account removes your profile, your scan history and your stored
        reports. Records Stripe keeps for its own financial and legal obligations are outside
        our control. Contact us through the repository issue tracker to request deletion.
      </p>
    </Prose>
  );
}
