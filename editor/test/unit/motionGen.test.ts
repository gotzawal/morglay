import { describe, expect, it } from 'vitest';
import { clipOntoModel, framesToClip, framesToClipOnce } from '../../src/core/motionGen/bake';
import { canonicalSkeleton, measureBody } from '../../src/core/motionGen/body';
import { GAIT_STYLE, gaitCycle, gaitFor, gaitPoser, type GaitFrame, type GaitMode, type Vault } from '../../src/core/motionGen/gait';
import { ARC_STYLE, carryFrames, PIVOT_STYLE, SLOPE_STYLE, START_STYLE, STOP_STYLE, walkArc, walkPivot, walkSlope, walkStart, walkStop, type ArcStyle } from '../../src/core/motionGen/carry';
import { chainFollow } from '../../src/core/motionGen/chain';
import { chainOf, LOCO_STYLE, locoLoop, locomote } from '../../src/core/motionGen/locomotion';
import { GUARD_STYLE, guardGait, guardLine, stepGuard, walkGuard } from '../../src/core/motionGen/guard';
import { soleRoll } from '../../src/core/motionGen/sole';
import { standFrame, TURN_STYLE, turnFor, turnFrames, type TurnStyle } from '../../src/core/motionGen/turn';
const vaultOf = (m: GaitMode) => m.support as Vault;
import { bridge, freeQuintic, minJerk, move, quintic, smoothCycle, viaCurve, wave } from '../../src/core/motionGen/tools';
import type { Clip, Quat, SkeletonBone, Vec3 } from '../../src/core/retarget';

// A plain humanoid standing in the reference pose (arms out level, legs straight down),
// facing +Z, its left at +X, `k` times life size.
function human(k = 1): SkeletonBone[] {
    const I: Quat = [0, 0, 0, 1];
    const list: [string, string | null, Vec3][] = [
        ['hips', null, [0, 0.95, 0]], ['spine', 'hips', [0, 0.12, 0]], ['chest', 'spine', [0, 0.14, 0]], ['neck', 'chest', [0, 0.2, 0]], ['head', 'neck', [0, 0.1, 0]],
        ['leftShoulder', 'chest', [0.04, 0.16, 0]], ['leftUpperArm', 'leftShoulder', [0.12, 0, 0]], ['leftLowerArm', 'leftUpperArm', [0.27, 0, 0]], ['leftHand', 'leftLowerArm', [0.25, 0, 0]],
        ['rightShoulder', 'chest', [-0.04, 0.16, 0]], ['rightUpperArm', 'rightShoulder', [-0.12, 0, 0]], ['rightLowerArm', 'rightUpperArm', [-0.27, 0, 0]], ['rightHand', 'rightLowerArm', [-0.25, 0, 0]],
        ['leftUpperLeg', 'hips', [0.09, -0.05, 0]], ['leftLowerLeg', 'leftUpperLeg', [0, -0.42, 0]], ['leftFoot', 'leftLowerLeg', [0, -0.41, 0]], ['leftToes', 'leftFoot', [0, -0.05, 0.12]],
        ['rightUpperLeg', 'hips', [-0.09, -0.05, 0]], ['rightLowerLeg', 'rightUpperLeg', [0, -0.42, 0]], ['rightFoot', 'rightLowerLeg', [0, -0.41, 0]], ['rightToes', 'rightFoot', [0, -0.05, 0.12]],
    ];
    const index = new Map(list.map(([name], i) => [name, i]));
    return list.map(([name, parent, t]) => ({ name, parent: parent ? index.get(parent)! : -1, translation: [t[0] * k, t[1] * k, t[2] * k], rotation: I }));
}
const rolesOf = (sk: SkeletonBone[]) => Object.fromEntries(sk.map((b, i) => [b.name, i]));

const qmul = (a: Quat, b: Quat): Quat => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const rot = (q: Quat, v: Vec3): Vec3 => {
    const c = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const u: Vec3 = [q[0], q[1], q[2]];
    const t = c(u, v).map((x) => 2 * x) as Vec3;
    const ct = c(u, t);
    return [v[0] + q[3] * t[0] + ct[0], v[1] + q[3] * t[1] + ct[1], v[2] + q[3] * t[2] + ct[2]];
};
/** Where every bone is at key `k` of a clip. */
function places(sk: SkeletonBone[], clip: Clip, k: number): Vec3[] {
    const T = sk.map((b) => [...b.translation] as Vec3), R = sk.map((b) => [...b.rotation] as Quat);
    for (const tr of clip.tracks) {
        const n = tr.path === 'rotation' ? 4 : 3;
        const v = Array.from(tr.values.subarray(k * n, k * n + n));
        if (n === 4) R[tr.bone] = v as Quat; else T[tr.bone] = v as Vec3;
    }
    const P: Vec3[] = [], W: Quat[] = [];
    sk.forEach((b, i) => {
        if (b.parent < 0) { P[i] = T[i]; W[i] = R[i]; return; }
        const o = rot(W[b.parent], T[i]);
        P[i] = [P[b.parent][0] + o[0], P[b.parent][1] + o[1], P[b.parent][2] + o[2]];
        W[i] = qmul(W[b.parent], R[i]);
    });
    return P;
}
const far = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('motion curves', () => {
    it('goes from rest to rest the smoothest way', () => {
        expect(minJerk(0)).toBe(0);
        expect(minJerk(1)).toBe(1);
        expect(minJerk(0.5)).toBeCloseTo(0.5, 12);
        // No speed at the ends.
        expect(minJerk(1e-4) / 1e-4).toBeLessThan(1e-6);
        expect((1 - minJerk(1 - 1e-4)) / 1e-4).toBeLessThan(1e-6);
    });

    it('meets the speeds asked for at both ends', () => {
        const h = 1e-5;
        expect(quintic(2, 3, 5, -1, 0)).toBe(2);
        expect(quintic(2, 3, 5, -1, 1)).toBeCloseTo(5, 12);
        expect((quintic(2, 3, 5, -1, h) - 2) / h).toBeCloseTo(3, 3);
        expect((5 - quintic(2, 3, 5, -1, 1 - h)) / h).toBeCloseTo(-1, 3);
    });

    it('joins two states with their speeds and accelerations', () => {
        const h = 1e-4;
        const f = (u: number) => bridge(1, 2, -3, 4, -1, 5, u);
        expect(f(0)).toBe(1);
        expect(f(1)).toBeCloseTo(4, 12);
        expect((f(h) - f(0)) / h).toBeCloseTo(2, 2);
        expect((f(1) - f(1 - h)) / h).toBeCloseTo(-1, 2);
        expect((f(2 * h) - 2 * f(h) + f(0)) / (h * h)).toBeCloseTo(-3, 1);
        expect((f(1) - 2 * f(1 - h) + f(1 - 2 * h)) / (h * h)).toBeCloseTo(5, 1);
    });

    it('passes a value on the way between two states, without a break where it does', () => {
        const h = 1e-4, at = 0.4;
        const f = viaCurve(1, 2, -3, 4, -1, 5, at, 2.5);
        expect(f(0)).toBe(1);
        expect(f(1)).toBeCloseTo(4, 10);
        expect(f(at)).toBeCloseTo(2.5, 10);
        expect((f(h) - f(0)) / h).toBeCloseTo(2, 2);
        expect((f(1) - f(1 - h)) / h).toBeCloseTo(-1, 2);
        // Speed and acceleration are the same on both sides of the value.
        const before = (f(at) - f(at - h)) / h, after = (f(at + h) - f(at)) / h;
        expect(after - before).toBeCloseTo(0, 2);
        const bend = (u: number) => (f(u + h) - 2 * f(u) + f(u - h)) / (h * h);
        expect(bend(at + 2 * h) - bend(at - 2 * h)).toBeCloseTo(0, 1);
        // With nothing to detour for, it is the plain curve between the two states.
        const plain = viaCurve(0, 0, 0, 1, 0, 0, 0.5, 0.5);
        for (const u of [0.1, 0.37, 0.8]) expect(plain(u)).toBeCloseTo(minJerk(u), 10);
    });

    it('starts already speeding up when the push at its start is left free', () => {
        const f = viaCurve(0, 0.2, NaN, 0.1, -0.3, 0, 0.4, 1, 0);
        const h = 1e-3;
        expect(f(0.4)).toBeCloseTo(1, 9);
        expect((f(0.4 + h) - f(0.4 - h)) / (2 * h)).toBeCloseTo(0, 4);
        expect(f(1)).toBeCloseTo(0.1, 9);
        // No jerk at the start: the speed gained over the first step of time is the same as over the second, less next to nothing.
        const speedUp = (u: number) => (f(u + 2 * h) - 2 * f(u + h) + f(u)) / (h * h);
        expect(speedUp(0)).toBeGreaterThan(1);
        expect(Math.abs(speedUp(h) - speedUp(0)) / speedUp(0)).toBeLessThan(0.02);
    });

    it('moves the smoothest way between two states, an end held or left free', () => {
        // Both ends held: the same as the closed form. Both free: likewise.
        const held = move(1, 0.4, -0.3, 2, -0.2, 0.5), free = move(0, 0.3, NaN, 1, -0.1, NaN);
        for (const u of [0, 0.2, 0.5, 0.8, 1]) {
            expect(held(u)).toBeCloseTo(bridge(1, 0.4, -0.3, 2, -0.2, 0.5, u), 10);
            expect(free(u)).toBeCloseTo(freeQuintic(0, 0.3, 1, -0.1, u), 10);
        }
        // One held and one free: it starts from rest without a push and still meets the other state.
        const mixed = move(0, 0, 0, 1, 0.5, NaN);
        const h = 1e-4;
        expect((mixed(2 * h) - 2 * mixed(h) + mixed(0)) / (h * h)).toBeCloseTo(0, 2);
        expect(mixed(1)).toBeCloseTo(1, 12);
        expect((mixed(1) - mixed(1 - h)) / h).toBeCloseTo(0.5, 2);
    });

    it('makes a wave once a cycle, and with its third harmonic one that rises fast and comes back slowly', () => {
        expect(wave(0.25, 0.25)).toBeCloseTo(1, 12);
        expect(wave(0.75, 0.25)).toBeCloseTo(-1, 12);
        expect(wave(1.25, 0.25, [0.5, 0.25])).toBeCloseTo(1.5, 12);
        // The walking pelvis' list: next to nothing as the heel strikes, at its most soon after, and back slowly.
        const list = (p: number) => wave(p, 0.184, [0.33, 0.149]);
        let most = 0;
        for (let k = 1; k < 100; k++) if (list(k / 100) > list(most / 100)) most = k;
        expect(Math.abs(list(0)) / list(most / 100)).toBeLessThan(0.15);
        expect(most).toBeGreaterThan(10);
        expect(most).toBeLessThan(20);
        expect(list(0.4)).toBeGreaterThan(0.1 * list(most / 100));
    });

    it('smooths a cycle around its ends and keeps its mean', () => {
        const spike = [0, 0, 0, 8, 0, 0, 0, 0];
        const s = smoothCycle(spike, 2);
        expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(8, 10);
        expect(Math.max(...s)).toBeLessThan(8);
        // The first sample is a neighbour of the last.
        expect(smoothCycle([8, 0, 0, 0, 0, 0, 0, 0], 2)[7]).toBeGreaterThan(0);
    });
});

describe('gait formulas', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const walk = gaitFor(body, 1.3);
    const frames = gaitCycle(body, walk, GAIT_STYLE, 60);

    it('measures the body', () => {
        expect(body.left).toEqual([1, 0, 0]);
        expect(body.fwd[2]).toBeCloseTo(1, 12);
        expect(body.leg).toBeCloseTo(0.83, 10);
        expect(body.hipHeight).toBeCloseTo(0.9, 10);
        expect(body.ankleHeight).toBeCloseTo(0.07, 10);
        expect(body.hipHalf).toBeCloseTo(0.09, 10);
    });

    it('walks with the long stride of its style, the step growing more slowly than the speed', () => {
        // The default style strides long: about 100 steps a minute and a step of 0.8 m at 1.3 m/s on an adult's legs.
        expect(60 / walk.stepTime).toBeGreaterThan(90);
        expect(60 / walk.stepTime).toBeLessThan(115);
        expect(walk.step).toBeGreaterThan(0.7);
        expect(walk.step).toBeLessThan(0.9);
        // One foot is down a little over half the time: the feet are both down only briefly.
        expect(walk.duty).toBeGreaterThan(0.5);
        expect(walk.duty).toBeLessThan(0.6);
        // Its steps come faster with the speed (steps a second · √(hip height / g) = rate[0] + rate[1]·√Fr),
        // so twice the speed is a longer step, but not twice as long.
        const slow = gaitFor(body, 0.7), fast = gaitFor(body, 1.4);
        const rate = GAIT_STYLE.walk.rate;
        for (const g of [slow, fast]) expect((1 / g.stepTime) * Math.sqrt(body.hipHeight / 9.81)).toBeCloseTo(rate[0] + rate[1] * Math.sqrt(g.froude), 6);
        expect(fast.step / slow.step).toBeGreaterThan(1.2);
        expect(fast.step / slow.step).toBeLessThan(1.6);
    });

    it('sets its feet close to one line and swings each round the other', () => {
        // Seen from above: the standing ankles are a hand's width apart at most, and the swinging one bows out to its own side.
        const side = (f: (typeof frames)[number], i: number) => f.ankles[i][0];
        const standing = frames.filter((f) => f.stance[0]).map((f) => side(f, 0));
        const swinging = frames.filter((f) => !f.stance[0]).map((f) => side(f, 0));
        expect(Math.max(...standing)).toBeLessThan(0.05);
        expect(Math.max(...swinging)).toBeGreaterThan(Math.max(...standing) + 0.02);
    });

    it('lets each part of an arm follow the one above it, and turns the shoulders against the hips', () => {
        const fine = gaitCycle(body, walk, GAIT_STYLE, 240);
        // When each curve over the cycle is greatest.
        const peakOf = (v: number[]) => v.indexOf(Math.max(...v)) / v.length;
        const canon = canonicalSkeleton(sk, body);
        const clip = framesToClip(canon, body, fine, walk.stride, 'walk');
        const at = fine.map((_, k) => places(canon.bones, clip, k));
        const fore = (P: Vec3[], a: string, b: string) => P[canon.index[b]][2] - P[canon.index[a]][2];
        const upper = peakOf(at.map((P) => fore(P, 'leftUpperArm', 'leftLowerArm')));
        const lower = peakOf(at.map((P) => fore(P, 'leftLowerArm', 'leftHand')));
        // The forearm is farthest forward a little after the upper arm.
        expect(lower).toBeGreaterThan(upper);
        expect(lower - upper).toBeLessThan(0.1);
        // The shoulder line and the hip line turn opposite ways, the shoulders further.
        const turn = (P: Vec3[], l: string, r: string) => Math.atan2(P[canon.index[l]][2] - P[canon.index[r]][2], P[canon.index[l]][0] - P[canon.index[r]][0]);
        const hips = at.map((P) => turn(P, 'leftUpperLeg', 'rightUpperLeg')), shoulders = at.map((P) => turn(P, 'leftUpperArm', 'rightUpperArm'));
        const k = hips.indexOf(Math.max(...hips));
        expect(shoulders[k]).toBeLessThan(0);
        expect(Math.max(...shoulders)).toBeGreaterThan(Math.max(...hips));
    });

    it('never moves a foot that stands, and its legs always reach', () => {
        for (let i = 0; i < 2; i++) {
            for (let k = 0; k + 1 < frames.length; k++) {
                const a = frames[k], b = frames[k + 1];
                expect(a.short[i]).toBe(0);
                if (!a.stance[i] || !b.stance[i]) continue;
                // Flat: the ankle itself stays. Rolling: the sole point it rolls on stays.
                if (!a.pivots[i] && !b.pivots[i]) expect(far(a.ankles[i], b.ankles[i])).toBeLessThan(1e-9);
                if (a.pivots[i] && b.pivots[i] && far(a.pivots[i]!, b.pivots[i]!) < 0.05) expect(far(a.pivots[i]!, b.pivots[i]!)).toBeLessThan(1e-9);
            }
        }
    });

    it('bends and straightens each standing knee once, and lowers the hips once a step', () => {
        // How often a curve over the cycle turns back by more than `tol`.
        const turns = (v: number[], tol: number) => {
            const n = v.length;
            let start = 0;
            for (let j = 1; j < n; j++) if (v[j] < v[start]) start = j;
            // From its lowest point round to it again: that point, and every turn back by more than `tol` on the way.
            let count = 1, dir = 1, ref = v[start];
            for (let j = 1; j <= n; j++) {
                const x = v[(start + j) % n];
                if ((x - ref) * dir > 0) ref = x;
                else if (Math.abs(x - ref) > tol) { count++; dir = -dir; ref = x; }
            }
            return count;
        };
        for (const speed of [0.9, 1.3, 1.8]) {
            const g = gaitFor(body, speed);
            const cycle = gaitCycle(body, g, GAIT_STYLE, 96);
            // A stride: bend as the weight comes on, straighten, bend into the swing, straighten to land.
            for (let i = 0; i < 2; i++) expect(turns(cycle.map((f) => (f.knees[i] * 180) / Math.PI), 0.05)).toBe(4);
            // Down and up once a step (reversals of a millimetre or more).
            expect(turns(cycle.map((f) => f.hips[1]), 0.001)).toBe(4);
            for (const f of cycle) expect(Math.max(...f.short)).toBe(0);
        }
    });

    it('lands with the knee and the foot pitch it is asked for', () => {
        const root = Math.sqrt(walk.froude);
        const strike = vaultOf(GAIT_STYLE.walk).kneeStrike[0] + vaultOf(GAIT_STYLE.walk).kneeStrike[1] * root;
        // The first instant is the left heel's strike.
        expect((frames[0].knees[0] * 180) / Math.PI).toBeCloseTo(strike, 3);
        const toesUp = (q: Quat) => Math.asin(rot(q, [0, 0, 1])[1]);
        expect(toesUp(frames[0].world.leftFoot)).toBeCloseTo(walk.strikePitch, 4);
        // Flat in the middle of its stance.
        expect(Math.abs(toesUp(frames[12].world.leftFoot))).toBeLessThan(1e-6);
    });

    it('always has a foot on the ground walking, and swings the arm against its own leg', () => {
        for (const f of frames) expect(f.stance[0] || f.stance[1]).toBe(true);
        // At the left heel's strike the left foot is ahead; so is the right hand.
        const canon = canonicalSkeleton(sk, body);
        const clip = framesToClip(canon, body, frames, walk.stride, 'walk');
        const P = places(canon.bones, clip, 0);
        expect(P[canon.index.leftFoot][2]).toBeGreaterThan(P[canon.index.rightFoot][2] + 0.3);
        expect(P[canon.index.rightHand][2]).toBeGreaterThan(P[canon.index.leftHand][2] + 0.1);
    });

    it('takes the same pose at any size, at the speed that scales with it', () => {
        const k = 1.5;
        const big = human(k);
        const bigBody = measureBody(big, { roles: rolesOf(big) });
        const bigWalk = gaitFor(bigBody, 1.3 * Math.sqrt(k));
        const bigFrames = gaitCycle(bigBody, bigWalk, GAIT_STYLE, 60);
        expect(bigWalk.step).toBeCloseTo(walk.step * k, 6);
        expect(bigWalk.stride).toBeCloseTo(walk.stride * Math.sqrt(k), 6);
        for (const j of [0, 13, 29, 44]) {
            for (const [role, q] of Object.entries(frames[j].world)) {
                const b = bigFrames[j].world[role];
                expect(Math.abs(q[0] * b[0] + q[1] * b[1] + q[2] * b[2] + q[3] * b[3])).toBeCloseTo(1, 6);
            }
            expect(bigFrames[j].hips[1]).toBeCloseTo(frames[j].hips[1] * k, 5);
        }
    });

    it('is the same every time', () => {
        expect(gaitCycle(body, gaitFor(body, 1.3), GAIT_STYLE, 60)).toEqual(frames);
    });

    it('carries the hips through each landing without a jolt', () => {
        // The same walk with the hips at their lowest just as each heel strikes.
        const still = { ...GAIT_STYLE, walk: { ...GAIT_STYLE.walk, support: { ...vaultOf(GAIT_STYLE.walk), sink: 0 } } };
        for (const speed of [0.9, 1.3, 1.6]) {
            // After a heel strikes (key 0, and half a stride on) the hips are not thrown upward: a body made to follow
            // the landing leg at once leaps at twice gravity there. They go on down a little while that leg takes the
            // weight (`sink`: a millimetre or so), and not at all where the style asks for none.
            for (const [style, give] of [[GAIT_STYLE, 2e-3], [still, 2e-4]] as const) {
                const g = gaitFor(body, speed, style);
                const n = 128, dt = g.stride / n;
                const h = gaitCycle(body, g, style, n).map((f) => f.hips[1]);
                const at = (k: number) => h[((k % n) + n) % n];
                for (const strike of [0, n / 2]) {
                    for (let k = 0; k <= n * 0.15; k++) {
                        expect(at(strike + k)).toBeGreaterThan(at(strike) - give);
                        expect((at(strike + k - 1) - 2 * at(strike + k) + at(strike + k + 1)) / (dt * dt)).toBeLessThan(0.7 * 9.81);
                    }
                }
                // Asked to sink, they are still coming down as the heel lands, and lowest a little after it.
                if (style === GAIT_STYLE) expect(at(2)).toBeLessThan(at(0) - 1e-4);
            }
        }
    });

    it('draws a walking leg through as its toes leave, or leaves it behind to be thrown on late', () => {
        const swingOf = (pull: number) => {
            const style = { ...GAIT_STYLE, walk: { ...GAIT_STYLE.walk, swingPull: pull } };
            const g = gaitFor(body, 1.3, style), n = 240;
            const cycle = gaitCycle(body, g, style, n);
            // The left foot's swing: where its ankle is along the way, and the fastest it goes.
            const first = cycle.findIndex((f) => !f.stance[0]);
            const keys = cycle.filter((f) => !f.stance[0]).length;
            const z = (k: number) => cycle[k].ankles[0][2];
            let fastest = 0;
            for (let k = first; k + 1 < first + keys; k++) fastest = Math.max(fastest, ((cycle[k + 1].ankles[0][2] - cycle[k].ankles[0][2]) * n) / g.stride);
            return { start: z(first), quarter: z(first + Math.round(0.25 * keys)), end: cycle[first + keys - 1].ankles[0][2], fastest };
        };
        const drawn = swingOf(1), left = swingOf(0);
        // Both leave from the same place and land in the same place.
        expect(drawn.start).toBeCloseTo(left.start, 3);
        expect(drawn.end).toBeCloseTo(left.end, 2);
        // Drawn through, the ankle is well on its way a quarter into the swing; left behind, it has to be thrown on faster later.
        expect(drawn.quarter).toBeGreaterThan(left.quarter + 0.01);
        expect(drawn.fastest).toBeLessThan(left.fastest);
    });

    it('hands the swing on down the arm: late after the leg, the elbow held bent, the hand carried past the forearm, round a loop', () => {
        const n = 240;
        // The left arm over a cycle: which way its upper arm, forearm and hand point (they lie along +X in the reference pose).
        const armOf = (over: Partial<GaitMode>) => {
            const style = { ...GAIT_STYLE, walk: { ...GAIT_STYLE.walk, ...over } };
            return gaitCycle(body, gaitFor(body, 1.3, style), style, n).map((f) => ({
                upper: rot(f.world.leftUpperArm, [1, 0, 0]), fore: rot(f.world.leftLowerArm, [1, 0, 0]), hand: rot(f.world.leftHand, [1, 0, 0]),
            }));
        };
        const most = (v: number[]) => v.indexOf(Math.max(...v));
        const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const arm = armOf({});
        const front = most(arm.map((a) => a.upper[2]));
        // The left arm is farthest forward a little after the right heel strikes (half a stride in), not with it.
        expect(front / n).toBeGreaterThan(0.505);
        expect(front / n).toBeLessThan(0.56);
        // The elbow is bent more than halfway for most of the cycle: held bent, let straight only briefly at the back.
        const held = (list: ReturnType<typeof armOf>) => {
            const bend = list.map((a) => Math.acos(Math.min(1, dot(a.upper, a.fore))));
            const middle = (Math.max(...bend) + Math.min(...bend)) / 2;
            return bend.filter((b) => b > middle).length / n;
        };
        expect(held(arm)).toBeGreaterThan(0.54);
        // A pumping elbow (a pulse as the arm comes forward) is the other way about.
        expect(held(armOf({ elbowSnap: 2 }))).toBeLessThan(0.42);
        // The hand is carried on past the forearm at each end of the swing: it sweeps further forward and further back.
        const handZ = arm.map((a) => a.hand[2]), foreZ = arm.map((a) => a.fore[2]);
        expect(Math.max(...handZ)).toBeGreaterThan(Math.max(...foreZ) + 0.015);
        expect(Math.min(...handZ)).toBeLessThan(Math.min(...foreZ) - 0.015);
        // With neither the carry nor the wait, the hand is in line with the forearm all the way.
        for (const a of armOf({ wristFlick: 0, wristLag: 0 })) expect(dot(a.hand, a.fore)).toBeGreaterThan(1 - 1e-9);
        // Round a loop: in the middle of its swing the arm is further out to its side going forward than coming back.
        const loop = (list: ReturnType<typeof armOf>) => {
            const z = list.map((a) => a.upper[2]);
            const middle = (Math.max(...z) + Math.min(...z)) / 2;
            let going = 0, coming = 0;
            for (let k = 0; k < n; k++) {
                const next = z[(k + 1) % n];
                if (z[k] <= middle && next > middle) going = k;
                if (z[k] >= middle && next < middle) coming = k;
            }
            return list[going].upper[0] - list[coming].upper[0];
        };
        expect(loop(arm)).toBeGreaterThan(0.04);
        expect(Math.abs(loop(armOf({ armLoop: 0 })))).toBeLessThan(0.01);
    });

    it('shifts its weight onto the landing foot faster than it drifts back', () => {
        const n = 240;
        // The hips' way to the side over a cycle, about its mean: toward the left as the left foot takes the weight.
        const x = gaitCycle(body, walk, GAIT_STYLE, n).map((f) => f.hips[0]);
        const mean = x.reduce((a, b) => a + b, 0) / n;
        let crossing = 0;
        for (let k = 0; k < n; k++) if (x[(k + n - 1) % n] <= mean && x[k] > mean) crossing = k;
        const top = x.indexOf(Math.max(...x));
        // From the middle to farthest over the foot in less than a quarter of the stride: it comes back in what is left of the half.
        const rise = ((top - crossing + n) % n) / n;
        expect(rise).toBeGreaterThan(0.1);
        expect(rise).toBeLessThan(0.23);
    });

    it('keeps its chest over the line while its hips sway under it, the spine leaning to join them', () => {
        const n = 120;
        const canon = canonicalSkeleton(sk, body);
        // Where the hips and the top of the spine are to the side over a cycle, and the chest's turn.
        const sideOf = (style: typeof GAIT_STYLE) => {
            const g = gaitFor(body, 1.3, style);
            const cycle = gaitCycle(body, g, style, n);
            const clip = framesToClip(canon, body, cycle, g.stride, 'walk');
            const at = cycle.map((_, k) => places(canon.bones, clip, k));
            return { g, cycle, hips: at.map((P) => P[canon.index.hips][0]), top: at.map((P) => P[canon.index.chest][0]) };
        };
        const half = (v: number[]) => (Math.max(...v) - Math.min(...v)) / 2;
        const kept = sideOf(GAIT_STYLE);
        const { chestSway: _, ...plainWalk } = GAIT_STYLE.walk;
        const plain = sideOf({ ...GAIT_STYLE, walk: plainWalk });
        // The hips sway a centimetre and more each way; the top of the spine a fifth of that at most, and exactly as far as it is asked.
        expect(half(kept.hips)).toBeGreaterThan(0.01);
        expect(half(kept.top)).toBeLessThan(0.2 * half(kept.hips));
        const sway = GAIT_STYLE.walk.chestSway!;
        kept.top.forEach((x, k) => expect(x).toBeCloseTo(sway.size * body.hipHeight * wave(k / n, sway.at, sway.third), 4));
        // Left to an evenly shared spine, the chest goes to and fro with the hips.
        expect(half(plain.top)).toBeGreaterThan(2 * half(kept.top));
        // Only the bones between lean: the pelvis and the chest turn as they did.
        for (const k of [0, 17, 44, 90]) {
            for (const role of ['hips', 'chest'] as const) {
                const a = kept.cycle[k].world[role], b = plain.cycle[k].world[role];
                expect(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])).toBeCloseTo(1, 10);
            }
        }
    });

    it('turns both legs about the upright together, and the toes of a foot in the air out and back', () => {
        const n = 120;
        // Which way a bone's side axis points, seen from above: degrees to the left of straight across.
        const heading = (q: Quat) => { const l = rot(q, [1, 0, 0]); return (Math.atan2(-l[2], l[0]) * 180) / Math.PI; };
        const cycle = gaitCycle(body, walk, GAIT_STYLE, n);
        const still = { ...GAIT_STYLE, walk: { ...GAIT_STYLE.walk, legTurn: { size: 0, at: 0.5 }, swingTurn: [0, 0.5] as [number, number] } };
        const straight = gaitCycle(body, gaitFor(body, 1.3, still), still, n);
        const toeOut = (walk.toeOut * 180) / Math.PI;
        // As the left heel strikes (key 0) both knees are turned to the right: the left one, ahead, toward the other leg; the right one away.
        // Half a stride on, both to the left.
        for (const leg of ['leftUpperLeg', 'rightUpperLeg'] as const) {
            expect(heading(cycle[0].world[leg])).toBeLessThan(-2);
            expect(heading(cycle[n / 2].world[leg])).toBeGreaterThan(2);
        }
        // With no turn asked the knees face the way their feet do, all the way round.
        for (const f of straight) {
            expect(heading(f.world.leftUpperLeg)).toBeCloseTo(toeOut, 6);
            expect(heading(f.world.rightUpperLeg)).toBeCloseTo(-toeOut, 6);
        }
        // Turning the legs moves no foot: the ankles are where they were, and the legs still reach.
        cycle.forEach((f, k) => {
            for (let i = 0; i < 2; i++) expect(far(f.ankles[i], straight[k].ankles[i])).toBeLessThan(1e-12);
            expect(Math.max(...f.short)).toBe(0);
        });
        // A standing foot keeps its heading; in the air its toes turn out and back, and it lands at its heading.
        const first = cycle.findIndex((f) => !f.stance[0]), keys = n - first;
        const [turn, when] = GAIT_STYLE.walk.swingTurn;
        for (let k = 0; k < first; k++) expect(heading(cycle[k].world.leftFoot)).toBeCloseTo(toeOut, 6);
        expect(heading(cycle[first + Math.round(when * keys)].world.leftFoot)).toBeGreaterThan(toeOut + 0.9 * turn);
        for (let k = first; k < n; k++) expect(heading(cycle[k].world.leftFoot)).toBeGreaterThan(toeOut - 0.5);
        expect(heading(cycle[n - 1].world.leftFoot)).toBeLessThan(toeOut + 0.2 * turn);
    });

    it('nods and tilts its head on its own, and leans its neck to keep the head over the line', () => {
        const n = 120;
        const canon = canonicalSkeleton(sk, body);
        const walkWith = (mode: GaitMode) => {
            const style = { ...GAIT_STYLE, walk: mode };
            const g = gaitFor(body, 1.3, style);
            const cycle = gaitCycle(body, g, style, n);
            const clip = framesToClip(canon, body, cycle, g.stride, 'walk');
            return { cycle, head: cycle.map((_, k) => places(canon.bones, clip, k)[canon.index.head][0]) };
        };
        // How far the head is tipped forward and to the side (left side up), degrees.
        const forward = (q: Quat) => (-Math.asin(rot(q, [0, 0, 1])[1]) * 180) / Math.PI;
        const sideways = (q: Quat) => (Math.asin(rot(q, [1, 0, 0])[1]) * 180) / Math.PI;
        const range = (v: number[]) => Math.max(...v) - Math.min(...v);
        const own = walkWith(GAIT_STYLE.walk), still = walkWith({ ...GAIT_STYLE.walk, headNod: [0, 0], headTilt: [0, 0] });
        // It nods a degree and more each way, twice a stride: forward most about when the style says, and the same half a stride on.
        const nod = own.cycle.map((f) => forward(f.world.head));
        expect(range(nod)).toBeGreaterThan(2);
        expect(range(still.cycle.map((f) => forward(f.world.head)))).toBeLessThan(0.6 * range(nod));
        const most = nod.indexOf(Math.max(...nod)) / n;
        expect(Math.min(Math.abs(most - 0.26), Math.abs(most - 0.76))).toBeLessThan(0.06);
        for (let k = 0; k < n / 2; k++) expect(nod[k + n / 2]).toBeCloseTo(nod[k], 3);
        // It tilts once a stride, its left side highest when the style says.
        const tilt = own.cycle.map((f) => sideways(f.world.head));
        expect(range(tilt)).toBeGreaterThan(1.5 * GAIT_STYLE.walk.headTilt[0]);
        expect(Math.abs(tilt.indexOf(Math.max(...tilt)) / n - GAIT_STYLE.walk.headTilt[1])).toBeLessThan(0.03);
        expect(range(still.cycle.map((f) => sideways(f.world.head)))).toBeLessThan(0.2);
        // The head's joint is where it is asked to be to the side: the neck leans to put it there.
        const sway = GAIT_STYLE.walk.headSway!;
        own.head.forEach((x, k) => expect(x).toBeCloseTo(sway.size * body.hipHeight * wave(k / n, sway.at, sway.third), 4));
        const { headSway: _, ...unkept } = GAIT_STYLE.walk;
        const loose = walkWith(unkept);
        expect(Math.max(...own.head.map((x, k) => Math.abs(x - loose.head[k])))).toBeGreaterThan(3e-4);
        // Only the neck leans for that: the head's own turn is the same either way.
        for (const k of [0, 23, 61, 97]) {
            const a = own.cycle[k].world.head, b = loose.cycle[k].world.head;
            expect(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])).toBeCloseTo(1, 10);
        }
        const leaned = Math.max(...own.cycle.map((f, k) => {
            const c = f.world.neck, d = loose.cycle[k].world.neck;
            return 2 * Math.acos(Math.min(1, Math.abs(c[0] * d[0] + c[1] * d[1] + c[2] * d[2] + c[3] * d[3])));
        }));
        expect(leaned).toBeGreaterThan((0.2 * Math.PI) / 180);
    });

    it('asks the body what its joints can do', () => {
        const toesUp = (q: Quat) => Math.asin(rot(q, [0, 0, 1])[1]);
        // When the left heel has risen by a degree, as a share of the stride.
        const heelOff = (ankleUp: number) => {
            const b = measureBody(sk, { roles: rolesOf(sk), joints: { ankleUp } });
            const cycle = gaitCycle(b, gaitFor(b, 1.3), GAIT_STYLE, 200);
            return cycle.findIndex((f, k) => k > 20 && toesUp(f.world.leftFoot) < -Math.PI / 180) / 200;
        };
        // An ankle that bends further keeps the heel down longer.
        expect(heelOff(28)).toBeGreaterThan(heelOff(10) + 0.03);
        // A foot in the air hangs from a relaxed ankle: toes further down for an ankle that rests further down.
        const lowest = (ankleRest: number) => {
            const b = measureBody(sk, { roles: rolesOf(sk), joints: { ankleRest } });
            return Math.min(...gaitCycle(b, gaitFor(b, 1.3), GAIT_STYLE, 100).map((f) => toesUp(f.world.leftFoot)));
        };
        expect(lowest(35)).toBeLessThan(lowest(5) - (10 * Math.PI) / 180);
    });

    it('puts the model\'s ankles where the formulas put them', () => {
        const canon = canonicalSkeleton(sk, body);
        const clip = framesToClip(canon, body, frames, walk.stride, 'walk');
        const onto = clipOntoModel({ skeleton: sk, clips: [] }, body, canon, clip).clip;
        const roles = rolesOf(sk);
        for (const k of [0, 7, 22, 41, 59]) {
            const P = places(sk, onto, k);
            for (let i = 0; i < 2; i++) {
                const ankle = P[roles[i ? 'rightFoot' : 'leftFoot']];
                // The clip stays in place: the travel goes back on.
                expect(far([ankle[0], ankle[1], ankle[2] + frames[k].travel], frames[k].ankles[i])).toBeLessThan(1e-5);
            }
        }
        // It closes on itself.
        const first = places(sk, onto, 0), last = places(sk, onto, frames.length);
        for (const i of Object.values(roles)) expect(far(first[i], last[i])).toBeLessThan(1e-5);
    });
});

describe('turning on the spot', () => {
    const sk = human();
    const roles = rolesOf(sk);
    const body = measureBody(sk, { roles });
    const D = Math.PI / 180;
    const H = body.hipHeight;
    const flat = (v: Vec3): [number, number] => [v[0], v[2]];
    /** A point turned about another by an angle about the upright (positive to the left: +Z toward +X). */
    const about = (v: Vec3, pivot: Vec3, a: number): Vec3 => {
        const x = v[0] - pivot[0], z = v[2] - pivot[2];
        return [pivot[0] + x * Math.cos(a) + z * Math.sin(a), v[1], pivot[2] + z * Math.cos(a) - x * Math.sin(a)];
    };
    const spin = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    /** Which way a role faces, seen from above, radians to the left of forward; continuous over the frames. */
    const facings = (frames: GaitFrame[], role: string) => {
        const out = frames.map((f) => { const v = rot(f.world[role] as Quat, [0, 0, 1]); return Math.atan2(v[0], v[2]); });
        for (let k = 1; k < out.length; k++) { while (out[k] - out[k - 1] > Math.PI) out[k] -= 2 * Math.PI; while (out[k] - out[k - 1] < -Math.PI) out[k] += 2 * Math.PI; }
        return out;
    };
    const turn = (deg: number, toLeft = deg >= 0, style = TURN_STYLE) => { const plan = turnFor(body, deg * D, style, toLeft); return { plan, frames: turnFrames(body, plan, style) }; };

    it('ends in the stance it began in, turned by the angle', () => {
        const stand = standFrame(body);
        for (const [deg, toLeft] of [[180, true], [90, true], [45, true], [0, true], [0, false], [-30, false], [-90, false], [-180, false]] as const) {
            const { plan, frames } = turn(deg, toLeft);
            const first = frames[0], last = frames[frames.length - 1];
            expect(last.time).toBeCloseTo(TURN_STYLE.seconds, 9);
            // It starts standing.
            expect(far(first.hips, stand.hips)).toBeLessThan(1e-9);
            for (const r of Object.keys(stand.world)) expect(apart(first.world[r] as Quat, stand.world[r] as Quat)).toBeLessThan(1e-7);
            // And ends standing the same way, about the point under its hips.
            expect(far(last.hips, about(first.hips, plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            for (let i = 0; i < 2; i++) expect(far(last.ankles[i], about(first.ankles[i], plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            for (const r of Object.keys(first.world)) expect(apart(last.world[r] as Quat, qmul(spin(deg * D), first.world[r] as Quat))).toBeLessThan(1e-6);
        }
    });

    it('takes three steps, the near foot, the far foot, the near foot, and never has both feet up', () => {
        for (const [deg, near] of [[90, 0], [-90, 1], [180, 0], [-180, 1]] as const) {
            const { plan, frames } = turn(deg);
            expect(plan.steps.map((s) => s.foot)).toEqual([near, 1 - near, near]);
            // The far foot goes straight to where it will stand; the near foot gets there with its second step.
            expect(far(plan.steps[1].to.at as Vec3, about(plan.start[1 - near].at as Vec3, plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            expect(far(plan.steps[2].to.at as Vec3, about(plan.start[near].at as Vec3, plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            // Its first step turns it about half the way.
            const opened = Math.abs(plan.steps[0].to.heading - plan.steps[0].from.heading) / Math.abs(deg * D);
            expect(opened).toBeGreaterThan(0.4);
            expect(opened).toBeLessThan(0.6);
            const standing = body.floor + body.ankleHeight;
            for (const f of frames) expect(Math.min(f.ankles[0][1], f.ankles[1][1])).toBeLessThan(standing + 0.004);
            // The foot that swings round goes higher than the one that opens and closes.
            expect(plan.steps[1].rise).toBeGreaterThan(plan.steps[0].rise);
        }
        // And higher the further it goes.
        expect(turn(180).plan.steps[1].rise).toBeGreaterThan(turn(90).plan.steps[1].rise * 1.5);
    });

    it('keeps a planted foot where it is, flat on the floor', () => {
        for (const deg of [135, -135]) {
            const { frames } = turn(deg);
            for (let k = 1; k < frames.length; k++) for (let i = 0; i < 2; i++) {
                if (!frames[k].stance[i] || !frames[k - 1].stance[i]) continue;
                expect(far(frames[k].ankles[i], frames[k - 1].ankles[i])).toBeLessThan(1e-9);
                const foot = i ? 'rightFoot' : 'leftFoot';
                expect(apart(frames[k].world[foot] as Quat, frames[k - 1].world[foot] as Quat)).toBeLessThan(1e-7);
                expect(frames[k].ankles[i][1]).toBeCloseTo(body.floor + body.ankleHeight, 9);
                // Flat: its own up is the world's.
                expect(rot(frames[k].world[foot] as Quat, [0, 1, 0])[1]).toBeGreaterThan(1 - 1e-12);
            }
            for (const f of frames) for (let i = 0; i < 2; i++) expect(f.short[i]).toBe(0);
        }
    });

    it('lifts a stepping foot by its heel, its toes left near the floor', () => {
        const { plan, frames } = turn(180);
        const swing = plan.steps[1];
        const k = frames.findIndex((f) => f.time >= (swing.lift + swing.land) / 2);
        const foot = swing.foot ? 'rightFoot' : 'leftFoot';
        // Toes down: the foot's own forward points below the level.
        const toe = rot(frames[k].world[foot] as Quat, [0, 0, 1]);
        expect(toe[1]).toBeLessThan(-0.2);
        // The tip of the sole is still within a few centimetres of the floor while the ankle is well up.
        const rise = frames[k].ankles[swing.foot][1] - (body.floor + body.ankleHeight);
        expect(rise).toBeGreaterThan(0.04);
        const tip = frames[k].ankles[swing.foot][1] + rot(frames[k].world[foot] as Quat, [0, -body.ankleHeight, body.sole.tip])[1] - body.floor;
        expect(tip).toBeGreaterThan(-1e-6);
        expect(tip).toBeLessThan(0.03);
    });

    it('looks first: the head leads the chest, the chest the pelvis, and all arrive', () => {
        for (const deg of [90, -90, 180]) {
            const { frames } = turn(deg);
            const sign = Math.sign(deg);
            const head = facings(frames, 'head'), chest = facings(frames, 'chest'), hips = facings(frames, 'hips');
            const turned = (v: number[], k: number) => (sign * (v[k] - v[0])) / Math.abs(deg * D);
            const early = frames.findIndex((f) => f.time >= 0.45);
            expect(turned(head, early)).toBeGreaterThan(turned(chest, early) + 0.15);
            expect(turned(chest, early)).toBeGreaterThan(turned(hips, early));
            // By then the head has gone about half the way and the pelvis less than a quarter.
            expect(turned(head, early)).toBeGreaterThan(0.45);
            expect(turned(hips, early)).toBeLessThan(0.25);
            const end = frames.length - 1;
            for (const v of [head, chest, hips]) expect(turned(v, end)).toBeCloseTo(1, 6);
        }
        // To the left the trunk swings past and comes back with the last step; to the right it does not.
        const most = (deg: number, role: string) => { const { frames } = turn(deg); const v = facings(frames, role); return Math.max(...v.map((x) => (Math.sign(deg) * (x - v[0])) / Math.abs(deg * D))); };
        expect(most(90, 'hips')).toBeGreaterThan(1.04);
        expect(most(90, 'chest')).toBeGreaterThan(most(90, 'hips'));
        expect(most(90, 'head')).toBeLessThan(most(90, 'hips'));
        expect(most(-90, 'hips')).toBeLessThan(1.005);
    });

    it('tilts its head as it turns it far: the head turns about an axis that leans', () => {
        const tilt = (deg: number) => { const { frames } = turn(deg); return Math.max(...frames.map((f) => Math.abs(Math.asin(rot(f.world.head as Quat, [1, 0, 0])[1])))); };
        expect(tilt(180)).toBeGreaterThan(4 * D);
        expect(tilt(180)).toBeGreaterThan(tilt(90) * 1.5);
        // With an upright axis, an upright stance and no bow it does not tilt.
        const upright: TurnStyle = { ...TURN_STYLE, left: { ...TURN_STYLE.left, headAxis: 0, nod: [[0, 0.8, 0, 0], [0.5, 2, 0, 0]] }, stance: { ...TURN_STYLE.stance, lean: [0, 0, 0] } };
        const { frames } = turn(180, true, upright);
        expect(Math.max(...frames.map((f) => Math.abs(Math.asin(rot(f.world.head as Quat, [1, 0, 0])[1]))))).toBeLessThan(1e-6);
    });

    it('carries its weight toward the foot it stands on', () => {
        const { plan, frames } = turn(90);
        for (const s of plan.steps) {
            const k = frames.findIndex((f) => f.time >= (s.lift + s.land) / 2);
            const other = 1 - s.foot;
            const hips = flat(frames[k].hips), standing = flat(frames[k].ankles[other]), swinging = flat(frames[k].ankles[s.foot]);
            expect(Math.hypot(hips[0] - standing[0], hips[1] - standing[1])).toBeLessThan(Math.hypot(hips[0] - swinging[0], hips[1] - swinging[1]));
        }
        // It stays about where it stands: the hips never go far from the point it turns about.
        for (const deg of [180, -180]) {
            const t = turn(deg);
            for (const f of t.frames) expect(Math.hypot(f.hips[0] - t.plan.pivot[0], f.hips[2] - t.plan.pivot[2])).toBeLessThan(0.22 * H);
        }
        // With no shift (and no bow to balance) the hips stay nearer the middle between the feet.
        const still: TurnStyle = { ...TURN_STYLE, counter: 0, left: { ...TURN_STYLE.left, shift: [0, 0, 0] } };
        const a = turn(90, true, still).frames, b = turn(90).frames;
        const k = a.findIndex((f) => f.time >= 0.9);
        const mid = (f: GaitFrame) => [(f.ankles[0][0] + f.ankles[1][0]) / 2, (f.ankles[0][2] + f.ankles[1][2]) / 2];
        const off = (f: GaitFrame) => Math.hypot(f.hips[0] - mid(f)[0], f.hips[2] - mid(f)[1]);
        expect(off(a[k])).toBeLessThan(off(b[k]));
    });

    it('swings each arm forward with the step of the other side', () => {
        const { plan, frames } = turn(90);
        // How far forward of the chest's own down an upper arm points.
        const fore = (f: GaitFrame, side: 'left' | 'right') => {
            const v = rot(f.world[`${side}UpperArm`] as Quat, [side === 'left' ? 1 : -1, 0, 0]);
            const c = f.world.chest as Quat, inv: Quat = [-c[0], -c[1], -c[2], c[3]];
            const u = rot(inv, v);
            return Math.atan2(u[2], -u[1]);
        };
        const at = (time: number) => frames[frames.findIndex((f) => f.time >= time)];
        const rest = { left: fore(frames[0], 'left'), right: fore(frames[0], 'right') };
        // The left foot steps first: the right arm comes forward, the left goes back a little.
        const first = at((plan.steps[0].lift + plan.steps[0].land) / 2);
        expect(fore(first, 'right')).toBeGreaterThan(rest.right + 2 * D);
        expect(fore(first, 'left')).toBeLessThan(rest.left);
        // Then the right foot swings round: the left arm comes forward, further (its foot turns further).
        const second = at(plan.steps[1].land);
        expect(fore(second, 'left')).toBeGreaterThan(rest.left + 4 * D);
        expect(fore(second, 'left') - rest.left).toBeGreaterThan(fore(first, 'right') - rest.right);
    });

    it('moves without a jolt', () => {
        for (const deg of [180, -180, 60]) {
            const { frames } = turn(deg);
            const dt = frames[1].time - frames[0].time;
            let accel = 0, most = 0;
            for (let k = 1; k + 1 < frames.length; k++) {
                const a = frames[k - 1].hips, b = frames[k].hips, c = frames[k + 1].hips;
                accel = Math.max(accel, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2]) / (dt * dt));
            }
            for (let k = 1; k < frames.length; k++) for (const r of Object.keys(frames[k].world)) most = Math.max(most, apart(frames[k].world[r] as Quat, frames[k - 1].world[r] as Quat));
            expect(accel).toBeLessThan(8 * H);
            expect(most).toBeLessThan(12 * D);
            // The feet keep clear of each other.
            expect(Math.min(...frames.map((f) => far(f.ankles[0], f.ankles[1])))).toBeGreaterThan(0.1 * H);
        }
    });

    it('takes the same pose on a body of another size', () => {
        const big = human(1.4);
        const bigBody = measureBody(big, { roles: rolesOf(big) });
        const a = turnFrames(body, turnFor(body, 2)), b = turnFrames(bigBody, turnFor(bigBody, 2));
        for (const k of [0, 30, 61, 97, 150]) {
            for (const r of Object.keys(a[k].world)) expect(apart(a[k].world[r] as Quat, b[k].world[r] as Quat)).toBeLessThan(1e-6);
            expect(far(b[k].hips, [a[k].hips[0] * 1.4, a[k].hips[1] * 1.4, a[k].hips[2] * 1.4])).toBeLessThan(1e-6);
        }
    });

    it('turns to the right as in a mirror, where its stance and its numbers are the same to both sides', () => {
        const even: TurnStyle = {
            ...TURN_STYLE, right: TURN_STYLE.left,
            stance: { ...TURN_STYLE.stance, feet: [TURN_STYLE.stance.feet[0], TURN_STYLE.stance.feet[0]], facing: [0, 0, 0], list: 0, arms: [TURN_STYLE.stance.arms[0], TURN_STYLE.stance.arms[0]] },
        };
        const l = turn(120, true, even).frames, r = turn(-120, false, even).frames;
        const mirror = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];
        const other = (role: string) => (role.startsWith('left') ? `right${role.slice(4)}` : role.startsWith('right') ? `left${role.slice(5)}` : role);
        for (const k of [0, 20, 45, 80, 110, 150]) {
            expect(far(r[k].hips, [-l[k].hips[0], l[k].hips[1], l[k].hips[2]])).toBeLessThan(1e-9);
            for (const role of Object.keys(l[k].world)) expect(apart(r[k].world[other(role)] as Quat, mirror(l[k].world[role] as Quat))).toBeLessThan(1e-6);
            expect(far(r[k].ankles[1], [-l[k].ankles[0][0], l[k].ankles[0][1], l[k].ankles[0][2]])).toBeLessThan(1e-9);
        }
    });

    it('puts the joints of the model where the formulas put them, a key a frame', () => {
        const { frames } = turn(-90);
        const canon = canonicalSkeleton(sk, body);
        const clip = framesToClipOnce(canon, frames, 'turn');
        const onto = clipOntoModel({ skeleton: sk, clips: [] }, body, canon, clip).clip;
        expect(onto.tracks[0].times.length).toBe(frames.length);
        expect(onto.tracks[0].times[frames.length - 1]).toBeCloseTo(TURN_STYLE.seconds, 6);
        for (const k of [0, 33, 75, 120, frames.length - 1]) {
            const P = places(sk, onto, k);
            expect(far(P[roles.hips], frames[k].hips)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(P[roles[i ? 'rightFoot' : 'leftFoot']], frames[k].ankles[i])).toBeLessThan(1e-5);
        }
    });
});

describe('starting to walk', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const speed = 1.3;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    const spin = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
    const about = (v: Vec3, pivot: Vec3, a: number): Vec3 => {
        const x = v[0] - pivot[0], z = v[2] - pivot[2];
        return [pivot[0] + x * Math.cos(a) + z * Math.sin(a), v[1], pivot[2] + z * Math.cos(a) - x * Math.sin(a)];
    };
    const start = (deg: number, toLeft = deg >= 0, seconds = 1.7, style = START_STYLE, turn = TURN_STYLE) => walkStart(body, speed, deg * D, toLeft, seconds, style, GAIT_STYLE, turn);

    it('begins in its stance, facing away from its way by the angle', () => {
        const stand = standFrame(body);
        for (const [deg, toLeft] of [[0, true], [0, false], [90, true], [-90, false], [180, true], [-135, false]] as const) {
            const first = start(deg, toLeft).frames[0];
            expect(far(first.hips, stand.hips)).toBeLessThan(1e-9);
            for (let i = 0; i < 2; i++) expect(far(first.ankles[i], about(stand.ankles[i], [0, 0, 0], -deg * D))).toBeLessThan(1e-9);
            for (const r of Object.keys(stand.world)) expect(apart(first.world[r] as Quat, qmul(spin(-deg * D), stand.world[r] as Quat))).toBeLessThan(1e-6);
        }
    });

    it('is the walk itself once it is up to speed and turned', () => {
        for (const deg of [0, 120, -60]) {
            const { plan, frames } = start(deg, deg >= 0, 3.4);
            const walk = gaitPoser(body, plan.gait);
            let checked = 0;
            for (const f of frames) {
                if (f.time < 2.4) continue;
                const w = walk(plan.phase(f.time) * plan.gait.stride);
                // The walk's pose, where the body is on its way.
                const hips: Vec3 = [w.hips[0], w.hips[1], w.hips[2] - w.travel + plan.travelled(f.time)];
                expect(far(f.hips, hips)).toBeLessThan(1e-9);
                for (const r of Object.keys(w.world)) expect(apart(f.world[r] as Quat, w.world[r] as Quat)).toBeLessThan(1e-5);
                for (let i = 0; i < 2; i++) expect(far(f.ankles[i], [w.ankles[i][0], w.ankles[i][1], w.ankles[i][2] - w.travel + plan.travelled(f.time)])).toBeLessThan(1e-6);
                checked++;
            }
            expect(checked).toBeGreaterThan(40);
            // By then it travels as fast as the walk.
            const a = frames[frames.length - 31], b = frames[frames.length - 1];
            expect((b.hips[2] - a.hips[2]) / (b.time - a.time)).toBeCloseTo(plan.gait.speed, 1);
        }
    });

    it('takes its first step with the foot of the side it turns to, and is soon up to speed', () => {
        for (const [deg, toLeft, near] of [[0, true, 0], [0, false, 1], [90, true, 0], [-180, false, 1]] as const) {
            const { plan, frames } = start(deg, toLeft);
            // That foot is in the air from the first instant; the other still stands.
            expect(frames[2].stance[near]).toBe(false);
            expect(frames[2].stance[1 - near]).toBe(true);
            // It lands ahead on the way, about a step from where the body stood, within half a second or so.
            const first = plan.holds[near][1];
            expect(first.on).toBeGreaterThan(0.2);
            expect(first.on).toBeLessThan(0.6);
            expect(first.stand.at[2]).toBeGreaterThan(0.6 * plan.gait.step);
            expect(first.stand.at[2]).toBeLessThan(1.2 * plan.gait.step);
            // Up to speed within the style's time: after it, the body covers the ground at the walk's speed.
            const t0 = START_STYLE.accel + 0.02;
            expect((plan.travelled(t0 + 0.5) - plan.travelled(t0)) / 0.5).toBeCloseTo(plan.gait.speed, 6);
            expect(plan.travelled(0)).toBe(0);
        }
    });

    it('turns to the way it goes within a second, the foot that stays swivelling and then shuffling round', () => {
        const { plan, frames } = start(180);
        const facing = (f: GaitFrame) => { const v = rot(f.world.chest as Quat, [0, 0, 1]); return Math.atan2(v[0], v[2]); };
        // Facing backward as it begins, along its way by the end of the turn.
        expect(Math.abs(Math.abs(facing(frames[0])) - Math.PI)).toBeLessThan(8 * D);
        const after = frames.find((f) => f.time >= START_STYLE.turn[0] + 0.05)!;
        expect(Math.abs(facing(after))).toBeLessThan(12 * D);
        expect(plan.facing(0)).toBeCloseTo(-Math.PI, 9);
        expect(plan.facing(START_STYLE.turn[0])).toBeCloseTo(0, 6);
        // The right foot stays at first, turning where it stands, and leaves well before the walk's own foot would.
        const stay = plan.holds[1][0];
        expect(stay.swivel!(0.1)).toBeGreaterThan(0);
        const straight = start(0).plan.holds[1][0];
        expect(frames.findIndex((f) => !f.stance[1]) / 60).toBeLessThan(straight.off - 0.1);
        // Its first footfall is stepped onto with less of the walk's swing.
        expect(plan.holds[1][1].soft![1]).toBeLessThan(0.6);
        expect(start(0).plan.holds[1][1].soft).toBeUndefined();
    });

    it('keeps its feet on the floor: a flat foot does not move, no standing leg is stretched, no sole goes under', () => {
        const roll = soleRoll(body);
        for (const deg of [0, 90, -90, 180, -135]) {
            const { frames } = start(deg);
            for (let k = 0; k < frames.length; k++) {
                for (let i = 0; i < 2; i++) {
                    const f = frames[k], foot = i ? 'rightFoot' : 'leftFoot';
                    if (f.stance[i]) expect(f.short[i]).toBe(0);
                    const level = (g: GaitFrame) => Math.abs(rot(g.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
                    if (k && f.stance[i] && frames[k - 1].stance[i] && level(f) && level(frames[k - 1])) expect(far(f.ankles[i], frames[k - 1].ankles[i])).toBeLessThan(1e-9);
                    // Every point of the sole over the floor (the foot's own forward and up, turned as the foot is).
                    for (const [o, z] of roll.points) {
                        const p = rot(f.world[foot] as Quat, [0, z - body.ankleHeight, o]);
                        expect(f.ankles[i][1] + p[1] - body.floor).toBeGreaterThan(-1e-6);
                    }
                }
            }
        }
    });

    it('lets the heel of the foot it leaves behind rise, the knee kept bent', () => {
        const { frames } = start(0);
        // The right foot stays as the left steps: before it leaves, its heel is up and its knee is not locked.
        const lift = frames.findIndex((f) => !f.stance[1]);
        const before = frames[lift - 1];
        expect(rot(before.world.rightFoot as Quat, [0, 0, 1])[1]).toBeLessThan(-0.15);
        expect(before.knees[1]).toBeGreaterThan(8 * D);
    });

    it('starts to the right as in a mirror, where its stance is the same to both sides', () => {
        const even: TurnStyle = {
            ...TURN_STYLE,
            stance: { ...TURN_STYLE.stance, feet: [TURN_STYLE.stance.feet[0], TURN_STYLE.stance.feet[0]], facing: [0, 0, 0], list: 0, arms: [TURN_STYLE.stance.arms[0], TURN_STYLE.stance.arms[0]] },
        };
        const l = start(100, true, 1.7, START_STYLE, even).frames, r = start(-100, false, 1.7, START_STYLE, even).frames;
        const mirror = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];
        const other = (role: string) => (role.startsWith('left') ? `right${role.slice(4)}` : role.startsWith('right') ? `left${role.slice(5)}` : role);
        for (const k of [0, 9, 20, 33, 61, 100]) {
            expect(far(r[k].hips, [-l[k].hips[0], l[k].hips[1], l[k].hips[2]])).toBeLessThan(1e-9);
            for (const role of Object.keys(l[k].world)) expect(apart(r[k].world[other(role)] as Quat, mirror(l[k].world[role] as Quat))).toBeLessThan(1e-6);
            expect(far(r[k].ankles[1], [-l[k].ankles[0][0], l[k].ankles[0][1], l[k].ankles[0][2]])).toBeLessThan(1e-9);
        }
    });

    it('moves without a jolt', () => {
        const g = gaitFor(body, speed, GAIT_STYLE), walk = gaitPoser(body, g);
        let walkMost = 0;
        for (let k = 1; k <= 64; k++) { const a = walk((k - 1) / 60), b = walk(k / 60); for (const r of Object.keys(a.world)) walkMost = Math.max(walkMost, apart(a.world[r] as Quat, b.world[r] as Quat)); }
        for (const deg of [0, 90, 180, -135]) {
            const { frames } = start(deg);
            let most = 0;
            for (let k = 1; k < frames.length; k++) for (const r of Object.keys(frames[k].world)) most = Math.max(most, apart(frames[k].world[r] as Quat, frames[k - 1].world[r] as Quat));
            // No bone turns much further between two keys than in the walk itself (its foot slapping flat is its sharpest move).
            expect(most).toBeLessThan(walkMost + 3 * D);
            // The hips' speed never jumps: no key-to-key change of pace beyond what getting up to speed asks.
            const dt = frames[1].time - frames[0].time;
            let accel = 0;
            for (let k = 1; k + 1 < frames.length; k++) {
                const a = frames[k - 1].hips, b = frames[k].hips, c = frames[k + 1].hips;
                accel = Math.max(accel, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2]) / (dt * dt));
            }
            expect(accel).toBeLessThan((1.875 * speed * 1.4) / START_STYLE.accel);
        }
    });
});

describe('coming to a stand', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const speed = 1.3;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    const stop = (standing: number, turn = TURN_STYLE) => walkStop(body, speed, standing, 2.5, STOP_STYLE, GAIT_STYLE, turn);

    it('begins as the walk itself, one foot standing under the body and the other in the air', () => {
        for (const standing of [0, 1]) {
            const { plan, frames } = stop(standing);
            const walk = gaitPoser(body, plan.gait);
            expect(frames[0].stance[standing]).toBe(true);
            expect(frames[0].stance[1 - standing]).toBe(false);
            for (const f of frames) {
                if (f.time > Math.min(STOP_STYLE.blend[0], STOP_STYLE.brakeAt, STOP_STYLE.tuck[2]) - 0.02) break;
                const w = walk(plan.phase(f.time) * plan.gait.stride);
                expect(far(f.hips, [w.hips[0], w.hips[1], w.hips[2] - w.travel + plan.travelled(f.time)])).toBeLessThan(1e-9);
                for (const r of ['hips', 'chest', 'head', 'leftUpperArm', 'rightLowerArm']) expect(apart(f.world[r] as Quat, w.world[r] as Quat)).toBeLessThan(1e-5);
            }
            // At the first instant so are both feet; from then on the one in the air is aimed a little short, and the other stays where it stands.
            const w0 = walk(plan.phase(0) * plan.gait.stride);
            for (let i = 0; i < 2; i++) expect(far(frames[0].ankles[i], [w0.ankles[i][0], w0.ankles[i][1], w0.ankles[i][2] - w0.travel])).toBeLessThan(1e-6);
            // The hips are over the foot that stands, about.
            expect(Math.abs(frames[0].hips[2] - frames[0].ankles[standing][2])).toBeLessThan(0.08 * body.hipHeight);
        }
    });

    it('ends standing, having slowed to nothing', () => {
        const stand = standFrame(body);
        for (const standing of [0, 1]) {
            const { plan, frames } = stop(standing);
            const last = frames[frames.length - 1];
            const whole = plan.travelled(10);
            expect(whole).toBeCloseTo(plan.gait.speed * (STOP_STYLE.brakeAt + STOP_STYLE.brake / 2), 9);
            expect(far(last.hips, [stand.hips[0], stand.hips[1], stand.hips[2] + whole])).toBeLessThan(1e-9);
            for (let i = 0; i < 2; i++) expect(far(last.ankles[i], [stand.ankles[i][0], stand.ankles[i][1], stand.ankles[i][2] + whole])).toBeLessThan(1e-9);
            for (const r of Object.keys(stand.world)) expect(apart(last.world[r] as Quat, stand.world[r] as Quat)).toBeLessThan(1e-6);
            // Its pace only falls, to nothing.
            let before = Infinity;
            for (let k = 1; k < frames.length; k++) {
                const pace = (plan.travelled(frames[k].time) - plan.travelled(frames[k - 1].time)) * 60;
                expect(pace).toBeLessThan(before + 1e-9);
                expect(pace).toBeGreaterThan(-1e-9);
                before = pace;
            }
            expect(before).toBeLessThan(1e-9);
            // The walk's phase goes on to the last footfall and stays there.
            expect(plan.phase(STOP_STYLE.land + 0.5)).toBeCloseTo(1 + 0.5 * standing, 9);
            for (let k = 1; k < frames.length; k++) expect(plan.phase(frames[k].time)).toBeGreaterThan(plan.phase(frames[k - 1].time) - 1e-9);
        }
    });

    it('lands the foot in the air a little short, sets the other down where it will stand, then the first beside it', () => {
        for (const standing of [0, 1]) {
            const { plan, frames } = stop(standing);
            const other = 1 - standing;
            const [, first, beside] = plan.holds[other];
            const [, last] = plan.holds[standing];
            expect(first.on).toBeLessThan(last.on);
            expect(last.on).toBeLessThanOrEqual(first.off + 1e-9);
            expect(first.off).toBeLessThan(beside.on);
            // Short of the walk's own place, by a share of a step.
            expect(first.walk!.at[2] - first.stand.at[2]).toBeCloseTo(STOP_STYLE.short * plan.gait.step, 9);
            // The last places are those of the standing pose, where the body ends.
            const last2 = frames[frames.length - 1];
            expect(far([last.stand.at[0], last2.ankles[standing][1], last.stand.at[2]], last2.ankles[standing])).toBeLessThan(1e-9);
            expect(far([beside.stand.at[0], last2.ankles[other][1], beside.stand.at[2]], last2.ankles[other])).toBeLessThan(1e-9);
            // While the first foot is set beside the other the hips lean toward the foot that stands.
            const mid = frames[frames.findIndex((f) => f.time >= (first.off + beside.on) / 2)];
            const side = standing === 0 ? 1 : -1;
            expect(side * (mid.hips[0] - last2.hips[0])).toBeGreaterThan(0.02 * body.hipHeight);
            // Braking, the pelvis is tipped back and the chest is forward of it.
            const lean = (f: GaitFrame, role: string) => -Math.asin(rot(f.world[role] as Quat, [0, 0, 1])[1]);
            const braking = frames[frames.findIndex((f) => f.time >= 0.9)];
            expect(lean(braking, 'hips')).toBeLessThan(lean(last2, 'hips') - 2 * D);
            expect(lean(braking, 'chest') - lean(braking, 'hips')).toBeGreaterThan(lean(last2, 'chest') - lean(last2, 'hips') + 4 * D);
        }
    });

    it('keeps its feet on the floor, and one of them on it at all times', () => {
        const roll = soleRoll(body);
        for (const standing of [0, 1]) {
            const { frames } = stop(standing);
            for (let k = 0; k < frames.length; k++) {
                const f = frames[k];
                expect(f.stance[0] || f.stance[1]).toBe(true);
                for (let i = 0; i < 2; i++) {
                    const foot = i ? 'rightFoot' : 'leftFoot';
                    if (f.stance[i]) expect(f.short[i]).toBe(0);
                    const level = (g: GaitFrame) => Math.abs(rot(g.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
                    if (k && f.stance[i] && frames[k - 1].stance[i] && level(f) && level(frames[k - 1])) expect(far(f.ankles[i], frames[k - 1].ankles[i])).toBeLessThan(1e-9);
                    for (const [o, z] of roll.points) expect(f.ankles[i][1] + rot(f.world[foot] as Quat, [0, z - body.ankleHeight, o])[1] - body.floor).toBeGreaterThan(-1e-6);
                }
            }
        }
    });

    it('stops on the other foot as in a mirror, where its stance is the same to both sides', () => {
        const even: TurnStyle = {
            ...TURN_STYLE,
            stance: { ...TURN_STYLE.stance, feet: [TURN_STYLE.stance.feet[0], TURN_STYLE.stance.feet[0]], facing: [0, 0, 0], list: 0, arms: [TURN_STYLE.stance.arms[0], TURN_STYLE.stance.arms[0]] },
        };
        const l = stop(0, even).frames, r = stop(1, even).frames;
        const mirror = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];
        const other = (role: string) => (role.startsWith('left') ? `right${role.slice(4)}` : role.startsWith('right') ? `left${role.slice(5)}` : role);
        for (const k of [0, 12, 30, 55, 80, 110, l.length - 1]) {
            expect(far(r[k].hips, [-l[k].hips[0], l[k].hips[1], l[k].hips[2]])).toBeLessThan(1e-9);
            for (const role of Object.keys(l[k].world)) expect(apart(r[k].world[other(role)] as Quat, mirror(l[k].world[role] as Quat))).toBeLessThan(1e-6);
            expect(far(r[k].ankles[1], [-l[k].ankles[0][0], l[k].ankles[0][1], l[k].ankles[0][2]])).toBeLessThan(1e-9);
        }
    });

    it('moves without a jolt', () => {
        const g = gaitFor(body, speed, GAIT_STYLE), walk = gaitPoser(body, g);
        let walkMost = 0;
        for (let k = 1; k <= 64; k++) { const a = walk((k - 1) / 60), b = walk(k / 60); for (const r of Object.keys(a.world)) walkMost = Math.max(walkMost, apart(a.world[r] as Quat, b.world[r] as Quat)); }
        for (const standing of [0, 1]) {
            const { frames } = stop(standing);
            let most = 0, accel = 0;
            for (let k = 1; k < frames.length; k++) for (const r of Object.keys(frames[k].world)) most = Math.max(most, apart(frames[k].world[r] as Quat, frames[k - 1].world[r] as Quat));
            // (The last step is taken a little quicker than the walk's: its sharpest move, the toes coming back in line, with it.)
            expect(most).toBeLessThan(walkMost * 1.3);
            const dt = frames[1].time - frames[0].time;
            for (let k = 1; k + 1 < frames.length; k++) {
                const a = frames[k - 1].hips, b = frames[k].hips, c = frames[k + 1].hips;
                accel = Math.max(accel, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2]) / (dt * dt));
            }
            expect(accel).toBeLessThan(12);
        }
    });
});

describe('turning right about while walking', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const speed = 1.3;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    const half: Quat = [0, 1, 0, 0];
    const about = (v: Vec3): Vec3 => [-v[0], v[1], -v[2]];

    it('begins as the walk the other way, on the foot of the side it turns to, and ends as the walk this way', () => {
        for (const toLeft of [true, false]) {
            const near = toLeft ? 0 : 1;
            const { plan, frames } = walkPivot(body, speed, toLeft, 3.4);
            const walk = gaitPoser(body, plan.gait);
            // The first instant: the walk at the phase the style names, turned right about where it stands.
            const w0 = walk((0.5 * near + PIVOT_STYLE.from) * plan.gait.stride);
            const inPlace = (p: Vec3, w: { travel: number }): Vec3 => [p[0], p[1], p[2] - w.travel];
            expect(far(frames[0].hips, about(inPlace(w0.hips, w0)))).toBeLessThan(1e-9);
            for (const r of ['hips', 'chest', 'head', 'leftUpperArm', 'rightLowerArm', 'leftFoot', 'rightFoot']) expect(apart(frames[0].world[r] as Quat, qmul(half, w0.world[r] as Quat))).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(frames[0].ankles[i], about(inPlace(w0.ankles[i], w0)))).toBeLessThan(1e-6);
            expect(frames[0].stance[1 - near]).toBe(false);
            // Later: the walk itself, in place.
            let checked = 0;
            for (const f of frames) {
                if (f.time < 2.4) continue;
                const w = walk(plan.phase(f.time) * plan.gait.stride);
                expect(far(f.hips, inPlace(w.hips, w))).toBeLessThan(1e-9);
                for (const r of Object.keys(w.world)) expect(apart(f.world[r] as Quat, w.world[r] as Quat)).toBeLessThan(1e-5);
                for (let i = 0; i < 2; i++) expect(far(f.ankles[i], inPlace(w.ankles[i], w))).toBeLessThan(1e-6);
                checked++;
            }
            expect(checked).toBeGreaterThan(40);
            // It stays where it is: the way it has gone is told apart.
            for (const f of frames) expect(Math.hypot(f.hips[0], f.hips[2])).toBeLessThan(0.12 * body.hipHeight);
            expect(frames[frames.length - 1].travel).toBeGreaterThan(2);
        }
    });

    it('puts the foot in the air down at once, steps round with the other, and takes the first up again as the turn asks', () => {
        const { plan, frames } = walkPivot(body, speed, true);
        const [down, next] = plan.holds[1];
        expect(down.on).toBeCloseTo(PIVOT_STYLE.drop[0], 9);
        expect(down.place).toBe(true);
        // Down a little ahead in the way it was going (behind, as it will go), out to its own side (the left, as it will go).
        expect(down.stand.at[2]).toBeCloseTo(-PIVOT_STYLE.drop[1] * plan.gait.step, 9);
        expect(down.stand.at[0]).toBeCloseTo(PIVOT_STYLE.drop[2] * body.hipHeight, 9);
        expect(down.off).toBeGreaterThan(down.on);
        expect(down.off).toBeLessThan(next.on);
        // The left foot, which stood, leaves at once and lands ahead on the new way.
        expect(frames[3].stance[0]).toBe(false);
        expect(plan.holds[0][1].stand.at[2]).toBeGreaterThan(0.5 * plan.gait.step);
        // The body has turned right about within a second.
        expect(plan.facing(0)).toBeCloseTo(-Math.PI, 9);
        expect(Math.abs(plan.facing(1))).toBeLessThan(1e-9);
    });

    it('turns to the right as in a mirror', () => {
        const l = walkPivot(body, speed, true).frames, r = walkPivot(body, speed, false).frames;
        const mirror = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];
        const other = (role: string) => (role.startsWith('left') ? `right${role.slice(4)}` : role.startsWith('right') ? `left${role.slice(5)}` : role);
        for (const k of [0, 5, 12, 25, 40, 70, 100]) {
            expect(far(r[k].hips, [-l[k].hips[0], l[k].hips[1], l[k].hips[2]])).toBeLessThan(1e-9);
            for (const role of Object.keys(l[k].world)) expect(apart(r[k].world[other(role)] as Quat, mirror(l[k].world[role] as Quat))).toBeLessThan(1e-6);
            expect(far(r[k].ankles[1], [-l[k].ankles[0][0], l[k].ankles[0][1], l[k].ankles[0][2]])).toBeLessThan(1e-9);
        }
    });

    it('keeps its feet on the floor and moves without a jolt', () => {
        const roll = soleRoll(body);
        const g = gaitFor(body, speed, GAIT_STYLE), walk = gaitPoser(body, g);
        let walkMost = 0;
        for (let k = 1; k <= 64; k++) { const a = walk((k - 1) / 60), b = walk(k / 60); for (const r of Object.keys(a.world)) walkMost = Math.max(walkMost, apart(a.world[r] as Quat, b.world[r] as Quat)); }
        const { frames } = walkPivot(body, speed, true);
        let most = 0;
        for (let k = 0; k < frames.length; k++) {
            const f = frames[k];
            for (let i = 0; i < 2; i++) {
                const foot = i ? 'rightFoot' : 'leftFoot';
                if (f.stance[i]) expect(f.short[i]).toBe(0);
                // On the floor a flat foot does not move: with the way gone put back on.
                const level = (h: GaitFrame) => Math.abs(rot(h.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
                const onFloor = (h: GaitFrame): Vec3 => [h.ankles[i][0], h.ankles[i][1], h.ankles[i][2] + h.travel];
                if (k && f.stance[i] && frames[k - 1].stance[i] && level(f) && level(frames[k - 1])) expect(far(onFloor(f), onFloor(frames[k - 1]))).toBeLessThan(1e-9);
                for (const [o, z] of roll.points) expect(f.ankles[i][1] + rot(f.world[foot] as Quat, [0, z - body.ankleHeight, o])[1] - body.floor).toBeGreaterThan(-1e-6);
            }
            if (k) for (const r of Object.keys(f.world)) most = Math.max(most, apart(f.world[r] as Quat, frames[k - 1].world[r] as Quat));
        }
        expect(most).toBeLessThan(Math.max(walkMost * 1.3, 14 * D));
    });
});

describe('walking round a circle', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const speed = 1.3;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

    it('is the straight walk itself where the way does not bend and nothing else is asked', () => {
        const plain: ArcStyle = { ...ARC_STYLE, turn: 1e-7, phase: 0, bank: 0, track: [0, 0], toe: [0, 0], face: 0, look: [0, 0], curl: [0, 1], roll: [0, 0], armOut: [0, 0], elbow: [0, 0] };
        const { plan, frames } = walkArc(body, speed, true, 48, plain);
        const walk = gaitCycle(body, plan.gait, GAIT_STYLE, 48);
        for (const k of [0, 5, 13, 24, 31, 47]) {
            expect(far(frames[k].hips, [walk[k].hips[0], walk[k].hips[1], walk[k].hips[2] - walk[k].travel])).toBeLessThan(1e-6);
            for (const r of Object.keys(walk[k].world)) expect(apart(frames[k].world[r] as Quat, walk[k].world[r] as Quat)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(frames[k].ankles[i], [walk[k].ankles[i][0], walk[k].ankles[i][1], walk[k].ankles[i][2] - walk[k].travel])).toBeLessThan(1e-5);
        }
    });

    it('closes on itself, and goes to the right as in a mirror', () => {
        const l = walkArc(body, speed, true).frames, r = walkArc(body, speed, false).frames;
        expect(l.length).toBe(65);
        const first = l[0], last = l[64];
        expect(far(first.hips, last.hips)).toBeLessThan(1e-9);
        for (const role of Object.keys(first.world)) expect(apart(first.world[role] as Quat, last.world[role] as Quat)).toBeLessThan(1e-6);
        for (let i = 0; i < 2; i++) expect(far(first.ankles[i], last.ankles[i])).toBeLessThan(1e-9);
        // The right turn: the left turn mirrored, half a stride on (the walk itself is the same to both sides half a stride apart).
        const mirror = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]];
        const other = (role: string) => (role.startsWith('left') ? `right${role.slice(4)}` : role.startsWith('right') ? `left${role.slice(5)}` : role);
        for (const k of [0, 9, 20, 41, 60]) {
            const m = l[(k + 32) % 64];
            expect(far(r[k].hips, [-m.hips[0], m.hips[1], m.hips[2]])).toBeLessThan(1e-6);
            for (const role of Object.keys(m.world)) expect(apart(r[k].world[other(role)] as Quat, mirror(m.world[role] as Quat))).toBeLessThan(1e-5);
        }
    });

    it('keeps its feet on the floor of the circle, the inner foot stepping shorter', () => {
        const { plan } = walkArc(body, speed, true);
        // On the floor itself (not in place): a foot standing flat does not move.
        const world = carryFrames(body, plan, GAIT_STYLE, 64 / plan.gait.stride);
        for (let k = 1; k < world.length; k++) for (let i = 0; i < 2; i++) {
            const foot = i ? 'rightFoot' : 'leftFoot';
            const level = (f: GaitFrame) => Math.abs(rot(f.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
            if (world[k].stance[i]) expect(world[k].short[i]).toBe(0);
            if (world[k].stance[i] && world[k - 1].stance[i] && level(world[k]) && level(world[k - 1])) expect(far(world[k].ankles[i], world[k - 1].ankles[i])).toBeLessThan(1e-9);
        }
        // From one footfall to the next of the same foot: less for the foot nearer the middle of the circle.
        const step = (foot: number) => far(plan.holds[foot][3].stand.at as Vec3, plan.holds[foot][2].stand.at as Vec3);
        expect(step(0)).toBeLessThan(step(1) * 0.95);
        // The way turns by the style's angle each stride, to the left.
        const a = plan.way!(0), b = plan.way!(plan.gait.speed * plan.gait.stride);
        expect(b.heading - a.heading).toBeCloseTo(ARC_STYLE.turn, 9);
    });

    it('leans in and looks where it goes', () => {
        const { frames } = walkArc(body, speed, true);
        const straight = walkArc(body, speed, true, 64, { ...ARC_STYLE, bank: 0, look: [0, 0], face: 0, roll: [0, 0] }).frames;
        const mean = (f: (x: GaitFrame) => number, list: GaitFrame[]) => list.slice(0, 64).reduce((sum, x) => sum + f(x), 0) / 64;
        // The hips toward the middle of the circle (the left).
        expect(mean((f) => f.hips[0], frames) - mean((f) => f.hips[0], straight)).toBeGreaterThan(0.04 * body.hipHeight);
        // The head turned into the turn, further than the chest.
        const face = (role: string) => (f: GaitFrame) => { const v = rot(f.world[role] as Quat, [0, 0, 1]); return Math.atan2(v[0], v[2]); };
        expect(mean(face('head'), frames)).toBeGreaterThan(mean(face('chest'), frames) + 4 * D);
        expect(mean(face('chest'), frames)).toBeGreaterThan(mean(face('hips'), frames) + 4 * D);
    });
});

describe('walking up and down a slope', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const speed = 1.3;
    const steep = SLOPE_STYLE.grade;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    /** How far a part leans forward, radians. */
    const lean = (q: Quat) => -Math.asin(Math.max(-1, Math.min(1, rot(q, [0, 0, 1])[1])));
    const mean = (f: (x: GaitFrame) => number, list: GaitFrame[]) => list.slice(0, 64).reduce((sum, x) => sum + f(x), 0) / 64;
    /** The walk on its way itself (not in place), and the hold a foot stands on at a frame. */
    const onTheWay = (grade: number) => {
        const { plan } = walkSlope(body, speed, grade);
        const world = carryFrames(body, plan, GAIT_STYLE, 64 / plan.gait.stride);
        const holdOf = (foot: number, t: number) => plan.holds[foot].find((x) => t >= x.on && t < x.off);
        return { plan, world, holdOf };
    };

    it('is the level walk itself where the way does not climb', () => {
        const { plan, frames } = walkSlope(body, speed, 0, 48);
        const walk = gaitCycle(body, plan.gait, GAIT_STYLE, 48);
        // The first frame is a quarter of a stride into the walk.
        expect(SLOPE_STYLE.phase).toBe(0.25);
        for (const k of [0, 5, 13, 24, 31, 47]) {
            const w = walk[(k + 12) % 48];
            expect(far(frames[k].hips, [w.hips[0], w.hips[1], w.hips[2] - w.travel])).toBeLessThan(1e-6);
            for (const r of Object.keys(w.world)) expect(apart(frames[k].world[r] as Quat, w.world[r] as Quat)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(frames[k].ankles[i], [w.ankles[i][0], w.ankles[i][1], w.ankles[i][2] - w.travel])).toBeLessThan(1e-5);
        }
    });

    it('closes on itself, up and down', () => {
        for (const grade of [steep, -steep, 0.3 * steep]) {
            const { frames } = walkSlope(body, speed, grade);
            expect(frames.length).toBe(65);
            const first = frames[0], last = frames[64];
            expect(far(first.hips, last.hips)).toBeLessThan(1e-7);
            for (const role of Object.keys(first.world)) expect(apart(first.world[role] as Quat, last.world[role] as Quat)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(first.ankles[i], last.ankles[i])).toBeLessThan(1e-7);
        }
    });

    it('goes as far along the slope each stride as on the level, every footfall level on a height of its own', () => {
        for (const grade of [steep, -steep]) {
            const { plan, world, holdOf } = onTheWay(grade);
            const angle = Math.atan(grade), stride = plan.gait.speed * plan.gait.stride;
            for (let foot = 0; foot < 2; foot++) {
                const a = plan.holds[foot][2], b = plan.holds[foot][3];
                // From one footfall to the same foot's next: a stride along the slope.
                expect(b.up! - a.up!).toBeCloseTo(stride * Math.sin(angle), 9);
                expect((b.stand.at as Vec3)[2] - (a.stand.at as Vec3)[2]).toBeCloseTo(stride * Math.cos(angle), 9);
            }
            // The other foot's footfalls lie half way between.
            expect(plan.holds[1][2].up! - plan.holds[0][2].up!).toBeCloseTo((stride / 2) * Math.sin(angle), 9);
            let stood = 0;
            for (let k = 1; k < world.length; k++) for (let i = 0; i < 2; i++) {
                if (!world[k].stance[i]) continue;
                const foot = i ? 'rightFoot' : 'leftFoot';
                const level = (f: GaitFrame) => Math.abs(rot(f.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
                // A standing leg reaches its foot; a foot standing flat is level (not along the slope), on its own step, and does not move.
                expect(world[k].short[i]).toBe(0);
                if (!level(world[k])) continue;
                expect(world[k].ankles[i][1]).toBeCloseTo(body.floor + body.ankleHeight + holdOf(i, world[k].time)!.up!, 9);
                if (world[k - 1].stance[i] && level(world[k - 1])) { expect(far(world[k].ankles[i], world[k - 1].ankles[i])).toBeLessThan(1e-9); stood++; }
            }
            expect(stood).toBeGreaterThan(8);
        }
    });

    it('carries the body from the level of one footfall to the next: on the bent leg ahead going up, onto the straight leg ahead going down', () => {
        for (const grade of [steep, -steep]) {
            const { plan, world } = onTheWay(grade);
            const stepRise = (plan.gait.speed * plan.gait.stride * Math.sin(Math.atan(grade))) / 2;
            // Half a stride on the hips are a step's rise higher (or lower), exactly.
            for (const k of [0, 7, 19, 30]) expect(world[k + 32].hips[1] - world[k].hips[1]).toBeCloseTo(stepRise, 7);
            // The frame at which a foot has just landed: its knee, and the other leg's.
            for (let i = 0; i < 2; i++) {
                const k = world.findIndex((f, j) => j > 0 && f.stance[i] && !world[j - 1].stance[i]);
                expect(k).toBeGreaterThan(0);
                const ahead = world[k].knees[i] / D, behind = world[k].knees[1 - i] / D;
                if (grade > 0) { expect(ahead).toBeGreaterThan(60); expect(behind).toBeLessThan(35); }
                else { expect(ahead).toBeLessThan(30); expect(behind).toBeGreaterThan(50); }
            }
        }
        // Going up the hips rise most while one leg carries them (the other in the air); going down they sink most about the landing.
        const up = onTheWay(steep).world;
        const rate = (list: GaitFrame[], k: number) => (list[k + 1].hips[1] - list[k].hips[1]) * (64 / list[64].time);
        const single = (f: GaitFrame) => f.stance[0] !== f.stance[1];
        const fastest = up.slice(0, 64).reduce((best, _, k) => (rate(up, k) > rate(up, best) ? k : best), 0);
        expect(single(up[fastest])).toBe(true);
    });

    it('lifts the foot in the air clear of the straight way between its two places', () => {
        for (const grade of [steep, -steep]) {
            const { plan, world } = onTheWay(grade);
            let most = 0;
            for (const f of world) for (let i = 0; i < 2; i++) {
                if (f.stance[i]) continue;
                // The place it is going to, and the one it left.
                const at = plan.holds[i].findIndex((x) => x.off > f.time);
                const a = plan.holds[i][at - 1], b = plan.holds[i][at];
                const share = ((f.ankles[i][2] - (a.stand.at as Vec3)[2]) / ((b.stand.at as Vec3)[2] - (a.stand.at as Vec3)[2]));
                if (share < 0.1 || share > 0.9) continue;
                const line = body.floor + body.ankleHeight + a.up! + (b.up! - a.up!) * share;
                expect(f.ankles[i][1]).toBeGreaterThan(line);
                most = Math.max(most, f.ankles[i][1] - line);
            }
            // Higher over it than the level walk lifts its foot.
            expect(most).toBeGreaterThan(0.1 * body.leg);
        }
    });

    it('leans into the climb, tucks its pelvis going down, and has as much less of both on a gentler slope', () => {
        const level = walkSlope(body, speed, 0).frames, up = walkSlope(body, speed, steep).frames, down = walkSlope(body, speed, -steep).frames;
        const half = walkSlope(body, speed, steep / 2).frames;
        const chest = (f: GaitFrame) => lean(f.world.chest as Quat), pelvis = (f: GaitFrame) => lean(f.world.hips as Quat), head = (f: GaitFrame) => lean(f.world.head as Quat);
        const more = mean(chest, up) - mean(chest, level);
        expect(more).toBeGreaterThan(15 * D);
        // The head does not go with the trunk: it keeps looking ahead.
        expect(Math.abs(mean(head, up) - mean(head, level))).toBeLessThan(0.5 * more);
        expect(mean(pelvis, down)).toBeLessThan(mean(pelvis, level) - 3 * D);
        expect(mean(chest, half) - mean(chest, level)).toBeCloseTo(more / 2, 2);
        // A slope steeper than the numbers are for leans no further.
        const steeper = walkSlope(body, speed, 1.5 * steep).frames;
        expect(mean(chest, steeper) - mean(chest, level)).toBeCloseTo(more, 6);
    });
});

describe('walking on guard', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
    /** Which way a part faces, radians to the left of what the body guards against (+Z). */
    const yaw = (q: Quat) => { const v = rot(q, [0, 0, 1]); return Math.atan2(v[0], v[2]); };
    /** The mean of angles near each other. */
    const meanAngle = (list: number[]) => Math.atan2(list.reduce((s, a) => s + Math.sin(a), 0), list.reduce((s, a) => s + Math.cos(a), 0));
    const ways: [number, boolean][] = [[0, false], [90 * D, false], [-90 * D, false], [180 * D, false], [180 * D, true], [90 * D, true], [-90 * D, true], [0, true]];

    it('turns the body to its line, the chest further back and the head to what it faces, whichever way it goes', () => {
        for (const [travel, backward] of ways) {
            const { frames } = walkGuard(body, travel, backward);
            const way = backward ? GUARD_STYLE.backward : GUARD_STYLE.forward;
            const dir = wrap(backward ? travel - Math.PI : travel);
            const line = guardLine(way, dir);
            const list = frames.slice(0, 80);
            const pelvis = meanAngle(list.map((f) => yaw(f.world.hips as Quat))), chest = meanAngle(list.map((f) => yaw(f.world.chest as Quat))), head = meanAngle(list.map((f) => yaw(f.world.head as Quat)));
            expect(Math.abs(wrap(pelvis - (dir + line.turn * D)))).toBeLessThan(4 * D);
            expect(Math.abs(wrap(chest - (dir + (line.turn + line.chest) * D)))).toBeLessThan(6 * D);
            expect(Math.abs(wrap(head - line.head * D))).toBeLessThan(4 * D);
        }
    });

    it('closes on itself', () => {
        for (const [travel, backward] of ways.slice(0, 5)) {
            const { frames } = walkGuard(body, travel, backward);
            expect(frames.length).toBe(81);
            const first = frames[0], last = frames[80];
            expect(far(first.hips, last.hips)).toBeLessThan(1e-7);
            for (const role of Object.keys(first.world)) expect(apart(first.world[role] as Quat, last.world[role] as Quat)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(first.ankles[i], last.ankles[i])).toBeLessThan(1e-7);
        }
    });

    it('keeps its feet on the floor along its line, and goes backward on its forefeet', () => {
        const pitch = (q: Quat) => Math.asin(Math.max(-1, Math.min(1, rot(q, [0, 0, 1])[1])));
        for (const [travel, backward] of ways) {
            const { plan } = walkGuard(body, travel, backward);
            const world = carryFrames(body, plan, guardGait(body).gaitStyle, 80 / plan.gait.stride);
            let stood = 0;
            const landing: number[] = [];
            for (let k = 1; k < world.length; k++) for (let i = 0; i < 2; i++) {
                const foot = i ? 'rightFoot' : 'leftFoot';
                if (!world[k].stance[i]) continue;
                expect(world[k].short[i]).toBe(0);
                if (!world[k - 1].stance[i]) landing.push(pitch(world[k].world[foot] as Quat));
                const level = (f: GaitFrame) => Math.abs(rot(f.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
                if (world[k - 1].stance[i] && level(world[k]) && level(world[k - 1])) { expect(far(world[k].ankles[i], world[k - 1].ankles[i])).toBeLessThan(1e-9); stood++; }
                expect(world[k].ankles[i][1]).toBeGreaterThan(body.floor + body.ankleHeight - 1e-9);
            }
            expect(stood).toBeGreaterThan(10);
            expect(landing.length).toBeGreaterThan(1);
            // Forward a foot lands on its heel (toes up); backward on its forefoot (heel up).
            for (const p of landing) if (backward) expect(p).toBeLessThan(-3 * D); else expect(p).toBeGreaterThan(3 * D);
        }
    });

    it('has, for a way between two lines, what the two lines have, in proportion', () => {
        const way = GUARD_STYLE.forward;
        const mid = guardLine(way, 45 * D);
        expect(mid.turn).toBeCloseTo((way.front.turn + way.left.turn) / 2, 9);
        expect(mid.head).toBeCloseTo((way.front.head + way.left.head) / 2, 9);
        expect(mid.feet[1]).toBeCloseTo((way.front.feet[1] + way.left.feet[1]) / 2, 9);
        expect(guardLine(way, 90 * D).turn).toBeCloseTo(way.left.turn, 9);
        expect(guardLine(way, 180 * D).chest).toBeCloseTo(way.back.chest, 9);
        expect(guardLine(way, -90 * D).feet[0]).toBeCloseTo(way.right.feet[0], 9);
        expect(guardLine(way, -135 * D).turn).toBeCloseTo((way.right.turn + way.back.turn) / 2, 9);
    });

    it('steps on the spot: each foot lifted once a round, the hips over the foot that stays', () => {
        const { frames } = stepGuard(body);
        expect(frames.length).toBe(81);
        expect(far(frames[0].hips, frames[80].hips)).toBeLessThan(1e-7);
        const highest = [0, 1].map((i) => frames.reduce((best, f, k) => (f.ankles[i][1] > frames[best].ankles[i][1] ? k : best), 0));
        for (let i = 0; i < 2; i++) {
            expect(frames[highest[i]].stance[i]).toBe(false);
            expect(frames[highest[i]].ankles[i][1] - (body.floor + body.ankleHeight)).toBeGreaterThan(0.5 * GUARD_STYLE.step.rise * body.leg);
        }
        // Standing feet do not move; with the left foot up the hips are nearer the right foot than with the right foot up.
        for (let k = 1; k < frames.length; k++) for (let i = 0; i < 2; i++) {
            const foot = i ? 'rightFoot' : 'leftFoot';
            const level = (f: GaitFrame) => Math.abs(rot(f.world[foot] as Quat, [0, 0, 1])[1]) < 1e-9;
            if (frames[k].stance[i] && frames[k - 1].stance[i] && level(frames[k]) && level(frames[k - 1])) expect(far(frames[k].ankles[i], frames[k - 1].ankles[i])).toBeLessThan(1e-9);
        }
        const flat = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[2] - q[2]);
        const right = frames[highest[1]].ankles[1] as Vec3;
        expect(flat(frames[highest[0]].hips as Vec3, frames[highest[0]].ankles[1] as Vec3)).toBeLessThan(flat(frames[highest[1]].hips as Vec3, right));
    });
});

describe('one formula: a steady walk from its path and its look', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    const speed = 1.3;
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    const yaw = (q: Quat) => { const v = rot(q, [0, 0, 1]); return Math.atan2(v[0], v[2]); };
    const along = (deg: number, v: number, grade = 0) => (t: number): Vec3 => {
        const a = deg * D, run = Math.cos(Math.atan(grade)), rise = Math.sin(Math.atan(grade));
        return [Math.sin(a) * v * run * t, v * rise * t, Math.cos(a) * v * run * t];
    };
    const circle = (v: number, omega: number) => (t: number): Vec3 => { const r = v / omega, a = omega * t; return [r * (1 - Math.cos(a)), 0, r * Math.sin(a)]; };
    const mean = (f: (x: GaitFrame) => number, list: GaitFrame[]) => list.slice(0, -1).reduce((sum, x) => sum + f(x), 0) / (list.length - 1);

    it('is the walk itself on a straight path, looking where it goes', () => {
        const { plan, frames } = locoLoop(body, { path: along(0, speed), phase: 0 }, 48);
        const walk = gaitCycle(body, plan.gait, GAIT_STYLE, 48);
        for (const k of [0, 5, 13, 24, 31, 47]) {
            expect(far(frames[k].hips, [walk[k].hips[0], walk[k].hips[1], walk[k].hips[2] - walk[k].travel])).toBeLessThan(1e-6);
            for (const r of Object.keys(walk[k].world)) expect(apart(frames[k].world[r] as Quat, walk[k].world[r] as Quat)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(frames[k].ankles[i], [walk[k].ankles[i][0], walk[k].ankles[i][1], walk[k].ankles[i][2] - walk[k].travel])).toBeLessThan(1e-5);
        }
    });

    it('closes on itself, whatever the path and the look', () => {
        const inputs = [
            { path: along(0, speed), phase: 0.25 },
            { path: circle(speed, 1.1), phase: 0.25 },
            { path: along(0, speed, 0.5), phase: 0.25 },
            { path: along(90, 0.95), look: () => 0, phase: 0.25, posture: 1 },
            { path: along(180, 0.95), look: () => 0, phase: 0.27, posture: 1, backward: true },
        ];
        for (const input of inputs) {
            const { frames } = locoLoop(body, input, 64);
            const first = frames[0], last = frames[64];
            expect(far(first.hips, last.hips)).toBeLessThan(1e-6);
            for (const role of Object.keys(first.world)) expect(apart(first.world[role] as Quat, last.world[role] as Quat)).toBeLessThan(1e-5);
            for (let i = 0; i < 2; i++) expect(far(first.ankles[i], last.ankles[i])).toBeLessThan(1e-6);
        }
    });

    it('shares the look out along the body: the head nearly gets there while it can, behind the rest is left short', () => {
        const chain = LOCO_STYLE.chain;
        const none = { pelvis: 0, chest: 0, toes: [0, 0] as [number, number] };
        const side = chainOf(chain, 60 * D, none, false);
        const headShare = 1 - chain.share[0] - chain.share[1];
        expect(side.pelvis).toBeCloseTo(chain.share[0] * 60 * D, 9);
        expect(side.chest).toBeCloseTo(chain.share[1] * 60 * D, 9);
        expect(side.head).toBeCloseTo(headShare * chain.reach * 60 * D, 9);
        expect(side.short).toBeCloseTo(headShare * (1 - chain.reach) * 60 * D, 9);
        // Behind: chest and head at their most, the pelvis takes what it can, the rest is short.
        const behind = chainOf(chain, Math.PI, none, false);
        expect(behind.chest).toBeCloseTo(chain.most[2] * D, 9);
        expect(behind.head).toBeCloseTo(chain.most[3] * D, 9);
        expect(behind.pelvis).toBeLessThanOrEqual(chain.most[0] * D + 1e-9);
        expect(behind.short).toBeGreaterThan(0);
        expect(behind.pelvis + behind.chest + behind.head + behind.short).toBeCloseTo(Math.PI, 9);
        // To the right as to the left, mirrored (without a stance of its own); the feet turn toward the look.
        const right = chainOf(chain, -60 * D, none, false);
        expect(right.pelvis).toBeCloseTo(-side.pelvis, 9);
        expect(side.feet[0]).toBeGreaterThan(0);
        expect(right.feet[1]).toBeLessThan(0);
    });

    it('walks round a circle leaning in and looking where it goes, the inner foot stepping shorter', () => {
        const { plan, frames } = locoLoop(body, { path: circle(speed, 1.1), phase: 0.25 }, 64);
        const straight = locoLoop(body, { path: along(0, speed), phase: 0.25 }, 64).frames;
        expect(mean((f) => f.hips[0], frames) - mean((f) => f.hips[0], straight)).toBeGreaterThan(0.02 * body.hipHeight);
        expect(mean((f) => yaw(f.world.head as Quat), frames)).toBeGreaterThan(mean((f) => yaw(f.world.chest as Quat), frames));
        const step = (foot: number) => far(plan.holds[foot][4].stand.at as Vec3, plan.holds[foot][3].stand.at as Vec3);
        expect(step(0)).toBeLessThan(step(1) * 0.97);
    });

    it('on guard faces what it looks at, turned partly to its line; looking far behind it backs away, on its forefeet', () => {
        for (const deg of [0, 90, -90]) {
            const { frames } = locoLoop(body, { path: along(deg, 0.95), look: () => 0, phase: 0.25, posture: 1 }, 64);
            const head = mean((f) => yaw(f.world.head as Quat), frames), pelvis = mean((f) => yaw(f.world.hips as Quat), frames);
            expect(Math.abs(head)).toBeLessThan(10 * D);
            // The pelvis between the line and the look.
            if (deg) expect(Math.sign(pelvis)).toBe(Math.sign(deg));
            if (deg) expect(Math.abs(pelvis)).toBeLessThan(Math.abs(deg * D));
        }
        // The look straight behind its way, nothing said: it backs away (and lands each foot toes first).
        const { plan } = locoLoop(body, { path: along(180, 0.95), look: () => 0, phase: 0.27, posture: 1 }, 64);
        expect(plan.travelled(1)).toBeLessThan(0);
        const world = carryFrames(body, plan, { ...GAIT_STYLE, walk: { ...GAIT_STYLE.walk, rate: [GAIT_STYLE.walk.rate[0] * LOCO_STYLE.guard.quick, GAIT_STYLE.walk.rate[1] * LOCO_STYLE.guard.quick] } }, 64 / plan.gait.stride);
        let landed = 0;
        for (let k = 1; k < world.length; k++) for (let i = 0; i < 2; i++) {
            if (!world[k].stance[i] || world[k - 1].stance[i]) continue;
            const foot = i ? 'rightFoot' : 'leftFoot';
            expect(Math.asin(rot(world[k].world[foot] as Quat, [0, 0, 1])[1])).toBeLessThan(0);
            landed++;
        }
        expect(landed).toBeGreaterThan(0);
    });

    it('takes every walk through one entry: the path, the look and where the body begins choose the rule', () => {
        const same = (a: GaitFrame[], b: GaitFrame[]) => {
            expect(a.length).toBe(b.length);
            for (const k of [0, Math.floor(a.length / 3), a.length - 1]) {
                expect(far(a[k].hips, b[k].hips)).toBeLessThan(1e-12);
                expect(apart(a[k].world.chest as Quat, b[k].world.chest as Quat)).toBeLessThan(1e-6);
            }
        };
        const still = (): Vec3 => [0, 0, 0];
        // Steady: no state, a path that goes on.
        expect(locomote(body, { path: along(0, speed), phase: 0.25 }).kind).toBe('walk');
        // Setting off from a stand turned away from the way: a start, as the start's own planner makes it.
        const start = locomote(body, { path: along(0, speed), phase: 0, seconds: 1.2, state: { stand: { facing: -90 * D } } });
        expect(start.kind).toBe('start');
        same(start.frames, walkStart(body, speed, 90 * D, true, 1.2, LOCO_STYLE.rules.start, GAIT_STYLE, LOCO_STYLE.rules.turn, LOCO_STYLE.chain).frames);
        // Coming to rest from a walk: a stop on the foot the walk has down at that phase.
        const rest = (t: number) => along(0, speed)(Math.min(t, 0.5));
        const stop = locomote(body, { path: rest, phase: 0, seconds: 2, state: { walk: { speed, phase: 0.5 + STOP_STYLE.phase, heading: 0 } } });
        expect(stop.kind).toBe('stop');
        same(stop.frames, walkStop(body, speed, 1, 2).frames);
        // A way that turns back on the walk: a turn right about, to the leading side.
        const pivot = locomote(body, { path: along(0, speed), phase: 0, seconds: 1.2, lead: 1, state: { walk: { speed, phase: 0.26, heading: Math.PI } } });
        expect(pivot.kind).toBe('pivot');
        same(pivot.frames, walkPivot(body, speed, false, 1.2, LOCO_STYLE.rules.pivot, GAIT_STYLE, LOCO_STYLE.rules.turn, LOCO_STYLE.chain).frames);
        // Standing still, told to look elsewhere: a turn on the spot (half a turn: to the leading side).
        const turn = locomote(body, { path: still, look: () => Math.PI, phase: 0, seconds: 2.5, lead: 1, state: { stand: { facing: 0 } } });
        expect(turn.kind).toBe('turn');
        same(turn.frames, turnFrames(body, turnFor(body, -Math.PI, LOCO_STYLE.rules.turn, false), LOCO_STYLE.rules.turn, 60, LOCO_STYLE.chain));
        // Standing on guard: stepping on the spot.
        expect(locomote(body, { path: still, look: () => 0, phase: 0, posture: 1, state: { stand: { facing: 0 } } }).kind).toBe('step');
    });
});

describe('the chain in time: following a look that moves', () => {
    it('turns the head first and the pelvis last, and settles on the shares', () => {
        const chain = LOCO_STYLE.chain;
        const D = Math.PI / 180;
        const none = { pelvis: 0, chest: 0, toes: [0, 0] as [number, number] };
        // The look jumps 60 degrees to the left at time 0 and stays.
        const follow = chainFollow(chain, () => chainOf(chain, 60 * D, none, false), 8);
        const goal = chainOf(chain, 60 * D, none, false);
        expect(follow(0).head).toBe(0);
        const early = follow(0.2);
        // Each part's share of the way so far: the head furthest, then the chest, then the pelvis.
        const done = (part: 'pelvis' | 'chest' | 'head') => early[part] / goal[part];
        expect(done('head')).toBeGreaterThan(done('chest'));
        expect(done('chest')).toBeGreaterThan(done('pelvis'));
        // A critically damped spring does not overshoot, and comes to rest on its share.
        for (let t = 0; t <= 8; t += 0.05) expect(follow(t).head).toBeLessThanOrEqual(goal.head + 1e-9);
        const late = follow(8);
        expect(late.pelvis).toBeCloseTo(goal.pelvis, 4);
        expect(late.chest).toBeCloseTo(goal.chest, 4);
        expect(late.head).toBeCloseTo(goal.head, 6);
    });
});
