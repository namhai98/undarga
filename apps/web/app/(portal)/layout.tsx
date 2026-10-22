/**
 * The customer portal's frame: its own route group, apart from `(app)` (a
 * staff session) and `(booking)`. Mobile first, like public booking.
 */
export default function PortalGroupLayout({ children }: LayoutProps<'/'>) {
  return <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>;
}
