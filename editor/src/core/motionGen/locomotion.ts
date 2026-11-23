// One formula for walking: the pose from two inputs, where the body goes (the capsule's predicted path) and which
// way it looks. No motion is stored and none is picked: the walk's own pose (gait.ts) is carried onto footfalls
// solved from the path (carry.ts), the body's facing comes from the angle between the look and the way it goes,
// shared out along a chain (legs, pelvis, chest, head), and the rest of the body is a field of the controls.
//
//   the inputs     LocoInput     the path (a point of the floor at any time) and the look (a direction at any
//                                time, or along the path ahead); the posture (ordinary or on guard) is a setting
//   the controls   controlsOf    speed, the turn of the path per stride, its grade, and the look against the line
//                                the body walks on
//   the chain      chainOf       the look's angle shared out: the pelvis and the chest by their shares, the head
//                                the rest, each within its reach; what none can reach is left short. The feet turn
//                                toward the look too, the one on its side more. It also decides whether the body
//                                walks forward or backs away (the look far behind)
//   the field      locoLoop      the rest of the body as sums of terms of the controls: leaning into a turn, curling
//                                up a slope, crouching on guard ...
//
// This first piece makes a steady walk (one stride, in place): straight, round a circle, up or down a slope, on
// guard in any direction. Its numbers start from the ones fitted to each kind of walk on its own (carry.ts, guard.ts).
//
// The formula, how its values were fitted and which to change for which look: editor/MOTION.md.

import { add, dot, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import { carryFrames, PIVOT_STYLE, SLOPE_STYLE, START_STYLE, STOP_STYLE, walkPivot, walkStart, walkStop, type CarryPlan, type Hold, type PivotStyle, type SlopeSide, type StartStyle, type StopStyle } from './carry';
import { GUARD_STYLE, stepGuard, type GuardStep } from './guard';
import { GAIT_STYLE, gaitFor, gaitPoser, type Gait, type GaitFrame, type GaitStyle, type Vault } from './gait';
import { chainOf, wrapLeft, type ChainStyle } from './chain';
import { axisAngle, clamp, DEG, minJerk } from './tools';

export { chainOf } from './chain';
export type { ChainGiven, ChainPose, ChainStyle } from './chain';
import { standFrame, TURN_STYLE, turnFor, turnFrames, type Stance, type TurnStyle } from './turn';

/** What the walk is asked to do. */
export interface LocoInput {
    /** Where the capsule is at a time: the point of the floor under it (above zero where the ground is higher), model space. A steady walk's path goes on both ways in time. */
    path: (t: number) => V3;
    /** Which way the body looks at a time: radians about the upright from the body's forward, positive to the left; none (or null): along its path, `ahead` strides on. */
    look?: ((t: number) => number | null) | null;
    /** The walk's phase at the first frame, strides (0: the left heel strikes): the state it is in. */
    phase: number;
    /** 0 ordinary, 1 on guard: a setting of the character, not an input. */
    posture?: number;
    /** Walking backward where the look is far behind, or forward looking back: as the chain chooses (none), or as given. */
    backward?: boolean | null;
}

/** How the body answers a turning way, per radian its way turns in a stride (or per the sideways acceleration over gravity, for the bank). */
export interface TurningTerms {
    /** The hips lean in toward the middle of the turn, share of hip height per a⊥/g. */
    bank: number;
    /** The footfalls are set in toward the middle (inner foot, outer foot), shares of hip height; the feet point in, degrees. */
    track: [number, number];
    toe: [number, number];
    /** The pelvis faces off the way (above zero: into the turn), and the chest further, degrees. */
    face: number;
    chest: number;
    /** The spine curls forward (the head takes this share of it), the chest and the head roll into the turn, degrees. */
    curl: [number, number];
    roll: [number, number];
    /** The arms are held further out (inner, outer) and their elbows more bent, degrees. */
    armOut: [number, number];
    elbow: [number, number];
}

/** How the body walks on guard one way: going forward along its line, or backing away. */
export interface GuardTerms {
    /** A foot in the air turns out and back over what the walk turns it: degrees for the left foot and the right, and when (share of its time in the air); its path bows out, share of hip height; a standing knee is bent more as the heel strikes and through the stance, degrees. */
    swingTurn: [number, number, number];
    out: number;
    knee: [number, number];
    /** How much of the walk's lift a foot in the air keeps, and of its pitch. */
    swing: [number, number];
    /** The hips lower, the footfalls further apart each side, the hips to the left of the line: shares of hip height. */
    sink: number;
    wide: number;
    aside: number;
    /** With each step: the hips rise and fall, go to and fro along the line (share of hip height, and when most: share of a step); where along the line throughout. */
    bob: [number, number];
    surge: [number, number, number];
    /** The pelvis tips forward, the spine curls, the head nods (degrees); the chest pitches with each step (degrees, when). */
    bow: number;
    curl: number;
    nod: number;
    pitch: [number, number];
    /** The pelvis lists once a stride (degrees, when), throughout, and more by so much per radian the look is off the line. */
    list: [number, number, number, number];
    /** The pelvis turns once a stride, degrees and when. */
    yaw: [number, number];
    /** How much of the walk's arm swing is kept; the arms further out, more bent, further forward (degrees). */
    armShare: number;
    armOut: number;
    elbow: number;
    armFore: number;
    /** The stance's own turn: the pelvis against its line and the chest against the pelvis where the body looks along its line, degrees. */
    offset: [number, number];
    /** The feet against the line there, the left and the right, degrees. */
    toes: [number, number];
    /** Where the look is to the right, the pelvis and the chest take shares this much larger (the stance is not the same to both sides). */
    rightShare: [number, number];
}

/** The numbers of the rules that set off, stop, turn about and turn on the spot (each still its own planner: carry.ts, turn.ts, guard.ts). */
export interface LocoRules {
    start: StartStyle;
    stop: StopStyle;
    pivot: PivotStyle;
    turn: TurnStyle;
    guardStep: { stance: Stance; step: GuardStep };
}

export interface LocoStyle {
    /** Where the body looks along its path when it is not told: so many strides on. */
    ahead: number;
    rules: LocoRules;
    chain: ChainStyle;
    turning: TurningTerms;
    climbing: { grade: number; airKnee: number; up: SlopeSide; down: SlopeSide };
    guard: { quick: number; forward: GuardTerms; backward: GuardTerms };
    kneeFollow: number;
}


export const LOCO_STYLE: LocoStyle = {
    ahead: 0.2,
    rules: {
        // (Fitted with the chain's springs: the start's and the turn right about's facing follow the look over the line of the legs.)
        start: { ...START_STYLE, turn: [1, -0.01, 0.25], landTurn: 0.14, swivel: 0.16, twistMost: 25, bow: [2.7, 0.45, 1.6, 1], shift: 0.23, phase: -0.017, blend: 0.35 },
        stop: STOP_STYLE,
        pivot: { ...PIVOT_STYLE, turn: [1, -0.01, 0.27], from: 0.25, blend: 0.29, swivel: 0.4, landTurn: 0.14 },
        // (Its facing from the chain: the steps and how far the first one turns, refitted.)
        turn: {
            ...TURN_STYLE,
            left: { ...TURN_STYLE.left, steps: [[0.065, 0.6], [0.5, 1.3], [1.2, 2.2]], first: { ...TURN_STYLE.left.first, turn: [5, 0.55] }, swivel: 0.4, headAxis: 4 },
            right: { ...TURN_STYLE.right, steps: [[0.021, 0.6], [0.5, 1.3], [1.2, 2]], first: { ...TURN_STYLE.right.first, turn: [3, 0.5] }, swivel: 0.7, headAxis: 3.5 },
        },
        guardStep: { stance: GUARD_STYLE.stance, step: GUARD_STYLE.step },
    },
    chain: { share: [0.17, 0.15], reach: 1, most: [35, 55, 23, 55], feet: { forward: [0.45, 0.16, 0.23, 0.027], backward: [0.35, 0.25, -0.0055, 0.0055], most: [50, 40] }, back: 110, time: [0.8, 0.6, 0.18] },
    turning: {
        bank: 0.35,
        track: [0.038, -0.025],
        toe: [3.8, -1.9],
        face: -5,
        chest: 7,
        curl: [5, 0.85],
        roll: [1.2, 2],
        armOut: [0.37, 5],
        elbow: [5, 5],
    },
    climbing: { grade: SLOPE_STYLE.grade, airKnee: SLOPE_STYLE.airKnee, up: SLOPE_STYLE.up, down: SLOPE_STYLE.down },
    guard: {
        quick: 1,
        forward: {
            swingTurn: [13, 10, 0.28], out: 0.009, knee: [12, 9], swing: [1, 0.9], sink: 0, wide: 0.045, aside: -0.021,
            bob: [0.0037, 0.75], surge: [0.0003, 0.15, -0.012], bow: -2.8, curl: 11, nod: 14, pitch: [0.9, 0.15], list: [0.55, 0.12, -5, 1.6], yaw: [-4.5, 0.35],
            armShare: 0.45, armOut: 1, elbow: 4.5, armFore: -3.3,
            offset: [-16, -10], toes: [-5.5, -11], rightShare: [-0.08, 0.045],
        },
        backward: {
            swingTurn: [-9, -4.5, 0.3], out: 0.02, knee: [12, 5], swing: [1, 0.45], sink: 0.01, wide: 0.045, aside: -0.025,
            bob: [0.01, 0.55], surge: [0.03, 0.4, -0.019], bow: -3, curl: 12, nod: 12, pitch: [-3, 0.4], list: [-2.7, 0.24, 1.1, -0.2], yaw: [3, -0.17],
            armShare: 0.3, armOut: 1, elbow: 6, armFore: -2.2,
            offset: [-15, -11], toes: [3.7, -17], rightShare: [-0.06, 0.01],
        },
    },
    kneeFollow: 0.5,
};

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));


/** The controls of a steady path at a time: speed, which way it goes, how fast that turns, its grade. */
export function controlsOf(body: Body, path: (t: number) => V3, t: number) {
    const { up, fwd, left } = body;
    const h = 1e-3;
    const velocity = (at: number) => scale(sub(path(at + h), path(at - h)), 1 / (2 * h));
    const heading = (at: number) => { const v = velocity(at); return Math.atan2(dot(v, left), dot(v, fwd)); };
    const v = velocity(t);
    const flat = Math.hypot(dot(v, left), dot(v, fwd));
    return { speed: Math.hypot(v[0], v[1], v[2]), heading: heading(t), turn: wrap(heading(t + h) - heading(t - h)) / (2 * h), grade: flat > 1e-9 ? dot(v, up) / flat : 0 };
}

/**
 * A steady walk (the path goes at one speed, turning and climbing at one rate): one stride of it as `count` + 1
 * frames (the last is the first again), given in place, seen from the capsule as it faces along its path at the
 * first frame.
 */
export function locoLoop(
    body: Body, input: LocoInput, count = 64,
    style: LocoStyle = LOCO_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const { up, fwd, left } = body;
    const L = body.hipHeight;
    const s = clamp(input.posture ?? 0, 0, 1);
    const c = controlsOf(body, input.path, 0);
    // The walk at that speed: on guard its steps quicker, its knees bent more, its feet bowing out its own way.
    const quickness = 1 + s * (style.guard.quick - 1);
    const rate = gaitStyle.walk.rate;
    const walked: GaitStyle = quickness === 1 ? gaitStyle : { ...gaitStyle, walk: { ...gaitStyle.walk, rate: [rate[0] * quickness, rate[1] * quickness] } };
    const plain = gaitFor(body, c.speed, walked);
    // The turn of the way in a stride, and how much of the slope's numbers it asks for.
    const kappa = c.turn * plain.stride;
    const turnSign = Math.sign(kappa) || 1, inner = kappa >= 0 ? 0 : 1;
    const climb = c.grade >= 0 ? style.climbing.up : style.climbing.down;
    const q = clamp(Math.abs(c.grade) / Math.max(1e-9, style.climbing.grade), 0, 1);
    // Which way it looks against the way it goes: forward, or backing away when the look is far behind.
    const lookAt = (t: number) => {
        const given = input.look?.(t);
        if (given !== null && given !== undefined) return given;
        // Along the path ahead: the way it will be going so many strides on.
        return controlsOf(body, input.path, t + style.ahead * plain.stride).heading;
    };
    const lookOff = wrapLeft(lookAt(0) - c.heading);
    const backward = input.backward ?? Math.abs(lookOff) > style.chain.back * DEG;
    const guard = backward ? style.guard.backward : style.guard.forward;
    const how = plain.mode.support as Vault;
    const k = guard.knee;
    const g: Gait = s === 0 ? plain : {
        ...plain,
        mode: {
            ...plain.mode,
            swingOut: plain.mode.swingOut + s * (guard.out - plain.mode.swingOut),
            support: { ...how, kneeStrike: [how.kneeStrike[0] + s * k[0], how.kneeStrike[1]], kneeLoad: [how.kneeLoad[0] + s * k[1], how.kneeLoad[1]], kneeLeast: how.kneeLeast + s * k[1], kneeToeOff: how.kneeToeOff + s * k[1] },
        },
    };
    const stride = g.speed * g.stride;
    const going = backward ? -1 : 1;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const start = input.path(0);
    // The line the body walks on: its path, or (backing away) its path the other way round. Along it so far is where the path is so long after (or before) now.
    const lineAt = (along: number) => {
        const t = (going * along) / g.speed;
        const at = input.path(t);
        return { at: add(origin, sub(at, scale(sub(start, scale(up, dot(start, up))), 1))), heading: controlsOf(body, input.path, t).heading + (backward ? Math.PI : 0), t };
    };
    const way = (along: number) => { const l = lineAt(along); return { at: l.at, heading: l.heading }; };
    const travelled = (t: number) => going * g.speed * t;
    const phase = (t: number) => input.phase + (going * t) / g.stride;
    // The chain, and what the field turns before it.
    const toward = (part: number) => kappa * part * DEG;
    const given = {
        pelvis: s * guard.offset[0] * DEG + toward(style.turning.face) + q * climb.face * DEG,
        chest: s * guard.offset[1] * DEG + toward(style.turning.chest),
        toes: [s * guard.toes[0] * DEG, s * guard.toes[1] * DEG] as [number, number],
        rightShare: [s * guard.rightShare[0], s * guard.rightShare[1]] as [number, number],
    };
    const chainAt = (t: number) => chainOf(style.chain, wrapLeft(lookAt(t) - way(travelled(t)).heading), given, backward);
    const late = q * climb.late * g.stride;
    const holds: [Hold[], Hold[]] = [[], []];
    for (let foot = 0; foot < 2; foot++) {
        const side = foot ? -1 : 1;
        const kIn = foot === inner ? 0 : 1;
        for (let n = -3; n <= 4; n++) {
            const cycle = going * n;
            const strike = cycle + 0.5 * foot, leave = strike + g.duty;
            const along = stride * (strike - input.phase) + g.lead;
            const here = lineAt(along);
            const across = rotate(axisAngle(up, here.heading), left);
            const feet = chainOf(style.chain, wrapLeft(lookAt(here.t) - here.heading), given, backward).feet;
            const on = going * ((backward ? leave : strike) - input.phase) * g.stride + late;
            const off = going * ((backward ? strike : leave) - input.phase) * g.stride + q * climb.stay * g.stride;
            holds[foot].push({
                on, off,
                stand: {
                    at: add(here.at, scale(across, side * (g.width / 2 + (q * climb.wide + s * guard.wide) * L) + turnSign * style.turning.track[kIn] * Math.abs(kappa) * L)),
                    heading: here.heading + side * g.toeOut + turnSign * style.turning.toe[kIn] * Math.abs(kappa) * DEG + q * climb.toe[foot] * DEG + feet[foot],
                },
                cycle, own: false, along,
                up: dot(here.at, up) - dot(origin, up),
                clear: [q * climb.clear[0] * body.leg, climb.clear[1]],
                soft: [1, (1 - q * (1 - climb.heel)) * (1 + s * (guard.swing[1] - 1))],
                twist: [s * guard.swingTurn[foot] * DEG, guard.swingTurn[2]],
            });
        }
    }
    // The level that carries the body: each footfall's own, gone over to in a smooth step some time after (or before) it lands.
    const stepTime = g.stride / 2;
    const falls = [...holds[0], ...holds[1]].sort((a, b) => a.on - b.on);
    const [carryFrom, carryOver] = [climb.carry[0], Math.max(0.05, climb.carry[1])];
    const level = (t: number) => {
        let at = falls[0].up ?? 0;
        for (let j = 1; j < falls.length; j++) {
            const from = falls[j].on + carryFrom * stepTime;
            at += ((falls[j].up ?? 0) - (falls[j - 1].up ?? 0)) * minJerk(clamp((t - from) / (carryOver * stepTime), 0, 1));
        }
        return at;
    };
    const pose = gaitPoser(body, g, walked);
    let mean = 0;
    for (let j = 0; j < 32; j++) mean += dot(pose((j * g.stride) / 32).hips, up) / 32;
    const bobLeft = 1 - q * (1 - climb.bob);
    const once = (pair: readonly number[], t: number) => pair[0] * DEG * Math.cos(2 * Math.PI * (phase(t) - pair[1]));
    const twice = (pair: readonly number[], t: number) => pair[0] * Math.cos(2 * Math.PI * (2 * phase(t) - pair[1]));
    const tipped = (t: number) => climb.tip[0] * Math.cos(4 * Math.PI * (phase(t) - climb.tip[1]));
    const turnCurl = style.turning.curl[0] * Math.abs(kappa);
    const a = Math.abs(kappa);
    const plan: CarryPlan = {
        seconds: g.stride, loop: true, gait: g, origin, way, travelled, phase,
        blend: () => 1,
        armBlend: () => 1 - s * (1 - guard.armShare),
        facing: (t) => chainAt(t).pelvis,
        stand: standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: 0, placeLift: turnStyle.lift, heel: turnStyle.heel,
        bow: (t) => (q * (climb.bow + tipped(t)) + s * guard.bow) * DEG, headBow: 0,
        curl: (t) => (q * (climb.curl - tipped(t)) + s * (guard.curl + twice(guard.pitch, t)) + turnCurl) * DEG,
        nod: (t) => (q * (climb.nod + climb.nods[0] * Math.cos(4 * Math.PI * (phase(t) - climb.nods[1]))) + s * guard.nod + style.turning.curl[1] * turnCurl) * DEG,
        pelvis: (t) => {
            const off = Math.abs(wrapLeft(lookAt(t) - way(travelled(t)).heading));
            return [
                q * once(climb.list, t) + s * (once(guard.list, t) + (guard.list[2] + guard.list[3] * off) * DEG),
                q * once(climb.hipTurn, t) + s * once(guard.yaw, t),
            ];
        },
        look: (t) => {
            const ch = chainAt(t);
            const chest = ch.chest + q * once(climb.chestTurn, t);
            return [chest, ch.chest + ch.head];
        },
        roll: (t) => [-turnSign * style.turning.roll[0] * a * DEG + q * once(climb.chestList, t), -turnSign * style.turning.roll[1] * a * DEG],
        arms: (t) => {
            const turn = 2 * Math.PI * (phase(t) - g.mode.armLag - climb.armSwing[1]);
            const of = (foot: number): [number, number, number] => {
                const kIn = foot === inner ? 0 : 1;
                const swung = -(foot ? -1 : 1) * Math.cos(turn);
                return [
                    (style.turning.armOut[kIn] * a + q * climb.armOut + s * guard.armOut) * DEG,
                    (style.turning.elbow[kIn] * a + q * (climb.elbow + (climb.elbowSwing * (1 + swung)) / 2) + s * guard.elbow) * DEG,
                    (q * (climb.armFore + climb.armSwing[0] * swung) + s * guard.armFore) * DEG,
                ];
            };
            return [of(0), of(1)];
        },
        lean: (t) => {
            const here = way(travelled(t));
            const across = rotate(axisAngle(up, here.heading), left), along = rotate(axisAngle(up, here.heading), fwd);
            const steps = 2 * phase(t);
            // Into the turn, as the sideways acceleration over gravity asks.
            const bank = scale(across, turnSign * style.turning.bank * ((g.speed * Math.abs(c.turn)) / 9.81) * L);
            // Up a slope: the level of the footfalls that carry it, over the way's own height here; less of the walk's own rise and fall.
            const less = bobLeft === 1 ? 0 : (1 - bobLeft) * (dot(pose(phase(t) * g.stride).hips, up) - mean);
            const high = level(t) - (dot(here.at, up) - dot(origin, up)) - q * climb.sink * L - less + s * (-guard.sink * L + guard.bob[0] * L * Math.cos(2 * Math.PI * (steps - guard.bob[1])));
            const ahead = q * L * (climb.fore + climb.surge[0] * Math.cos(2 * Math.PI * ((t - falls[0].on) / stepTime - climb.surge[1])))
                + s * L * (guard.surge[2] + guard.surge[0] * Math.cos(2 * Math.PI * (steps - guard.surge[1])));
            return add(add(add(bank, scale(up, high)), scale(along, ahead)), scale(across, s * guard.aside * L));
        },
        pushKnee: 0,
        airKnee: q * style.climbing.airKnee * DEG,
    };
    void fwd;
    // In place: every frame seen from the capsule, turned back by as much as its path has turned since the first.
    const heading0 = c.heading;
    const frames = carryFrames(body, plan, walked, count / g.stride).map((f) => {
        const here = input.path(f.time);
        const turned = wrap(controlsOf(body, input.path, f.time).heading - heading0);
        const back = axisAngle(up, -turned);
        const at = add(origin, sub(here, scale(sub(start, scale(up, dot(start, up))), 1)));
        const seen = (p: V3): V3 => add(origin, rotate(back, sub(p, at)));
        const world: Record<string, Quat> = {};
        for (const r of Object.keys(f.world)) world[r] = qmul(back, f.world[r] as Quat);
        return { ...f, travel: 0, hips: seen(f.hips), ankles: [seen(f.ankles[0]), seen(f.ankles[1])] as [V3, V3], world };
    });
    return { plan, frames };
}

/** Where the body is as the input begins: standing, facing so (radians from the body's forward); or walking at a speed, at a phase of its walk, its way heading so. */
export interface LocoState {
    stand?: { facing: number };
    walk?: { speed: number; phase: number; heading: number };
}

/** A run of the walk: the two inputs, how long, and where it begins. */
export interface LocoRun extends LocoInput {
    /** Seconds (a steady walk: one stride of it, whatever this says). */
    seconds?: number;
    state?: LocoState;
    /** Which foot leads where nothing else tells (a start straight ahead, a turn by nothing, which way to turn about): 0 the left, 1 the right. */
    lead?: number;
}

/**
 * One entry for every walk: from the path, the look and where the body begins, the rule that carries it. A path that
 * moves on from a walk is a steady walk (the chain and the field); one that sets off from a stand is a start; one that
 * comes to rest from a walk is a stop; one that turns back on a walk is a turn right about; one that stays where a body
 * stands is a turn on the spot toward the look (or, on guard, stepping on the spot). `count`: frames a stride of a
 * steady walk.
 */
export function locomote(
    body: Body, run: LocoRun, count = 64,
    style: LocoStyle = LOCO_STYLE, gaitStyle: GaitStyle = GAIT_STYLE,
): { kind: 'walk' | 'start' | 'stop' | 'pivot' | 'turn' | 'step'; plan: CarryPlan | null; frames: GaitFrame[] } {
    const seconds = run.seconds ?? 1;
    const end = controlsOf(body, run.path, Math.max(0, seconds - 0.05));
    const moving = end.speed > 0.05;
    const rules = style.rules;
    const toLeftOf = (angle: number) => (angle > 1e-6 ? true : angle < -1e-6 ? false : (run.lead ?? 0) === 0);
    // A turn by half a turn is either way round: the leading side says which.
    const angleOf = (a: number) => { const w = wrap(a); return Math.abs(Math.abs(w) - Math.PI) < 1e-6 ? ((run.lead ?? 0) === 0 ? Math.PI : -Math.PI) : w; };
    const walk = run.state?.walk, stand = run.state?.stand;
    if (walk) {
        if (!moving) {
            // Coming to a stand: the foot that stands as it begins is the one the walk has down at that phase.
            const standing = ((Math.round((walk.phase - rules.stop.phase) / 0.5) % 2) + 2) % 2;
            const { plan, frames } = walkStop(body, walk.speed, standing, seconds, rules.stop, gaitStyle, rules.turn);
            return { kind: 'stop', plan, frames };
        }
        if (Math.cos(end.heading - walk.heading) < -0.5) {
            const { plan, frames } = walkPivot(body, end.speed, (run.lead ?? 0) === 0, seconds, rules.pivot, gaitStyle, rules.turn, style.chain);
            return { kind: 'pivot', plan, frames };
        }
        const { plan, frames } = locoLoop(body, { ...run, phase: walk.phase }, count, style, gaitStyle, rules.turn);
        return { kind: 'walk', plan, frames };
    }
    if (stand) {
        if (moving) {
            const angle = angleOf(end.heading - stand.facing);
            const { plan, frames } = walkStart(body, end.speed, angle, toLeftOf(angle), seconds, rules.start, gaitStyle, rules.turn, style.chain);
            return { kind: 'start', plan, frames };
        }
        if ((run.posture ?? 0) >= 0.5) {
            const { plan, frames } = stepGuard(body, count, { ...GUARD_STYLE, quick: style.guard.quick, stance: rules.guardStep.stance, step: rules.guardStep.step }, gaitStyle, rules.turn);
            return { kind: 'step', plan, frames };
        }
        const look = run.look?.(seconds) ?? stand.facing;
        const angle = angleOf(look - stand.facing);
        const turn = turnFor(body, angle, rules.turn, toLeftOf(angle));
        return { kind: 'turn', plan: null, frames: turnFrames(body, turn, rules.turn, 60, style.chain) };
    }
    const { plan, frames } = locoLoop(body, run, count, style, gaitStyle, rules.turn);
    return { kind: 'walk', plan, frames };
}
