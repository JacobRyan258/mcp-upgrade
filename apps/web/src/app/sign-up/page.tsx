import { AuthForm } from '../../components/auth-form';
import { PLANS } from '@mcp-upgrade/shared';
import { SiteFooter, SiteHeader } from '../../components/site';

export const metadata = { title: 'Create an account' };

export default function SignUpPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-sm px-5 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
        <p className="mt-2 text-sm text-muted">
          {PLANS.free.scansPerPeriod} free scans every month. No card required.
        </p>
        <div className="mt-8">
          <AuthForm mode="sign-up" />
        </div>
        <p className="mt-8 text-xs leading-relaxed text-muted">
          By creating an account you agree to the{' '}
          <a href="/terms" className="underline">Terms of Service</a> and{' '}
          <a href="/privacy" className="underline">Privacy Policy</a>. You confirm you are
          authorised to upload the code you submit.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
