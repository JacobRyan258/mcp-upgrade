import { Prose, GITHUB_URL } from '../../components/site';

export const metadata = { title: 'FAQ' };

const faqs: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: 'Do you run my code?',
    a: <>No. The scanner reads your source files as text and parses them. Nothing is executed, no module is imported, no package scripts run, no dependencies are installed, and the scan itself has no network access.</>,
  },
  {
    q: 'What happens to the code I upload?',
    a: <>The uploaded archive is stored only until the worker picks it up, then deleted. The unpacked source is removed as soon as the scan finishes — including when it fails or times out. We keep the report; we do not keep your code.</>,
  },
  {
    q: 'Can you scan a private repository?',
    a: <>Not in this release. Only public GitHub repositories are supported. For a private project, upload a ZIP instead.</>,
  },
  {
    q: 'Does a clean report mean I am safe to upgrade?',
    a: <>No, and we will not claim otherwise. A clean report means that no implemented rule fired. It does not guarantee complete compatibility with the target MCP specification.</>,
  },
  {
    q: 'What is the readiness score?',
    a: <>A heuristic this tool produces by deducting points for each finding, weighted by severity and confidence. It is a way to compare one scan to another. It is not an official certification, score or endorsement of any kind.</>,
  },
  {
    q: 'Why does the report say the target is a release candidate?',
    a: <>Because it is. The rules target a revision whose final specification is not yet published. We would rather say so on every report than let you discover it later.</>,
  },
  {
    q: 'Is there a free command-line version?',
    a: <>Yes, and it is the same scanner. It is MIT-licensed and available at <a href={GITHUB_URL} className="text-accent underline" rel="noreferrer noopener">github.com/JacobRyan258/mcp-upgrade</a>. The hosted service exists for people who would rather not use a terminal.</>,
  },
  {
    q: 'What counts against my monthly allowance?',
    a: <>One scan is reserved when you submit. If the scan completes, it is counted — whether or not it found anything. If it fails for any reason, including a problem with your upload or a fault on our side, the reservation is released and you are not charged for it.</>,
  },
  {
    q: 'How do I cancel?',
    a: <>From the billing portal, linked in your dashboard. Cancelling keeps Pro until the end of the period you have already paid for, then drops you to Free.</>,
  },
];

export default function FaqPage() {
  return (
    <Prose title="Frequently asked questions">
      {faqs.map((item) => (
        <section key={item.q}>
          <h2>{item.q}</h2>
          <p>{item.a}</p>
        </section>
      ))}
    </Prose>
  );
}
