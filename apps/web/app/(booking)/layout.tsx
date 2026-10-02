/**
 * Shell for the customer-facing booking pages.
 *
 * Its own route group, apart from `(app)` — which requires a staff session —
 * and from `(public)`, whose narrow centred frame suits a sign-in form rather
 * than a multi-step booking. Mobile first: full width with comfortable padding
 * on a phone, capped for readability on a desktop.
 */
export default function BookingLayout({ children }: LayoutProps<'/'>) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
  );
}
