// The math of a model's motion on top of its clip (core/model.ts Motion):
// bones that swing as springs, and the timing of a blink. Plain numbers, so
// it runs and is tested without the engine; engine/characterMotion.ts binds
// it to a skeleton.

import type { SpringGroupDoc } from './model';

export type V3 = [number, number, number];
/** A rotation as a quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: V3, fallback: V3 = [0, -1, 0]): V3 {
    const l = length(a);
    return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback];
}

export function qmul(a: Quat, b: Quat): Quat {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}
export const qinv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qnormalize(q: Quat): Quat {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** A vector turned by a rotation. */
export function rotate(q: Quat, v: V3): V3 {
    const u: V3 = [q[0], q[1], q[2]];
    const t = scale(cross(u, v), 2);
    return add(add(v, scale(t, q[3])), cross(u, t));
}
/** The shortest rotation that turns one unit vector onto another. */
export function rotationBetween(from: V3, to: V3): Quat {
    const d = dot(from, to);
    if (d > 1 - 1e-9) return [0, 0, 0, 1];
    if (d < -1 + 1e-9) {
        // Opposite: half a turn about any axis square to it.
        const axis = normalize(cross(Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], from));
        return [axis[0], axis[1], axis[2], 0];
    }
    const c = cross(from, to);
    return qnormalize([c[0], c[1], c[2], 1 + d]);
}
/** The rotation of a matrix (column-major 4x4 without shear; scale is divided out). */
export function rotationOf(m: ArrayLike<number>): Quat {
    const sx = Math.hypot(m[0], m[1], m[2]) || 1;
    const sy = Math.hypot(m[4], m[5], m[6]) || 1;
    const sz = Math.hypot(m[8], m[9], m[10]) || 1;
    const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
    const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
    const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
    const trace = r00 + r11 + r22;
    let q: Quat;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        q = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
    } else if (r00 > r11 && r00 > r22) {
        const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
        q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
    } else if (r11 > r22) {
        const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
        q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
    } else {
        const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
        q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
    }
    return qnormalize(q);
}

/**
 * Whether a bone's name is one of a group's: the group names its bones as
 * patterns separated by commas or spaces, where * stands for any run of
 * characters ("hair_* ribbon_L_*_jnt").
 */
export function boneMatcher(patterns: string): (name: string) => boolean {
    const list = patterns
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
    return (name) => list.some((re) => re.test(name));
}

/** One swinging bone between frames: where its tail is, where it was, and how its head moved. */
export interface SpringState {
    cur: V3;
    prev: V3;
    headPrev: V3;
    headVelocity: V3;
}

export const springRest = (head: V3, restDir: V3, len: number): SpringState => {
    const tail = add(head, scale(restDir, len));
    return { cur: tail, prev: [...tail], headPrev: [...head], headVelocity: [0, 0, 0] };
};

/** Seconds a step may take: frames outside it are stepped as its nearest end (a hitch must not fling the bones). */
export const SPRING_STEP = { min: 1 / 240, max: 1 / 30 };

/**
 * One step of a swinging bone. `head` is where the bone starts this frame
 * and `restDir` where its pose points from there (both in the world);
 * the tail keeps `len` from the head. Returns the direction the bone points
 * now and moves the state on.
 *
 * The pull back to the pose is set by the swing's period, so it scales with
 * the bone's length and long and short bones of a group swing alike; the
 * speed the tail has of its own (against the head's) dies by the damping,
 * and what it has from being carried along dies by the drag.
 */
export function springStep(
    s: SpringState,
    head: V3,
    restDir: V3,
    len: number,
    g: Pick<SpringGroupDoc, 'period' | 'damping' | 'gravity' | 'drag' | 'limit'>,
    dt: number,
    stepRatio: number,
    push?: (tail: V3) => V3,
): V3 {
    const h = Math.min(SPRING_STEP.max, Math.max(SPRING_STEP.min, dt));
    const w = (2 * Math.PI * h) / Math.max(g.period, 0.05);
    const pull = w * w * len;
    const keep = Math.exp(-2 * g.damping * w);
    const carry = Math.exp(-g.drag * h);

    const headVelocity = sub(head, s.headPrev);
    const own = scale(sub(sub(s.cur, s.prev), s.headVelocity), stepRatio);
    let next = add(s.cur, scale(headVelocity, carry));
    next = add(next, scale(own, keep));
    next = add(next, scale(restDir, pull));
    next[1] -= g.gravity * pull;
    // The bone keeps its length.
    next = add(head, scale(normalize(sub(next, head), restDir), len));
    if (push) next = add(head, scale(normalize(sub(push(next), head), restDir), len));

    // No further from its pose than the limit.
    let dir = normalize(sub(next, head), restDir);
    const max = (g.limit * Math.PI) / 180;
    const angle = Math.acos(Math.min(1, Math.max(-1, dot(restDir, dir))));
    if (angle > max) {
        const axis = cross(restDir, dir);
        if (length(axis) > 1e-9) {
            const a = normalize(axis);
            const half = max / 2;
            dir = normalize(rotate([a[0] * Math.sin(half), a[1] * Math.sin(half), a[2] * Math.sin(half), Math.cos(half)], restDir), restDir);
        } else dir = [...restDir];
    }
    next = add(head, scale(dir, len));

    s.prev = s.cur;
    s.cur = next;
    s.headVelocity = headVelocity;
    s.headPrev = [...head];
    return dir;
}

/** A point kept out of a ball, or of a capsule when `b` is given: the point, or where it is pushed out to. */
export function pushOut(p: V3, a: V3, b: V3 | null, radius: number): V3 {
    let center = a;
    if (b) {
        const seg = sub(b, a);
        const l2 = dot(seg, seg);
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, dot(sub(p, a), seg) / l2)) : 0;
        center = add(a, scale(seg, t));
    }
    const d = sub(p, center);
    const dist = length(d);
    return dist < radius && dist > 1e-6 ? add(center, scale(d, radius / dist)) : p;
}

/** How closed the eyes are, seconds into a blink: they shut fast, hold, and open slower. */
export function blinkCurve(t: number): number {
    if (t < 0) return 0;
    if (t < 0.07) return t / 0.07;
    if (t < 0.11) return 1;
    if (t < 0.23) return 1 - (t - 0.11) / 0.12;
    return 0;
}
/** The length of a blink, seconds. */
export const BLINK_SECONDS = 0.23;
