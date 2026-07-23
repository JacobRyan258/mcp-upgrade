import { Prose } from '../../components/site';

export const metadata = { title: 'How it works' };

export default function HowItWorksPage() {
  return (
    <Prose title="How it works">
      <h2>1. You give us the code</h2>
      <p>
        Either upload a ZIP of your project folder, or paste the address of a public GitHub
        repository. For a GitHub repository we resolve the default branch to a specific
        commit and scan that exact commit, so the report records precisely what was read
        and a repeat scan of the same commit gives the same answer.
      </p>

      <h2>2. We read it, and only read it</h2>
      <p>
        The scanner parses your source files and matches them against a set of rules derived
        from the published protocol changes. It is worth being precise about what does
        <em> not</em> happen:
      </p>
      <ul>
        <li>Your code is never executed.</li>
        <li>No module from your project is imported.</li>
        <li>No package scripts run.</li>
        <li>No dependencies are installed.</li>
        <li>The scan has no network access.</li>
      </ul>
      <p>
        Archives are unpacked with hard limits on size, file count and nesting, and entries
        that try to write outside the scan folder are refused rather than sanitised.
      </p>

      <h2>3. You get a report</h2>
      <p>
        Every finding is graded. <strong>Will break</strong> means a confirmed
        incompatibility. <strong>Deprecated</strong> means a feature that still works during
        its deprecation window but is going away. <strong>Needs review</strong> means we found
        something that may or may not matter and a person has to decide.
      </p>
      <p>
        Each finding says what was found, why it matters, what may stop working, and a
        sentence you can send to whoever maintains the code. The technical detail and a link
        to the official source sit underneath.
      </p>

      <h2>4. Then we delete it</h2>
      <p>
        Uploaded archives are held only until the scan runs, then deleted. The unpacked
        source is removed as soon as the scan finishes — on success, on failure and on
        timeout alike. We keep the report, not your code.
      </p>

      <h2>What we cannot tell you</h2>
      <p>
        A clean report means that no implemented rule fired. It does not guarantee complete
        compatibility with the target MCP specification. Static analysis cannot see what your
        code does at runtime, cannot follow behaviour through a dependency it has not been
        taught about, and cannot know about a change we have not written a rule for.
      </p>
    </Prose>
  );
}
