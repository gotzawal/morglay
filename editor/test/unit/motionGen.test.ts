import { describe, expect, it } from 'vitest';
import { clipOntoModel, framesToClipOnce } from '../../src/core/motionGen/bake';
import { canonicalSkeleton, measureBody, type Body } from '../../src/core/motionGen/body';
import { GAIT_STYLE, gaitFor, gaitPoser, type Gait, type GaitFrame, type GaitMode, type GaitStyle, type Vault } from '../../src/core/motionGen/gait';
import { START_STYLE, walkAlong } from '../../src/core/motionGen/carry';
import { CHAIN_STYLE, chainFollow, chainOf } from '../../src/core/motionGen/chain';
import { LOCO_STYLE, locoPath } from '../../src/core/motionGen/locomotion';
import { rollTo } from '../../src/core/motionGen/sole';
import { standFrame, TURN_STYLE, turnFor, turnFrames, type TurnStyle } from '../../src/core/motionGen/turn';
const vaultOf = (m: GaitMode) => m.support as Vault;
import { bridge, minJerk, move, quintic, viaCurve, wave } from '../../src/core/motionGen/tools';
import { HUMAN_MANNER } from '../../src/core/motionGen/manner';
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
/** One stride of a gait as `count` instants from the left heel's strike (the poser the walk plays, gait.ts gaitPoser). */
function gaitCycle(body: Body, g: Gait, style: GaitStyle = GAIT_STYLE, count = 64): GaitFrame[] {
    const pose = gaitPoser(body, g, style, count);
    return Array.from({ length: count }, (_, k) => {
        const { feet: _feet, legTurn: _legTurn, ...frame } = pose((k * g.stride) / count);
        return frame;
    });
}

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
        // Both ends held: the same as the closed form.
        const held = move(1, 0.4, -0.3, 2, -0.2, 0.5);
        for (const u of [0, 0.2, 0.5, 0.8, 1]) expect(held(u)).toBeCloseTo(bridge(1, 0.4, -0.3, 2, -0.2, 0.5, u), 10);
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
        expect(wave(1.25, 0.25, 0.5, 0.25)).toBeCloseTo(1.5, 12);
        // The walking pelvis' list: next to nothing as the heel strikes, at its most soon after, and back slowly.
        const list = (p: number) => wave(p, 0.184, 0.33, 0.149);
        let most = 0;
        for (let k = 1; k < 100; k++) if (list(k / 100) > list(most / 100)) most = k;
        expect(Math.abs(list(0)) / list(most / 100)).toBeLessThan(0.15);
        expect(most).toBeGreaterThan(10);
        expect(most).toBeLessThan(20);
        expect(list(0.4)).toBeGreaterThan(0.1 * list(most / 100));
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
    });

    it('walks with the long stride of its style, the step growing more slowly than the speed', () => {
        expect(walk.run).toBe(false);
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
        const clip = framesToClipOnce(canon, fine, 'walk');
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
        const clip = framesToClipOnce(canon, frames, 'walk');
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

    it('runs above the Froude number of the change, with both feet in the air between steps', () => {
        const run = gaitFor(body, 3.2);
        expect(run.run).toBe(true);
        expect(run.duty).toBeLessThan(0.5);
        const air = gaitCycle(body, run, GAIT_STYLE, 60).filter((f) => !f.stance[0] && !f.stance[1]);
        expect(air.length).toBeGreaterThan(4);
        // And walking just under it.
        expect(gaitFor(body, 0.99 * Math.sqrt(GAIT_STYLE.runAt * 9.81 * body.hipHeight)).run).toBe(false);
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

    it('hands the swing on down the arm: late after the leg, the elbow held bent, the hand carried past the forearm; round a loop where a style asks', () => {
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
        // Round a loop where a style asks for one: in the middle of its swing the arm is further out to its side going forward
        // than coming back (this character's own walk swings to and fro along one line).
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
        expect(Math.abs(loop(arm))).toBeLessThan(0.01);
        expect(loop(armOf({ armLoop: 2 }))).toBeGreaterThan(0.04);
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
            const clip = framesToClipOnce(canon, cycle, 'walk');
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
        kept.top.forEach((x, k) => expect(x).toBeCloseTo(sway.size * body.hipHeight * wave(k / n, sway.at, sway.third, GAIT_STYLE.thirdAt), 4));
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

    it('keeps its head level as it walks, and tilts it or sways it where a style asks, the neck leaning to keep it over the line', () => {
        const n = 120;
        const canon = canonicalSkeleton(sk, body);
        const walkWith = (mode: GaitMode) => {
            const style = { ...GAIT_STYLE, walk: mode };
            const g = gaitFor(body, 1.3, style);
            const cycle = gaitCycle(body, g, style, n);
            const clip = framesToClipOnce(canon, cycle, 'walk');
            return { cycle, head: cycle.map((_, k) => places(canon.bones, clip, k)[canon.index.head][0]) };
        };
        // How far the head is tipped forward and to the side (left side up), degrees.
        const forward = (q: Quat) => (-Math.asin(rot(q, [0, 0, 1])[1]) * 180) / Math.PI;
        const sideways = (q: Quat) => (Math.asin(rot(q, [1, 0, 0])[1]) * 180) / Math.PI;
        const range = (v: number[]) => Math.max(...v) - Math.min(...v);
        // Its own style: the head nods and tilts with each step by no more than the chest under it makes it (a degree or so).
        const own = walkWith(GAIT_STYLE.walk);
        expect(range(own.cycle.map((f) => forward(f.world.head)))).toBeLessThan(2);
        expect(range(own.cycle.map((f) => sideways(f.world.head)))).toBeLessThan(1.5);
        // Asked to tilt once a stride, it does: its left side highest when the style says.
        const tilted = walkWith({ ...GAIT_STYLE.walk, headTilt: [2, 0.35] });
        const tilt = tilted.cycle.map((f) => sideways(f.world.head));
        expect(range(tilt)).toBeGreaterThan(3);
        expect(Math.abs(tilt.indexOf(Math.max(...tilt)) / n - 0.35)).toBeLessThan(0.03);
        // Asked to sway, the head's joint is where it is asked to be to the side: the neck leans to put it there, and only the neck.
        const sway = { size: 0.01, at: 0.3 };
        const swayed = walkWith({ ...GAIT_STYLE.walk, headSway: sway });
        swayed.head.forEach((x, k) => expect(x).toBeCloseTo(sway.size * body.hipHeight * wave(k / n, sway.at), 4));
        for (const k of [0, 23, 61, 97]) {
            const p = swayed.cycle[k].world.head, q = own.cycle[k].world.head;
            expect(Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3])).toBeCloseTo(1, 10);
        }
        const leaned = Math.max(...swayed.cycle.map((f, k) => {
            const c = f.world.neck, d = own.cycle[k].world.neck;
            return 2 * Math.acos(Math.min(1, Math.abs(c[0] * d[0] + c[1] * d[1] + c[2] * d[2] + c[3] * d[3])));
        }));
        expect(leaned).toBeGreaterThan((0.2 * Math.PI) / 180);
    });

    it('takes the kind of gait its speed asks for, or the one it is told', () => {
        expect(gaitFor(body, 1.3).kind).toBe('walk');
        expect(gaitFor(body, 4).kind).toBe('run');
        expect(gaitFor(body, 7).kind).toBe('run');
        expect(gaitFor(body, 4, GAIT_STYLE, 'walk').kind).toBe('walk');
        expect(gaitFor(body, 1.3).run).toBe(false);
        expect(gaitFor(body, 7).run).toBe(true);
    });

    it('throws a flying foot ahead of its hip and pulls it back before it lands', () => {
        for (const speed of [4, 7]) {
            const g = gaitFor(body, speed);
            const cycle = gaitCycle(body, g, GAIT_STYLE, 96);
            const ahead = cycle.map((f) => f.ankles[0][2] - f.hips[2]);
            let most = 0;
            for (let k = 1; k < 96; k++) if (ahead[k] > ahead[most]) most = k;
            // Farthest ahead while still in the air, in the last tenth of the stride before its strike (key 0).
            expect(cycle[most].stance[0]).toBe(false);
            expect(most).toBeGreaterThan(96 * 0.88);
            expect(ahead[most]).toBeGreaterThan(ahead[0] + 0.01);
            for (let i = 0; i < 2; i++) {
                for (let k = 0; k + 1 < cycle.length; k++) {
                    const a = cycle[k], b = cycle[k + 1];
                    expect(a.short[i]).toBe(0);
                    if (a.stance[i] && b.stance[i] && !a.pivots[i] && !b.pivots[i]) expect(far(a.ankles[i], b.ankles[i])).toBeLessThan(1e-9);
                }
            }
        }
    });

    it('runs faster without a jump: the step’s time and the stance’s share change smoothly with the pace, and the legs always reach', () => {
        let last = gaitFor(body, 3.5);
        for (let k = 1; k <= 40; k++) {
            const g = gaitFor(body, 3.5 + 0.1 * k);
            expect(Math.abs(g.stepTime - last.stepTime) / last.stepTime).toBeLessThan(0.04);
            expect(Math.abs(g.duty - last.duty)).toBeLessThan(0.02);
            for (const f of gaitCycle(body, g, GAIT_STYLE, 32)) expect(Math.max(...f.short)).toBe(0);
            last = g;
        }
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
        const clip = framesToClipOnce(canon, frames, 'walk');
        const onto = clipOntoModel({ skeleton: sk, clips: [] }, body, canon, clip).clip;
        const roles = rolesOf(sk);
        for (const k of [0, 7, 22, 41, 59]) {
            const P = places(sk, onto, k);
            for (let i = 0; i < 2; i++) expect(far(P[roles[i ? 'rightFoot' : 'leftFoot']], frames[k].ankles[i])).toBeLessThan(1e-5);
        }
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
    // (The pelvis, the chest and the head follow the look by their springs: given the time a path walk gives them to come round.)
    const settled = (deg: number) => { const plan = turnFor(body, deg * D, TURN_STYLE, deg >= 0); return { plan, frames: turnFrames(body, { ...plan, seconds: plan.seconds + 1.2 }) }; };

    it('ends in the stance it began in, turned by the angle, once its parts have come round', () => {
        const stand = standFrame(body);
        for (const [deg, toLeft] of [[180, true], [90, true], [45, true], [0, true], [0, false], [-30, false], [-90, false], [-180, false]] as const) {
            const plan = turnFor(body, deg * D, TURN_STYLE, toLeft), frames = turnFrames(body, { ...plan, seconds: plan.seconds + 1.2 });
            const first = frames[0], last = frames[frames.length - 1];
            // It starts standing.
            expect(far(first.hips, stand.hips)).toBeLessThan(1e-9);
            for (const r of Object.keys(stand.world)) expect(apart(first.world[r] as Quat, stand.world[r] as Quat)).toBeLessThan(1e-7);
            // And ends standing the same way, about the point under its hips: the feet exactly, the body as near as its springs have come.
            for (let i = 0; i < 2; i++) expect(far(last.ankles[i], about(first.ankles[i], plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            expect(far(last.hips, about(first.hips, plan.pivot as Vec3, deg * D))).toBeLessThan(0.001);
            for (const r of Object.keys(first.world)) expect(apart(last.world[r] as Quat, qmul(spin(deg * D), first.world[r] as Quat))).toBeLessThan(2.5 * D);
        }
    });

    it('takes three steps, the near foot, the far foot, the near foot, and never has both feet up', () => {
        for (const [deg, near] of [[90, 0], [-90, 1], [180, 0], [-180, 1]] as const) {
            const { plan, frames } = turn(deg);
            expect(plan.steps.map((s) => s.foot)).toEqual([near, 1 - near, near]);
            // The far foot goes straight to where it will stand; the near foot gets there with its second step.
            expect(far(plan.steps[1].to.at as Vec3, about(plan.start[1 - near].at as Vec3, plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            expect(far(plan.steps[2].to.at as Vec3, about(plan.start[near].at as Vec3, plan.pivot as Vec3, deg * D))).toBeLessThan(1e-9);
            // Its first step turns it about half the way (a quarter turn a little more: a few degrees and half of the rest).
            const opened = Math.abs(plan.steps[0].to.heading - plan.steps[0].from.heading) / Math.abs(deg * D);
            expect(opened).toBeGreaterThan(0.4);
            expect(opened).toBeLessThan(0.65);
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

    it('looks first: the head leads the chest, the chest the pelvis, and all come round', () => {
        for (const deg of [90, -90, 180]) {
            const { frames } = settled(deg);
            const sign = Math.sign(deg);
            const head = facings(frames, 'head'), chest = facings(frames, 'chest'), hips = facings(frames, 'hips');
            const turned = (v: number[], k: number) => (sign * (v[k] - v[0])) / Math.abs(deg * D);
            const early = frames.findIndex((f) => f.time >= 0.45);
            expect(turned(head, early)).toBeGreaterThan(turned(chest, early) + 0.15);
            expect(turned(chest, early)).toBeGreaterThan(turned(hips, early));
            // By then the head has gone more than half the way and the pelvis a third at most.
            expect(turned(head, early)).toBeGreaterThan(0.5);
            expect(turned(hips, early)).toBeLessThan(0.35);
            // Each is carried a little past by its spring as the feet stop turning, and comes back.
            const end = frames.length - 1;
            for (const v of [head, chest, hips]) {
                expect(Math.max(...v.map((_, k) => turned(v, k)))).toBeLessThan(1.35);
                expect(turned(v, end)).toBeCloseTo(1, 1);
            }
        }
    });

    it('tilts its head as it turns it far: the head turns about an axis that leans', () => {
        const tilt = (deg: number) => { const { frames } = turn(deg); return Math.max(...frames.map((f) => Math.abs(Math.asin(rot(f.world.head as Quat, [1, 0, 0])[1])))); };
        expect(tilt(180)).toBeGreaterThan(4 * D);
        expect(tilt(180)).toBeGreaterThan(tilt(90) * 1.3);
        // With an upright axis, an upright stance and no bow it does not tilt.
        const upright: TurnStyle = { ...TURN_STYLE, side: { ...TURN_STYLE.side, headAxis: 0, nod: [[0, 0.8, 0, 0], [0.5, 2, 0, 0]] }, stance: { ...TURN_STYLE.stance, lean: [0, 0, 0] } };
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
        const still: TurnStyle = { ...TURN_STYLE, counter: 0, side: { ...TURN_STYLE.side, shift: [0, 0, 0] } };
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

    it('turns to the right as in a mirror, where its stance is the same to both sides', () => {
        const even: TurnStyle = {
            ...TURN_STYLE,
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

describe('the chain in time: following a look that moves', () => {
    it('turns the head first and the pelvis last, and settles on the shares', () => {
        const chain = CHAIN_STYLE;
        const D = Math.PI / 180;
        // The look jumps 60 degrees to the left at time 0 and stays.
        const follow = chainFollow(chain, () => chainOf(chain, 60 * D), 8);
        const goal = chainOf(chain, 60 * D);
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

describe('walking along a path: any pace, stops and turns', () => {
    const sk = human();
    const body = measureBody(sk, { roles: rolesOf(sk) });
    const D = Math.PI / 180;
    /** A path from its pace over time and its bend (radians a metre) over distance, `seconds` long. */
    const pathOf = (pace: (t: number) => number, bend: (s: number) => number, seconds: number) => {
        const h = 1 / 480, n = Math.ceil(seconds / h);
        const xs = [0], zs = [0];
        let x = 0, z = 0, s = 0, psi = 0;
        for (let k = 0; k < n; k++) {
            const ds = pace((k + 0.5) * h) * h;
            psi += bend(s + ds / 2) * ds;
            x += Math.sin(psi) * ds; z += Math.cos(psi) * ds; s += ds;
            xs.push(x); zs.push(z);
        }
        return (t: number): Vec3 => {
            const u = Math.min(n, Math.max(0, t / h)), k = Math.min(n - 1, Math.floor(u)), f = u - k;
            return [xs[k] + (xs[k + 1] - xs[k]) * f, 0, zs[k] + (zs[k + 1] - zs[k]) * f];
        };
    };
    /** Sets off at 0.4 s (in half a second), goes at `v`, brakes to rest from `stopAt` in 0.6 s. */
    const goes = (v: number, stopAt: number) => (t: number) => v * minJerk((t - 0.4) / 0.5) * (1 - minJerk((t - stopAt) / 0.6));
    const length = (list: Vec3[]) => list.slice(1).reduce((sum, p, k) => sum + far(p, list[k]), 0);
    const yawOf = (q: Quat) => { const v = rot(q, [0, 0, 1]); return Math.atan2(v[0], v[2]); };
    const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
    const apart = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    /** The most a bone turns between two frames: how far (degrees), which bone, and when (the toes flex fast as a foot rolls: left out). */
    const quickest = (frames: GaitFrame[]) => {
        let most = 0, bone = '', time = 0;
        for (let k = 1; k < frames.length; k++) for (const r of Object.keys(frames[k].world)) {
            if (/Toes$/.test(r)) continue;
            const a = apart(frames[k].world[r] as Quat, frames[k - 1].world[r] as Quat) / D;
            if (a > most) { most = a; bone = r; time = frames[k].time; }
        }
        return { most, bone, time, text: `${bone} ${most.toFixed(1)} degrees at ${time.toFixed(2)} s` };
    };

    it('keeps its legs on its feet along a curve whose pace goes up and down and to nothing', () => {
        const pace = (t: number) => (t < 6 ? goes(1.3, 5.2)(t) * (0.75 + 0.25 * Math.cos(t * 1.3)) : 0);
        const { frames } = walkAlong(body, pathOf(pace, (s) => 0.5 * Math.sin((2 * Math.PI * s) / 6), 9), 9);
        let short = 0, low = Infinity, near = Infinity;
        for (const f of frames) {
            for (let i = 0; i < 2; i++) {
                if (f.stance[i]) short = Math.max(short, f.short[i]);
                low = Math.min(low, f.ankles[i][1]);
            }
            near = Math.min(near, far(f.ankles[0], f.ankles[1]));
        }
        expect(short).toBeLessThan(1e-6);
        expect(low).toBeGreaterThan(body.floor + body.ankleHeight - 0.02);
        expect(near).toBeGreaterThan(0.05);
        // Never a pop: no bone turns far between two frames.
        const quick = quickest(frames);
        expect(quick.most, quick.text).toBeLessThan(15);
    });

    it('does not move a foot that stands flat', () => {
        const { frames } = walkAlong(body, pathOf(goes(1.2, 5), () => 0.2, 8), 8);
        let slid = 0, flat = 0;
        for (let k = 1; k < frames.length; k++) {
            for (let i = 0; i < 2; i++) {
                const a = frames[k - 1], b = frames[k];
                if (!a.stance[i] || !b.stance[i]) continue;
                // Standing flat: its toes point level, in both frames.
                const level = (f: GaitFrame) => Math.abs(rot(f.world[i ? 'rightFoot' : 'leftFoot'] as Quat, [0, 0, 1])[1]) < 1e-4;
                if (!level(a) || !level(b)) continue;
                flat++;
                slid = Math.max(slid, far(a.ankles[i], b.ankles[i]));
            }
        }
        expect(flat).toBeGreaterThan(200);
        expect(slid).toBeLessThan(5e-4);
    });

    it('stops with the last foot to land staying put and the other stepped beside it', () => {
        const stopAt = 5;
        const { plan, frames } = walkAlong(body, pathOf(goes(1.3, stopAt), () => 0, 9), 9);
        // From the end of the braking on: the hips stay where the body stopped along its way, and one ankle never moves.
        const rest = frames.filter((f) => f.time >= stopAt + 0.6);
        const fore = rest.map((f) => (f.hips as Vec3)[2]);
        expect(Math.max(...fore) - Math.min(...fore)).toBeLessThan(0.03);
        const travel = [0, 1].map((i) => length(rest.map((f) => f.ankles[i] as Vec3)));
        expect(Math.min(...travel)).toBeLessThan(1e-3);
        // While the other is stepped beside it, the hips lean to the side toward the foot that stands, no further than over
        // it, and come back (a stop's own shift, STOP_STYLE.shift).
        const stays = travel[0] < travel[1] ? 0 : 1, side = rest.map((f) => (f.hips as Vec3)[0]), end = side[side.length - 1];
        const foot = (rest[0].ankles[stays] as Vec3)[0], most = side.reduce((m, x) => (Math.abs(x - end) > Math.abs(m - end) ? x : m), end);
        expect(Math.sign(most - end)).toBe(Math.sign(foot - end));
        expect(Math.abs(most - end)).toBeGreaterThan(0.02);
        expect(Math.abs(most - end)).toBeLessThan(Math.abs(foot - end));
        // The other one comes beside it by a short step, not a long drag, and lifts as it goes.
        expect(Math.max(...travel)).toBeLessThan(0.3);
        // And it comes up beside it, never back along the way: also braking gently (over 1.3 s), where the walk's lead would
        // put it down past its own place.
        const gently = walkAlong(body, pathOf((t) => 1.3 * minJerk((t - 0.4) / 0.5) * (1 - minJerk((t - stopAt) / 1.3)), () => 0, 9), 9).plan;
        for (const p of [plan, gently]) for (const placed of p.holds) {
            const own = placed.filter((h) => h.own && h.cycle === null && h.on > stopAt), was = placed[placed.indexOf(own[0]) - 1];
            if (own.length && was) expect(own[0].stand.at[2] - was.stand.at[2]).toBeGreaterThan(-0.01);
        }
        const last = frames[frames.length - 1];
        expect(Math.abs(last.ankles[0][2] - last.ankles[1][2])).toBeLessThan(0.05);
        expect(Math.abs(last.ankles[0][0] - last.ankles[1][0])).toBeGreaterThan(0.1);
        expect(Math.abs(last.ankles[0][0] - last.ankles[1][0])).toBeLessThan(0.35);
    });

    it('sets off from standing on a whole step of the walk it gets up to, the foot going forward from the first', () => {
        // (Counted in a slow walk's stride while the body speeds up, its first step was a short one, and the foot swung back
        // first as each moment's walk had it further behind.) Up to its pace in 0.3 s, as the walk's own starts are.
        const { frames } = walkAlong(body, pathOf((t) => 1.3 * minJerk((t - 0.4) / 0.3), () => 0, 4), 4);
        const moved = (i: number) => frames.findIndex((f) => Math.abs((f.ankles[i] as Vec3)[2] - (frames[0].ankles[i] as Vec3)[2]) > 0.01 || (f.ankles[i] as Vec3)[1] - (frames[0].ankles[i] as Vec3)[1] > 0.01);
        const first = moved(0) <= moved(1) ? 0 : 1, from = moved(first);
        let back = 0, lands = from;
        for (let k = from; k < frames.length && !(k > from + 3 && frames[k].stance[first]); k++) {
            back = Math.max(back, (frames[from].ankles[first] as Vec3)[2] - (frames[k].ankles[first] as Vec3)[2]);
            lands = k;
        }
        expect(back).toBeLessThan(0.01);
        const g = gaitFor(body, 1.3, GAIT_STYLE), step = (g.speed * g.stride) / 2;
        const gone = (frames[lands + 1].ankles[first] as Vec3)[2] - (frames[0].ankles[first] as Vec3)[2];
        expect(gone).toBeGreaterThan(0.9 * step);
        expect(gone).toBeLessThan(1.3 * step);
    });

    it('setting off turned, lets the foot that stays go before the pelvis twists past what it can against it', () => {
        // Standing facing +Z, setting off to the left (+X) by a half turn less a little: the right foot stays.
        const way = 170 * D, pace = goes(1.3, 99), h = 1 / 480, seconds = 4, n = Math.ceil(seconds / h);
        const gone = [0];
        for (let k = 0; k < n; k++) gone.push(gone[k] + pace((k + 0.5) * h) * h);
        const path = (t: number): Vec3 => {
            const u = Math.min(n, Math.max(0, t / h)), k = Math.min(n - 1, Math.floor(u)), s = gone[k] + (gone[k + 1] - gone[k]) * (u - k);
            return [Math.sin(way) * s, 0, Math.cos(way) * s];
        };
        const { frames } = walkAlong(body, path, seconds, undefined, undefined, undefined, 60, { pivot: [0, body.floor, 0], heading: 0 });
        let twist = 0;
        for (const f of frames) {
            if (!f.stance[1] || far(f.ankles[1] as Vec3, frames[0].ankles[1] as Vec3) > 0.01) break;
            twist = Math.max(twist, Math.abs(wrap(yawOf(f.world.hips as Quat) - yawOf(f.world.rightFoot as Quat))));
        }
        expect(twist / D).toBeLessThan(START_STYLE.twistMost + 15);
        const quick = quickest(frames);
        expect(quick.most, quick.text).toBeLessThan(20);
    });

    it('coming to rest from a walk, keeps the foot behind down until the body has stopped, then steps it beside the other', () => {
        const stopAt = 5, rests = stopAt + 0.6;
        const { frames } = walkAlong(body, pathOf(goes(1.3, stopAt), () => 0, 9), 9);
        const end = frames[frames.length - 1];
        // The foot stepped beside the other: the one that moves last. It leaves no sooner than the body is at rest.
        const lastMove = [0, 1].map((i) => { let k = frames.length - 1; while (k > 0 && far(frames[k - 1].ankles[i] as Vec3, end.ankles[i] as Vec3) < 1e-4) k--; return k; });
        const behind = lastMove[0] > lastMove[1] ? 0 : 1;
        let k = lastMove[behind];
        while (k > 0 && far(frames[k - 1].ankles[behind] as Vec3, frames[k].ankles[behind] as Vec3) > 1e-5) k--;
        expect(frames[k].time).toBeGreaterThan(rests - 0.05);
        expect(frames[lastMove[behind]].time - frames[k].time).toBeLessThan(0.8);
    });

    it('takes shorter steps when it goes slower, without slowing its legs to a crawl', () => {
        const stepsAt = (v: number) => {
            const { frames } = walkAlong(body, pathOf(goes(v, 12), () => 0, 14), 14);
            // The strikes between 3 s and 9 s, where the pace is steady: each foot's ankle when it lands.
            const strikes: { t: number; z: number }[] = [];
            for (let k = 1; k < frames.length; k++) {
                const f = frames[k];
                if (f.time < 3 || f.time > 9) continue;
                for (let i = 0; i < 2; i++) if (f.stance[i] && !frames[k - 1].stance[i]) strikes.push({ t: f.time, z: f.ankles[i][2] });
            }
            expect(strikes.length).toBeGreaterThan(4);
            const first = strikes[0], last = strikes[strikes.length - 1];
            return { step: (last.z - first.z) / (strikes.length - 1) / 1, rate: (strikes.length - 1) / (last.t - first.t) };
        };
        const quick = stepsAt(1.4), slow = stepsAt(0.6);
        // (The step a foot takes past the other's: the strikes alternate, so this is half a stride's travel in a step.)
        expect(slow.step).toBeLessThan(0.75 * quick.step);
        expect(slow.rate).toBeGreaterThan(0.55 * quick.rate);
        expect(slow.rate).toBeLessThan(quick.rate);
    });

    it('sets off turning toward its way: the body comes round and no bone pops', () => {
        // Standing facing +Z; the path goes off 80 degrees to the left (toward +X).
        const way = 80 * D;
        const pace = goes(1.3, 99);
        const h = 1 / 480, seconds = 6, n = Math.ceil(seconds / h);
        const gone = [0];
        for (let k = 0; k < n; k++) gone.push(gone[k] + pace((k + 0.5) * h) * h);
        const path = (t: number): Vec3 => {
            const u = Math.min(n, Math.max(0, t / h)), k = Math.min(n - 1, Math.floor(u));
            const s = gone[k] + (gone[k + 1] - gone[k]) * (u - k);
            return [Math.sin(way) * s, 0, Math.cos(way) * s];
        };
        const { frames } = walkAlong(body, path, seconds, undefined, undefined, undefined, 60, { pivot: [0, body.floor, 0], heading: 0 });
        const start = yawOf(frames[0].world.hips as Quat), end = yawOf(frames[frames.length - 1].world.hips as Quat);
        expect(Math.abs(start)).toBeLessThan(15 * D);
        expect(Math.abs(wrap(end - way))).toBeLessThan(25 * D);
        // (A foot swinging round to the new way turns fast: what this guards against is a flip, not a quick turn.)
        const quick = quickest(frames);
        expect(quick.most, quick.text).toBeLessThan(20);
    });

    it('goes out, turns on the spot, comes back, stops and turns to its first way: the clip closes on itself', () => {
        // Out 3 m, a rest, then back the way it came: more than half a turn, so it turns on the spot first.
        const pace = (t: number) => (t < 5.2 ? goes(1.2, 2.4)(t) : goes(1.2, 2.4)(t - 5.2));
        const h = 1 / 480, seconds = 9.5, n = Math.ceil(seconds / h);
        const zs = [0];
        let z = 0;
        for (let k = 0; k < n; k++) { const t = (k + 0.5) * h; z += (t < 5.2 ? 1 : -1) * pace(t) * h; zs.push(z); }
        const path = (t: number): Vec3 => { const u = Math.min(n, Math.max(0, t / h)), k = Math.min(n - 1, Math.floor(u)); return [0, 0, zs[k] + (zs[k + 1] - zs[k]) * (u - k)]; };
        const frames = locoPath(body, path, seconds, LOCO_STYLE, undefined, undefined, 60, undefined, undefined, undefined, undefined, undefined, 0);
        const first = frames[0], last = frames[frames.length - 1];
        // Back where it began, standing as it stood.
        expect(far(first.hips, last.hips)).toBeLessThan(0.02);
        for (let i = 0; i < 2; i++) expect(far(first.ankles[i], last.ankles[i])).toBeLessThan(0.03);
        let apartMost = 0;
        for (const r of Object.keys(first.world)) apartMost = Math.max(apartMost, apart(first.world[r] as Quat, last.world[r] as Quat));
        expect(apartMost / D).toBeLessThan(8);
        // Halfway through the rest at the far end it faces back along its way, on the spot.
        const far3 = frames.reduce((a, b) => (b.hips[2] > a.hips[2] ? b : a));
        const turned = frames.filter((f) => f.time > far3.time + 0.5 && f.time < far3.time + 3 && Math.abs(f.hips[2] - far3.hips[2]) < 0.15);
        const yaws = turned.map((f) => Math.abs(wrap(yawOf(f.world.hips as Quat) - 0)));
        expect(Math.max(...yaws)).toBeGreaterThan(150 * D);
        expect(Math.max(...turned.map((f) => far(f.hips, far3.hips)))).toBeLessThan(0.2);
        // No bone pops along the whole of it.
        const quick = quickest(frames);
        expect(quick.most, quick.text).toBeLessThan(20);
    });

    /** When each foot lands: the frames where it stands that it did not stand the frame before. */
    const strikesOf = (frames: GaitFrame[]) => frames.flatMap((f, k) => (k > 0 ? [0, 1].filter((i) => f.stance[i] && !frames[k - 1].stance[i]).map(() => f.time) : []));

    it('sets off into a run where the pace asks for one at once, flies between its footfalls, and brakes to rest on its feet', () => {
        // From standing, up to 4.5 m/s in a quarter second, on, then braking to rest in half a second.
        const pace = (t: number) => 4.5 * minJerk((t - 0.4) / 0.25) * (1 - minJerk((t - 3) / 0.5));
        const { plan, frames } = walkAlong(body, pathOf(pace, () => 0, 5.5), 5.5);
        expect(plan.gaitAt!(2).kind).toBe('run');
        // Running, both feet are off the floor for a while each step.
        expect(frames.filter((f) => f.time > 1.2 && f.time < 2.8 && !f.stance[0] && !f.stance[1]).length).toBeGreaterThan(10);
        // The first step is the run's own: the first footfall comes a run's step after it moves, not a walk's quick shuffle.
        expect(strikesOf(frames)[0] - 0.4).toBeGreaterThan(0.15);
        // At rest, one foot never moves and the hips are still; no standing leg falls short of its foot.
        const rest = frames.filter((f) => f.time >= 4.4);
        expect(length(rest.map((f) => f.hips as Vec3))).toBeLessThan(0.03);
        expect(Math.min(...[0, 1].map((i) => length(rest.map((f) => f.ankles[i] as Vec3))))).toBeLessThan(1e-3);
        let short = 0, shortAt = 0;
        for (const f of frames) for (let i = 0; i < 2; i++) if (f.stance[i] && f.short[i] > short) { short = f.short[i]; shortAt = f.time; }
        expect(short, `a standing leg short at ${shortAt.toFixed(3)} s`).toBeLessThan(1e-6);
        // Setting off, the first foot to swing up is lifted lower than the run's later swings (it had no run behind it).
        const floor = body.floor + body.ankleHeight;
        const swingTop = (foot: number, from: number, to: number) => Math.max(...frames.filter((f) => f.time >= from && f.time < to && !f.stance[foot]).map((f) => f.ankles[foot][1] - floor));
        const pusherLeaves = frames.find((f) => f.time > 0.4 && !f.stance[0] && !f.stance[1])!.time;
        const pusher = frames.find((f) => f.time >= pusherLeaves - 1 / 60 && f.time < pusherLeaves && (f.stance[0] || f.stance[1]))?.stance[0] ? 0 : 1;
        const first = swingTop(pusher, pusherLeaves, pusherLeaves + 0.45), later = swingTop(pusher, 1.5, 2.5);
        expect(first).toBeLessThan(0.75 * later);
    });

    it('running, keeps a leg in the air bent: never snapped straight behind a body that vaults on, as it slows into a walk round a bend', () => {
        // Up to 4.2 m/s, on, then slowing to a walk while the way bends to the left (where a trailing leg out of reach was
        // stretched straight in one frame).
        const pace = (t: number) => 4.2 * minJerk((t - 0.4) / 0.6) - 2.8 * minJerk((t - 2.5) / 1.5);
        const { plan, frames } = walkAlong(body, pathOf(pace, (s) => (s > 8 ? 0.25 : 0), 6), 6);
        let least = Infinity, at = 0, running = 0;
        for (const f of frames) {
            if (plan.gaitAt!(f.time).kind !== 'run') continue;
            for (let i = 0; i < 2; i++) if (!f.stance[i]) { running++; if (f.knees[i] < least) { least = f.knees[i]; at = f.time; } }
        }
        expect(running).toBeGreaterThan(60);
        expect(least / D, `a running leg in the air at ${at.toFixed(3)} s`).toBeGreaterThan(HUMAN_MANNER.kneeLeast - 0.5);
        // (No pop of the legs: the thighs and shins turn no more between two frames than the run's own swing does.)
        let most = 0, which = '';
        for (let k = 1; k < frames.length; k++) for (const r of ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg']) {
            const turned = apart(frames[k].world[r] as Quat, frames[k - 1].world[r] as Quat) / D;
            if (turned > most) { most = turned; which = `${r} at ${frames[k].time.toFixed(3)} s`; }
        }
        expect(most, which).toBeLessThan(15);
    });

    it('brakes from a run on one foot put out ahead, sets the other down as it slows, then steps the first back into its stance', () => {
        // Running at 4.5 m/s, braking to rest from 3 s in under half a second (as a run stops).
        const pace = (t: number) => 4.5 * minJerk((t - 0.4) / 0.25) * (1 - minJerk((t - 3) / 0.45));
        const { frames } = walkAlong(body, pathOf(pace, () => 0, 5), 5);
        const stopsAt = 3.45;
        // The last three footfalls: the one it brakes on, well before the body comes to rest; the foot behind set down soon
        // after; then the first foot again, stepped back into the stance.
        const strikes = strikesOf(frames).filter((t) => t > 2.6 && t < 4.9);
        const [last, beside, back] = strikes.slice(-3);
        expect(stopsAt - last).toBeGreaterThan(0.12);
        expect(beside - last).toBeLessThan(0.3);
        expect(back).toBeGreaterThan(beside);
        // The first foot landed ahead of where it ends up standing (along the way, +z).
        const at = (t: number) => frames.find((f) => f.time >= t - 1e-9)!;
        const braker = at(last).stance[0] && !frames[frames.indexOf(at(last)) - 1].stance[0] ? 0 : 1;
        expect(at(last + 0.05).ankles[braker][2] - frames[frames.length - 1].ankles[braker][2]).toBeGreaterThan(0.05);
        // From the last footfall on, a foot is always on the floor (the body brakes on it, no hop).
        expect(frames.filter((f) => f.time >= last && !f.stance[0] && !f.stance[1]).length).toBe(0);
        // Before it, no longer in the air than a run's own flight.
        let air = 0, most = 0;
        for (const f of frames) { if (f.time > 2.6 && f.time < last && !f.stance[0] && !f.stance[1]) air += 1 / 60; else { most = Math.max(most, air); air = 0; } }
        expect(most).toBeLessThan(0.25);
        // The body does not rise over its standing height on the way.
        const standing = frames[frames.length - 1].hips[1];
        expect(Math.max(...frames.filter((f) => f.time > 2.6).map((f) => f.hips[1]))).toBeLessThan(standing + 0.01);
    });

    it('goes over from a run to a walk at a footfall once the pace falls below the walk’s top', () => {
        // Running at 4 m/s, slowing to 1.2 m/s from 3 s in two thirds of a second, on walking.
        const pace = (t: number) => (t < 3 ? 4 * minJerk((t - 0.4) / 0.4) : 4 - 2.8 * minJerk((t - 3) / 0.7));
        const { plan, frames } = walkAlong(body, pathOf(pace, () => 0, 7), 7);
        expect(plan.gaitAt!(2.5).kind).toBe('run');
        expect(plan.gaitAt!(6).kind).toBe('walk');
        // Where it goes over, the body flies no more: walking, a foot is always down.
        expect(frames.filter((f) => f.time > 5 && !f.stance[0] && !f.stance[1]).length).toBe(0);
        let short = 0, shortAt = 0;
        for (const f of frames) for (let i = 0; i < 2; i++) if (f.stance[i] && f.short[i] > short) { short = f.short[i]; shortAt = f.time; }
        expect(short, `a standing leg short at ${shortAt.toFixed(3)} s`).toBeLessThan(1e-6);
    });
});

describe('rolling a foot on its heel', () => {
    it('finds the pitch that makes the leg reach where the hip is nearest the ankle part of the way up the roll', () => {
        // The ankle turns about the heel; with the hip over it the ankle comes nearest the hip partway up, and further again
        // beyond (a body with high ankles and a short heel). Looking only at the end of the range misses the pitch that reaches
        // and stands the foot on end.
        const heel = [{ x: 0, z: 0, at: 0, from: 0, to: Math.PI / 2, len: 0.12, rise: 1.2 }];
        const want = 0.68;
        const r = rollTo(heel, false, -0.22, 0.76, 0, want, 0);
        expect(r.tight).toBe(false);
        expect(r.far).toBeCloseTo(want, 6);
        expect(r.rise).toBeLessThan(0.5);
        // A leg that cannot reach at any pitch is still rolled as far as it goes.
        expect(rollTo(heel, false, -0.22, 0.76, 0, 0.5, 0).tight).toBe(true);
    });
});
