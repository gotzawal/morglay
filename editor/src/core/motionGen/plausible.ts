// Whether a made motion is one a body could have made: checked on the frames, whatever made them (formulas or forces).
//
// A motion is laid over the body's masses (mass.ts): every part's place at every frame, so the whole body's centre of mass
// and how it speeds up. That is what the floor must have pushed with (its push is the body's mass times how the centre
// speeds up, less the weight), and the floor can only do so much:
//   - with no foot standing it cannot push at all (the body flies as it was thrown);
//   - it never pulls;
//   - it pushes no harder than legs bear, and along itself no more than it grips;
//   - it pushes from within the soles that stand (where from follows from how the body's turning about its centre changes).
// And the body has its own limits: no joint past its range, no leg longer than it is, no foot standing flat that slides,
// no foot through the other, no part jerked from one frame to the next.
// Nothing here corrects a motion: it says how far outside each limit the motion goes, for a test to hold against a tolerance.

import { add, cross, dot, length, qinv, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import type { GaitFrame } from './gait';
import { HUMAN_MASS, HUMAN_RANGES, type JointRanges, type MassTable } from './mass';
import { clamp, GRAVITY } from './tools';
import { along } from './turn';

// ---------------------------------------------------------------- shapes on the floor
type P2 = [number, number];
const turn2 = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** The outline round some points (counter-clockwise). */
function outline(points: P2[]): P2[] {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const lower: P2[] = [], upper: P2[] = [];
    for (const q of p) { while (lower.length >= 2 && turn2(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && turn2(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const within = (poly: P2[], p: P2) => poly.length >= 3 && poly.every((a, i) => turn2(a, poly[(i + 1) % poly.length], p) >= 0);
/** The point of an outline (or within it) nearest to a point. */
function nearest(poly: P2[], p: P2): P2 {
    if (!poly.length) return p;
    if (within(poly, p)) return p;
    let best: P2 = poly[0], least = Infinity;
    poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length], ab: P2 = [b[0] - a[0], b[1] - a[1]];
        const span = ab[0] * ab[0] + ab[1] * ab[1];
        const u = span > 0 ? clamp(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / span, 0, 1) : 0;
        const q: P2 = [a[0] + ab[0] * u, a[1] + ab[1] * u], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < least) { least = d; best = q; }
    });
    return best;
}
/** The corners of a sole on the floor: the ankle's place, the way the foot points, half its width; kept `inset` inside its edges (outside, below zero). */
function soleCorners(body: Body, at: V3, heading: number, half: number, inset: number): P2[] {
    const { left, up, fwd } = body;
    const u = along(body, heading), n = cross(up, u);
    const wide = Math.max(0.002, half - inset);
    const back = Math.min(body.sole.heel + inset, -0.002), front = Math.max(body.sole.tip - inset, 0.002);
    return ([[back, wide], [front, wide], [front, -wide], [back, -wide]] as P2[]).map(([x, y]) => { const p = add(at, add(scale(u, x), scale(n, y))); return [dot(p, left), dot(p, fwd)] as P2; });
}

/** The vector of a turn (the shorter way round). */
function turnVector(q: Quat): V3 {
    const sign = q[3] < 0 ? -1 : 1;
    const s = Math.hypot(q[0], q[1], q[2]);
    if (s < 1e-12) return [2 * sign * q[0], 2 * sign * q[1], 2 * sign * q[2]];
    const a = 2 * Math.atan2(s, sign * q[3]);
    return [(sign * q[0] * a) / s, (sign * q[1] * a) / s, (sign * q[2] * a) / s];
}


export interface Plausible {
    /** How far past its range each joint goes at most, degrees (0: within): the hips, the knees, the waist, the neck, the shoulders, the elbows. */
    joints: { hip: number; knee: number; waist: number; neck: number; shoulder: number; elbow: number };
    /** A standing leg short of its ankle at most, m; a foot standing flat moving between two frames at most, m; the ankles nearest to each other, m. */
    short: number;
    slide: number;
    near: number;
    /** The floor's push, in body weights: the hardest up; the most it would have had to pull down; the most asked with no foot standing. */
    push: number;
    pull: number;
    flight: number;
    /** The most asked along the floor, as a share of the push up (where that is more than a third of the body's weight). */
    grip: number;
    /** How far outside the soles that stand the push was asked from at most, m (where the push up is more than half the body's weight). */
    off: number;
    /** The hips' speeding up at most, m/s²; the most a bone turns between two frames, degrees. */
    accel: number;
    turn: number;
    /** When each of the floor's and the jerks' worst was, s into the motion (by name: push, pull, flight, grip, off, accel, turn). */
    at: Record<string, number>;
}

const D = 180 / Math.PI;
const mix = (a: V3, b: V3, t: number): V3 => add(a, scale(sub(b, a), t));
const SIDES = ['left', 'right'] as const;

/** Where the body's joints are in a frame, by role (those the frame turns; a part without a turn of its own goes with what carries it). */
function jointsOf(body: Body, f: GaitFrame): Record<string, V3> {
    const w = f.world as Record<string, Quat>, ref = body.ref;
    const at: Record<string, V3> = { hips: f.hips };
    const turnOf = (role: string, carrier: string): Quat => w[role] ?? w[carrier];
    const put = (role: string, parent: string) => { if (ref[role] && at[parent]) at[role] = add(at[parent], rotate(turnOf(parent, 'hips'), sub(ref[role], ref[parent]))); };
    const chain = ['spine', 'chest', 'upperChest', 'neck', 'head'].filter((r) => ref[r]);
    let last = 'hips';
    for (const r of chain) { put(r, last); last = r; }
    const top = ['upperChest', 'chest', 'spine', 'hips'].find((r) => ref[r])!;
    for (const side of SIDES) {
        let carrier = top;
        if (ref[`${side}Shoulder`]) { put(`${side}Shoulder`, top); carrier = `${side}Shoulder`; }
        put(`${side}UpperArm`, carrier);
        put(`${side}LowerArm`, `${side}UpperArm`);
        put(`${side}Hand`, `${side}LowerArm`);
        put(`${side}UpperLeg`, 'hips');
        put(`${side}LowerLeg`, `${side}UpperLeg`);
    }
    at.leftFoot = f.ankles[0];
    at.rightFoot = f.ankles[1];
    return at;
}

/** The body's parts as point masses in a frame: where each is, and its share of the body's mass. */
function massesOf(body: Body, at: Record<string, V3>, M: MassTable): [V3, number][] {
    const neck = at.neck ?? at.head, waist = at.spine ?? at.hips;
    const out: [V3, number][] = [[at.hips, M.pelvis.mass], [mix(waist, neck, M.trunk.com), M.trunk.mass], [mix(neck, at.head, 1 + M.head.com * 0.5), M.head.mass]];
    for (const s of SIDES) {
        out.push([mix(at[`${s}UpperArm`], at[`${s}LowerArm`], M.upperArm.com), M.upperArm.mass], [mix(at[`${s}LowerArm`], at[`${s}Hand`], M.forearm.com), M.forearm.mass]);
        out.push([mix(at[`${s}UpperLeg`], at[`${s}LowerLeg`], M.thigh.com), M.thigh.mass], [mix(at[`${s}LowerLeg`], at[`${s}Foot`], M.shank.com), M.shank.mass], [at[`${s}Foot`], M.foot.mass]);
    }
    return out;
}

/** Where the whole body's centre of mass is in a frame (its hips, its ankles and its bones' turns are all that is read). */
export function centreOfMass(body: Body, f: Pick<GaitFrame, 'hips' | 'world' | 'ankles'>, table: MassTable = HUMAN_MASS): V3 {
    const list = massesOf(body, jointsOf(body, f as GaitFrame), table);
    return scale(list.reduce((sum, [at, m]) => add(sum, scale(at, m)), [0, 0, 0] as V3), 1 / list.reduce((sum, [, m]) => sum + m, 0));
}

/**
 * How far outside what a body can do a motion goes. `frames`: evenly spaced in time (their `time`), the hips and the
 * ankles in model space; `pace`: frames given in place go so fast along the forward (the way gone is put back for what
 * is measured against the floor); `loop`: the last frame is the first again, and the motion goes round; `pushed`: the
 * times between which something outside pushes on the body (what the floor is asked for is not told from the motion there).
 */
export function plausible(body: Body, frames: GaitFrame[], options: { pace?: number; loop?: boolean; pushed?: [number, number][]; table?: MassTable; ranges?: JointRanges } = {}): Plausible {
    const { left, up, fwd } = body;
    const M = options.table ?? HUMAN_MASS, R = options.ranges ?? HUMAN_RANGES, pace = options.pace ?? 0, loop = !!options.loop;
    const n = frames.length, h = n > 1 ? (frames[n - 1].time - frames[0].time) / (n - 1) : 1;
    const flat = (v: V3): V3 => sub(v, scale(up, dot(v, up)));
    const to2 = (v: V3): P2 => [dot(v, left), dot(v, fwd)];
    const went = (k: number): V3 => scale(fwd, pace * frames[k].time);
    const out: Plausible = { joints: { hip: 0, knee: 0, waist: 0, neck: 0, shoulder: 0, elbow: 0 }, short: 0, slide: 0, near: Infinity, push: 0, pull: 0, flight: 0, grip: 0, off: 0, accel: 0, turn: 0, at: {} };
    const worse = (key: 'push' | 'pull' | 'flight' | 'grip' | 'off' | 'accel' | 'turn', value: number, k: number) => { if (value > out[key]) { out[key] = value; out.at[key] = frames[k].time; } };
    const past = (x: number, lo: number, hi: number) => Math.max(0, x - hi, lo - x);
    const angle = (a: V3, b: V3) => Math.acos(clamp(dot(a, b) / Math.max(1e-12, length(a) * length(b)), -1, 1)) * D;

    // ---- every frame: the joints, the masses, the body's own limits
    const joints = frames.map((f) => jointsOf(body, f));
    const masses = joints.map((at) => massesOf(body, at, M));
    const whole = masses[0].reduce((sum, [, m]) => sum + m, 0);
    const centre = masses.map((list) => scale(list.reduce((sum, [p, m]) => add(sum, scale(p, m)), [0, 0, 0] as V3), 1 / whole));
    const top = ['upperChest', 'chest', 'spine', 'hips'].find((r) => body.ref[r])!;
    frames.forEach((f, k) => {
        const w = f.world as Record<string, Quat>, at = joints[k];
        const trunk = w[top] ?? w.hips;
        // The waist and the neck: the turn of what is carried against what carries it, about the side axis, the upright and the forward.
        const about = (q: Quat, r: { bow: number; arch: number; side: number; twist: number }) => { const v = turnVector(q); return Math.max(past(dot(v, left) * D, -r.arch, r.bow), past(dot(v, up) * D, -r.twist, r.twist), past(dot(v, fwd) * D, -r.side, r.side)); };
        out.joints.waist = Math.max(out.joints.waist, about(qmul(qinv(w.hips), trunk), R.waist));
        if (w.head) out.joints.neck = Math.max(out.joints.neck, about(qmul(qinv(trunk), w.head), R.neck));
        SIDES.forEach((side, i) => {
            const sign = i === 0 ? 1 : -1;
            // The hip: where the thigh points, seen from the pelvis.
            const thigh = rotate(qinv(w.hips), sub(at[`${side}LowerLeg`], at[`${side}UpperLeg`]));
            out.joints.hip = Math.max(out.joints.hip, past(Math.atan2(dot(thigh, fwd), -dot(thigh, up)) * D, -R.hip.back, R.hip.bend), past(Math.asin(clamp((sign * dot(thigh, left)) / Math.max(1e-9, length(thigh)), -1, 1)) * D, -R.hip.in, R.hip.out));
            out.joints.knee = Math.max(out.joints.knee, past(f.knees[i] * D, -1, R.knee));
            // The shoulder: where the upper arm points, seen from the trunk; the elbow: the forearm against the upper arm.
            const arm = rotate(qinv(trunk), sub(at[`${side}LowerArm`], at[`${side}UpperArm`]));
            const lifted = angle(arm, scale(up, -1));
            out.joints.shoulder = Math.max(out.joints.shoulder, past(lifted, 0, Math.max(R.shoulder.fore, R.shoulder.out)), dot(arm, fwd) < 0 && sign * dot(arm, left) < Math.abs(dot(arm, fwd)) ? past(lifted, 0, R.shoulder.back + 40) : 0);
            out.joints.elbow = Math.max(out.joints.elbow, past(angle(sub(at[`${side}LowerArm`], at[`${side}UpperArm`]), sub(at[`${side}Hand`], at[`${side}LowerArm`])), 0, R.elbow));
            if (f.stance[i]) out.short = Math.max(out.short, f.short[i]);
        });
        out.near = Math.min(out.near, length(sub(f.ankles[0], f.ankles[1])));
    });

    // ---- between frames: a foot standing flat does not slide; nothing is jerked
    const toesOf = (f: GaitFrame, i: number): V3 => rotate((f.world as Record<string, Quat>)[`${SIDES[i]}Foot`] ?? [0, 0, 0, 1], add(scale(fwd, Math.cos(body.footYaw[i])), scale(left, Math.sin(body.footYaw[i]))));
    const flatFoot = (f: GaitFrame, i: number) => f.stance[i] && Math.abs(dot(toesOf(f, i), up)) < 1e-3 && Math.abs(dot(f.ankles[i], up) - body.floor - body.ankleHeight) < 2e-3;
    for (let k = 0; k < n - 1; k++) {
        const a = frames[k], b = frames[k + 1];
        for (let i = 0; i < 2; i++) if (flatFoot(a, i) && flatFoot(b, i)) out.slide = Math.max(out.slide, length(flat(sub(add(b.ankles[i], went(k + 1)), add(a.ankles[i], went(k))))));
        for (const role of Object.keys(a.world)) { const qa = (a.world as Record<string, Quat>)[role], qb = (b.world as Record<string, Quat>)[role]; if (qa && qb) worse('turn', length(turnVector(qmul(qinv(qa), qb))) * D, k); }
    }

    // ---- what the floor is asked for: the body's mass times how its centre speeds up, less its weight
    const m = loop ? n - 1 : n;
    const ix = (k: number) => (loop ? ((k % m) + m) % m : k);
    const ok = (k: number) => loop || (k >= 0 && k < n);
    const second = (list: V3[], k: number): V3 => scale(add(sub(list[ix(k + 1)], scale(list[ix(k)], 2)), list[ix(k - 1)]), 1 / (h * h));
    const hips = frames.map((f) => f.hips);
    // (How the body turns about its centre: each mass's place from the centre crossed with its speed from the centre's.)
    const turning = (k: number): V3 | null => {
        if (!ok(k - 1) || !ok(k + 1)) return null;
        const i = ix(k), i0 = ix(k - 1), i1 = ix(k + 1);
        let sum: V3 = [0, 0, 0];
        masses[i].forEach(([at, mass], j) => {
            const v = scale(sub(sub(masses[i1][j][0], centre[i1]), sub(masses[i0][j][0], centre[i0])), 1 / (2 * h));
            sum = add(sum, scale(cross(sub(at, centre[i]), v), mass / whole));
        });
        return sum;
    };
    const offs: number[] = new Array(m).fill(0);
    for (let k = 0; k < m; k++) {
        if (!ok(k - 1) || !ok(k + 1)) continue;
        worse('accel', length(second(hips, k)), k);
        const f = frames[k];
        if ((options.pushed ?? []).some(([from, to]) => f.time >= from - h && f.time <= to + h)) continue;
        // (How the centre speeds up is told from three frames: they have to stand on the same feet for it to say what the floor did.)
        // (In the air, two frames either side: a hop of a few frames is too short to tell.)
        const same = (j: number) => ok(j) && frames[ix(j)].stance[0] === f.stance[0] && frames[ix(j)].stance[1] === f.stance[1];
        if (!same(k - 1) || !same(k + 1) || (!f.stance[0] && !f.stance[1] && (!same(k - 2) || !same(k + 2)))) continue;
        const asked = add(second(centre, k), scale(up, GRAVITY)), lift = dot(asked, up), along = length(flat(asked));
        const standing = [0, 1].filter((i) => f.stance[i]);
        if (!standing.length) { worse('flight', length(asked) / GRAVITY, k); continue; }
        worse('push', lift / GRAVITY, k);
        worse('pull', -lift / GRAVITY, k);
        if (lift > GRAVITY / 3) worse('grip', along / lift, k);
        if (lift > GRAVITY / 2) {
            // Where the push has to come from: under the centre, moved by the push along the floor and by how the body's turning changes.
            const before = turning(k - 1), after = turning(k + 1);
            const change: V3 = before && after ? scale(sub(after, before), 1 / (2 * h)) : [0, 0, 0];
            const high = dot(centre[k], up) - body.floor;
            const from = add(flat(centre[k]), scale(add(scale(flat(asked), -high), cross(up, change)), 1 / lift));
            const corners = standing.flatMap((i) => { const toes = toesOf(f, i); return soleCorners(body, flat(f.ankles[i]), Math.atan2(dot(toes, left), dot(toes, fwd)), body.sole.half, 0); });
            const hull = outline(corners), q = to2(from), near = nearest(hull, q);
            offs[k] = Math.hypot(q[0] - near[0], q[1] - near[1]);
        }
    }
    // (Where the push comes from is told roughly: it counts where it stays outside the soles for three frames running.)
    for (let k = 0; k < m; k++) if (ok(k - 1) && ok(k + 1)) worse('off', Math.min(offs[ix(k - 1)], offs[k], offs[ix(k + 1)]), k);
    return out;
}
