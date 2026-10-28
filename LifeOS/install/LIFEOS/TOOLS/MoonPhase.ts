/**
 * MoonPhase — the next true new and full moon after a given instant.
 *
 * Meeus, Astronomical Algorithms (2nd ed.), chapter 49: the mean phase plus
 * its largest periodic corrections, good to a few minutes. The mean synodic
 * month alone can miss a real phase by over half a day, which is enough to
 * put the wrong date on the statusline.
 */

const RAD = Math.PI / 180;
const JD_UNIX_EPOCH = 2440587.5;

const toJd = (d: Date) => d.getTime() / 86_400_000 + JD_UNIX_EPOCH;
const fromJd = (jd: number) => new Date((jd - JD_UNIX_EPOCH) * 86_400_000);

/** Meeus 49.1 and table 49.A; k is an integer for a new moon and k + 0.5 for a full one. */
function phaseJde(k: number, full: boolean): number {
  const T = k / 1236.85;
  const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T ** 2 - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T ** 2;
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T ** 2 - 0.00000011 * T ** 3) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T ** 2 + 0.00001238 * T ** 3 - 0.000000058 * T ** 4) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T ** 2 - 0.00000227 * T ** 3 + 0.000000011 * T ** 4) * RAD;
  const Om = (124.7746 - 1.56375588 * k + 0.0020672 * T ** 2 + 0.00000215 * T ** 3) * RAD;
  const [a, b, c, d, e, f] = full
    ? [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515]
    : [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514];
  const corr =
    a * Math.sin(Mp) +
    b * E * Math.sin(M) +
    c * Math.sin(2 * Mp) +
    d * Math.sin(2 * F) +
    e * E * Math.sin(Mp - M) +
    f * E * Math.sin(Mp + M) +
    (full ? 0.00209 : 0.00208) * E * E * Math.sin(2 * M) -
    0.00111 * Math.sin(Mp - 2 * F) -
    0.00057 * Math.sin(Mp + 2 * F) +
    0.00056 * E * Math.sin(2 * Mp + M) -
    0.00042 * Math.sin(3 * Mp) +
    0.00042 * E * Math.sin(M + 2 * F) +
    0.00038 * E * Math.sin(M - 2 * F) -
    0.00024 * E * Math.sin(2 * Mp - M) -
    0.00017 * Math.sin(Om);
  // JDE is Terrestrial Time; the ~69 s gap to UTC is below what we display.
  return jde + corr;
}

/** The first true new or full moon strictly after `now`. */
export function nextPhase(now: Date, kind: "new" | "full"): Date {
  const jdNow = toJd(now);
  const full = kind === "full";
  let k = Math.floor((jdNow - 2451550.09766) / 29.530588861) - 1 + (full ? 0.5 : 0);
  while (phaseJde(k, full) <= jdNow) k += 1;
  return fromJd(phaseJde(k, full));
}
