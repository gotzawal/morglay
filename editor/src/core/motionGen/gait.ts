/// Gaits made from formulas alone: no clip, no stored pose. A gait is put together from a few
// general pieces, each meant to be used again for other motion:
//
//   the body      body.ts    its lengths, its sole, what its joints can do
//   curves        tools.ts   the smoothest move between two states (`move`), by way of a place
//                            (`viaCurve`); a wave once a cycle (`wave`)
//   contact       sole.ts    a sole rolling on the floor without slipping
//   limbs         limbs.ts   a leg by two-bone IK, a foot turned and pitched, an arm from its
//                            upper arm's way and its elbow's bend, a chain leaned to reach a place
//
// and, in this file, in the order they depend on each other (contacts first):
//
//   the steps     gaitFor      speed ─► cadence, step, stance share (dimensionless: Froude number)
//   the feet      footModel    a standing foot rolls heel, flat, forefoot; a swinging one goes the
//                              smoothest way from how it left the floor to how it meets it
//   the support   vault        the body carried over a leg kept long: the standing knee follows
//                              a course, and the hips' height comes from it
//   the pelvis    pelvisModel  sway, turn and list as waves; surge
//   the rest      gaitCycle    legs by two-bone IK, turned about the upright together; the chest
//                              and the head keep their own places to the side, and the spine and
//                              the neck lean to join what sways under them to them (the same
//                              way a leg joins a hip to a foot); then the head's nod, the arms
//
// What gives a gait its look is a set of numbers (GAIT_STYLE): shares of the body's own size,
// angles, shares of the stride. A planted foot does not move: sliding is not corrected, it
// cannot happen. Every length is a share of the body's own, so a body k times as tall going
// √k times as fast takes the same pose.
//
// The formulas, how their values were fitted and which to change when something looks wrong:
// editor/MOTION.md.

import type { Body } from './body';
import { armBones, footTurn, kneeFor, leanToJoin, legPose, legSpan } from './limbs';
import { rolled, rollTo, soleRoll } from './sole';
import { add, cross, dot, normalize, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import { axisAngle, bridge, clamp, DEG, GRAVITY, lerp, minJerk, move, quintic, slerp, viaCurve, wave } from './tools';

/**
 * A wave once a stride: how big it is, when it is at its most (as a share of the stride after
 * the left heel strikes), and its third harmonic riding on it (its size as a share of the
 * first, and when it peaks). One wave alone rises and falls evenly; the third lets it rise
 * fast and come back slowly, or flattens its top.
 */
export interface Wave {
    size: number;
    at: number;
    third?: [number, number];
}

/**
 * The body carried over a leg kept long (a walk): the standing knee follows a set course and
 * the hips' height comes from it (core/motionGen/gait.ts vault).
 */
export interface Vault {
    how: 'vault';
    /**
     * The standing knee's bend, degrees: as the heel strikes and when it has taken the weight
     * (each [0] + [1]·√Fr: it gives more the faster it goes), at its straightest, and as the
     * toes leave (or the most the foot's rise lets it bend).
     */
    kneeStrike: [number, number];
    kneeLoad: [number, number];
    kneeLeast: number;
    kneeToeOff: number;
    /** When, as shares of stance: the weight is on (the first bend at its most), and the knee is straightest. */
    loadAt: number;
    leastAt: number;
    /** How the knee straightens between those two: 1 evenly, above 1 late. */
    ease: number;
    /**
     * How fast the hips are still sinking as a heel strikes, as a share of the body's speed
     * (0: they are at their lowest just then). A little of it carries the fall on into the new
     * leg, so the body comes down longer and more gently and turns upward only once the weight
     * is coming on.
     */
    sink: number;
    /** The hips' fore-aft surge, as a share of an inverted pendulum's between the footfalls, and when they are farthest ahead (share of the stride after a strike). */
    surge: number;
    surgeAt: number;
}

/** A gait's numbers: its steps, how the body is carried, the swing, the pelvis, the chest and head, the arms. */
export interface GaitMode {
    // ---- The steps.
    /** Stance share of the stride: duty[0] − duty[1]·√Fr. */
    duty: [number, number];
    /** Steps a second · √(hip height / g) = rate[0] + rate[1]·√Fr. */
    rate: [number, number];
    /** The ankle ahead of the hips as its heel strikes, as a share of the step. */
    lead: number;
    /** Step width over hip height. */
    width: number;
    /** Foot pitch at the strike, as a share of the legs' swing angle (toes up). */
    strike: number;
    /** The most the pelvis may sink below standing, as a share of the leg: the step shortens instead. */
    maxDrop: number;

    // ---- How the body is carried.
    support: Vault;

    // ---- The swing (core/motionGen/gait.ts footModel).
    /** The ankle's lift in mid-swing over the leg's length: lift[0] + lift[1]·√Fr; and the share of the swing at which it is highest. */
    lift: [number, number];
    liftAt: number;
    /** How far the swinging foot bows out round the standing one, over hip height, and the share of the swing at which it is farthest out. */
    swingOut: number;
    outAt: number;
    /** The share of the swing at which the ankle passes under its hip (0: wherever the smoothest way puts it). */
    passAt: number;
    /**
     * How hard the leg is drawn forward as the toes leave: 0, the foot leaves as it was going
     * (left behind first, thrown on late); 1, it is already speeding up as it
     * leaves, as much as the smoothest swing asks (drawn through at once). Too little in a walk
     * and the leg waits, then snaps forward.
     */
    swingPull: number;
    /**
     * A foot thrown ahead and pulled back before it lands: the share of the swing
     * at which the ankle is farthest ahead of its hip. From there it slows evenly to its
     * landing speed. (0: it is farthest ahead as it lands.)
     */
    reachAt: number;
    /** How the foot arrives: the ankle's speed forward as the heel strikes, as a share of the body's, and downward, over √(g·hip height). */
    strikeSpeed: number;
    land: number;

    // ---- The pelvis. Sizes of turns are shares of the legs' swing angle.
    /** Its swing to each side over the standing foot, over hip height (toward the left at its most). */
    sway: Wave;
    /** Its turn about the upright (to the left at its most: the right side forward). */
    yaw: Wave;
    /** Its list (the left side up at its most: the swinging right side sinks as the left foot takes the weight). */
    list: Wave;
    /** Its tip forward at each footfall. */
    pelvisTilt: number;
    /**
     * The legs' turn about the upright, as a share of the legs' swing angle (to the left at
     * its most). Both legs turn the same way at once: the one ahead has its knee turned toward
     * the other, the one behind away from it. With none the knees face straight ahead whatever
     * the pelvis does, and its turning cannot be seen in the legs.
     */
    legTurn: Wave;
    /**
     * A foot in the air turns its toes out as it goes round the standing leg and back before
     * it lands: how far at the most (degrees), and when in its swing (0 to 1). It leaves and
     * lands at its own heading.
     */
    swingTurn: [number, number];

    // ---- The chest and the head.
    /** The chest's twist about its own length (to the left at its most), against the pelvis. */
    chest: Wave;
    /** How far the chest rolls with its twist, as a share of it (the forward shoulder up; below zero, down). */
    chestRoll: number;
    /**
     * The chest gives with each step: how far its lean comes and goes (degrees each way), and
     * when it leans most, as a share of the stride after a strike. Leaning most where the hips
     * are highest, it takes some of the bob out of the head; leaning back as the hips surge
     * ahead, it takes up their fore and aft instead of passing it on.
     */
    nod: [number, number];
    /**
     * The head: its share of the chest's twist, of the chest's list (how far the chest ends up
     * tipped to the side, by its roll and by twisting while it leans), and of its lean. It
     * stays nearly level, eyes ahead.
     */
    headFollow: number;
    headRoll: number;
    headLean: number;
    /**
     * The head's own nod with each step: how far it tips (degrees each way), and when it tips
     * forward most, as a share of the stride after a strike. It tips forward about when it is
     * highest and back as the foot lands: what keeps the eyes on a point ahead while the body
     * bobs. The neck takes its part of it (`neck`).
     */
    headNod: [number, number];
    /** The head's own tilt to the side once a stride: how far (degrees each way), and when its left side is highest, as a share of the stride. */
    headTilt: [number, number];
    /**
     * The head's own sway: where the head's joint is to the side (to the left at its most), as
     * a share of the hip height. The neck leans sideways to join the chest to it, as the spine
     * does for the chest. Left out: the neck stays between the chest's turn and the head's.
     */
    headSway?: Wave;
    /**
     * The chest's own sway: where the top of the spine is to the side (to the left at its
     * most), as a share of the hip height. The bones between the pelvis and the chest lean
     * sideways to join the swaying hips to it, bending as little as they can at each joint.
     * A chest that sways less than the hips stays over the line while the hips move under
     * it: that is what shows the pelvis moving. Left out: the spine is shared evenly and the
     * chest sways as that leaves it.
     */
    chestSway?: Wave;
    /** Where the neck is between the chest's turn and the head's: 0 with the chest, 1 with the head. */
    neck: number;

    // ---- The arms.
    /** How much of the chest's twist the arms' swing takes: 0, they swing in the body's fore and aft; 1, in the chest's own (the hand comes across the body in front, the elbow goes in behind it). */
    armFollow: number;
    /** How late the arms swing behind the legs, as a share of the stride (below zero: ahead of them). */
    armLag: number;
    /** The swing as a share of the legs' swing angle; its middle, as a share of the swing (below zero: behind the body). */
    arm: number;
    armBias: number;
    /**
     * How far the arm hangs out from the side, and how far its swing is turned inward, degrees.
     * `armLoop`: how much further out it is going forward than coming back, degrees each way:
     * the hand goes round a narrow loop instead of to and fro along one line.
     */
    armOut: number;
    armIn: number;
    armLoop: number;
    /**
     * The elbow's bend, degrees, and what the forward end adds. `elbowSnap` 1: it bends evenly
     * with the swing; above 1: in a pulse as the arm comes forward (a pumping arm); below 1:
     * it stays bent through most of the stride and straightens only briefly at the back (a
     * loose arm: the forearm is carried forward, hangs behind on the way back, and is flung
     * straight as the upper arm turns round).
     */
    elbow: [number, number];
    elbowSnap: number;
    /** How late the elbow's bend follows the upper arm, and the hand the forearm (shares of the stride; below zero the elbow leads: a pumping arm). */
    elbowLag: number;
    wristLag: number;
    /** How far the hand is carried on past the forearm at each end of the swing, as a share of the arm's swing (its own weight takes it there). */
    wristFlick: number;
    /** How far each shoulder goes forward and back, as a share of the arm's swing: it comes forward with the hand, a little after the upper arm. */
    shoulderGive: number;
}

export interface GaitStyle {
    /** Toe-out, degrees: toeOut[0] − toeOut[1]·√Fr, not below 0. */
    toeOut: [number, number];
    /** The sole's clearance in swing, over hip height. */
    clearance: number;
    /** Lean of the chest and of the pelvis, degrees forward: each [0] + [1]·√Fr, not below 0 (leaning more the faster it goes). */
    lean: [number, number];
    pelvisLean: [number, number];
    /** The widest an arm swings to each side, degrees. */
    armMost: number;
    walk: GaitMode;
}

/**
 * The defaults. Each is a share of the body's own size, an angle or a share of the stride;
 * none is a pose or a curve taken from a clip. Their values were set so that the walk they
 * make measures close to a stylised walk (editor/MOTION.md).
 */
export const GAIT_STYLE: GaitStyle = {
    toeOut: [1, 0],
    clearance: 0.015,
    lean: [-23, 30],
    pelvisLean: [-23, 27],
    armMost: 60,
    walk: {
        duty: [0.6, 0.18], rate: [0.22, 0.75], lead: 0.4, width: 0.02, strike: 0.75, maxDrop: 0.1,
        support: { how: 'vault', kneeStrike: [13, 8], kneeLoad: [14, 32], kneeLeast: 12, kneeToeOff: 16, loadAt: 0.35, leastAt: 0.8, ease: 1.3, sink: 0.05, surge: 0.8, surgeAt: 0.17 },
        lift: [0.09, 0.08], liftAt: 0.38, swingOut: 0.045, outAt: 0.35, passAt: 0.6, swingPull: 1, reachAt: 0, strikeSpeed: 1.6, land: 0,
        sway: { size: 0.015, at: 0.2, third: [0.12, 0.15] }, yaw: { size: 0.18, at: 0.45, third: [0.12, 0.15] }, list: { size: 0.095, at: 0.18, third: [0.33, 0.15] }, pelvisTilt: 0.11, legTurn: { size: 0.17, at: 0.5 }, swingTurn: [8, 0.45],
        chest: { size: 0.2, at: 0.003, third: [0.11, 0.014] }, chestRoll: -0.15, nod: [1.2, 0.35], headFollow: 0.15, headRoll: 0, headLean: 0.5, headNod: [1.3, 0.23], headTilt: [0.6, 0.35], headSway: { size: 0.002, at: 0.3 }, chestSway: { size: 0.0019, at: 0.35 }, neck: 0.9,
        armFollow: 0, armLag: 0.022, arm: 0.6, armBias: -0.14, armOut: 16, armIn: 4, armLoop: 2, elbow: [4, 18], elbowSnap: 0.7, elbowLag: 0.09, wristLag: 0.03, wristFlick: 0.16, shoulderGive: 0.23,
    },
};

/** A gait at one speed: its numbers. */
export interface Gait {
    speed: number;
    /** The numbers that make it. */
    mode: GaitMode;
    /** v² / (g · hip height). */
    froude: number;
    /** Metres from one footfall to the next, and seconds. */
    step: number;
    stepTime: number;
    /** Seconds of a stride (two steps). */
    stride: number;
    /** Stance share of the stride. */
    duty: number;
    width: number;
    /** Radians. */
    toeOut: number;
    /** Where the foot will stand flat, ahead of the hips as its heel strikes, metres. */
    lead: number;
    /** The legs' swing angle: asin(step / 2·leg), radians. */
    swing: number;
    strikePitch: number;
    /** How far the pelvis sinks below standing at its lowest, metres. */
    drop: number;
}

/** One instant of a gait: where the body is, in model space, travelling along its forward. */
export interface GaitFrame {
    time: number;
    /** How far the body has travelled: take it off the hips for a clip that stays in place. */
    travel: number;
    /** The hips joint. */
    hips: V3;
    /** World turn from the reference pose, by role. */
    world: Record<string, Quat>;
    /** Left and right: the ankle, whether the foot stands, the sole point it stands on (null: flat or in the air). */
    ankles: [V3, V3];
    stance: [boolean, boolean];
    pivots: [V3 | null, V3 | null];
    /** How far each ankle fell short of where the foot should be (a leg too short to reach): zero in a sound gait. */
    short: [number, number];
    /** Each knee's bend, radians (0: straight). */
    knees: [number, number];
}

const SIDE = [1, -1];
const LEG = ['left', 'right'] as const;
/** An end left free (tools.ts move): pushed off, or stopped by what it meets. */
const FREE = NaN;
/** On its forefoot a foot never comes nearer than this to pointing at the hip, radians (past it, it could rise no further). */
const TOE_SLACK = 25 * DEG;

interface FootState {
    /** The ankle from where it stands flat. */
    rel: V3;
    /** Toes up, radians: the foot, and its toes (the same where they do not bend). */
    pitch: number;
    toes: number;
    /** The sole point on the floor it turns about, from the flat ankle (null: flat). */
    pivot: V3 | null;
}

interface FootAt extends FootState {
    standing: boolean;
    /** How far through its stance or its swing, 0 to 1. */
    progress: number;
    ankle: V3;
    heading: V3;
}

type Feet = (foot: number, t: number) => FootAt;

/** A walking foot rolling on its heel or its forefoot at a time, `p` of the way through its stance: its pitch and its toes' (toes up, radians). */
type Roll = (foot: number, t: number, p: number) => { pitch: number; toes: number };

/** How far a shin leans forward (radians) at a time with its ankle at a place. */
type Lean = (foot: number, t: number, ankle: V3) => number;

/** Where a hip socket is at a time. */
type Hip = (foot: number, t: number) => V3;

/** The way a foot points: forward, turned out by the gait's toe-out. */
const footHeading = (body: Body, g: Gait, foot: number): V3 =>
    add(scale(body.fwd, Math.cos(SIDE[foot] * g.toeOut)), scale(body.left, Math.sin(SIDE[foot] * g.toeOut)));

/** Where a foot's ankle stands flat in its `cycle`-th stride. */
const footFlat = (body: Body, g: Gait, foot: number, cycle: number): V3 =>
    add(add(scale(body.fwd, g.speed * (cycle + 0.5 * foot) * g.stride + g.lead), scale(body.left, (SIDE[foot] * g.width) / 2)), scale(body.up, body.floor + body.ankleHeight));

/**
 * The feet of a gait: where each ankle is and how the foot is pitched, at any time. A standing
 * foot rolls as `roll` says (its roll comes from the knee's course). A swinging foot is timed
 * against its hip's way over the ground (`over`), and with `lean` it hangs from its shin.
 */
function footModel(body: Body, g: Gait, style: GaitStyle, over: Hip, roll: Roll, lean?: Lean): Feet {
    const mode = g.mode;
    const { left, up, fwd } = body;
    const h = body.ankleHeight;
    const { ball, tip } = body.sole;
    const sole = soleRoll(body);
    const point = (f: V3, o: number): V3 => add(scale(f, o), scale(up, -h));

    /** A foot pitched (toes up) rolling on its sole: its ankle from where it stands flat, and the sole point on the floor. */
    const placed = (f: V3, pitch: number): { rel: V3; pivot: V3 | null } => {
        const r = rolled(sole, h, pitch);
        return { rel: add(scale(f, r.along), scale(up, r.up)), pivot: r.on === null ? null : point(f, r.on) };
    };
    /** Toes that bend, their ball off the floor: the ankle with the toes pitched about their tip and the foot about its ball. */
    const tiptoe = (f: V3, toes: number, foot: number): V3 =>
        add(
            scale(f, tip - (tip - ball) * Math.cos(toes) - ball * Math.cos(foot) - h * Math.sin(foot)),
            scale(up, -h - (tip - ball) * Math.sin(toes) - ball * Math.sin(foot) + h * Math.cos(foot)),
        );

    /** Stance of a foot's `cycle`-th stride, from the strike (0) to the toes leaving (1): heel rocker, flat, forefoot rocker. */
    const stance = (foot: number, cycle: number, p: number): FootState => {
        const f = footHeading(body, g, foot);
        const r = roll(foot, (cycle + 0.5 * foot + p * g.duty) * g.stride, p);
        // Toes that bend, bent as far as they go: the ball is off the floor and the foot stands on their tip.
        if (!body.stiffToes && r.toes < 0) return { rel: tiptoe(f, r.toes, r.pitch), pitch: r.pitch, toes: r.toes, pivot: point(f, tip) };
        const at = placed(f, r.pitch);
        // Toes that do not bend go with the foot; toes that do stay on the floor while the heel rises.
        return { rel: at.rel, pitch: r.pitch, toes: r.pitch > 0 || body.stiffToes ? r.pitch : 0, pivot: at.pivot };
    };

    /**
     * Swing, from the toes leaving (0) to the next strike (1). One move for every gait:
     *
     *   - Forward: the smoothest way from how the foot leaves the floor to how it meets it,
     *     under its hip at `passAt`. A foot that is thrown ahead and pulled back (`reachAt`
     *     below 1) is farthest ahead of its hip at `reachAt`, going just as fast as the hip,
     *     and slows evenly from there to its landing speed.
     *   - Up: through its highest point at `liftAt`. A thrown foot comes down from where it is
     *     farthest ahead at its landing speed.
     *   - To the side: straight across, bowed out round the standing foot.
     *   - Its pitch: the foot hangs from the shin. The ankle's own bend goes smoothly from
     *     what it is as the toes leave to what it is at the strike.
     *
     * Forward the foot leaves as it was going or is drawn through at once (`swingPull`), and is
     * stopped by the floor, still slowing as it lands; upward it is pushed off, already rising
     * faster as it leaves.
     */
    const swingOf = (foot: number) => {
        const eps = 1e-3;
        const a = stance(foot, 0, 1), b = stance(foot, 0, 1 - eps), e = stance(foot, 1, 0);
        const rate = (1 - g.duty) / g.duty / eps;
        const swingTime = (1 - g.duty) * g.stride;
        const leave = (0.5 * foot + g.duty) * g.stride;
        const flat = footFlat(body, g, foot, 0);
        // How it leaves the floor, and how it meets it: still going forward and down (the heel stops there; the ankle goes on).
        const v0 = scale(sub(a.rel, b.rel), rate);
        const w0 = (a.pitch - b.pitch) * rate;
        const v1 = add(scale(fwd, mode.strikeSpeed * g.speed * swingTime), scale(up, -mode.land * Math.sqrt(GRAVITY * body.hipHeight) * swingTime));
        const end = add(e.rel, scale(fwd, 2 * g.step));
        // A thrown foot is farthest ahead of its hip before it lands; any other, as it lands.
        const reach = mode.reachAt > 0 && mode.reachAt < 1 ? clamp(mode.reachAt, 0.5, 0.98) : 1;
        const last = 1 - reach;
        const hip = (t: number) => dot(sub(over(foot, t), flat), fwd);
        /** The smoothest way between two states along one line, by way of a place where one is given. */
        const way = (p0: number, s0: number, a0: number, p1: number, s1: number, a1: number, at: number, via?: number) =>
            via === undefined ? move(p0, s0, a0, p1, s1, a1) : viaCurve(p0, s0, a0, p1, s1, a1, clamp(at, 0.1, 0.9), via);
        /** The same, leaving as it was going or already drawn forward: some of each, by `swingPull`. */
        const pull = clamp(mode.swingPull, 0, 1);
        const drawn = (p0: number, s0: number, p1: number, s1: number, a1: number, at: number, via?: number) => {
            const held = way(p0, s0, 0, p1, s1, a1, at, via);
            if (pull === 0) return held;
            const free = way(p0, s0, FREE, p1, s1, a1, at, via);
            return (x: number) => lerp(held(x), free(x), pull);
        };

        // Forward.
        const from = dot(a.rel, fwd), off = dot(v0, fwd), to = dot(end, fwd), slow = dot(v1, fwd);
        const under = mode.passAt > 0 && mode.passAt < reach ? hip(leave + mode.passAt * swingTime) : undefined;
        let forward: (u: number) => number;
        if (reach < 1) {
            const h = 1e-3 * swingTime, when = leave + reach * swingTime;
            const fast = ((hip(when + h) - hip(when - h)) / (2 * h)) * swingTime;
            const there = to - ((fast + slow) / 2) * last, braking = (slow - fast) / last;
            const first = drawn(from, off * reach, there, fast * reach, braking * reach * reach, mode.passAt / reach, under);
            forward = (u) => (u <= reach ? first(u / reach) : bridge(there, fast * last, braking * last * last, to, slow * last, braking * last * last, (u - reach) / last));
        } else forward = drawn(from, off, to, slow, FREE, mode.passAt, under);

        // Up.
        const peak = clamp(mode.liftAt, 0.2, 0.8);
        const want = (mode.lift[0] + mode.lift[1] * Math.sqrt(g.froude)) * body.leg;
        const low = dot(a.rel, up), rising = dot(v0, up), down = dot(end, up), sink = dot(v1, up);
        const upThrough = (top: number): ((u: number) => number) => {
            if (reach === 1) return viaCurve(low, rising, FREE, down, sink, 0, peak, top, 0);
            const high = down - sink * last;
            const first = viaCurve(low, rising * reach, FREE, high, sink * reach, 0, clamp(peak / reach, 0.1, 0.9), Math.max(top, high), 0);
            return (u) => (u <= reach ? first(u / reach) : high + sink * (u - reach));
        };
        let rise = upThrough(Math.max(want, low, down));

        // To the side: a hump that is nothing at both ends and most at a given share of the swing.
        const hump = (at: number) => { const n = Math.log(0.5) / Math.log(clamp(at, 0.2, 0.8)); return (u: number) => Math.sin(Math.PI * Math.pow(u, n)) ** 2; };
        const bow = hump(mode.outAt), out = SIDE[foot] * mode.swingOut * body.hipHeight;
        const across = move(dot(a.rel, left), dot(v0, left), FREE, dot(end, left), dot(v1, left), FREE);
        const place = (u: number): V3 => add(add(scale(fwd, forward(u)), scale(left, across(u) + out * bow(u))), scale(up, rise(u)));

        // Its pitch. The foot hangs from the shin: the ankle's own bend goes smoothly from what it is as the toes leave,
        // through hanging relaxed and at rest (toes down) when the foot is highest, to what it will be as the heel strikes. A thrown
        // foot's ankle is set for landing by the time it is farthest ahead, and from then the foot only turns as the shin
        // does: its toes are up out in front and come down as it is pulled back.
        const pitchWith = (): ((u: number) => number) => {
            // Without a shin to hang from: straight from one pitch to the other.
            if (!lean) {
                const plain = move(a.pitch, w0 * reach, FREE, e.pitch, 0, FREE);
                return (u) => plain(u / reach);
            }
            const leanAt = (u: number) => lean(foot, leave + u * swingTime, add(flat, place(u)));
            const first = lean(foot, leave, add(flat, a.rel));
            const before = lean(foot, leave - eps * g.duty * g.stride, add(flat, b.rel));
            const bend = viaCurve(a.pitch + first, (w0 + (first - before) * rate) * reach, FREE, e.pitch + leanAt(1), 0, FREE, clamp(peak / reach, 0.1, 0.9), -body.joints.ankleRest * DEG, 0);
            return (u) => bend(u / reach) - leanAt(u);
        };
        let pitchAt = pitchWith();

        // Every point of the sole clears the floor in mid-swing: the highest point goes up until it does.
        let top = Math.max(want, low, down);
        for (let round = 0; round < 4; round++) {
            let short = 0;
            for (let i = 0; i <= 40; i++) {
                const u = 0.06 + (0.88 * i) / 40;
                // Only well into the swing: near its ends the foot is leaving or meeting the floor, and its toes are kept off it below.
                if (Math.abs(u - peak) > 0.25) continue;
                const th = pitchAt(u), y = rise(u);
                for (const [x, z] of sole.points) short = Math.max(short, style.clearance * body.hipHeight - (y + h + x * Math.sin(th) + (z - h) * Math.cos(th)));
            }
            if (short <= 1e-6) break;
            top += short;
            rise = upThrough(top);
            pitchAt = pitchWith();
        }
        /** The sole's lowest point over the floor, the ankle `y` over where it stands flat and the foot pitched. */
        const lowest = (y: number, th: number) => {
            let least = Infinity;
            for (const [x, z] of sole.points) least = Math.min(least, y + h + x * Math.sin(th) + (z - h) * Math.cos(th));
            return least;
        };
        // The sole never dips under the floor: where it would, the foot is pitched only as far as touches it (the toes skim).
        const guarded = (u: number) => {
            const th = pitchAt(u), y = rise(u);
            if (lowest(y, th) >= -1e-7 || lowest(y, 0) < 0) return th;
            let lo = 0, hi = th;
            for (let k = 0; k < 28; k++) {
                const mid = (lo + hi) / 2;
                if (lowest(y, mid) >= 0) lo = mid; else hi = mid;
            }
            return lo;
        };
        return (u: number): FootState => {
            const pitch = guarded(u);
            return {
                rel: place(u),
                pitch,
                // Toes that bend come back in line with the foot in the first quarter of the swing.
                toes: body.stiffToes ? pitch : lerp(a.toes, pitch, minJerk(u / 0.25)),
                pivot: null,
            };
        };
    };
    const swing = [swingOf(0), swingOf(1)];

    return (foot: number, t: number) => {
        const x = t / g.stride - 0.5 * foot;
        const cycle = Math.floor(x + 1e-9);
        const phase = Math.max(0, x - cycle);
        const flat = footFlat(body, g, foot, cycle);
        const standing = phase < g.duty;
        const progress = standing ? phase / g.duty : (phase - g.duty) / (1 - g.duty);
        const s = standing ? stance(foot, cycle, progress) : swing[foot](progress);
        return { ...s, standing, progress, ankle: add(flat, s.rel), pivot: s.pivot ? add(flat, s.pivot) : null, heading: footHeading(body, g, foot) };
    };
}

/** A vaulting gait's knee bends, radians: as the heel strikes, with the weight on, at its straightest, as the toes leave. */
function kneeBends(g: Gait, how: Vault) {
    const root = Math.sqrt(g.froude);
    const strike = (how.kneeStrike[0] + how.kneeStrike[1] * root) * DEG;
    return { kS: strike, kL: Math.max(strike, (how.kneeLoad[0] + how.kneeLoad[1] * root) * DEG), kM: how.kneeLeast * DEG, kT: how.kneeToeOff * DEG };
}


/**
 * The pelvis but its height: where the middle of the hip sockets is over the ground, and its
 * turn. Its sway, turn and list are waves once a stride; it tips forward once a step.
 */
function pelvisModel(body: Body, g: Gait, style: GaitStyle) {
    const mode = g.mode;
    const { left, up, fwd } = body;
    // The body surges fore and aft as an inverted pendulum does between two footfalls (slowest
    // over the standing foot). The pendulum's size is kept and its corners are not: one sine a
    // step (its own curve turns sharply at every footfall, where two feet share the weight and
    // it does not).
    const T = g.stepTime, w = Math.sqrt(GRAVITY / (body.massHeight * body.hipHeight));
    const A = g.step / 2 / Math.sinh((w * T) / 2);
    const lagAt = Math.acosh(Math.max(1, g.speed / (A * w))) / w;
    const surgeMost = mode.support.surge * (g.speed * lagAt - A * Math.sinh(w * lagAt));
    const surgeAt = mode.support.surgeAt;
    const hipsToMid = scale(add(sub(body.ref.leftUpperLeg, body.ref.hips), sub(body.ref.rightUpperLeg, body.ref.hips)), 0.5);
    const lean = Math.max(0, style.pelvisLean[0] + style.pelvisLean[1] * Math.sqrt(g.froude)) * DEG;
    return (t: number) => {
        const phase = t / g.stride;
        // Over the standing foot (toward the left while the left foot stands); ahead of the mean before the foot is passed, behind after.
        const sway = mode.sway.size * body.hipHeight * wave(phase, mode.sway.at, mode.sway.third);
        const surge = surgeMost * Math.cos(4 * Math.PI * (phase - surgeAt));
        // It turns with the legs, lists as each foot takes the weight, and tips forward as each foot lands.
        const yaw = mode.yaw.size * g.swing * wave(phase, mode.yaw.at, mode.yaw.third);
        const list = mode.list.size * g.swing * wave(phase, mode.list.at, mode.list.third);
        const tilt = lean + mode.pelvisTilt * g.swing * Math.cos(4 * Math.PI * phase);
        const rot = qmul(axisAngle(up, yaw), qmul(axisAngle(fwd, list), axisAngle(left, tilt)));
        const mid = add(scale(fwd, g.speed * t + surge), scale(left, sway));
        // The hips joint over the ground (its height comes later): the sockets' middle less the way to it.
        const offset = rotate(rot, hipsToMid);
        return { rot, yaw, list, across: sub(mid, sub(offset, scale(up, dot(offset, up)))) };
    };
}

/** Where each hip socket is over the ground at a time (how high does not come into it). */
function hipsOver(body: Body, g: Gait, style: GaitStyle): Hip {
    const pelvis = pelvisModel(body, g, style);
    return (i, at) => { const q = pelvis(at); return add(q.across, rotate(q.rot, sub(body.ref[`${LEG[i]}UpperLeg`], body.ref.hips))); };
}

/** A vaulting gait's hips and how its feet roll under them. */
interface Vaulted {
    /** The hips joint's height at a time. */
    height: (t: number) => number;
    roll: Roll;
    /** The foot left behind cannot keep the floor until its toes are due to leave without its leg straighter than `kneeLeast`: the step is too long for these legs. */
    stretched: () => boolean;
}

/**
 * A gait that vaults (a walk): the height of its hips and the roll of its feet, which depend on
 * each other through the knee.
 *
 * A leg near straight turns a millimetre of the hips into degrees of knee, so the standing
 * knee is never left to the hips. It follows a set course over its stance, and what would
 * otherwise bend it gives way instead: the hips' height while the foot is flat, the foot's own
 * roll while it is on its heel or its forefoot.
 *
 *   - The knee: `kneeStrike` as the heel strikes; `kneeLoad` when it has taken the weight
 *     (`loadAt`); straightening to `kneeLeast` at `leastAt`; then bending toward
 *     `kneeToeOff`, faster and faster, into the swing. It turns at each of these like a wave,
 *     without waiting there.
 *   - The hips' height: from when the standing knee has taken the weight (`loadAt`) to the
 *     top of its rise, the arc that puts that leg's knee on its course (the foot flat, then
 *     its heel rising by what the ankle cannot bend). From the top the smoothest curve (least
 *     jerk) down and up again to the next leg's arc, which it meets when that knee has taken
 *     the weight (speed and acceleration meet at both ends). At its lowest it passes the
 *     height at which the new leg, its knee bent by `kneeStrike` and its foot pitched for the
 *     strike, just meets the floor: that is when the heel strikes. It does not take up the
 *     new arc as that foot comes flat: the ankle stops coming down there, so the arc starts
 *     upward at once, and hips made to follow it are jolted as every foot lands.
 *   - The feet: under that curve the foot left behind raises its heel, and the foot that lands
 *     comes down from its heel, by what keeps each knee on its course; once flat it stays
 *     flat, and its knee goes with the hips until they ride its arc. Toes that bend stay
 *     flat until they are bent as far as they go or the foot nears pointing at the hip; then
 *     the ball leaves the floor and the foot stands on the toes' tip.
 */
function vault(body: Body, g: Gait, style: GaitStyle): Vaulted {
    const how = g.mode.support as Vault;
    const { up } = body;
    const h = body.ankleHeight;
    const { ball, tip } = body.sole;
    const sole = soleRoll(body);
    const pelvis = pelvisModel(body, g, style);
    const { kS, kL, kM, kT } = kneeBends(g, how);
    // Shares of stance: where the knee is straightest, and where its first bend is at its most.
    const low = Math.min(how.leastAt, 0.5 / g.duty - 0.03);
    const peak = clamp(how.loadAt, 0.05, low - 0.05);
    /** The standing knee's bend, `p` of the way through stance; `off`: its bend as the toes leave. */
    const bend = (p: number, off: number) => {
        // Like a wave, it turns at its most and at its least without waiting there.
        if (p <= peak) return quintic(kS, 0, kL, 0, p / peak);
        if (p <= low) return kL + ((kM - kL) * (1 - Math.cos(Math.PI * Math.pow((p - peak) / (low - peak), how.ease)))) / 2;
        // Into the swing: from its turn, faster and faster.
        const q = Math.min(1, (p - low) / (1 - low));
        return kM + (off - kM) * (1 - Math.cos((Math.PI / 2) * q));
    };
    const socket = (i: number, rot: Quat) => rotate(rot, sub(body.ref[`${LEG[i]}UpperLeg`], body.ref.hips));
    /** Which stride of foot `i` a time is in, and how far through its stance. */
    const stanceOf = (i: number, t: number) => {
        const x = t / g.stride - 0.5 * i;
        const cycle = Math.floor(x + 1e-9);
        return { cycle, p: Math.max(0, x - cycle) / g.duty };
    };

    const ankleMost = body.joints.ankleUp * DEG;
    /**
     * Foot `i` standing with its knee on its course: how far its heel has risen, and the hips'
     * height that goes with it. The foot is flat until the shin leans further over it than the
     * ankle bends; from there the heel rises by the rest, the foot rolling on its sole.
     */
    const standing = (i: number, t: number): { rise: number; hips: number } => {
        const p = pelvis(t), st = stanceOf(i, t);
        const flat = footFlat(body, g, i, st.cycle), f = footHeading(body, g, i);
        const at = socket(i, p.rot);
        const span = legSpan(body, bend(st.p, kT));
        // The shin leans further than the line from ankle to hip, by the knee's bend.
        const inner = Math.asin(clamp((body.thigh * Math.sin(kneeFor(body, span))) / span, -1, 1));
        const pose = (rise: number) => {
            const r = rolled(sole, h, -rise);
            const ankle = add(flat, add(scale(f, r.along), scale(up, r.up)));
            const d = sub(add(p.across, at), ankle);
            const reach = Math.sqrt(Math.max(0, span * span - dot(d, body.fwd) ** 2 - dot(d, body.left) ** 2));
            return { hips: dot(ankle, up) + reach - dot(at, up), over: Math.atan2(dot(d, f), reach) + inner - rise };
        };
        const level = pose(0);
        if (level.over <= ankleMost) return { rise: 0, hips: level.hips };
        let lo = 0, hi = 0.5 * Math.PI;
        for (let k = 0; k < 30; k++) {
            const mid = (lo + hi) / 2;
            if (pose(mid).over > ankleMost) lo = mid; else hi = mid;
        }
        return { rise: hi, hips: pose(hi).hips };
    };
    /** The hips' height that puts foot `i`'s knee on its course while that foot alone carries them. */
    const arc = (i: number, t: number): number => standing(i, t).hips;

    // From foot i's arc to the other foot's: one curve through the whole time both feet are down.
    const T = g.stepTime;
    const dt = 1e-3 * T;
    // When the landing leg's knee has taken the weight (its first bend at its most), seconds after its strike: from there the hips ride its arc.
    const joinAt = peak * g.duty * g.stride;
    /** The curve between two arcs: when it leaves the first (seconds after that foot's strike), how long it lasts, its height along the way (0 to 1). */
    interface Glide { lift: number; span: number; along: (u: number) => number }
    const along = (d: Glide, u: number) => d.along(u);
    /** The hips' height at which foot `i` strikes at time t: its knee bent by `kneeStrike`, its foot pitched for the strike about its heel. */
    const strikeHeight = (i: number, t: number): number => {
        const p = pelvis(t), f = footHeading(body, g, i);
        const r = rolled(sole, h, g.strikePitch);
        const ankle = add(footFlat(body, g, i, stanceOf(i, t).cycle), add(scale(f, r.along), scale(up, r.up)));
        const at = socket(i, p.rot);
        const d = sub(ankle, add(p.across, at));
        const flat2 = dot(d, body.fwd) ** 2 + dot(d, body.left) ** 2;
        return dot(ankle, up) + Math.sqrt(Math.max(0, legSpan(body, kS) ** 2 - flat2)) - dot(at, up);
    };
    // The hips leave an arc at its top: they never ride its falling side.
    let topShare: number | undefined;
    const top = () => {
        if (topShare === undefined) {
            topShare = peak;
            for (let k = 0; k <= 48; k++) {
                const p = peak + ((low - peak) * k) / 48;
                if (arc(0, p * g.duty * g.stride) > arc(0, topShare * g.duty * g.stride)) topShare = p;
            }
        }
        return topShare;
    };
    const glideOf = (i: number): Glide => {
        const strike = (i + 1) * T, t1 = strike + joinAt;
        const b = [arc(1 - i, t1), arc(1 - i, t1 + dt), arc(1 - i, t1 + 2 * dt)];
        const meet = strikeHeight(1 - i, strike);
        const from = (share: number): Glide => {
            const lift = share * g.duty * g.stride, t0 = i * T + lift, span = t1 - t0;
            const a = [arc(i, t0), arc(i, t0 - dt), arc(i, t0 - 2 * dt)];
            // The smoothest way from the one arc to the other through the height at which the other foot strikes.
            return {
                lift, span,
                along: viaCurve(
                    a[0], ((3 * a[0] - 4 * a[1] + a[2]) / (2 * dt)) * span, ((a[0] - 2 * a[1] + a[2]) / (dt * dt)) * span * span,
                    b[0], ((-3 * b[0] + 4 * b[1] - b[2]) / (2 * dt)) * span, ((b[0] - 2 * b[1] + b[2]) / (dt * dt)) * span * span,
                    (strike - t0) / span, meet, -how.sink * g.speed * span,
                ),
            };
        };
        return from(top());
    };
    const glides: (Glide | undefined)[] = [];
    const glide = (i: number) => (glides[i] ??= glideOf(i));
    const height = (t: number): number => {
        const n = Math.floor(t / T + 1e-9);
        const i = ((n % 2) + 2) % 2;
        const since = t - n * T;
        // Foot i has just struck: the curve from the other foot's arc is still on its way to this one's.
        if (since < joinAt) {
            const d = glide(1 - i);
            return along(d, (since + T - d.lift) / d.span);
        }
        const d = glide(i);
        return since <= d.lift ? arc(i, t) : along(d, (since - d.lift) / d.span);
    };

    // Toes that bend: the foot turns on its ball. The ankle is on an arm from it: its length, and its angle over the floor with the foot flat.
    interface Arm { len: number; rise: number }
    const ballArm: Arm = { len: Math.hypot(ball, h), rise: Math.atan2(h, ball) };
    const slack = TOE_SLACK, bendMost = body.joints.toesBack * DEG;
    /** The hip from foot `i`'s flat ankle at a time, the hips at `hips` high: along the foot, up, and (squared) to the side. */
    const hipFrom = (i: number, cycle: number, t: number, hips: number) => {
        const p = pelvis(t);
        const f = footHeading(body, g, i);
        const d = sub(add(add(p.across, scale(up, hips)), socket(i, p.rot)), footFlat(body, g, i, cycle));
        const x = dot(d, f), z = dot(d, up);
        return { x, z, side2: Math.max(0, dot(d, d) - x * x - z * z) };
    };
    /**
     * How far the arm turns up for hip to ankle to be `want` (not past `least` short of pointing at
     * the hip), and the hip-to-ankle distance that leaves. The hip is at (px, pz) from the sole
     * point, px toward the ankle's side of it.
     */
    const turnOn = (px: number, pz: number, side2: number, a: Arm, want: number, least: number) => {
        const m = Math.hypot(px, pz);
        const c = (m * m + side2 + a.len * a.len - want * want) / (2 * a.len * m);
        const rise = Math.max(0, Math.atan2(pz, px) - a.rise - Math.acos(clamp(c, -1, Math.cos(least))));
        const far = Math.sqrt(Math.max(0, m * m + side2 + a.len * a.len - 2 * a.len * m * Math.cos(Math.atan2(pz, px) - a.rise - rise)));
        return { rise, tight: c > Math.cos(least), far };
    };
    const bent = (far: number) => (far >= body.leg ? 0 : kneeFor(body, far));

    /** Foot `i` on its forefoot: how far its heel and toes rise for the knee to be bent by `knee`, and the bend it then has (less, where the foot cannot rise enough). */
    const forefoot = (i: number, cycle: number, t: number, knee: number, hips: number) => {
        const { x, z, side2 } = hipFrom(i, cycle, t, hips);
        const want = legSpan(body, knee);
        // Rolling on the sole, the heel rising.
        const on = rollTo(sole.front, true, x, z + h, side2, want, slack);
        if (body.stiffToes) return { heel: on.rise, toes: on.rise, knee: bent(on.far) };
        // Toes that bend: flat while they can be; else raised by the least that lets the foot reach.
        const lifted = (toes: number) => turnOn(tip - (tip - ball) * Math.cos(toes) - x, z + h - (tip - ball) * Math.sin(toes), side2, ballArm, want, slack);
        const fits = (r: { rise: number; tight: boolean }, toes: number) => !r.tight && r.rise - toes <= bendMost;
        let toes = 0, r = on;
        if (!fits(r, 0)) {
            let lo = 0, hi = 0.5 * Math.PI;
            for (let k = 0; k < 32; k++) {
                const mid = (lo + hi) / 2;
                if (fits(lifted(mid), mid)) hi = mid; else lo = mid;
            }
            toes = hi;
            r = lifted(hi);
        }
        return { heel: Math.max(r.rise, toes), toes, knee: bent(r.far) };
    };
    /** Foot `i` on its heel: how far its toes are up for the knee to be bent by `knee`. */
    const onHeel = (i: number, cycle: number, t: number, knee: number, hips: number) => {
        const { x, z, side2 } = hipFrom(i, cycle, t, hips);
        return rollTo(sole.heel, false, x, z + h, side2, legSpan(body, knee), 0).rise;
    };

    // Each knee's bend as its toes leave: what was asked, or the most the foot can rise to.
    let offs: number[] | undefined;
    const off = (i: number) => (offs ??= [0, 1].map((j) => {
        const t = (0.5 * j + g.duty) * g.stride;
        return forefoot(j, 0, t, kT, height(t)).knee;
    }))[i];

    /** Foot `i` coming down from its heel, `p` of the way through its stance: toes up by what keeps its knee on its course under the hips. */
    const heelDown = (i: number, p: number) => {
        const t = (0.5 * i + p * g.duty) * g.stride;
        return onHeel(i, 0, t, bend(p, kT), height(t));
    };
    // The share of stance at which each foot is flat: from there it stays flat (its knee goes with the hips until they ride its arc).
    let flats: number[] | undefined;
    const flatFrom = (i: number) => (flats ??= [0, 1].map((j) => {
        const n = 48;
        let k = 1;
        while (k <= n && heelDown(j, (peak * k) / n) > 1e-5) k++;
        if (k > n) return peak;
        let lo = (peak * (k - 1)) / n, hi = (peak * k) / n;
        for (let r = 0; r < 20; r++) {
            const mid = (lo + hi) / 2;
            if (heelDown(j, mid) > 1e-5) lo = mid; else hi = mid;
        }
        return hi;
    }))[i];

    const roll: Roll = (i, t, p) => {
        const cycle = Math.round(t / g.stride - 0.5 * i - p * g.duty);
        const hips = height(t);
        if (p < peak) {
            const pitch = p < flatFrom(i) ? onHeel(i, cycle, t, bend(p, kT), hips) : 0;
            return { pitch, toes: pitch };
        }
        // Still carrying the hips alone: the heel rises only by what the ankle cannot bend.
        if (p * g.duty * g.stride <= glide(i).lift) {
            const rise = standing(i, t).rise;
            return { pitch: -rise, toes: body.stiffToes ? -rise : 0 };
        }
        const r = forefoot(i, cycle, t, bend(p, off(i)), hips);
        return { pitch: -r.heel, toes: -r.toes };
    };
    return { height, roll, stretched: () => Math.min(off(0), off(1)) < kM - 1e-9 };
}

/**
 * The walk of a body at a speed (m/s, above zero). The step comes from the speed; the foot
 * lands a share of the step ahead of the hips. A step the legs cannot take (the pelvis sinking
 * past `maxDrop`, a leg stretched straight before its toes leave) is shortened, the steps
 * quickened.
 */
export function gaitFor(body: Body, speed: number, style: GaitStyle = GAIT_STYLE): Gait {
    if (!(speed > 0)) throw new Error('a gait needs a speed above zero');
    const L = body.hipHeight;
    const froude = (speed * speed) / (GRAVITY * L);
    const root = Math.sqrt(froude);
    const mode = style.walk;
    const duty = clamp(mode.duty[0] - mode.duty[1] * root, 0.2, 0.75);
    let step = speed / (Math.sqrt(GRAVITY / L) * (mode.rate[0] + mode.rate[1] * root));
    const standing = body.ref.hips[1];
    let g!: Gait;
    for (let pass = 0; pass < 24; pass++) {
        const swing = Math.asin(Math.min(0.95, step / (2 * body.leg)));
        const base: Gait = {
            speed, mode, froude, step, stepTime: step / speed, stride: (2 * step) / speed, duty,
            width: mode.width * L,
            toeOut: Math.max(0, style.toeOut[0] - style.toeOut[1] * root) * DEG,
            lead: 0, swing,
            strikePitch: Math.min(25 * DEG, mode.strike * swing),
            drop: 0,
        };
        // The ankle strikes a share of the step ahead; the foot will stand flat farther on by what its heel rocker carries it.
        const lead = mode.lead * step - rolled(soleRoll(body), body.ankleHeight, base.strikePitch).along * Math.cos(base.toeOut);
        const walk = vault(body, { ...base, lead }, style);
        let low = Infinity;
        for (let k = 0; k < 48; k++) low = Math.min(low, walk.height((k * base.stride) / 48));
        g = { ...base, lead, drop: standing - low };
        if (g.drop <= mode.maxDrop * body.leg && !walk.stretched()) break;
        step *= 0.97;
    }
    return g;
}

/** What a foot is doing at an instant of a gait: for carrying the gait onto other footfalls (stride.ts). */
export interface FootTrace {
    standing: boolean;
    /** How far through its stance or its swing, 0 to 1. */
    progress: number;
    /** Where its ankle stands flat in the stance it is in, or has just left. */
    flat: V3;
    /** Its pitch and its toes' (toes up, radians), and the way it points (radians about the upright from forward, positive to the left). */
    pitch: number;
    toes: number;
    heading: number;
}

/** An instant of a gait with what its feet are doing. */
export interface GaitPose extends GaitFrame {
    feet: [FootTrace, FootTrace];
    /** How far both legs are turned about the upright just now, radians (the knees point that far off the feet's own way). */
    legTurn: number;
}

/**
 * A gait as a pose at any time: time 0 is the left heel's strike, and the gait repeats every
 * stride, one stride's length further on.
 */
export function gaitPoser(body: Body, g: Gait, style: GaitStyle = GAIT_STYLE): (t: number) => GaitPose {
    const mode = g.mode;
    const { left, up, fwd } = body;
    const pelvis = pelvisModel(body, g, style);
    const root = Math.sqrt(g.froude);

    // The hips' height, from the knee of the leg that carries it.
    const walk = vault(body, g, style);
    const heightAt = walk.height;
    // A swinging foot hangs from its shin: how far that leans, from the hip and the ankle.
    const shin: Lean = (i, at, ankle) => {
        const q = pelvis(at);
        const d = sub(add(add(q.across, scale(up, heightAt(at))), rotate(q.rot, sub(body.ref[`${LEG[i]}UpperLeg`], body.ref.hips))), ankle);
        const span = Math.min(body.leg, Math.hypot(d[0], d[1], d[2]));
        return Math.atan2(dot(d, footHeading(body, g, i)), dot(d, up)) + Math.asin(clamp((body.thigh * Math.sin(kneeFor(body, span))) / span, -1, 1));
    };
    const foot = footModel(body, g, style, hipsOver(body, g, style), walk.roll, shin);

    /** How far a foot in the air is turned out, by how far through its swing it is: out and back once, the smoothest way from rest to rest. */
    const swingTurn = viaCurve(0, 0, 0, 0, 0, 0, clamp(mode.swingTurn[1], 0.1, 0.9), mode.swingTurn[0] * DEG);
    const spine = (['spine', 'chest', 'upperChest'] as const).filter((r) => body.roles[r] !== undefined);
    return (t: number): GaitPose => {
        const p = pelvis(t);
        const hips = add(p.across, scale(up, heightAt(t)));
        const world: Record<string, Quat> = { hips: p.rot };
        const ankles: V3[] = [], stance: boolean[] = [], pivots: (V3 | null)[] = [], short: number[] = [], knees: number[] = [];
        const feet: FootTrace[] = [];
        // Both legs turn about the upright together (the one ahead toward the other, the one behind away from it).
        const legTurned = mode.legTurn.size * g.swing * wave(t / g.stride, mode.legTurn.at, mode.legTurn.third);
        const legTurn = axisAngle(up, legTurned);

        for (let i = 0; i < 2; i++) {
            const f = foot(i, t);
            const socket = add(hips, rotate(p.rot, sub(body.ref[`${LEG[i]}UpperLeg`], body.ref.hips)));
            // Two-bone IK: the knee in the plane of the hip-ankle line and the way the leg is turned (the foot's heading, turned with the legs).
            // The knees are already where the hips' height put them.
            const most = body.leg + 1e-6;
            const leg = legPose(body, socket, f.ankle, rotate(legTurn, f.heading), most);
            knees.push(leg.knee);
            world[`${LEG[i]}UpperLeg`] = leg.upper;
            world[`${LEG[i]}LowerLeg`] = leg.lower;
            // The foot: turned to its heading from where it rests, then pitched about its own side axis; its toes likewise.
            // In the air its toes turn out and back, and it is at its heading again as it lands.
            const yaw = SIDE[i] * (g.toeOut + (f.standing ? 0 : swingTurn(f.progress)));
            world[`${LEG[i]}Foot`] = footTurn(body, i, yaw, f.pitch);
            world[`${LEG[i]}Toes`] = footTurn(body, i, yaw, f.toes);
            ankles.push(leg.ankle);
            stance.push(f.standing);
            pivots.push(f.pivot);
            short.push(leg.short);
            feet.push({ standing: f.standing, progress: f.progress, flat: sub(f.ankle, f.rel), pitch: f.pitch, toes: f.toes, heading: yaw });
        }

        // The chest turns its right shoulder forward as the left foot comes forward (against the pelvis), rolls a little with that, and leans with the speed.
        const lean = (Math.max(0, style.lean[0] + style.lean[1] * root) + mode.nod[0] * Math.cos(4 * Math.PI * (t / g.stride - mode.nod[1]))) * DEG;
        const chestTurn = mode.chest.size * g.swing * wave(t / g.stride, mode.chest.at, mode.chest.third);
        const against = qmul(axisAngle(up, chestTurn), axisAngle(fwd, mode.chestRoll * chestTurn));
        // It twists about its own length, then leans: a leaned chest that turned about the upright instead would swing round like a boom.
        const chest = qmul(axisAngle(left, lean), against);
        // The spine's bones go evenly from the pelvis' turn to the chest's.
        spine.forEach((r, j) => (world[r] = slerp(p.rot, chest, (j + 1) / spine.length)));
        // The chest keeps its own place to the side: the bones between it and the pelvis lean to join the swaying hips to it.
        const sideOf = (w?: Wave) => (w ? w.size * body.hipHeight * wave(t / g.stride, w.at, w.third) : null);
        const chestAt = leanToJoin(body, world, spine.length ? add(hips, rotate(p.rot, sub(body.ref[spine[0]], body.ref.hips))) : hips, spine, sideOf(mode.chestSway));
        const top = spine.length ? chest : p.rot;
        // The head stays level and looks ahead, giving a little to the chest's turn and to its list. On its own it nods with each step and tilts once a stride.
        const nodding = mode.headNod[0] * DEG * Math.cos(4 * Math.PI * (t / g.stride - mode.headNod[1]));
        const tilting = mode.headTilt[0] * DEG * Math.cos(2 * Math.PI * (t / g.stride - mode.headTilt[1]));
        const chestList = Math.asin(clamp(dot(rotate(chest, left), up), -1, 1));
        const gaze = axisAngle(up, mode.headFollow * chestTurn), listing = mode.headRoll * chestList;
        // The neck goes between the chest and the head as it would be without its nod and its tilt: those are the head's own, on top of the neck.
        world.neck = slerp(top, qmul(axisAngle(left, mode.headLean * lean), qmul(gaze, axisAngle(fwd, listing))), mode.neck);
        world.head = qmul(axisAngle(left, mode.headLean * lean + nodding), qmul(gaze, axisAngle(fwd, listing + tilting)));
        // The head keeps its own place to the side too: the neck leans to join the chest to it.
        if (mode.headSway && body.roles.neck !== undefined && body.roles.head !== undefined) {
            const under = spine.length ? spine[spine.length - 1] : 'hips';
            leanToJoin(body, world, add(chestAt, rotate(top, sub(body.ref.neck, body.ref[under]))), ['neck', 'head'], sideOf(mode.headSway));
        }

        // Arms: each swings against its own side's leg, a little late, and what swings is handed
        // on down the arm: the elbow bends after the upper arm, the hand goes where the forearm
        // has just been and is carried a little past it at each end, and the shoulder comes
        // forward with the hand. Going forward the arm is a little further out than coming back:
        // the hand goes round a narrow loop, not to and fro along a line.
        const turn = (2 * Math.PI * t) / g.stride - 2 * Math.PI * mode.armLag;
        const amplitude = Math.min(mode.arm * g.swing, style.armMost * DEG);
        const hingeDown = scale(left, -1);
        for (let i = 0; i < 2; i++) {
            const side = SIDE[i];
            /** The arm's swing about its middle (forward above zero), and where its middle is. */
            const swung = (at: number) => -side * amplitude * Math.cos(at);
            const middle = mode.armBias * amplitude;
            // The arms' own fore and aft: the body's, turned by their share of the chest's turn.
            const withChest = axisAngle(up, mode.armFollow * chestTurn);
            // The swing's axis, turned so that forward is also a little inward.
            const swingAxis = rotate(withChest, rotate(axisAngle(up, -side * mode.armIn * DEG), hingeDown));
            /** The arm at a moment of its swing: the turns of the upper arm and of the forearm, the elbow's axis, and how far forward of its middle it is. */
            const armAt = (at: number) => {
                // How far it hangs out from the side: further while it is going forward (the loop).
                const away = (mode.armOut + mode.armLoop * side * Math.sin(at)) * DEG;
                const hang = rotate(withChest, normalize(add(scale(up, -Math.cos(away)), scale(left, side * Math.sin(away)))));
                // How far forward in its swing the arm was a moment ago (0 at the back, 1 at the front).
                const forward = (1 - side * Math.cos(at - 2 * Math.PI * mode.elbowLag)) / 2;
                // Evenly with the swing; or in a pulse as the arm comes forward (above 1); or held bent and let straight only briefly at the back (below 1).
                const snap = mode.elbowSnap;
                const bent = snap >= 1 ? Math.pow(forward, snap) : 1 - Math.pow(1 - forward, 1 / Math.max(0.2, snap));
                const elbow = (mode.elbow[0] + mode.elbow[1] * bent) * DEG;
                const upper = rotate(axisAngle(swingAxis, middle + swung(at)), hang);
                return { ...armBones(body, side, upper, swingAxis, elbow), swung: swung(at) };
            };
            const now = armAt(turn), then = armAt(turn - 2 * Math.PI * mode.wristLag);
            world[`${LEG[i]}Shoulder`] = qmul(axisAngle(up, mode.shoulderGive * amplitude * Math.cos(turn - 2 * Math.PI * mode.wristLag)), top);
            world[`${LEG[i]}UpperArm`] = now.upper;
            world[`${LEG[i]}LowerArm`] = now.fore;
            // The hand: where the forearm has just been, and carried on past it by its own weight at each end of the swing.
            world[`${LEG[i]}Hand`] = qmul(axisAngle(then.hinge, mode.wristFlick * then.swung), then.fore);
        }

        return {
            time: t, travel: g.speed * t, hips, world,
            ankles: ankles as [V3, V3], stance: stance as [boolean, boolean], pivots: pivots as [V3 | null, V3 | null], short: short as [number, number], knees: knees as [number, number],
            feet: feet as [FootTrace, FootTrace],
            legTurn: legTurned,
        };
    };
}

/**
 * One stride of a gait as `count` instants (the first at the left heel's strike; the
 * stride closes on itself: the instant after the last is the first, one stride on).
 */
export function gaitCycle(body: Body, g: Gait, style: GaitStyle = GAIT_STYLE, count = 64): GaitFrame[] {
    const pose = gaitPoser(body, g, style);
    return Array.from({ length: count }, (_, k) => {
        const { feet: _feet, legTurn: _legTurn, ...frame } = pose((k * g.stride) / count);
        return frame;
    });
}
