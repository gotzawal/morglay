// The small pieces every motion formula uses: curves between two states,
// rotations made from axes, smoothing over a cycle. Plain numbers; rotations
// are quaternions [x, y, z, w] as in core/rigMotion.ts. Nothing here reads a
// clip, a pose or any other stored motion.

import { rotationOf, type Quat, type V3 } from '../rigMotion';

/** Standard gravity, m/s². */
export const GRAVITY = 9.81;

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** The fractional part, in [0, 1). */
export const frac = (x: number) => x - Math.floor(x);
export const DEG = Math.PI / 180;

/**
 * Minimum-jerk progress from 0 to 1 (Flash & Hogan 1985): the smoothest way
 * from rest to rest, with zero speed and acceleration at both ends.
 */
export function minJerk(u: number): number {
    const x = clamp(u, 0, 1);
    return x * x * x * (10 + x * (-15 + 6 * x));
}

/**
 * The minimum-jerk move between two states with speeds given at both ends
 * (accelerations zero there): the value at u in [0, 1]. `v0` and `v1` are
 * speeds per unit of u.
 */
export function quintic(p0: number, v0: number, p1: number, v1: number, u: number): number {
    const x = clamp(u, 0, 1);
    const x3 = x * x * x, x4 = x3 * x, x5 = x4 * x;
    return p0 + v0 * (x - 6 * x3 + 8 * x4 - 3 * x5) + (p1 - p0) * (10 * x3 - 15 * x4 + 6 * x5) + v1 * (-4 * x3 + 7 * x4 - 3 * x5);
}

/**
 * The quintic between two states with speed and acceleration given at both ends
 * (per unit of u, and per unit of u squared): the value at u in [0, 1]. It joins
 * two curves so that neither the speed nor the acceleration jumps where they meet.
 */
export function bridge(p0: number, v0: number, a0: number, p1: number, v1: number, a1: number, u: number): number {
    const x = clamp(u, 0, 1);
    const x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
    return (
        p0 * (1 - 10 * x3 + 15 * x4 - 6 * x5) + v0 * (x - 6 * x3 + 8 * x4 - 3 * x5) + a0 * (0.5 * x2 - 1.5 * x3 + 1.5 * x4 - 0.5 * x5) +
        p1 * (10 * x3 - 15 * x4 + 6 * x5) + v1 * (-4 * x3 + 7 * x4 - 3 * x5) + a1 * (0.5 * x3 - x4 + 0.5 * x5)
    );
}

/**
 * The minimum-jerk move between two states with speeds given at both ends and the pushes
 * there left free (the jerk, not the acceleration, is zero at the ends): the value at u in
 * [0, 1]. It is already speeding up as it starts and still slowing as it arrives, so it
 * spreads its speed more evenly than `quintic` does: a foot pushed off the floor and
 * stopped by it. `v0` and `v1` are speeds per unit of u.
 */
export function freeQuintic(p0: number, v0: number, p1: number, v1: number, u: number): number {
    const x = clamp(u, 0, 1), d = p1 - p0;
    const a5 = (2 * d - v0 - v1) / 2, a4 = -2.5 * a5, a2 = 2.5 * d - 1.75 * v0 - 0.75 * v1;
    const x2 = x * x;
    return p0 + v0 * x + a2 * x2 + a4 * x2 * x2 + a5 * x2 * x2 * x;
}

/** Solves a small set of linear equations: each row its coefficients, then its right side. Returns the unknowns. */
function solve(m: number[][]): number[] {
    const n = m.length;
    for (let col = 0; col < n; col++) {
        let best = col;
        for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[best][col])) best = row;
        [m[col], m[best]] = [m[best], m[col]];
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const k = m[row][col] / m[col][col];
            for (let j = col; j <= n; j++) m[row][j] -= k * m[col][j];
        }
    }
    return m.map((row, i) => row[n] / row[i]);
}

/** A row of an equation set: zeros but for the given places, then the right side. */
const row = (n: number, at: Record<number, number>, right: number): number[] => {
    const r = new Array<number>(n + 1).fill(0);
    for (const k in at) r[+k] = at[k];
    r[n] = right;
    return r;
};

/**
 * The smoothest move (least jerk) between two states, as a curve over u in [0, 1]. A state is
 * a value, a speed (per unit of u) and an acceleration (per unit of u squared). An
 * acceleration that is not a number is left free: there is no jerk at that end instead, so
 * the move is already speeding up as it starts, or still slowing as it arrives (something
 * pushed off, or stopped by what it meets). With both given this is `bridge`; with both free,
 * `freeQuintic`.
 */
export function move(p0: number, v0: number, a0: number, p1: number, v1: number, a1: number): (u: number) => number {
    // p0 + v0·t + c2·t² + c3·t³ + c4·t⁴ + c5·t⁵
    const [c2, c3, c4, c5] = solve([
        Number.isFinite(a0) ? row(4, { 0: 2 }, a0) : row(4, { 1: 6 }, 0),
        row(4, { 0: 1, 1: 1, 2: 1, 3: 1 }, p1 - p0 - v0),
        row(4, { 0: 2, 1: 3, 2: 4, 3: 5 }, v1 - v0),
        Number.isFinite(a1) ? row(4, { 0: 2, 1: 6, 2: 12, 3: 20 }, a1) : row(4, { 1: 6, 2: 24, 3: 60 }, 0),
    ]);
    return (u: number) => {
        const t = clamp(u, 0, 1);
        return p0 + t * (v0 + t * (c2 + t * (c3 + t * (c4 + t * c5))));
    };
}

/**
 * The smoothest curve (least jerk) from one state to another that passes a given value on the
 * way: two quintics that meet there (the via-point movement of Flash & Hogan 1985). The whole
 * way is u from 0 to 1; `at` is where on it the value `via` is passed. States are as in
 * `move`: an end's acceleration that is not a number is left free.
 *
 * Without `viaSpeed` the two pieces meet with speed, acceleration, jerk and snap unbroken.
 * With it the speed there is given too (0: the curve turns there), and acceleration and jerk
 * are unbroken.
 */
export function viaCurve(p0: number, v0: number, a0: number, p1: number, v1: number, a1: number, at: number, via: number, viaSpeed?: number): (u: number) => number {
    // Each piece in its own time from 0 to 1: the first c0..c5 (places 0-5), the second e0..e5 (places 6-11).
    // r turns a rate of the first piece into the second's.
    const d1 = clamp(at, 1e-6, 1 - 1e-6), d2 = 1 - d1, r = d2 / d1;
    const r2 = r * r, r3 = r2 * r, r4 = r3 * r;
    const N = 12;
    const speed1 = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
    const jerkMeets = row(N, { 9: 6, 3: -6 * r3, 4: -24 * r3, 5: -60 * r3 }, 0);
    const c = solve([
        row(N, { 0: 1 }, p0),
        row(N, { 1: 1 }, v0 * d1),
        Number.isFinite(a0) ? row(N, { 2: 2 }, a0 * d1 * d1) : row(N, { 3: 6 }, 0),
        row(N, { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }, via),
        row(N, { 6: 1 }, via),
        row(N, { 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1 }, p1),
        row(N, { 7: 1, 8: 2, 9: 3, 10: 4, 11: 5 }, v1 * d2),
        Number.isFinite(a1) ? row(N, { 8: 2, 9: 6, 10: 12, 11: 20 }, a1 * d2 * d2) : row(N, { 9: 6, 10: 24, 11: 60 }, 0),
        // Where they meet: the speed, the acceleration,
        row(N, { 7: 1, 1: -r, 2: -2 * r, 3: -3 * r, 4: -4 * r, 5: -5 * r }, 0),
        row(N, { 8: 2, 2: -2 * r2, 3: -6 * r2, 4: -12 * r2, 5: -20 * r2 }, 0),
        // and either the speed asked for and the jerk, or the jerk and the snap.
        viaSpeed !== undefined ? row(N, speed1, viaSpeed * d1) : jerkMeets,
        viaSpeed !== undefined ? jerkMeets : row(N, { 10: 24, 4: -24 * r4, 5: -120 * r4 }, 0),
    ]);
    return (u: number) => {
        const x = clamp(u, 0, 1);
        if (x <= d1) { const t = x / d1; return c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5])))); }
        const t = (x - d1) / d2;
        return c[6] + t * (c[7] + t * (c[8] + t * (c[9] + t * (c[10] + t * c[11]))));
    };
}

/**
 * A wave once a cycle, with (where asked) its third harmonic riding on it. `phase` counts
 * cycles; the wave is at its most `at` of a cycle on. `third`: the faster wave's size as a
 * share of the first, and when it peaks. One wave alone rises and falls evenly; the third
 * makes it rise fast and come back slowly, or flattens its top.
 */
export const wave = (phase: number, at: number, third: readonly [number, number] = [0, 0]): number =>
    Math.cos(2 * Math.PI * (phase - at)) + third[0] * Math.cos(6 * Math.PI * (phase - third[1]));

/** The rotation by `angle` (radians) about a unit axis. */
export function axisAngle(axis: V3, angle: number): Quat {
    const s = Math.sin(angle / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** The rotation that takes the three axes of `from` onto those of `to` (each right-handed and orthonormal). */
export function basisRotation(from: [V3, V3, V3], to: [V3, V3, V3]): Quat {
    // R = To · Fromᵀ, column by column.
    const m = new Array<number>(16).fill(0);
    for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
            let v = 0;
            for (let k = 0; k < 3; k++) v += to[k][row] * from[k][col];
            m[col * 4 + row] = v;
        }
    }
    m[15] = 1;
    return rotationOf(m);
}

/** Between two rotations, the short way. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1;
    d *= s;
    let k0 = 1 - t, k1 = t * s;
    if (d < 0.9995) {
        const th = Math.acos(d);
        k0 = Math.sin((1 - t) * th) / Math.sin(th);
        k1 = (s * Math.sin(t * th)) / Math.sin(th);
    }
    const q: Quat = [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * A cycle of samples smoothed around the cycle: each value becomes the Hann-weighted
 * mean of its neighbours `half` samples to each side, the ends wrapping.
 */
export function smoothCycle(values: number[], half: number): number[] {
    const n = values.length;
    if (half < 1 || n < 3) return [...values];
    const w: number[] = [];
    for (let j = -half; j <= half; j++) w.push(0.5 * (1 + Math.cos((Math.PI * j) / (half + 1))));
    const total = w.reduce((a, b) => a + b, 0);
    return values.map((_, i) => {
        let sum = 0;
        for (let j = -half; j <= half; j++) sum += w[j + half] * values[(((i + j) % n) + n) % n];
        return sum / total;
    });
}
