// Standing, and turning on the spot, made from formulas alone: no clip, no stored pose.
//
// A body that turns where it stands takes three steps. The foot on the side it turns to
// opens first (it goes part of the way round and points about half the way); the other foot
// swings round to where it will stand; the first foot closes. The pose at every instant
// follows from that plan of footfalls:
//
//   the stance    Stance       where the feet stand under the hips, how the body holds itself
//   the plan      turnFor      angle ─► three footfalls: which foot, when, from where to where
//   the feet      footAt       a planted foot does not move; one in the air goes the smoothest
//                              way to its next place, its heel lifted and its toes near the floor
//   the facing    chain.ts     pelvis, chest and head follow the look over the line the feet have
//                              turned, each by its spring (the chain the walk turns by)
//   the hips      hipsAt       over the feet, each counted by the weight on it (a foot in the
//                              air still counts a little: the body is on its way to it)
//   the rest      turnFrames   legs by two-bone IK, the spine from the pelvis' turn to the
//                              chest's, the trunk's nod, the swing-side hip lifted, each arm
//                              swung forward with the other side's step
//
// What gives the turn its look is a set of numbers (TURN_STYLE): shares of the body's own
// size, angles, seconds. A body is not the same to both sides (it stands with one foot back),
// so a turn to the left and one to the right each have their own. A planted foot stays where
// it is: sliding cannot happen.
//
// The formulas and which value to change for which look: editor/MOTION.md.

import { add, dot, qinv, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import type { GaitFrame } from './gait';
import { CHAIN_STYLE, chainFollow, chainOf, type ChainStyle } from './chain';
import { armBones, footTurn, legPose } from './limbs';
import { axisAngle, clamp, DEG, minJerk, slerp } from './tools';
import { HUMAN_MANNER } from './manner';

/** Where a foot stands under the body. */
export interface FootStand {
    /** The ankle from under the hips: to the foot's own side and forward, shares of hip height. */
    side: number;
    fore: number;
    /** Toes turned out, degrees. */
    out: number;
}

/** How an arm hangs, seen from the chest, degrees: out to its side, forward, and the elbow's bend. */
export interface ArmHang {
    out: number;
    fore: number;
    elbow: number;
}

/** How a body stands still. */
export interface Stance {
    /** Left foot, right foot. */
    feet: [FootStand, FootStand];
    /** How far the hips are let down from standing straight, share of hip height. */
    drop: number;
    /** Which way the pelvis, the chest and the head face, degrees to the left of the stance's own forward. */
    facing: [number, number, number];
    /** How far each leans forward, degrees. */
    lean: [number, number, number];
    /** The pelvis' list, degrees (left side up above zero). */
    list: number;
    /** Left arm, right arm. */
    arms: [ArmHang, ArmHang];
}

/** The numbers of a turn to one side. Angles in degrees; "per radian" is per radian of the turn. */
export interface TurnSide {
    /** When each of the three steps leaves the floor and lands, seconds: the near foot opens, the far foot swings round, the near foot closes. */
    steps: [[number, number], [number, number], [number, number]];
    /** The share of the last step's time in which its foot turns: it swivels first, then is drawn in (1: all the way). */
    swivel: number;
    /** Where the first step lands, round the place the body turns about. */
    first: {
        /** How far round it goes: degrees, and share of the angle. */
        round: [number, number];
        /** How far out it stands, as a share of where it stood: at no turn, and added per radian. */
        reach: [number, number];
        /** How far it turns: degrees, and share of the angle. */
        turn: [number, number];
    };
    /** How much of its weight each step takes off its foot's side (0: the hips stay between the feet; 1: they go right over the standing foot). */
    shift: [number, number, number];
    /** The trunk bows forward twice, as the turn starts and as it gathers to stop: each [from, to (seconds), degrees, degrees per radian]. */
    nod: [[number, number, number, number], [number, number, number, number]];
    /** The share of the trunk's bow the head takes. */
    headNod: number;
    /** The head turns about an axis that leans forward of the chest's own upright by this, degrees: turned far, it tilts. */
    headAxis: number;
    /** How far the hip of the foot in the air is lifted, degrees. */
    hike: number;
}

export interface TurnStyle {
    stance: Stance;
    /** How long a turn takes, whatever its angle, seconds. */
    seconds: number;
    /**
     * How a turn goes, to either side alike: a body is the same to both sides, so a turn to the right is the turn to the
     * left in a mirror (which foot is the near one and which way round it goes follow the side; the stance's own
     * difference between the feet is all that makes the two differ).
     */
    side: TurnSide;
    /** How high the ankle of a stepping foot goes, share of leg length. */
    lift: number;
    /** The foot that swings round rises with the square of how far it goes: share of leg length per (distance / leg length)². */
    swingLift: number;
    /** The foot that swings round goes wide of the straight line, away from the standing foot: share of its distance at a half turn. */
    bow: number;
    /** The hips ride highest over one foot and lowest between two: the whole range (share of hip height), and the share of it that is below standing. */
    bob: [number, number];
    /** When in each step they are highest, as a share of the step's time. */
    bobAt: [number, number, number];
    /** The point of a sole the body's weight counts at, from the heel's end (0) to the tip (1). */
    support: number;
    /** The weight starts to come off a foot this long before it leaves the floor, seconds. */
    shiftEarly: number;
    /** As the trunk bows forward the hips go back, to keep the weight over the feet: share of the trunk's length times the sine of the bow. */
    counter: number;
    /** The share of the trunk's bow the pelvis takes. */
    pelvisNod: number;
    /** A knee points between where its foot points and where the pelvis faces: the share of the way to the pelvis. */
    kneeFollow: number;
    /** How far the neck goes from the chest's turn to the head's (0: with the chest, 1: with the head). */
    neck: number;
    /** With each step the other side's arm swings forward: degrees, and degrees per radian the stepping foot turns. */
    armSwing: [number, number];
    /** The stepping side's own arm goes back by this share of that. */
    armBack: number;
    /**
     * When an arm's swing starts and ends against its step's leaving and landing, seconds: for the near foot's
     * two steps (the arm goes with the weight, ahead of the foot), and for the far foot's swing round (the arm
     * is flung by the turn, and comes back after the foot is down).
     */
    armLate: [[number, number], [number, number]];
    /** An arm that swings forward also goes out from the side: degrees out per degree forward. */
    armWide: number;
    /** The elbow bends as the arm comes forward and opens as its own side steps: degrees per degree of the arm's swing. */
    elbow: [number, number];
}

/** The default values: the stance, and the turn (to the left and to the right alike). */

export const TURN_STYLE: TurnStyle = {
    stance: {
        feet: [{ side: 0.125, fore: -0.021, out: 0.6 }, { side: 0.12, fore: -0.065, out: 5.5 }],
        drop: 0.0045,
        facing: [-6, -2.5, -0.3],
        lean: [0.7, -2.5, 5.5],
        list: 0.6,
        arms: [{ out: 18, fore: -6, elbow: 13 }, { out: 16, fore: -11, elbow: 17 }],
    },
    seconds: 2.5,
    side: {
        steps: [[0.042, 0.64], [0.54, 1.3], [1.26, 2.2]],
        swivel: 0.57,
        first: { round: [6, 0.45], reach: [0.9, 0.08], turn: [-0.6, 0.5] },
        shift: [0.36, 0.64, 0.65],
        nod: [[0, 0.8, 2.5, 1.4], [0.8, 2.2, 0.9, 1.6]],
        headNod: 0.13,
        headAxis: 3,
        hike: 2.1,
    },
    lift: 0.023,
    swingLift: 0.8,
    bow: 0.07,
    bob: [0.006, 0.35],
    bobAt: [0.45, 0.65, 0.55],
    support: 0.3,
    shiftEarly: 0.11,
    counter: 0.7,
    pelvisNod: 0.5,
    kneeFollow: HUMAN_MANNER.kneeFollow,
    neck: HUMAN_MANNER.neck,
    armSwing: [4, 2.9],
    armBack: 0.065,
    armLate: [[-0.25, 0.27], [0.1, 0.4]],
    armWide: 0.3,
    elbow: [0.9, 0.6],
};

/** Where a foot stands: the point of the floor under its ankle, and the way it points (radians about the upright from the body's forward, positive toward the left). */
export interface Stand {
    at: V3;
    heading: number;
}

/** One step of a plan: a foot leaves the place it stands and comes down at the next. */
export interface Footfall {
    /** 0: the left foot, 1: the right. */
    foot: number;
    /** Seconds. */
    lift: number;
    land: number;
    from: Stand;
    to: Stand;
    /** The foot has turned to its new heading by then, seconds. */
    turned: number;
    /** How high its ankle goes over standing, metres. */
    rise: number;
    /** How far its path goes off the straight line, and the unit vector of that way. */
    bow: number;
    wide: V3;
    /** How much of its weight it takes off its side while in the air (TurnSide.shift). */
    shift: number;
    /** It is the far foot swinging round (not the near foot opening or closing). */
    swings: boolean;
}

/** A turn on the spot, planned. */
export interface Turn {
    /** Radians, positive to the left. */
    angle: number;
    seconds: number;
    /** The numbers of its side. */
    side: TurnSide;
    /** The point of the floor the body turns about: under the hips as it stands. */
    pivot: V3;
    /** Where the feet stand before the first step. */
    start: [Stand, Stand];
    steps: Footfall[];
}

const SIDE = [1, -1];
const LEG = ['left', 'right'] as const;

/** A smooth rise and fall over v from 0 to 1: nothing at either end, 1 in the middle. */
const hump = (v: number) => Math.sin(Math.PI * clamp(v, 0, 1)) ** 2;
/** The same, at its most where v is `at` (0.5: in the middle). */
const humpAt = (v: number, at: number) => hump(Math.pow(clamp(v, 0, 1), Math.log(0.5) / Math.log(clamp(at, 0.05, 0.95))));

/** The unit vector along the floor at a heading. */
export const along = (body: Body, heading: number): V3 => add(scale(body.fwd, Math.cos(heading)), scale(body.left, Math.sin(heading)));

/** A part's world turn from its facing, its lean forward and its list (radians): listed, then leaned, then turned to face. */
export const held = (body: Body, facing: number, lean: number, list: number): Quat =>
    qmul(axisAngle(body.up, facing), qmul(axisAngle(body.left, lean), axisAngle(body.fwd, list)));

/** Where the feet of a stance stand, about a point of the floor. */
export function stanceFeet(body: Body, stance: Stance, pivot: V3): [Stand, Stand] {
    const place = (i: number): Stand => {
        const f = stance.feet[i];
        return {
            at: add(pivot, add(scale(body.left, SIDE[i] * f.side * body.hipHeight), scale(body.fwd, f.fore * body.hipHeight))),
            heading: SIDE[i] * f.out * DEG,
        };
    };
    return [place(0), place(1)];
}

/** A stand turned about a point by an angle. */
export const turnedAbout = (body: Body, s: Stand, pivot: V3, angle: number): Stand => ({
    at: add(pivot, rotate(axisAngle(body.up, angle), sub(s.at, pivot))),
    heading: s.heading + angle,
});

/**
 * The plan of a turn on the spot by `angle` (radians, positive to the left): three footfalls.
 * It ends in the stance it began in, turned by the angle about the point under the hips.
 * `toLeft` says which side's turn it is where the angle does not (a turn by nothing still
 * shifts its feet).
 */
export function turnFor(body: Body, angle: number, style: TurnStyle = TURN_STYLE, toLeft: boolean = angle >= 0): Turn {
    const { up, fwd, left } = body;
    const side = style.side;
    const sign = toLeft ? 1 : -1, size = Math.abs(angle);
    const pivot: V3 = add(sub(body.ref.hips, scale(up, dot(body.ref.hips, up))), scale(up, body.floor));
    const start = stanceFeet(body, style.stance, pivot);
    const end: [Stand, Stand] = [turnedAbout(body, start[0], pivot, angle), turnedAbout(body, start[1], pivot, angle)];
    const near = toLeft ? 0 : 1, far = 1 - near;

    // The first step: part of the way round the pivot, nearer to it or further from it, turned part of the angle.
    const from = sub(start[near].at, pivot);
    const radius = Math.hypot(dot(from, left), dot(from, fwd));
    const azimuth = Math.atan2(dot(from, left), dot(from, fwd)) + sign * (side.first.round[0] * DEG + side.first.round[1] * size);
    const mid: Stand = {
        at: add(pivot, scale(along(body, azimuth), radius * Math.max(0, side.first.reach[0] + side.first.reach[1] * size))),
        heading: start[near].heading + sign * (side.first.turn[0] * DEG + side.first.turn[1] * size),
    };

    const step = (k: number, foot: number, a: Stand, b: Stand, other: Stand): Footfall => {
        const [lift, land] = side.steps[k];
        const way = sub(b.at, a.at);
        const reach = Math.hypot(dot(way, left), dot(way, fwd));
        const far2 = (reach / body.leg) ** 2;
        // The foot that swings round rises with the square of how far it goes, and goes wide of the standing foot.
        const swings = k === 1;
        const rise = body.leg * (swings ? Math.hypot(style.lift, style.swingLift * far2) : style.lift);
        const across: V3 = reach > 1e-6 ? scale(add(scale(left, -dot(way, fwd)), scale(fwd, dot(way, left))), 1 / reach) : [0, 0, 0];
        const awayFrom = dot(sub(scale(add(a.at, b.at), 0.5), other.at), across) >= 0 ? 1 : -1;
        return {
            foot, lift, land, from: a, to: b,
            turned: k === 2 ? lift + clamp(side.swivel, 0.05, 1) * (land - lift) : land,
            rise,
            bow: swings ? style.bow * reach * ((b.heading - a.heading) / Math.PI) ** 2 : 0,
            wide: scale(across, awayFrom),
            shift: side.shift[k],
            swings,
        };
    };
    return {
        angle, seconds: style.seconds, side, pivot, start,
        steps: [
            step(0, near, start[near], mid, start[far]),
            step(1, far, start[far], end[far], mid),
            step(2, near, mid, end[near], end[far]),
        ],
    };
}

interface FootNow extends Stand {
    /** The ankle over where it stands flat, metres; whether it stands. */
    rise: number;
    standing: boolean;
}

/** A foot of a plan at a time: planted where its last step left it, or on its way. */
function footAt(body: Body, steps: Footfall[], start: [Stand, Stand], foot: number, t: number): FootNow {
    let stand = start[foot];
    for (const s of steps) {
        if (s.foot !== foot || t <= s.lift) continue;
        if (t >= s.land) { stand = s.to; continue; }
        const v = (t - s.lift) / (s.land - s.lift), u = minJerk(v);
        const turn = minJerk((t - s.lift) / Math.max(1e-6, s.turned - s.lift));
        return {
            at: add(add(s.from.at, scale(sub(s.to.at, s.from.at), u)), scale(s.wide, s.bow * 4 * u * (1 - u))),
            heading: s.from.heading + (s.to.heading - s.from.heading) * turn,
            rise: s.rise * hump(v),
            standing: false,
        };
    }
    return { ...stand, rise: 0, standing: true };
}

/** How far the trunk bows forward at a time, radians over its stance. */
function nodAt(turn: Turn, t: number): number {
    const size = Math.abs(turn.angle);
    if (!turn.steps.length) return 0;
    return turn.side.nod.reduce((sum, [from, to, deg, perRadian]) => sum + (deg + perRadian * size) * DEG * hump((t - from) / (to - from)), 0);
}

/**
 * The frames of a planned turn, `fps` a second, from the stance to the stance turned (both
 * ends included). The hips really turn and shift: nothing is taken off for a root to carry.
 */
export function turnFrames(body: Body, turn: Turn, style: TurnStyle = TURN_STYLE, fps = 60, chain: ChainStyle = CHAIN_STYLE): GaitFrame[] {
    const { left, up, fwd } = body;
    const stance = style.stance;
    const count = Math.max(1, Math.round(turn.seconds * fps));
    const spine = (['spine', 'chest', 'upperChest'] as const).filter((r) => body.roles[r] !== undefined);
    const middle = body.sole.heel + style.support * (body.sole.tip - body.sole.heel);
    /** The point of a foot's sole the weight counts at, on the floor. */
    const support = (f: Stand): V3 => add(f.at, scale(along(body, f.heading), middle));
    // Standing, the hips are not quite over the middle between the soles: what is left turns with the pelvis.
    const between = scale(add(support(turn.start[0]), support(turn.start[1])), 0.5);
    const offset = sub(turn.pivot, between);
    const trunk = body.roles.neck !== undefined ? dot(sub(body.ref.neck, body.ref.hips), up) : dot(sub(body.ref.head, body.ref.hips), up);
    const first = turn.steps[0] as Footfall | undefined, last = turn.steps[turn.steps.length - 1] as Footfall | undefined;
    // How the head sits on the chest, standing.
    const headOnChest = qmul(qinv(held(body, stance.facing[1] * DEG, stance.lean[1] * DEG, 0)), held(body, stance.facing[2] * DEG, stance.lean[2] * DEG, 0));
    const standingHeight = body.floor + body.hipHeight * (1 - stance.drop) + dot(sub(body.ref.hips, body.ref.leftUpperLeg), up);

    // The line is how far the feet have turned, and the body follows the look (where the turn ends) over it by the chain.
    const lineAt = (t: number) => { const f = [0, 1].map((i) => footAt(body, turn.steps, turn.start, i, t)); return (f[0].heading - turn.start[0].heading + f[1].heading - turn.start[1].heading) / 2; };
    const follow = chainFollow(chain, (t) => chainOf(chain, turn.angle - lineAt(t)), turn.seconds);
    const frames: GaitFrame[] = [];
    for (let k = 0; k <= count; k++) {
        const t = (k * turn.seconds) / count;
        const feet = [0, 1].map((i) => footAt(body, turn.steps, turn.start, i, t));
        const chained = follow(t), line = lineAt(t);
        const facing = [0, 1].map((p) => stance.facing[p] * DEG + line + chained.pelvis + (p ? chained.chest : 0));
        const nod = nodAt(turn, t);
        // The hip of the foot in the air is lifted.
        const hike = turn.steps.reduce((sum, s) => sum + SIDE[s.foot] * hump((t - s.lift) / (s.land - s.lift)), 0) * turn.side.hike * DEG;
        const pelvis = held(body, facing[0], stance.lean[0] * DEG + style.pelvisNod * nod, stance.list * DEG + hike);
        const chest = held(body, facing[1], stance.lean[1] * DEG + nod, 0);
        // The head is carried by the chest and turns on it about an axis that leans forward: turned far, it tilts.
        // Of the trunk's bow it takes its share, and gives the rest back about its own side axis.
        const lead = chained.head;
        const axis = add(scale(up, Math.cos(turn.side.headAxis * DEG)), scale(fwd, Math.sin(turn.side.headAxis * DEG)));
        const head = qmul(chest, qmul(axisAngle(axis, lead), qmul(headOnChest, axisAngle(left, -(1 - turn.side.headNod) * nod))));

        // The hips: over the feet, each counted by the weight on it; back a little as the trunk bows.
        // The weight comes off a foot a little before it leaves the floor, and is back on it as it lands.
        const weights = [0, 1].map((i) => turn.steps.reduce((w, s) => {
            const early = Math.min(style.shiftEarly, s.lift);
            return s.foot === i ? w - s.shift * hump((t - s.lift + early) / (s.land - s.lift + early)) : w;
        }, 1));
        const over = scale(add(scale(support(feet[0]), weights[0]), scale(support(feet[1]), weights[1])), 1 / (weights[0] + weights[1]));
        const turned = axisAngle(up, facing[0] - stance.facing[0] * DEG);
        const back = style.counter * trunk * (Math.sin(stance.lean[1] * DEG + nod) - Math.sin(stance.lean[1] * DEG));
        // Highest over one foot, lowest between two.
        const single = turn.steps.reduce((sum, s, j) => sum + humpAt((t - s.lift) / (s.land - s.lift), style.bobAt[j] ?? 0.5), 0);
        const turning = first && last ? minJerk((t - first.lift) / ((first.land - first.lift) / 2)) - minJerk((t - (last.lift + last.land) / 2) / ((last.land - last.lift) / 2)) : 0;
        const height = standingHeight + style.bob[0] * body.hipHeight * (single - style.bob[1] * turning);
        const flat = add(add(over, rotate(turned, offset)), scale(along(body, facing[0]), -back));
        const hips = add(sub(flat, scale(up, dot(flat, up))), scale(up, height));

        const world: Record<string, Quat> = { hips: pelvis };
        const ankles: V3[] = [], standingNow: boolean[] = [], short: number[] = [], knees: number[] = [];
        for (let i = 0; i < 2; i++) {
            const f = feet[i];
            const socket = add(hips, rotate(pelvis, sub(body.ref[`${LEG[i]}UpperLeg`], body.ref.hips)));
            const want = add(sub(f.at, scale(up, dot(f.at, up))), scale(up, body.floor + body.ankleHeight + f.rise));
            // The knee points between where the foot points and where the pelvis faces.
            const leg = legPose(body, socket, want, along(body, f.heading + style.kneeFollow * (facing[0] - f.heading)));
            // The heel lifts and the toes stay near the floor: the foot pitched as if it stood on its tip.
            const pitch = -Math.asin(clamp(f.rise / body.sole.tip, 0, 1));
            world[`${LEG[i]}UpperLeg`] = leg.upper;
            world[`${LEG[i]}LowerLeg`] = leg.lower;
            world[`${LEG[i]}Foot`] = footTurn(body, i, f.heading, pitch);
            world[`${LEG[i]}Toes`] = world[`${LEG[i]}Foot`];
            ankles.push(leg.ankle);
            standingNow.push(f.standing);
            short.push(leg.short);
            knees.push(leg.knee);
        }

        // The spine's bones go evenly from the pelvis' turn to the chest's; the neck part of the way from the chest's to the head's.
        spine.forEach((r, j) => (world[r] = slerp(pelvis, chest, (j + 1) / spine.length)));
        const above = spine.length ? chest : pelvis;
        world.neck = slerp(above, head, style.neck);
        world.head = head;

        // Arms: each hangs from the chest as it does standing, and swings forward with the other side's step (back a little with its own).
        for (let i = 0; i < 2; i++) {
            const hang = stance.arms[i];
            // How far the other side's steps have it forward now, and its own side's steps back.
            let forward = 0, backward = 0;
            for (const s of turn.steps) {
                const size = (style.armSwing[0] + style.armSwing[1] * Math.abs(s.to.heading - s.from.heading)) * DEG;
                const late = style.armLate[s.swings ? 1 : 0];
                const from = Math.max(0, s.lift + late[0]), to = s.land + late[1];
                if (s.foot === i) backward += size * hump((t - from) / (to - from));
                else forward += size * hump((t - from) / (to - from));
            }
            const fore = hang.fore * DEG + forward - style.armBack * backward;
            const elbow = Math.max(0, hang.elbow * DEG + style.elbow[0] * forward - style.elbow[1] * backward);
            // Seen from the chest: out to its side and forward of straight down.
            const out = hang.out * DEG + style.armWide * (forward - style.armBack * backward);
            const down = add(add(scale(left, SIDE[i] * Math.tan(out)), scale(up, -1)), scale(fwd, Math.tan(fore)));
            const length = Math.hypot(down[0], down[1], down[2]);
            const arm = armBones(body, SIDE[i], rotate(above, scale(down, 1 / length)), rotate(above, scale(left, -1)), elbow);
            world[`${LEG[i]}Shoulder`] = above;
            world[`${LEG[i]}UpperArm`] = arm.upper;
            world[`${LEG[i]}LowerArm`] = arm.fore;
            world[`${LEG[i]}Hand`] = arm.fore;
        }

        frames.push({
            time: t, travel: 0, hips, world,
            ankles: ankles as [V3, V3], stance: standingNow as [boolean, boolean], pivots: [null, null], short: short as [number, number], knees: knees as [number, number],
        });
    }
    return frames;
}

/** The body standing still: the first frame of a turn by nothing. */
export function standFrame(body: Body, style: TurnStyle = TURN_STYLE): GaitFrame {
    return turnFrames(body, { ...turnFor(body, 0, style), steps: [], seconds: 1 }, style, 1)[0];
}
