/** A Pulse session title is "NAME | activity". The name is the session's identity and is
 * always kept, even when it is PULSE or PULSE DESKTOP: the session card shows the name
 * large and the activity small, so stripping the name promotes the activity into its place
 * and the name goes missing. This only trims whitespace. */
export function pulseSessionTitle(title: string): string {
  return title.trim();
}
