// A guarded walk: walking while the head is kept to what one faces (a fight), whichever way the feet go.
//
// The body does not sidle. It turns toward a line and walks along it, forward or backward, a slow
// walk on bent knees; the pelvis stays turned part of the way back to what it faces, the feet set
// wide and turned with it, the chest further back, and the head looks there as far as the neck and
// the spine let it. The arms hang more than they swing.
//
//   the walk      walkGuard    the level walk (gait.ts) at the guard's pace, its knees bent more,
//                              carried along the line (carry.ts): forward, or backward (the same
//                              walk run the other way: a foot then lands on its forefoot and leaves
//                              from its heel)
//   the lines     GuardLine    how the body is turned for the line toward what it faces, the lines
//                              to its left and to its right, and the line away from it; a way in
//                              between has what the two lines next to it have, in proportion
//   on the spot   stepGuard    the feet lifted in turn where they stand on guard, the weight going
//                              over to the foot that stays
//
// The formulas, how their values were fitted and which to change for which look: editor/MOTION.md.

import { add, dot, rotate, scale, sub, type V3 } from '../rigMotion';
import type { Body } from './body';
import { carryFrames, type CarryPlan, type Hold } from './carry';
import { GAIT_STYLE, gaitFor, type Gait, type GaitFrame, type GaitStyle, type Vault } from './gait';
import { axisAngle, DEG, GRAVITY } from './tools';
import { stanceFeet, standFrame, TURN_STYLE, type Stance, type TurnStyle } from './turn';

/** How the body is turned as it walks along a line. Degrees, to the left above zero. */
export interface GuardLine {
    /** The pelvis against the line. */
    turn: number;
    /** The chest against the pelvis; the head against what it looks at (it does not get all the way round where the body walks away). */
    chest: number;
    head: number;
    /** The feet against the line: the left and the right. */
    feet: [number, number];
    /** The pelvis lists (its left side up) throughout. */
    list: number;
}

/** The numbers of the guarded walk one way: the body going forward along its line, or backward. */
export interface GuardGait {
    /** The walk's phase at the first frame, strides (0: the left heel strikes; going backward the phase runs down). */
    phase: number;
    /**
     * A foot in the air turns out and back over what the walk turns it: degrees at most, the left foot and the right,
     * and when (share of its time in the air); its path bows out to its side, share of hip height. A standing knee is
     * bent more than the walk's: as the heel strikes, and through the rest of the stance, degrees.
     */
    swingTurn: [number, number, number];
    out: number;
    knee: [number, number];
    /** How much of the walk's lift a foot in the air keeps, and of the walk's pitch of it. */
    swing: [number, number];
    /** The hips ride lower than the walk's, share of hip height; the footfalls are set further apart, each side; the hips go to the left of the line, share of hip height. */
    sink: number;
    wide: number;
    aside: number;
    /**
     * With each step, over the walk's own: the hips rise and fall, and go to and fro along the line: share of hip height,
     * and when they are highest, furthest along (share of a step after a heel would strike); and where they are along
     * the line throughout (share of hip height, forward above zero).
     */
    bob: [number, number];
    surge: [number, number, number];
    /** The pelvis tips forward, the spine curls forward over it (at the chest), the head nods down: degrees. */
    bow: number;
    curl: number;
    nod: number;
    /** The chest pitches forward with each step: degrees, and when most (share of a step after a heel would strike). */
    pitch: [number, number];
    /** The pelvis lists (its left side up) once a stride, over what the walk has: degrees, and when it is so most (share of a stride after the left heel would strike). */
    list: [number, number];
    /** The pelvis turns (to the left) once a stride, over what the walk has: degrees, and when most. */
    yaw: [number, number];
    /** How much of the walk's arm swing is kept: the rest hangs as standing. The arms are held further out, more bent at the elbow, further forward: degrees. */
    armShare: number;
    armOut: number;
    elbow: number;
    armFore: number;
    /** The body turned for each line: toward what it faces, to the left of it, to the right of it, away from it. */
    front: GuardLine;
    left: GuardLine;
    right: GuardLine;
    back: GuardLine;
}

/** The numbers of stepping on the spot. */
export interface GuardStep {
    /** When each foot leaves the floor, share of the round (left, right), and for what share of it each is in the air. */
    lift: [number, number];
    air: number;
    /** How high the ankle goes, share of leg length; how much of that is the heel lifting. */
    rise: number;
    heel: number;
    /**
     * The hips go over toward the foot that stays: share of the way from between the feet to it, as the left foot is
     * in the air and as the right is. Meanwhile they rise, and come forward the way the pelvis faces: shares of hip height.
     */
    shift: [number, number];
    bob: number;
    surge: number;
    /** Where the hips stand over and above the standing pose's, to the left and forward: shares of hip height. */
    hips: [number, number];
}

/** The numbers of a guarded walk. */
export interface GuardStyle {
    /** How fast it goes: metres a second over the square root of gravity times hip height. */
    pace: number;
    /** Its steps are this much quicker than the walk's own at that speed. */
    quick: number;
    forward: GuardGait;
    backward: GuardGait;
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
    /** Standing on guard (the stance's own forward is what it faces), and stepping on the spot in it. */
    stance: Stance;
    step: GuardStep;
}

export const GUARD_STYLE: GuardStyle = {
    pace: 0.32,
    quick: 1,
    forward: {
        phase: 0.25, swingTurn: [15, 14, 0.3], out: 0.009, knee: [11, 8.5], swing: [1, 0.9], sink: 0, wide: 0.045, aside: -0.02,
        bob: [0.005, 0.65], surge: [0.003, 0.18, -0.013], bow: -3, curl: 11, nod: 14, pitch: [0.6, 0.15], list: [0.55, 0.09], yaw: [-4.5, 0.35],
        armShare: 0.45, armOut: 1, elbow: 4.5, armFore: -3.5,
        front: { turn: -13, chest: -6.5, head: -2.3, feet: [-1.5, -9], list: -4.2 },
        left: { turn: -22, chest: -22, head: 5, feet: [-6.5, -30], list: -3.3 },
        right: { turn: 14, chest: 27, head: -0.6, feet: [35, 7], list: -3 },
        back: { turn: 35, chest: 23, head: -65, feet: [37, 17], list: 0.6 },
    },
    backward: {
        phase: 0.27, swingTurn: [-9, -4.5, 0.3], out: 0.02, knee: [12, 7], swing: [1, 0.45], sink: 0.01, wide: 0.045, aside: -0.025,
        bob: [0.014, 0.55], surge: [0.028, 0.4, -0.014], bow: -2.3, curl: 12, nod: 12, pitch: [-3, 0.43], list: [-2.8, 0.25], yaw: [1.7, -0.16],
        armShare: 0.3, armOut: 1, elbow: 6.5, armFore: -2.5,
        front: { turn: -12, chest: -6.5, head: -1.8, feet: [-0.13, -17], list: 0.8 },
        left: { turn: -23, chest: -20, head: 6.5, feet: [-0.55, -18], list: 0.7 },
        right: { turn: 16, chest: 15, head: -4.5, feet: [35, 3.5], list: 0.7 },
        back: { turn: 55, chest: 20, head: -42, feet: [65, 22], list: 0.07 },
    },
    kneeFollow: 0.5,
    stance: {
        feet: [{ side: 0.065, fore: 0.05, out: -55 }, { side: -0.0045, fore: -0.09, out: 85 }],
        drop: 0.045, facing: [-70, -55, -2.5], lean: [-2.8, 8.5, 13], list: -1,
        arms: [{ out: 16, fore: -5, elbow: 18 }, { out: 20, fore: -7, elbow: 21 }],
    },
    step: { lift: [0.28, 0.8], air: 0.5, rise: 0.09, heel: 1, shift: [0.4, 0.05], bob: 0.027, surge: 0.025, hips: [0.03, -0.016] },
};

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** How the body is turned for a line that goes `dir` radians to the left of what it faces: the four lines' numbers, in proportion between two of them. */
export function guardLine(way: GuardGait, dir: number): GuardLine {
    const quarter = (((dir / (Math.PI / 2)) % 4) + 4) % 4;
    const lines = [way.front, way.left, way.back, way.right];
    const a = Math.floor(quarter) % 4, f = quarter - Math.floor(quarter);
    const p = lines[a], q = lines[(a + 1) % 4];
    const mix = (x: number, y: number) => x + (y - x) * f;
    return { turn: mix(p.turn, q.turn), chest: mix(p.chest, q.chest), head: mix(p.head, q.head), feet: [mix(p.feet[0], q.feet[0]), mix(p.feet[1], q.feet[1])], list: mix(p.list, q.list) };
}

/** The walk the guard goes at: the level walk at its pace, its steps quicker (and the gait style it is made with). */
export function guardGait(body: Body, style: GuardStyle = GUARD_STYLE, gaitStyle: GaitStyle = GAIT_STYLE): { gait: Gait; gaitStyle: GaitStyle } {
    const speed = style.pace * Math.sqrt(GRAVITY * body.hipHeight);
    const rate = gaitStyle.walk.rate;
    const quick: GaitStyle = { ...gaitStyle, walk: { ...gaitStyle.walk, rate: [rate[0] * style.quick, rate[1] * style.quick] } };
    return { gait: gaitFor(body, speed, quick), gaitStyle: quick };
}

/** The same walk with the guard's own feet in the air and knees: as long and as quick, only posed otherwise. */
function guarded(g: Gait, way: GuardGait): Gait {
    const how = g.mode.support as Vault;
    const [strike, k] = way.knee;
    const support: Vault = { ...how, kneeStrike: [how.kneeStrike[0] + strike, how.kneeStrike[1]], kneeLoad: [how.kneeLoad[0] + k, how.kneeLoad[1]], kneeLeast: how.kneeLeast + k, kneeToeOff: how.kneeToeOff + k };
    return { ...g, mode: { ...g.mode, swingOut: way.out, support } };
}

/**
 * A guarded walk toward `travel` (radians to the left of what the body faces), the body going
 * forward along its way or backward: one stride of it as `count` + 1 frames (the last is the
 * first again), given in place, seen as facing what it guards against.
 */
export function walkGuard(
    body: Body, travel: number, backward: boolean, count = 80,
    style: GuardStyle = GUARD_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const { up, fwd, left } = body;
    const way = backward ? style.backward : style.forward;
    const { gait: plain, gaitStyle: walked } = guardGait(body, style, gaitStyle);
    const g = guarded(plain, way);
    const stride = g.speed * g.stride;
    const L = body.hipHeight;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    // The line the body is turned to: the way it goes, or the way it backs off from.
    const dir = wrap(backward ? travel - Math.PI : travel), going = backward ? -1 : 1;
    const line = guardLine(way, dir);
    const ahead = add(scale(fwd, Math.cos(dir)), scale(left, Math.sin(dir)));
    const across = rotate(axisAngle(up, dir), left);
    const wayAt = (gone: number) => ({ at: add(origin, scale(ahead, gone)), heading: dir });
    const travelled = (t: number) => going * g.speed * t;
    const phase = (t: number) => way.phase + (going * t) / g.stride;
    const holds: [Hold[], Hold[]] = [[], []];
    for (let foot = 0; foot < 2; foot++) {
        const sign = foot ? -1 : 1;
        for (let n = -3; n <= 4; n++) {
            // In the order they come: going backward the walk's strides are gone through the other way, and a foot stands
            // from where the walk's would leave to where it would strike.
            const cycle = going * n;
            const strike = cycle + 0.5 * foot, leave = strike + g.duty;
            const along = stride * (strike - way.phase) + g.lead;
            holds[foot].push({
                on: going * ((backward ? leave : strike) - way.phase) * g.stride,
                off: going * ((backward ? strike : leave) - way.phase) * g.stride,
                stand: {
                    at: add(wayAt(along).at, scale(across, sign * (g.width / 2 + way.wide * L))),
                    heading: dir + line.feet[foot] * DEG,
                },
                cycle, own: false, along,
                soft: [way.swing[0], way.swing[1]],
                twist: [way.swingTurn[foot] * DEG, way.swingTurn[2]],
            });
        }
    }
    const facing = line.turn * DEG;
    /** Steps since the left heel would strike (going backward they count down). */
    const steps = (t: number) => 2 * phase(t);
    const plan: CarryPlan = {
        seconds: g.stride, loop: true, gait: g, origin, way: wayAt, travelled, phase,
        blend: () => 1,
        armBlend: () => way.armShare,
        facing: () => facing,
        stand: standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: 0, placeLift: turnStyle.lift, heel: turnStyle.heel,
        bow: () => way.bow * DEG, headBow: 0,
        curl: (t) => (way.curl + way.pitch[0] * Math.cos(2 * Math.PI * (steps(t) - way.pitch[1]))) * DEG,
        nod: () => way.nod * DEG,
        // The chest part of the way back to what the body faces; the head all the way, as far as it gets.
        look: () => [line.chest * DEG, wrap(line.head * DEG - (dir + facing))],
        pelvis: (t) => [
            (line.list + way.list[0] * Math.cos(2 * Math.PI * (phase(t) - way.list[1]))) * DEG,
            way.yaw[0] * Math.cos(2 * Math.PI * (phase(t) - way.yaw[1])) * DEG,
        ],
        arms: () => [[way.armOut * DEG, way.elbow * DEG, way.armFore * DEG], [way.armOut * DEG, way.elbow * DEG, way.armFore * DEG]],
        lean: (t) => {
            const n = steps(t);
            const high = -way.sink * L + way.bob[0] * L * Math.cos(2 * Math.PI * (n - way.bob[1]));
            const on = (way.surge[2] + way.surge[0] * Math.cos(2 * Math.PI * (n - way.surge[1]))) * L;
            return add(add(scale(up, high), scale(ahead, on)), scale(across, way.aside * L));
        },
        pushKnee: 0,
    };
    // In place: every frame seen from where the body is on its way (still facing what it guards against).
    const frames = carryFrames(body, plan, walked, count / g.stride).map((f) => {
        const here = wayAt(f.travel);
        const seen = (p: V3): V3 => add(origin, sub(p, here.at));
        return { ...f, travel: 0, hips: seen(f.hips), ankles: [seen(f.ankles[0]), seen(f.ankles[1])] as [V3, V3] };
    });
    return { plan, frames };
}

/**
 * Stepping on the spot, on guard: one round of it (each foot lifted once) as `count` + 1 frames,
 * the last the first again. A round takes as long as a stride of the guarded walk.
 */
export function stepGuard(
    body: Body, count = 80,
    style: GuardStyle = GUARD_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const { up } = body;
    const { gait: g, gaitStyle: walked } = guardGait(body, style, gaitStyle);
    const round = g.stride;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const pivot = add(origin, scale(up, body.floor));
    const standing: TurnStyle = { ...turnStyle, stance: style.stance };
    const stand = standFrame(body, standing);
    const feet = stanceFeet(body, style.stance, pivot);
    const step = style.step;
    const holds: [Hold[], Hold[]] = [[], []];
    for (let foot = 0; foot < 2; foot++) {
        for (let n = -2; n <= 3; n++) {
            const lift = (step.lift[foot] + n) * round;
            // It stands from when it came down the round before until it is lifted.
            holds[foot].push({ on: lift - (1 - step.air) * round, off: lift, stand: feet[foot], cycle: null, own: true });
        }
    }
    /** How far through its time in the air a foot is (0 to 1), or -1 on the floor. */
    const inAir = (foot: number, t: number) => {
        const since = (((t / round - step.lift[foot]) % 1) + 1) % 1;
        return since < step.air ? since / step.air : -1;
    };
    const hump = (v: number) => Math.sin(Math.PI * v) ** 2;
    const between = scale(add(feet[0].at, feet[1].at), 0.5);
    const facingWay = style.stance.facing[0] * DEG;
    const ahead = add(scale(body.fwd, Math.cos(facingWay)), scale(body.left, Math.sin(facingWay)));
    const plan: CarryPlan = {
        seconds: round, loop: true, gait: g, origin,
        travelled: () => 0,
        phase: () => 0,
        blend: () => 0,
        facing: () => 0,
        stand,
        holds,
        kneeFollow: style.kneeFollow, standKnee: turnStyle.kneeFollow, placeLift: step.rise, heel: step.heel,
        bow: () => 0, headBow: 1,
        // The weight goes over to the foot that stays, and the hips rise a little as the other is in the air.
        lean: (t) => {
            let over: V3 = [0, 0, 0], high = 0;
            for (let foot = 0; foot < 2; foot++) {
                const u = inAir(foot, t);
                if (u < 0) continue;
                const to = sub(feet[1 - foot].at, between);
                over = add(add(over, scale(sub(to, scale(up, dot(to, up))), step.shift[foot] * hump(u))), scale(ahead, step.surge * body.hipHeight * hump(u)));
                high += step.bob * body.hipHeight * hump(u);
            }
            const still = add(scale(body.left, step.hips[0] * body.hipHeight), scale(body.fwd, step.hips[1] * body.hipHeight));
            return add(add(over, still), scale(up, high));
        },
        pushKnee: 0,
    };
    return { plan, frames: carryFrames(body, plan, walked, count / round) };
}
