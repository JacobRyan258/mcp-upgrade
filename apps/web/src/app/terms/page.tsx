import { Prose } from '../../components/site';

export const metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <Prose title="Terms of Service">
      <p className="text-sm text-muted">Last updated 22 July 2026.</p>

      <h2>What this service does</h2>
      <p>
        MCP Upgrade performs static analysis of source code you provide and returns a report
        describing patterns that are affected by a change to the Model Context Protocol
        specification. That is the entirety of what it does.
      </p>

      <h2>No warranty, and no guarantee of compatibility</h2>
      <p>
        The service is provided &ldquo;as is&rdquo;, without warranty of any kind, express or
        implied. In particular:
      </p>
      <ul>
        <li>
          A clean report means that no implemented rule fired. It does not guarantee complete
          compatibility with the target MCP specification.
        </li>
        <li>
          The readiness score is a heuristic produced by this tool. It is not an official
          certification, score or endorsement, and no certification is offered or implied.
        </li>
        <li>
          Reports may contain false positives and may miss real problems. You remain
          responsible for testing your own software.
        </li>
        <li>
          The target specification revision is a release candidate and may change before it
          is published.
        </li>
      </ul>

      <h2>Your responsibilities</h2>
      <p>You confirm that:</p>
      <ul>
        <li>
          You are authorised to upload the code you submit, and doing so does not breach an
          agreement you are party to.
        </li>
        <li>
          You will not upload material you are not entitled to disclose, including code
          belonging to a third party without permission.
        </li>
        <li>
          You accept that reports retain short excerpts of your source, and that automated
          credential redaction is best-effort.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>You may not:</p>
      <ul>
        <li>Attempt to use the scanner to attack this service or any other system.</li>
        <li>Upload malware, or content that is illegal to possess or distribute.</li>
        <li>
          Deliberately submit archives designed to exhaust resources. Such submissions are
          rejected automatically, and repeated attempts may end your access.
        </li>
        <li>Circumvent, or attempt to circumvent, plan limits or the submission rate limit.</li>
        <li>Resell or redistribute the hosted service as your own.</li>
      </ul>
      <p>
        The command-line scanner is separately licensed under the MIT licence and those
        restrictions do not apply to it.
      </p>

      <h2>Plans and billing</h2>
      <p>
        The Free plan includes a monthly scan allowance. Paid plans are billed monthly in
        advance through Stripe and renew until cancelled. Cancelling stops future renewals and
        keeps the paid plan until the end of the period already paid for. Allowance resets at
        the start of each calendar month and does not carry over.
      </p>
      <p>
        A scan is counted when it completes. Scans that fail — for any reason, including a
        fault on our side — do not count against your allowance.
      </p>

      <h2>Availability</h2>
      <p>
        No uptime is guaranteed. The service may be unavailable for maintenance or because
        something has broken.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, liability arising from your use of this
        service is limited to the amount you paid for it in the twelve months before the
        claim. We are not liable for indirect or consequential loss, including lost profits
        or data, or for the consequences of an upgrade you performed on the strength of a
        report.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change. Material changes will be reflected in the date at the top of
        this page. Continuing to use the service after a change means you accept it.
      </p>
    </Prose>
  );
}
