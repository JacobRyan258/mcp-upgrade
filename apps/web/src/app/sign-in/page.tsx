import { AuthForm } from '../../components/auth-form';
import { SiteFooter, SiteHeader } from '../../components/site';

export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-sm px-5 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-muted">Welcome back.</p>
        <div className="mt-8">
          <AuthForm mode="sign-in" />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
