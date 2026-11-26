// A path on the floor and how a body goes along it, as a file (<name>.path.json, a 'data' asset):
// where it goes is drawn the way an illustration program draws curves (anchors with an in and an
// out handle, cubic Bezier between them), and when it is where is a second curve of the same kind:
// metres along the path over seconds, its keys with handles as in an animation program's graph
// editor. A walk is made from the two for any body (motionGen/pathWalk.ts).
//
//   {
//     "format": "morglay-path", "version": 1, "closed": true,
//     "points": [ { "at": [x, z], "in": [x, z], "out": [x, z] }, ... ],
//     "timing": { "keys": [ { "t": 0, "s": 0, "in": [dt, ds], "out": [dt, ds] }, ... ] }
//   }
//
// x is metres to the left and z metres ahead of where the body stands at first, facing ahead: the
// editor's x and z for a character facing +z at the origin. A point's handles are positions (as in
// SVG); one left out sits on the point (a corner). A closed path goes on from its last point back to
// its first. A key's t is seconds and s metres along the path; its handles are offsets from the key
// (seconds, metres), and a key without one has the straight line to its neighbour there. s never goes
// back: where two keys have the same s the body stands still between them.

import { z } from 'zod';

export const PATH_FORMAT = 'morglay-path';

/** A path file's name ends so; the assets panel and the pickers know paths by it. */
export const PATH_SUFFIX = '.path.json';

export type P2 = [number, number];

const pair = z.tuple([z.number(), z.number()]);
const Point = z.strictObject({ at: pair, in: pair.optional(), out: pair.optional() });
const Key = z.strictObject({ t: z.number().min(0), s: z.number().min(0), in: pair.optional(), out: pair.optional() });

/** The file as written (other fields beside these, a name or a note, are kept and not read). */
export const PathFile = z.looseObject({
    format: z.literal(PATH_FORMAT),
    version: z.literal(1),
    closed: z.boolean().optional(),
    points: z.array(Point).min(2),
    timing: z.strictObject({ keys: z.array(Key).min(2) }),
});
export type PathFileDoc = z.output<typeof PathFile>;

/** A path read from its file, ready to sample. */
export interface MotionPath {
    file: PathFileDoc;
    closed: boolean;
    /** Metres along the whole path (once round, when closed). */
    length: number;
    /** Seconds the timing lasts: its last key's time. */
    duration: number;
    /** The point `s` metres along the path, as [left, ahead]: clamped to its ends, or round again when closed. */
    at(s: number): P2;
    /** The way the path goes `s` metres along it, as a unit [left, ahead]. */
    direction(s: number): P2;
    /** Metres along the path at `t` seconds (the first key's before it, the last key's after it). */
    distance(t: number): number;
    /**
     * Metres along the path where the body stands still: where the timing begins (it stands there at first), and between
     * two keys at the same distance. (Round again, when closed: within one round.)
     */
    rests: number[];
    /** Where the body is at `t` seconds, as [left, ahead]. */
    sample(t: number): P2;
}

/** True for a data asset that holds a path (by its file name). */
export function isPathAsset(meta: { kind: string; name: string } | null | undefined): boolean {
    return !!meta && meta.kind === 'data' && meta.name.toLowerCase().endsWith(PATH_SUFFIX);
}

// ------------------------------------------------------------------ curves

type Cubic = [P2, P2, P2, P2];

/** A point of a cubic Bezier at `u` in [0, 1]. */
export function bezier([a, b, c, d]: Cubic, u: number): P2 {
    const v = 1 - u, k0 = v * v * v, k1 = 3 * v * v * u, k2 = 3 * v * u * u, k3 = u * u * u;
    return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
}

/** Its derivative by `u`. */
export function bezierSlope([a, b, c, d]: Cubic, u: number): P2 {
    const v = 1 - u, k0 = 3 * v * v, k1 = 6 * v * u, k2 = 3 * u * u;
    return [k0 * (b[0] - a[0]) + k1 * (c[0] - b[0]) + k2 * (d[0] - c[0]), k0 * (b[1] - a[1]) + k1 * (c[1] - b[1]) + k2 * (d[1] - c[1])];
}

/** One coordinate of a cubic: its value and slope at `u` (the timing's t and s). */
const cubic1 = (a: number, b: number, c: number, d: number, u: number) => {
    const v = 1 - u;
    return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
};
const cubic1Slope = (a: number, b: number, c: number, d: number, u: number) => {
    const v = 1 - u;
    return 3 * v * v * (b - a) + 6 * v * u * (c - b) + 3 * u * u * (d - c);
};

// Five-point Gauss-Legendre on [0, 1]: the length of a short piece of curve, to well under a micrometre.
const GL_X = [0.04691007703066802, 0.23076534494715845, 0.5, 0.7692346550528415, 0.9530899229693319];
const GL_W = [0.11846344252809454, 0.23931433524968324, 0.28444444444444444, 0.23931433524968324, 0.11846344252809454];
const speedAt = (c: Cubic, u: number) => Math.hypot(...bezierSlope(c, u));
function pieceLength(c: Cubic, u0: number, u1: number): number {
    let sum = 0;
    for (let i = 0; i < 5; i++) sum += GL_W[i] * speedAt(c, u0 + (u1 - u0) * GL_X[i]);
    return sum * (u1 - u0);
}

/** Pieces each segment is measured in. */
const PIECES = 64;

// ------------------------------------------------------------------ reading

/** The problems of a file, or none: what the structure alone does not say. */
function problems(f: PathFileDoc): string[] {
    const out: string[] = [];
    const keys = f.timing.keys;
    for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (!(b.t > a.t)) out.push(`timing key ${i}: its time ${b.t} s is not after the key before (${a.t} s)`);
        if (b.s < a.s) out.push(`timing key ${i}: s goes back from ${a.s} m to ${b.s} m`);
        if (!(b.t > a.t) || b.s < a.s) continue;
        // A segment's handles may lean, but its time must go on and its distance never go back.
        const T = b.t - a.t, S = b.s - a.s;
        const ot = a.out?.[0] ?? T / 3, os = a.out?.[1] ?? S / 3, it = -(b.in?.[0] ?? -T / 3), is = -(b.in?.[1] ?? -S / 3);
        if (!rises(ot, it, T)) out.push(`timing keys ${i - 1}-${i}: their handles reach past each other in time (out ${ot} s, in ${-it} s over ${T} s)`);
        if (!rises(os, is, S)) out.push(`timing keys ${i - 1}-${i}: their handles make s go back (out ${os} m, in ${-is} m over ${S} m)`);
    }
    return out;
}

/**
 * Whether a cubic from 0 to `span`, its inner control values `a` above the start and `b` below the
 * end, never goes down: its slope is a quadratic in Bernstein form (a, span - a - b, b), which stays
 * at or above zero when both ends do and the middle is no lower than minus their geometric mean.
 */
function rises(a: number, b: number, span: number): boolean {
    const eps = 1e-9 * Math.max(1, Math.abs(span));
    return a >= -eps && b >= -eps && span - a - b >= -Math.sqrt(Math.max(0, a) * Math.max(0, b)) - eps;
}

/** Reads a path file (its JSON text, or the parsed object). Throws with what is wrong. */
export function parsePath(input: unknown): MotionPath {
    let raw = input;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            throw new Error('the path file is not JSON');
        }
    }
    const r = PathFile.safeParse(raw);
    if (!r.success) {
        const issue = r.error.issues[0];
        throw new Error(`not a path file (${PATH_FORMAT} 1): ${issue.path.join('.') || 'the file'}: ${issue.message}`);
    }
    const bad = problems(r.data);
    if (bad.length) throw new Error(`the path file is not valid: ${bad.join('; ')}`);
    return motionPath(r.data);
}

/** A path from a file already checked (parsePath checks it). */
export function motionPath(file: PathFileDoc): MotionPath {
    const closed = !!file.closed;
    const pts = file.points;
    const segs: Cubic[] = [];
    const count = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        segs.push([a.at, a.out ?? a.at, b.in ?? b.at, b.at]);
    }
    // How far along each piece of each segment begins: the table that turns a distance into a place.
    const table = new Float64Array(segs.length * PIECES + 1);
    segs.forEach((c, i) => {
        for (let k = 0; k < PIECES; k++) table[i * PIECES + k + 1] = table[i * PIECES + k] + pieceLength(c, k / PIECES, (k + 1) / PIECES);
    });
    const length = table[table.length - 1];

    /** The segment and its parameter `s` metres along. */
    const locate = (s: number): [Cubic, number] => {
        if (closed && length > 0) s = ((s % length) + length) % length;
        s = Math.min(length, Math.max(0, s));
        let lo = 0, hi = table.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (table[mid] <= s) lo = mid;
            else hi = mid;
        }
        const seg = Math.min(segs.length - 1, Math.floor(lo / PIECES)), k = lo - seg * PIECES;
        const c = segs[seg], u0 = k / PIECES, u1 = (k + 1) / PIECES;
        const span = table[lo + 1] - table[lo];
        // Between the two ends of the piece by its length, then two Newton steps on the length itself.
        let u = span > 0 ? u0 + ((s - table[lo]) / span) * (u1 - u0) : u0;
        for (let i = 0; i < 2; i++) {
            const v = speedAt(c, u);
            if (v < 1e-12) break;
            u = Math.min(u1, Math.max(u0, u - (pieceLength(c, u0, u) - (s - table[lo])) / v));
        }
        return [c, u];
    };

    // The timing: one cubic per pair of keys, in (t, s).
    const keys = file.timing.keys;
    const spans = keys.slice(1).map((b, i) => {
        const a = keys[i], T = b.t - a.t, S = b.s - a.s;
        return {
            t: [a.t, a.t + (a.out?.[0] ?? T / 3), b.t + (b.in?.[0] ?? -T / 3), b.t] as const,
            s: [a.s, a.s + (a.out?.[1] ?? S / 3), b.s + (b.in?.[1] ?? -S / 3), b.s] as const,
        };
    });
    const duration = keys[keys.length - 1].t;

    const distance = (t: number): number => {
        if (!(t > keys[0].t)) return keys[0].s;
        if (t >= duration) return keys[keys.length - 1].s;
        let lo = 0, hi = keys.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (keys[mid].t <= t) lo = mid;
            else hi = mid;
        }
        const { t: T, s: S } = spans[lo];
        if (S[0] === S[3] && S[1] === S[0] && S[2] === S[0]) return S[0];
        // The curve's own parameter at this time: Newton's steps, kept within a bracket that halves when they stray.
        let a = 0, b = 1, u = (t - T[0]) / (T[3] - T[0]);
        for (let i = 0; i < 60; i++) {
            const f = cubic1(T[0], T[1], T[2], T[3], u) - t;
            if (Math.abs(f) < 1e-12) break;
            if (f > 0) b = u;
            else a = u;
            const d = cubic1Slope(T[0], T[1], T[2], T[3], u);
            let next = d > 1e-12 ? u - f / d : NaN;
            if (!(next > a && next < b)) next = (a + b) / 2;
            if (Math.abs(next - u) < 1e-14) break;
            u = next;
        }
        return cubic1(S[0], S[1], S[2], S[3], u);
    };

    const at = (s: number): P2 => {
        const [c, u] = locate(s);
        return bezier(c, u);
    };
    const direction = (s: number): P2 => {
        const [c, u] = locate(s);
        let d = bezierSlope(c, u);
        // At a corner's handle the slope vanishes: look a little further in.
        if (Math.hypot(d[0], d[1]) < 1e-9) d = bezierSlope(c, Math.min(1, Math.max(0, u < 0.5 ? u + 1e-3 : u - 1e-3)));
        const l = Math.hypot(d[0], d[1]) || 1;
        return [d[0] / l, d[1] / l];
    };
    const round = (d: number) => (closed && length > 0 ? ((d % length) + length) % length : d);
    const rests = [keys[0].s, ...keys.slice(1).filter((b, i) => b.s === keys[i].s).map((b) => b.s)].map(round)
        .filter((d, i, all) => all.findIndex((e) => Math.abs(e - d) < 5e-3 || (closed && Math.abs(Math.abs(e - d) - length) < 5e-3)) === i);
    return { file, closed, length, duration, at, direction, distance, rests, sample: (t) => at(distance(t)) };
}
