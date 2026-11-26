// A walk carried onto a plan: starting to walk from a standstill, turning to the way it goes; turning right about; coming to a stand.
//
// gait.ts makes a walk as one stride at one speed on a straight line. Here that same walk is
// carried along the body's own way over the floor, between places the body really stands:
//
//   the plan      CarryPlan    how far the body has gone at each time, the walk's phase then, how
//                              much of the pose is the walk's (the rest is the standing pose), how
//                              far the body is still turned against its way, and for each foot the
//                              places it is planted and when (`Hold`)
//   the feet      carryFrames  a planted foot does not move; it rolls heel, flat, forefoot as the
//                              walk's foot does at that phase. A foot in the air is the walk's own
//                              swing, set down exactly on the planned place, with what it differs by
//                              at either end faded in and out (it starts where the foot really was)
//   the body      carryFrames  the walk's pose at that phase mixed with the standing pose, turned
//                              as far as the body still is; the legs by two-bone IK to the feet
//   the planners  walkStart    a start: the standing foot is where the walk would have it, so the
//                              walk begins part-way through a step; the body is up to speed and
//                              turned within a fraction of a second
//                 walkPivot    a turn right about while walking: the foot in the air is put down
//                              at once, and from there it is a start by a half turn, begun from
//                              the walking pose instead of the standing one (frames in place)
//                 walkArc      a walk round a circle: the same walk on a way that bends, the inner
//                              foot's steps shorter by themselves; the body leans in and looks
//                              where it goes (one stride, in place)
//                 walkSlope    a walk up or down a slope: the same walk on a way that climbs, its
//                              footfalls each on a level of its own (stairs); the body's weight
//                              goes from one level to the next in its own time, the foot in the air
//                              is lifted clear, the trunk leans into the climb (one stride, in place)
//                 walkStop     a stop: the foot in the air lands, the other is set down where the
//                              body will stand, the first is set beside it; the body slows to a
//                              stand meanwhile and the pose goes over to the standing one
//
// Where the plan asks for nothing but the walk (full weight, no turn, feet on the walk's own
// places) the frames are the walk's, number for number.
//
// The formulas and which value to change for which look: editor/MOTION.md.

import { add, dot, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import { GAIT_STYLE, gaitFor, gaitPoser, type Gait, type GaitFrame, type GaitKind, type GaitPose, type GaitStyle, armEffort, armsAt } from './gait';
import { footTurn, legPose, legSpan, kneeFor } from './limbs';
import { rolled, soleRoll } from './sole';
import { axisAngle, clamp, DEG, GRAVITY, minJerk, slerp } from './tools';
import { along, stanceFeet, standFrame, TURN_STYLE, type Stand, type TurnStyle } from './turn';
import { HUMAN_MANNER, sidePull } from './manner';
import { HUMAN_RANGES } from './mass';

/** A foot planted for a while. */
export interface Hold {
    /** It stands from `on` until `off`, seconds. */
    on: number;
    off: number;
    stand: Stand;
    /** The stride of the walk whose stance it follows in rolling (heel, flat, forefoot), counted as gait.ts counts them; null: it stands flat, and is set down without the walk's swing. */
    cycle: number | null;
    /** A place of the body's own stance, not one of the walk's: its roll fades with the walk's weight. */
    own: boolean;
    /** It swivels where it stands: how far it has turned at a time, radians (the pelvis drags it round). */
    swivel?: (t: number) => number;
    /** Stepped onto with a shuffle: how much of the walk's swing it keeps on the way here, of its lift and of its heel's pitch (1: all). */
    soft?: [number, number];
    /** Set elsewhere than the walk's own place: swung as the walk's swing drawn out or squeezed to the step it takes. */
    squeeze?: boolean;
    /** Where the walk itself would have planted it, where the plan aims the foot elsewhere once it has begun (the foot is already in the air as the plan starts). */
    walk?: Stand;
    /** The gait it is stepped in (a walk's, a run's): standing here the foot rolls as that gait's does, and a foot swinging onto it swings as that gait's does where the time's own gait is of another kind. None: the time's own gait. */
    gait?: Gait;
    /** It rolls through its stance by time, from when it lands to when it leaves (a stance cut short of its gait's phases: a running foot that leaves as the run's would, though the steps slow). None: by the phase. */
    byTime?: boolean;
    /** When a roll by time is timed to end, if not when the foot leaves: the plan's own time, kept where the stance is cut short because the leg can no longer reach the foot (it leaves part of the way through its roll, as it is then). */
    rollsTo?: number;
    /** Set down on without the walk's swing (the smoothest way, low), though it rolls as the walk's foot does once it stands. */
    place?: boolean;
    /** How far along the plan's way it stands, metres (a way that bends or climbs: the swing onto it follows the way). */
    along?: number;
    /** How high over the floor it stands, metres (a step of a stair: the foot stands level on it). */
    up?: number;
    /** On its way here the foot is lifted further than the walk lifts it: by so much at most, metres, and most at this share of the swing's time. */
    clear?: [number, number];
    /** On its way here the foot turns out to its own side and back, over what the walk's swing turns it: radians at most, and most at this share of the swing's time. */
    twist?: [number, number];
    /** It stands slanted with the ground under it: its toes up by so much, radians (a foot lying along a slope; none: level). */
    tilt?: number;
}

/** A walk carried along a way, planned. */
export interface CarryPlan {
    seconds: number;
    /** The plan repeats every `seconds` (one stride of a walk that goes on): what is asked of a time before or after is as good as within. */
    loop?: boolean;
    /** The walk that is carried. */
    gait: Gait;
    /** A way whose pace changes: the walk at the pace of a time (each a walk of `gaitFor`; the same one for the same pace). None: `gait` throughout. */
    gaitAt?: (t: number, kind?: GaitKind) => Gait;
    /** How fast the body goes along its way at a time, and the walk's top pace (metres a second): a leg going over between a run's footfall and a walk's swings by them. None: such a leg swings as the run's. */
    paceAt?: (t: number) => number;
    walkTop?: number;
    /** Where it goes over from one kind of gait to another: the trunk's pose is so much (`share`) that of `other` at a time; none: its own gait's. */
    mixAt?: (t: number) => { other: Gait; share: number } | null;
    /** Where the way begins, on the floor; it goes straight along the body's forward unless `way` says otherwise. */
    origin: V3;
    /**
     * A way that bends or climbs: where the body is after going `s` metres along it (how high that is over where the
     * way begins is the ground's height there), and which way it goes there (radians about the upright from the body's
     * forward, positive to the left).
     */
    way?: (s: number) => { at: V3; heading: number };
    /** The chest and the head look off the way the body faces by so much at a time, radians (into a turn): the spine and the neck share it out. */
    look?: (t: number) => [number, number];
    /** The chest and the head are rolled to a side by so much at a time, radians (left side up above zero): shared out the same way. */
    roll?: (t: number) => [number, number];
    /** Each arm (left, right) is held further out from the side and its elbow more bent by so much at a time, radians; and (a third number) swung further forward about its shoulder. */
    arms?: (t: number) => [[number, number, number?], [number, number, number?]];
    /** The pelvis alone lists and turns about the upright by so much at a time, radians (its left side up, to the left above zero): the legs hang from it, the spine keeps its own turns. */
    pelvis?: (t: number) => [number, number];
    /** The head alone nods by so much at a time, radians (down above zero); the neck goes half the way. */
    nod?: (t: number) => number;
    /** How far along the way the body is at a time, metres. */
    travelled: (t: number) => number;
    /** The walk's phase at a time, in strides (0: the left heel strikes). */
    phase: (t: number) => number;
    /** How much of the pose is the walk's at a time: 0 standing, 1 walking. */
    blend: (t: number) => number;
    /** How much of the arms' pose is the walk's at a time (the rest hangs as standing); none: as much as of the rest. */
    armBlend?: (t: number) => number;
    /** How far the body is turned against its way at a time, radians (positive to the left). */
    facing: (t: number) => number;
    /** The standing pose, facing along the way (where it stands does not matter: it is carried along). */
    stand: GaitFrame;
    /** Left foot, right foot: the places each is planted, in order of time. */
    holds: [Hold[], Hold[]];
    /** A knee points between where its foot points and where the body faces: the share of the way to the body, walking and standing. */
    kneeFollow: number;
    standKnee: number;
    /** How high the ankle of a foot set down without the walk's swing goes, share of leg length (its heel lifting as that rise has it). */
    placeLift: number;
    /** How far the trunk bows forward at a time, over what the poses have, radians; and the share of it the head takes. */
    bow: (t: number) => number;
    headBow: number;
    /** How far the spine curls forward over the pelvis at a time, radians at the chest (the bones between take their share; the head takes the head's share). */
    curl?: (t: number) => number;
    /** How far the hips are off their way over the floor at a time (toward the foot the body turns over), metres. */
    lean: (t: number) => V3;
    /** A foot of the body's own stance that is left behind keeps its knee bent by this as its heel rises, radians. */
    pushKnee: number;
    /**
     * A leg in the air keeps its knee bent by at least this, radians: where its foot would be out of reach so, the foot
     * is drawn in; and a foot lands only when its leg reaches the place with the knee that much bent. None: a leg may
     * be stretched straight. (Or by the kind of gait of the footfall the leg swings from or to, the more of the two.)
     */
    airKnee?: number | ((kind: GaitKind) => number);
    /** A foot of the body's own stance takes less of the walk's roll by rolling less on its sole; none: by being drawn toward lying flat (its contact point slips). */
    rollOwn?: boolean;
    /** A foot that is in the air as the plan begins, with no hold before: how it is then. */
    airborne?: [FootNow | null, FootNow | null];
}

const SIDE = [1, -1];
const LEG = ['left', 'right'] as const;
const LEGS = new Set(['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']);
const ARMS = new Set(['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']);
const hump = (v: number) => Math.sin(Math.PI * clamp(v, 0, 1)) ** 2;

/** A foot at an instant. */
export interface FootNow {
    ankle: V3;
    /** Toes up, radians: the foot, and its toes. */
    pitch: number;
    toes: number;
    /** The way it points, and the way its leg goes (the same but for a swinging foot's own turn out and back). */
    heading: number;
    way: number;
    standing: boolean;
    /** How high the ground under it is over the floor, metres (a step of a stair); none: the floor itself. */
    floor?: number;
    /** In the air: the least it keeps its knee bent, radians (none: it may be stretched straight). */
    airKnee?: number;
}

/** The frames of a carried walk, `fps` a second, both ends included. The hips really travel. */
export function carryFrames(body: Body, plan: CarryPlan, gaitStyle: GaitStyle = GAIT_STYLE, fps = 60): GaitFrame[] {
    const { left, up, fwd } = body;
    const g = plan.gait;
    /** The walk at a time: the plan's one walk, or, where the pace changes, the walk at that time's pace. */
    const gaitOf = (t: number): Gait => (plan.gaitAt ? plan.gaitAt(t) : g);
    const kits = new Map<Gait, { pose: (t: number) => GaitPose; seen: Map<number, GaitPose> }>();
    const kitOf = (G: Gait) => {
        let kit = kits.get(G);
        if (!kit) { kit = { pose: gaitPoser(body, G, gaitStyle), seen: new Map() }; kits.set(G, kit); }
        return kit;
    };
    const sole = soleRoll(body);
    const h = body.ankleHeight;
    const flatOf = (s: Stand): V3 => add(sub(s.at, scale(up, dot(s.at, up))), scale(up, body.floor + h));
    /** Where a foot's ankle is, standing flat on a hold: on the floor, or on the hold's own level. */
    const flatOn = (hold: Hold): V3 => (hold.up ? add(flatOf(hold.stand), scale(up, hold.up)) : flatOf(hold.stand));
    /** Up and down once between 0 and 1: the smoothest way from rest up to its top (1, at `at`), then the smoothest way down to rest. */
    const humpAt = (at: number) => {
        const top = clamp(at, 0.1, 0.9);
        return (u: number) => (u <= top ? minJerk(clamp(u / top, 0, 1)) : 1 - minJerk(clamp((u - top) / (1 - top), 0, 1)));
    };
    /** Where the walk has a foot's ankle standing flat in its `cycle`-th stride, in the walk's own world. */
    const walkFlat = (foot: number, cycle: number, G: Gait = g): V3 =>
        add(add(scale(fwd, G.speed * G.stride * (cycle + 0.5 * foot) + G.lead), scale(left, (SIDE[foot] * G.width) / 2)), scale(up, body.floor + h));
    /** A walk at a phase (kept: the same phases are asked for at every frame). */
    const walkAt = (phase: number, G: Gait = g): GaitPose => {
        const kit = kitOf(G);
        let w = kit.seen.get(phase);
        if (!w) { w = kit.pose(phase * G.stride); kit.seen.set(phase, w); }
        return w;
    };

    const stand = plan.stand;
    const standOff = sub(stand.hips, plan.origin);
    /** How much of the spine's curl each bone of the spine has, from the pelvis up. */
    const spineRoles = (['spine', 'chest', 'upperChest'] as const).filter((r) => body.roles[r] !== undefined);
    const spineShare: Record<string, number> = {};
    spineRoles.forEach((r, j) => (spineShare[r] = (j + 1) / spineRoles.length));
    /** Which way the standing pose's pelvis faces. */
    const standFacing = (() => { const v = rotate(stand.world.hips, fwd); return Math.atan2(dot(v, left), dot(v, fwd)); })();
    interface Trunk { W: GaitPose; w: number; turned: number; heading: number; hips: V3; world: Record<string, Quat> }
    const trunks = new Map<number, Trunk>();
    /** The body but for its legs at a time: the walk's pose at that phase mixed with the standing pose, turned and bowed. */
    const trunkAt = (t: number): Trunk => {
        const kept = trunks.get(t);
        if (kept) return kept;
        const w = clamp(plan.blend(t), 0, 1), turned = plan.facing(t);
        const wArm = plan.armBlend ? clamp(plan.armBlend(t), 0, 1) : w;
        let W = walkAt(plan.phase(t), gaitOf(t));
        const mix = plan.mixAt?.(t);
        if (mix && mix.share > 0) {
            // Going over to another kind of gait: the trunk, the arms and the hips' own sway and bob part the one's, part the other's.
            const O = walkAt(plan.phase(t), mix.other), k = clamp(mix.share, 0, 1);
            const offW = sub(W.hips, scale(fwd, W.travel)), offO = sub(O.hips, scale(fwd, O.travel));
            const world: Record<string, Quat> = {};
            for (const r of Object.keys(W.world)) world[r] = O.world[r] ? slerp(W.world[r], O.world[r], k) : W.world[r];
            W = { ...W, hips: add(W.hips, scale(sub(offO, offW), k)), world, legTurn: W.legTurn + (O.legTurn - W.legTurn) * k };
        }
        // Where the body is on its way, and which way the way goes there.
        const gone = plan.travelled(t);
        const where = plan.way ? plan.way(gone) : { at: add(plan.origin, scale(fwd, gone)), heading: 0 };
        const onWay = axisAngle(up, where.heading);
        const spin = axisAngle(up, where.heading + turned);
        // The hips: over that place, what the walk and the standing pose each have them at.
        const root = where.at;
        const walkOff = rotate(onWay, sub(W.hips, scale(fwd, W.travel)));
        // (The standing pose is turned as a whole, where its hips are over its feet with it.)
        const hips = add(add(root, add(scale(rotate(spin, standOff), 1 - w), scale(walkOff, w))), plan.lean(t));
        // The trunk bows about the body's own side axis: the pelvis and all it carries; the head takes its share.
        const bowed = plan.bow(t), curled = plan.curl ? plan.curl(t) : 0;
        const side = rotate(spin, left);
        const world: Record<string, Quat> = {};
        for (const r of Object.keys(W.world)) {
            if (LEGS.has(r)) continue;
            const held = qmul(spin, slerp(stand.world[r] ?? W.world[r], W.world[r], ARMS.has(r) ? wArm : w));
            const head = r === 'head' ? plan.headBow : r === 'neck' ? (1 + plan.headBow) / 2 : 1;
            // The curl grows up the spine: nothing at the pelvis, all of it from the chest's top on.
            const up1 = r === 'hips' ? 0 : spineShare[r] ?? 1;
            world[r] = qmul(axisAngle(side, (bowed + curled * up1) * head), held);
        }
        // (The head's own nod first: the look then turns it with the head.)
        if (plan.nod) {
            const nodded = plan.nod(t);
            if (nodded) {
                world.head = qmul(axisAngle(side, nodded), world.head);
                if (world.neck) world.neck = qmul(axisAngle(side, nodded / 2), world.neck);
            }
        }
        if (plan.look) {
            // Looking off its way: the spine shares the chest's part out, the neck goes half the way from the chest's to the head's.
            const [chestLook, headLook] = plan.look(t);
            for (const r of Object.keys(world)) {
                const share = r === 'hips' ? 0 : r === 'head' ? headLook : r === 'neck' ? (chestLook + headLook) / 2 : chestLook * (spineShare[r] ?? 1);
                if (share) world[r] = qmul(axisAngle(up, share), world[r]);
            }
        }
        if (plan.roll) {
            const [chestRoll, headRoll] = plan.roll(t);
            const ahead = rotate(spin, fwd);
            for (const r of Object.keys(world)) {
                const share = r === 'hips' ? 0 : r === 'head' ? headRoll : r === 'neck' ? (chestRoll + headRoll) / 2 : chestRoll * (spineShare[r] ?? 1);
                if (share) world[r] = qmul(axisAngle(ahead, share), world[r]);
            }
        }
        if (plan.arms) {
            const more = plan.arms(t);
            const ahead = rotate(spin, fwd);
            for (let i = 0; i < 2; i++) {
                const [out, bend, fore] = more[i];
                const upper = `${LEG[i]}UpperArm`, lower = `${LEG[i]}LowerArm`, hand = `${LEG[i]}Hand`;
                if (!world[upper] || !world[lower]) continue;
                // Further forward: the whole arm about the body's side axis, at the shoulder.
                if (fore) for (const r of [upper, lower, hand]) if (world[r]) world[r] = qmul(axisAngle(side, -fore), world[r]);
                // Further out: the whole arm turned about the way forward, at the shoulder. More bent: the forearm and the hand about the elbow's own axis.
                if (out) for (const r of [upper, lower, hand]) if (world[r]) world[r] = qmul(axisAngle(ahead, SIDE[i] * out), world[r]);
                if (bend) {
                    const hinge = rotate(world[lower], scale(up, -SIDE[i]));
                    for (const r of [lower, hand]) if (world[r]) world[r] = qmul(axisAngle(hinge, bend), world[r]);
                }
            }
        }
        if (plan.pelvis) {
            const [listed, swung] = plan.pelvis(t);
            if (listed) world.hips = qmul(axisAngle(rotate(spin, fwd), listed), world.hips);
            if (swung) world.hips = qmul(axisAngle(up, swung), world.hips);
        }
        const made = { W, w, turned, heading: where.heading, hips, world };
        trunks.set(t, made);
        return made;
    };
    /** The least a leg in the air keeps its knee bent, for a footfall of a kind of gait (0: none, it may be stretched straight). */
    const airKneeOf = (kind?: GaitKind) => (typeof plan.airKnee === 'function' ? plan.airKnee(kind ?? 'walk') : plan.airKnee ?? 0);
    /** How far a leg in the air reaches, and one that lands, for a footfall of a kind of gait. */
    const airSpanOf = (kind?: GaitKind) => { const k = airKneeOf(kind); return k ? legSpan(body, k) : body.leg; };
    const socketAt = (foot: number, t: number): V3 => {
        const b = trunkAt(t);
        return add(b.hips, rotate(b.world.hips, sub(body.ref[`${LEG[foot]}UpperLeg`], body.ref.hips)));
    };

    /**
     * A planted foot: it rolls as the walk's foot does at this phase of its stance. Where the leg
     * can no longer reach it so, the hips having passed it, its heel rises further, the foot
     * rolling on its forefoot, as far as the leg needs (one of the body's own stance keeps its knee
     * bent meanwhile; one of the walk's is only kept within reach).
     */
    const planted = (foot: number, hold: Hold, t: number): FootNow => {
        const flat = flatOn(hold);
        const heading = hold.stand.heading + (hold.swivel ? hold.swivel(Math.min(t, hold.off)) : 0);
        let now: FootNow = { ankle: flat, pitch: 0, toes: 0, heading, way: heading, standing: true, floor: hold.up ?? 0 };
        if (hold.cycle !== null) {
            const G = hold.gait ?? gaitOf(t);
            const p = hold.byTime && hold.off > hold.on && Number.isFinite(hold.on + hold.off) ? clamp((t - hold.on) / ((hold.rollsTo ?? hold.off) - hold.on), 0, 1 - 1e-6)
                : clamp((plan.phase(t) - (hold.cycle + 0.5 * foot)) / G.duty, 0, 1 - 1e-6);
            const w = walkAt(hold.cycle + 0.5 * foot + p * G.duty, G);
            const f = w.feet[foot];
            const k = hold.own ? clamp(plan.blend(t), 0, 1) : 1;
            const turn = axisAngle(up, heading - SIDE[foot] * G.toeOut);
            if (plan.rollOwn && hold.own && k < 1) {
                // Less of the walk's roll, as a roll: the foot pitched by less, rolling on its sole without slipping.
                const r = rolled(sole, h, f.pitch * k);
                now = { ...now, ankle: add(add(flat, scale(along(body, heading), r.along)), scale(up, r.up)), pitch: f.pitch * k, toes: body.stiffToes ? f.pitch * k : Math.min(0, f.toes) * k };
            } else now = { ...now, ankle: add(flat, rotate(turn, scale(sub(w.ankles[foot], f.flat), k))), pitch: f.pitch * k, toes: f.toes * k };
        }
        const socket = socketAt(foot, t);
        const straight = body.leg * (1 - 1e-4);
        // How far the hip has passed the foot on its way: the bent knee is asked for little by little as it does.
        const passed = clamp((dot(sub(socket, now.ankle), along(body, trunkAt(t).heading)) - 0.05 * body.leg) / (0.2 * body.leg), 0, 1);
        const reach = hold.own ? straight + (legSpan(body, plan.pushKnee) - straight) * passed : airKneeOf(hold.gait?.kind) ? airSpanOf(hold.gait?.kind) : straight;
        const gap = (p: FootNow) => { const d = sub(p.ankle, socket); return Math.hypot(d[0], d[1], d[2]); };
        if (gap(now) > reach) {
            const start = now, way = along(body, heading);
            const tipped = (pitch: number): FootNow => {
                const r = rolled(sole, h, pitch);
                return { ...start, ankle: add(add(flat, scale(way, r.along)), scale(up, r.up)), pitch, toes: body.stiffToes ? pitch : Math.min(0, start.toes) };
            };
            let lo = Math.min(0, start.pitch), hi = -80 * DEG;
            // Rolled as far as brings it within reach; a foot no roll can bring there is left as it is (it has to leave the floor: below).
            if (gap(tipped(hi)) <= reach) {
                for (let n = 0; n < 30; n++) { const mid = (lo + hi) / 2; if (gap(tipped(mid)) > reach) lo = mid; else hi = mid; }
                now = tipped(hi);
            } else if (gap(tipped(hi)) <= straight) {
                for (let n = 0; n < 30; n++) { const mid = (lo + hi) / 2; if (gap(tipped(mid)) > straight) lo = mid; else hi = mid; }
                now = tipped(hi);
            }
        }
        return hold.tilt ? { ...now, pitch: now.pitch + hold.tilt } : now;
    };
    /** Whether a planted foot is within its leg's reach at a time (the leg stretched straight, or as far as `span`). */
    const reached = (foot: number, hold: Hold, t: number, span = body.leg) => {
        const d = sub(planted(foot, hold, t).ankle, socketAt(foot, t));
        return Math.hypot(d[0], d[1], d[2]) <= span + 1e-7;
    };

    /**
     * A foot in the air between two holds. Set down on a place of the walk's, it is the walk's own
     * swing put where that place is, and what it differs by where it left and where it lands fades
     * out and in. Set down flat (no stride of the walk's), it goes the smoothest way, low, its heel lifted.
     */
    const swinging = (foot: number, a: Hold | null, b: Hold, t: number): FootNow => {
        // A foot already in the air as the plan starts is the walk's own until then; from then on it is aimed where the plan has it.
        // (Only where the plan gives the walk's own place for it: any other foot in the air then has swung from where it left.)
        const reaimed = !!a && a.off < 0 && !!b.walk;
        const began = !a || reaimed ? 0 : a.off;
        const inAir = a ? null : plan.airborne?.[foot] ?? null;
        const u = clamp((t - began) / Math.max(1e-6, b.on - began), 0, 1), fade = minJerk(u);
        const to = planted(foot, b, b.on);
        if (b.cycle === null || b.place) {
            const from = inAir ?? planted(foot, a!, a!.off);
            // (A foot that comes down from the air is only set down: it is not lifted again on the way.)
            // (And lifted clear by what the place asks: a hop.)
            const rise = inAir ? 0 : plan.placeLift * body.leg * hump(u) + (b.clear && b.clear[0] ? b.clear[0] * humpAt(b.clear[1])(u) : 0);
            const pitch = -Math.asin(clamp(rise / body.sole.tip, 0, 1)) + from.pitch * (1 - fade);
            const heading = from.heading + (to.heading - from.heading) * fade;
            // (Brought up from a running stance, or set down into a run's footfall, it is carried along with the body, which goes
            // fast meanwhile: from where it was against the body to where it lands against it.)
            let path = add(from.ankle, scale(sub(to.ankle, from.ankle), fade));
            if (((a?.gait && a.gait.kind !== 'walk') || (b.gait && b.gait.kind !== 'walk')) && plan.way) {
                const bodyAt = (at: number) => plan.way!(plan.travelled(at)).at;
                path = add(bodyAt(t), add(scale(sub(from.ankle, bodyAt(began)), 1 - fade), scale(sub(to.ankle, bodyAt(b.on)), fade)));
            }
            return {
                ankle: add(path, scale(up, rise)), pitch, toes: pitch, heading, way: heading, standing: false,
                floor: Math.min(from.floor ?? 0, to.floor ?? 0),
            };
        }
        // (Where the pace changes, each pose of the walk is of its own time's walk, measured from that walk's own place.)
        // (A footfall of another kind of gait than the time's is swung onto as its own kind swings, at the time's pace. From a
        // footfall of one kind to one of another, it is the run's own swing, the one that reaches across the long step between
        // them, drawn out or hurried over the time it has: the two gaits do not have the foot in the air at the same phases.)
        const across = !!a?.gait && !!b.gait && a.gait.kind !== b.gait.kind && !inAir && !reaimed;
        const swingKind = across ? (a!.gait!.kind === 'walk' ? b.gait!.kind : a!.gait!.kind) : null;
        const of = (at: number) => {
            const G = gaitOf(at), kind = swingKind ?? (b.gait && G.kind !== b.gait.kind ? b.gait.kind : G.kind);
            return kind === G.kind ? G : plan.gaitAt?.(at, kind) ?? b.gait ?? G;
        };
        // (A running foot swings as one run does all through, the faster of the one it leaves and the one it lands in (the one
        // that reaches across the step): setting off or braking, the run's stride changes too fast with the pace for each
        // time's own run to carry it, the foot would be drawn back.)
        const onFrom = of(began), onTo = of(b.on), running = onTo.kind !== 'walk' && onFrom.kind !== 'walk';
        const one = onTo.speed >= onFrom.speed ? onTo : onFrom;
        // A running leg, and one going over between a run's footfall and a walk's, swings against the body, which speeds up
        // or brakes under it: set against the place it lands on, the foot would be left behind a body that brakes (the leg
        // thrown straight back of the pelvis) and run ahead of one that speeds up. Each gait's own swing is drawn out or
        // hurried over the time the leg has. Between a run's footfall and a walk's it swings part as the run's leg, part as
        // the walk's: as much the run's as the pace still is above the walk's top, against the faster pace of its two ends.
        if (running && plan.way && a && !inAir && !reaimed) {
            const wayOf = plan.way;
            const runG = one, walkG = across ? (a.gait!.kind === 'walk' ? a.gait! : b.gait!) : null;
            const top = plan.walkTop ?? 0, paceOf = plan.paceAt;
            const fastest = paceOf ? Math.max(paceOf(began), paceOf(Math.min(b.on, plan.seconds))) : 0;
            const runShare = (at: number) => (!walkG ? 1 : !paceOf || !(fastest > top) ? 1 : clamp((paceOf(Math.min(at, plan.seconds)) - top) / (fastest - top), 0, 1));
            const strike = b.cycle! + 0.5 * foot;
            /** A gait's own swing so far through (0 as its toes leave, 1 as it lands): the foot against the gait's own body. */
            const shapeOf = (G: Gait, x: number) => {
                const w = walkAt(strike - (1 - G.duty) * (1 - x), G), ft = w.feet[foot];
                return { off: sub(w.ankles[foot], scale(fwd, w.travel)), pitch: ft.pitch, toes: ft.toes, own: ft.heading - SIDE[foot] * G.toeOut };
            };
            const shape = (at: number) => {
                const x = clamp((at - began) / Math.max(1e-6, b.on - began), 0, 1), k = runShare(at), R = shapeOf(runG, x);
                if (!walkG || k >= 1) return R;
                const W = shapeOf(walkG, x);
                return { off: add(scale(W.off, 1 - k), scale(R.off, k)), pitch: W.pitch + (R.pitch - W.pitch) * k, toes: W.toes + (R.toes - W.toes) * k, own: W.own + (R.own - W.own) * k };
            };
            /** (A plan that repeats goes on past its end as it is; any other holds its last moment.) */
            const within = (at: number) => (plan.loop ? at : Math.min(at, plan.seconds));
            /**
             * Where a shape's foot is, set against the body as it is on its way at a time: as far along the way from the
             * body as the gait has it (on a way that bends or climbs it follows the way), as far to the side, as far over it.
             */
            const against = (at: number, sh: { off: V3 }): V3 => {
                const gone = plan.travelled(within(at)) + (!plan.loop && at > plan.seconds && paceOf ? paceOf(plan.seconds) * (at - plan.seconds) : 0);
                const here = wayOf(gone + dot(sh.off, fwd));
                const flat = sub(here.at, scale(up, dot(here.at, up)));
                return add(add(flat, scale(rotate(axisAngle(up, here.heading), left), dot(sh.off, left))), scale(up, dot(here.at, up) + dot(sh.off, up)));
            };
            const now = shape(t), s0 = shape(began), s1 = shape(b.on);
            const from = planted(foot, a, a.off);
            let ankle = add(add(against(t, now), scale(sub(from.ankle, against(began, s0)), 1 - fade)), scale(sub(to.ankle, against(b.on, s1)), fade));
            const [keepLift, keepPitch] = b.soft ?? [1, 1];
            if (keepLift !== 1) {
                const line = dot(from.ankle, up) + (dot(to.ankle, up) - dot(from.ankle, up)) * fade;
                ankle = add(ankle, scale(up, (keepLift - 1) * (dot(ankle, up) - line)));
            }
            if (b.clear && b.clear[0]) ankle = add(ankle, scale(up, b.clear[0] * humpAt(b.clear[1])(u)));
            const bodyWay = (at: number) => wayOf(plan.travelled(within(at))).heading + plan.facing(within(at));
            const way = bodyWay(t) + (from.way - bodyWay(began)) * (1 - fade) + (b.stand.heading - bodyWay(b.on)) * fade;
            const heading = way + now.own + (from.heading - from.way - s0.own) * (1 - fade) - s1.own * fade;
            const mixed = (get: (sh: { pitch: number; toes: number }) => number, start: number, end: number) => {
                const line = start + (end - start) * fade;
                return line + keepPitch * (get(now) + (start - get(s0)) * (1 - fade) + (end - get(s1)) * fade - line);
            };
            return {
                ankle, pitch: mixed((sh) => sh.pitch, from.pitch, to.pitch), toes: mixed((sh) => sh.toes, from.toes, to.toes),
                heading, way, standing: false, floor: Math.min(from.floor ?? 0, to.floor ?? 0),
            };
        }
        const Gn = running ? one : of(t), G0 = running ? one : onFrom, G1 = running ? one : onTo;
        const gaitIn = (w: GaitPose) => (w === now ? Gn : w === w0 ? G0 : G1);
        const flatIn = (w: GaitPose) => walkFlat(foot, b.cycle!, gaitIn(w));
        // The walk's swing, set down on the place: as a whole, or (a way that bends or climbs) following the way, each point
        // as far along it, as far to its side and as far over it as the walk has it from where it lands.
        const bent = plan.way && b.along !== undefined ? { way: plan.way, along: b.along, at: plan.way(b.along) } : null;
        const aside = bent ? dot(sub(flatOf(b.stand), bent.at.at), rotate(axisAngle(up, bent.at.heading), left)) : 0;
        const level = body.floor + h + (b.up ?? 0);
        const veer = (w: GaitPose, k = 1) => (bent ? bent.way(bent.along + k * dot(sub(w.ankles[foot], flatIn(w)), fwd)).heading - bent.at.heading : 0);
        // (`k`: the swing drawn out or squeezed along its way, below.)
        const placed = (w: GaitPose, k = 1): V3 => {
            const own = sub(w.ankles[foot], flatIn(w)), d = add(own, scale(fwd, (k - 1) * dot(own, fwd)));
            if (!bent) return add(flatOn(b), rotate(axisAngle(up, b.stand.heading - SIDE[foot] * gaitIn(w).toeOut), d));
            const here = bent.way(bent.along + dot(d, fwd));
            const across = rotate(axisAngle(up, here.heading), left);
            const climbed = dot(here.at, up) - dot(bent.at.at, up);
            return add(add(sub(here.at, scale(up, dot(here.at, up))), scale(across, aside + dot(d, left))), scale(up, level + climbed + dot(d, up)));
        };
        // The walk's swing at this time. (A foot that lands later than the walk's would is over its place in the walk's
        // time, and from then on as low as its leg lets it: it comes down with the hips.)
        // (So too from a stance that went by time, not by the phase: it leaves when it leaves, not at its gait's own phase.)
        const warped = across || (!!a?.byTime && !inAir && !reaimed);
        const phaseFor = (at: number, G: Gait) => (warped ? b.cycle! + 0.5 * foot - (1 - G.duty) * (1 - clamp((at - began) / Math.max(1e-6, b.on - began), 0, 1)) : plan.phase(at));
        const now = walkAt(phaseFor(t, Gn), Gn), w0 = walkAt(phaseFor(began, G0), G0), w1 = walkAt(phaseFor(b.on, G1), G1);
        /** The swing's own turn out and back. */
        const own = (w: GaitPose) => w.feet[foot].heading - SIDE[foot] * gaitIn(w).toeOut;
        let from: FootNow;
        if (inAir) from = inAir;
        else if (reaimed && b.walk) {
            const real = axisAngle(up, b.walk.heading - SIDE[foot] * G0.toeOut);
            from = {
                ankle: add(flatOf(b.walk), rotate(real, sub(w0.ankles[foot], flatIn(w0)))),
                pitch: w0.feet[foot].pitch, toes: w0.feet[foot].toes,
                heading: b.walk.heading + own(w0), way: b.walk.heading, standing: false,
            };
        } else from = planted(foot, a!, a!.off);
        // (Swung as the walk swings, drawn out or squeezed to the step it takes: the walk's reach along its way, times how much
        // longer or shorter this step is than the walk's own from the same phase. A short step is not a whole swing of the
        // walk with the difference faded off, which would run on past its place and come back.)
        const reachOwn = -dot(sub(w0.ankles[foot], flatIn(w0)), fwd);
        const reachNow = dot(sub(flatOn(b), from.ankle), along(body, b.stand.heading - SIDE[foot] * G0.toeOut));
        const k = b.squeeze && reachOwn > 0.05 * body.leg ? clamp(reachNow / reachOwn, 0, 2) : 1;
        let ankle = add(add(placed(now, k), scale(sub(from.ankle, placed(w0, k)), 1 - fade)), scale(sub(to.ankle, placed(w1, k)), fade));
        const [keepLift, keepPitch] = b.soft ?? [1, 1];
        // A shuffling step keeps only part of the walk's lift over the line between where it left and where it lands.
        if (keepLift !== 1) {
            const line = dot(from.ankle, up) + (dot(to.ankle, up) - dot(from.ankle, up)) * fade;
            ankle = add(ankle, scale(up, (keepLift - 1) * (dot(ankle, up) - line)));
        }
        // Lifted clear of what lies between (the edge of a step): up and down once more, over the walk's own lift.
        if (b.clear && b.clear[0]) ankle = add(ankle, scale(up, b.clear[0] * humpAt(b.clear[1])(u)));
        // Which way the leg goes: as it will stand, turned with the way under it where the way bends; what it left with fades out.
        // (A running foot in the air turns with the body, from the way it left with against the body to the way it lands
        // against it: its swing reaches a whole stride along a bend, and following the bend under it, it would turn past both.)
        const bodyWay = (at: number) => (plan.way ? plan.way(plan.travelled(at)).heading : 0) + plan.facing(at);
        const way = running && plan.way
            ? bodyWay(t) + (from.way - bodyWay(began)) * (1 - fade) + (b.stand.heading - bodyWay(b.on)) * fade
            : b.stand.heading + veer(now, k) + (from.way - b.stand.heading - veer(w0, k)) * (1 - fade) - veer(w1, k) * fade;
        const twisted = b.twist && b.twist[0] ? SIDE[foot] * b.twist[0] * humpAt(b.twist[1])(u) : 0;
        const heading = way + own(now) + (from.heading - from.way - own(w0)) * (1 - fade) - own(w1) * fade + twisted;
        const mixed = (get: (w: GaitPose) => number, start: number, end: number) => {
            const line = start + (end - start) * fade;
            return line + keepPitch * (get(now) + (start - get(w0)) * (1 - fade) + (end - get(w1)) * fade - line);
        };
        return {
            ankle,
            pitch: mixed((w) => w.feet[foot].pitch, from.pitch, to.pitch),
            toes: mixed((w) => w.feet[foot].toes, from.toes, to.toes),
            heading, way, standing: false,
            floor: Math.min(from.floor ?? 0, to.floor ?? 0),
        };
    };

    // A foot stands only where its leg reaches. It lands when the leg first reaches the place, if the plan has it land
    // sooner (the body still too high over a step down), and it leaves the floor when the leg can no longer reach it,
    // if the plan has it stay longer: or when, to stay within reach, it would have to roll on its forefoot, or its
    // knee to straighten, faster than a joint goes (a body running away from a foot on a leg nearly stretched: the foot
    // comes off, it is not spun, and the leg is not snapped straight).
    // (A plan that repeats is looked at through each hold's whole time, so that every round of it is the same.)
    const JOINT = 1500 * DEG;
    /** A planted foot at a time: how far it is pitched, and how far its knee is bent. */
    const bentAt = (foot: number, hold: Hold, t: number): [number, number] => {
        const f = planted(foot, hold, t), d = sub(f.ankle, socketAt(foot, t));
        return [f.pitch, kneeFor(body, Math.min(body.leg, Math.hypot(d[0], d[1], d[2])))];
    };
    const holds = plan.holds.map((list, foot) => list.map((hold) => {
        let from = plan.loop ? hold.on : Math.max(0, hold.on);
        const to = plan.loop ? hold.off : Math.min(hold.off, plan.seconds);
        if (!(to > from)) return hold;
        const step = 1 / 120;
        let held = hold;
        const landSpan = airSpanOf(hold.gait?.kind);
        if ((plan.loop || hold.on >= 0) && !reached(foot, hold, from, landSpan)) {
            let t = from + step;
            while (t < to && !reached(foot, hold, t, landSpan)) t += step;
            // (Never within reach: it is not stood on.)
            if (!(t < to)) return { ...hold, off: hold.on };
            let lo = t - step, hi = t;
            for (let n = 0; n < 20; n++) { const mid = (lo + hi) / 2; if (reached(foot, hold, mid, landSpan)) hi = mid; else lo = mid; }
            held = { ...hold, on: hi };
            from = hi;
        }
        // (A foot of the walk's, where the plan keeps knees bent: within reach of the leg bent so.)
        const span = hold.own ? body.leg : landSpan;
        let bent = bentAt(foot, held, from);
        for (let t = from; t < to; t += step) {
            const was = bent;
            bent = bentAt(foot, held, t);
            if (reached(foot, held, t, span) && Math.abs(bent[0] - was[0]) <= JOINT * step && was[1] - bent[1] <= JOINT * step) continue;
            let lo = Math.max(from, t - step), hi = t;
            if (!reached(foot, held, lo, span)) return { ...held, off: lo, rollsTo: held.off };
            if (reached(foot, held, hi, span)) return { ...held, off: lo, rollsTo: held.off };
            for (let n = 0; n < 20; n++) { const mid = (lo + hi) / 2; if (reached(foot, held, mid, span)) lo = mid; else hi = mid; }
            return { ...held, off: lo, rollsTo: held.off };
        }
        return held;
    }));
    const footAt = (foot: number, t: number): FootNow => {
        const list = holds[foot];
        let before: Hold | null = null;
        for (const hold of list) {
            if (t >= hold.on && t < hold.off) return planted(foot, hold, t);
            if (hold.off <= t) before = hold;
            else if (before || plan.airborne?.[foot]) {
                const swing = swinging(foot, before, hold, t), bent = Math.max(airKneeOf(before?.gait?.kind), airKneeOf(hold.gait?.kind));
                return bent ? { ...swing, airKnee: bent } : swing;
            }
        }
        // Past its last hold (a plan should not leave a foot there): as it left.
        const last = list[list.length - 1];
        return planted(foot, last, Math.min(t, last.off));
    };

    const count = Math.max(1, Math.round(plan.seconds * fps));
    const frames: GaitFrame[] = [];
    for (let k = 0; k <= count; k++) {
        const t = (k * plan.seconds) / count;
        const b = trunkAt(t);
        const world: Record<string, Quat> = { ...b.world };
        const ankles: V3[] = [], standing: boolean[] = [], short: number[] = [], knees: number[] = [];
        for (let i = 0; i < 2; i++) {
            const f = footAt(i, t);
            // The sole never dips under the floor: a pitched foot's ankle is at least where it would roll on its sole.
            const least = body.floor + h + (f.floor ?? 0) + rolled(sole, h, f.pitch).up;
            const y = dot(f.ankle, up);
            const want = y < least - 1e-9 ? add(f.ankle, scale(up, least - y)) : f.ankle;
            // The knee: the leg's own way; walking, turned with the walk's legs and part of the way to where the body still
            // faces; standing, part of the way to where the pelvis faces.
            const knee = f.way + b.w * (b.W.legTurn + plan.kneeFollow * (b.heading + b.turned - (f.way - SIDE[i] * gaitOf(t).toeOut)))
                + (1 - b.w) * plan.standKnee * (b.heading + standFacing + b.turned - f.way);
            // (A leg in the air keeps its knee bent, if the plan asks.)
            const leg = f.standing || !f.airKnee ? legPose(body, socketAt(i, t), want, along(body, knee)) : legPose(body, socketAt(i, t), want, along(body, knee), legSpan(body, f.airKnee));
            world[`${LEG[i]}UpperLeg`] = leg.upper;
            world[`${LEG[i]}LowerLeg`] = leg.lower;
            world[`${LEG[i]}Foot`] = footTurn(body, i, f.heading, f.pitch);
            world[`${LEG[i]}Toes`] = footTurn(body, i, f.heading, f.toes);
            ankles.push(leg.ankle);
            standing.push(f.standing);
            short.push(leg.short);
            knees.push(leg.knee);
        }
        frames.push({
            time: t, travel: plan.travelled(t), hips: b.hips, world,
            ankles: ankles as [V3, V3], stance: standing as [boolean, boolean], pivots: [null, null], short: short as [number, number], knees: knees as [number, number],
        });
    }
    return frames;
}

/** The numbers of a start from standing. */
export interface StartStyle {
    /** How long the pose takes from standing to the walk's, seconds. */
    blend: number;
    /** The turn to the way it goes, whatever the angle: how long it takes, and how much of that it takes to get going and to settle (the rest is at a steady rate), seconds. */
    turn: [number, number, number];
    /** How far the pelvis may turn against a planted foot before the foot has to leave the floor, degrees. */
    twistMost: number;
    /** The first foot lands still turned toward where it stood: the share of the angle. */
    landTurn: number;
    /** The walk's phase as it starts, against where the standing foot would put it: strides (below 0: earlier in the step, so the first footfall comes later). */
    phase: number;
    /** The trunk bows forward as the body starts, the head with it: degrees, degrees per radian of the turn, how long it lasts (seconds). */
    bow: [number, number, number];
    /** The foot that stays swivels where it stands, dragged round by the pelvis: the share of the body's turn it follows. */
    swivel: number;
    /** While it turns the body leans toward the foot that stays: the share of the way to it, at a half turn. */
    shift: number;
    /** The first footfall lands wide of the walk's line: share of hip height, and per radian of the turn. */
    landOut: [number, number];
    /** The foot that stays, dragged round, shuffles to its first footfall: how much of the walk's swing it loses at a half turn (of its heel's pitch; of its lift, by the square of the angle). */
    shuffle: number;
}

export const START_STYLE: StartStyle = {
    blend: 0.35, turn: [1, -0.01, 0.25], twistMost: 25, landTurn: 0.14, phase: -0.017,
    bow: [2.7, 0.45, 1.6], swivel: 0.16, shift: 0.23, landOut: [0.025, 0.0045], shuffle: 0.6,
};

/** How far a speed that rises the smoothest way from nothing, over one unit of time, has carried a body by x of it: ∫ of the least-jerk rise. */
const ramp = (x: number) => { const u = clamp(x, 0, 1); return u * u * u * u * (2.5 - 3 * u + u * u); };
/** The way gone at a time by something that gets up to a unit speed the smoothest way within `T` and holds it. */
const gone = (t: number, T: number) => (t <= 0 ? 0 : T * ramp(t / T) + Math.max(0, t - T));
/** A move from 0 to 1 at a steady rate, got up to within `start` and settled within `end`, over `whole` (seconds). */
const steady = (t: number, whole: number, start: number, end: number) => {
    const a = clamp(start, 1e-3, whole / 2), d = clamp(end, 1e-3, whole / 2);
    return clamp((gone(t, a) - gone(t - (whole - d), d)) / (whole - a / 2 - d / 2), 0, 1);
};

/** The numbers of a stop. */
export interface StopStyle {
    /** The stop's own pose begins so long before the body brakes, seconds (its tuck is timed from there). */
    brakeAt: number;
    /** The foot that landed first is then set beside the other, leaving as the other lands: how long it takes, seconds. */
    close: number;
    /** Meanwhile the hips lean toward the foot that stands: the share of the way to it. */
    shift: number;
    /** Braking, the pelvis tips back and the chest comes forward over it: degrees of each, from and to (seconds), and the share of the chest's the head takes. */
    tuck: [number, number, number, number, number];
}

export const STOP_STYLE: StopStyle = {
    brakeAt: 0.3, close: 0.65, shift: 0.65, tuck: [5.5, 4, 0.24, 2, 0.16],
};

/**
 * Where the way bends, for each unit of how sharply it bends against the body's size (hip height over the bend's
 * radius): the footfalls are set in from the walk's line (the inner foot, the outer: shares of hip height; walking only:
 * running, a foot lands under the body). And the hips lean in by `bank` of hip height for each g of the sideways pull
 * the body feels (manner.ts sidePull: its speed times how fast its way turns, up to the hardest it takes a bend with).
 */
export interface BendStyle {
    bank: number;
    track: [number, number];
}

export const BEND_STYLE: BendStyle = { bank: 0.35, track: [0.06, -0.04] };

/** The numbers of a walk along a way whose pace changes, coming to rest and setting off again. */
export interface AlongStyle {
    /** The walk's shape is taken at no less than this pace, metres a second: slower, its steps keep that length and come further apart in time. */
    least: number;
    /** Setting off, the pose is all the walk's from this pace up and all the standing one at rest, the smoothest way between, metres a second. */
    full: number;
    /** Coming to rest, the pose stays the walk's until the foot behind leaves to come beside the other (or, with no time for that, until the last foot is down), then goes over to the standing one in so long, seconds. */
    settleTime: number;
    /** The foot behind is no further than this from where it will stand as the body stops, metres: if it would be, the body takes one more step (quicker and shorter ones) before it stops. */
    closeMost: number;
    /** Coming to rest, the last foot to strike is this far into its stance as the body stops, strides: as far as brings it flat (it does not move again). */
    settle: number;
    /**
     * Coming to rest the phase goes by time, at the cadence it had, from so long before the braking begins (seconds), so
     * the feet keep stepping while the steps shorten (by distance the legs would all but stop with the body); and it is
     * bent the smoothest way so that it stops so.
     */
    ahead: number;
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
    /** A foot left behind keeps its knee bent by this as its heel rises, degrees. */
    pushKnee: number;
    /**
     * It runs from this share of the walk's top pace (where the walk's stance share falls to half: both feet would leave the
     * floor), and walks again below that top pace; it goes over at the next footfall. The trunk and the arms take so long
     * (seconds) to go over from the one gait's pose to the other's.
     */
    runFrom: number;
    mixTime: number;
    /**
     * The body answers its pace changing (the manner's own `react`): the way's own forward acceleration as the body feels it, over so long (seconds:
     * two stages of it, so that it comes on and goes off smoothly). For each g of it: speeding up while running, the hips
     * crouch by this share of hip height and the spine curls forward by so many degrees at the chest (it leans into the
     * push; a walk leans into its first step as a start does); braking, the trunk tilts back by so many degrees and the
     * spine curls forward as much (the trunk is carried on over the pelvis held back; a walk's stop tucks as the stop rule).
     */
    answer: number;
    crouch: number;
    curl: number;
    tilt: number;
    /**
     * Setting off into a run: the first swing of the foot that pushed off keeps this share of the run's lift (it has none of
     * the run's swing behind it); and setting off another way than it faces, the body comes round in so long (seconds), at
     * once and settling (a walk's start turns as the start rule does: START_STYLE.turn).
     */
    firstLift: number;
    runTurn: number;
    /**
     * Setting off into a run turned further from its way than this (degrees), it hops round: the foot behind leaves the floor
     * with the other, comes down under the body, turned as the body is by then, so long before the first footfall (seconds),
     * and pushes off from there until so long after it.
     */
    hopTurn: number;
    hop: [number, number];
    /** In the hop both feet are lifted clear of the floor by this share of leg length. */
    hopLift: number;
    /**
     * Braking from a run: the last foot lands so long before the body comes to rest (seconds), and the body brakes on it; the
     * foot behind comes down beside it so long after it lands; and a running foot that lands as the body brakes lands further
     * ahead by this share of hip height for each g of the braking felt (it is put out ahead to hold the body back), so that
     * the last one is then stepped back into the stance.
     */
    brakeOn: number;
    closeAfter: number;
    brakeLead: number;
    /** The foot a run's stop brakes on is put out further still: by this share of hip height for each g (instead of `brakeLead`). The body goes on over it less far than the foot was put out, and the foot is stepped back by the difference. */
    stopLead: number;
    /** Braking, the hips are carried on ahead of the way by this share of hip height for each g of the braking felt (the body's own way on, over the foot put out ahead). */
    brakeSurge: number;
}

export const ALONG_STYLE: AlongStyle = { runFrom: 1.1, mixTime: 0.3, answer: HUMAN_MANNER.react, crouch: 0.06, curl: 12, tilt: 6, firstLift: 0.5, runTurn: 0.6, hopTurn: 100, hop: [0.07, 0.02], hopLift: 0.1, brakeOn: 0.2, closeAfter: 0.15, brakeLead: 0.15, stopLead: 0.25, brakeSurge: 0.07, least: 0.3, full: 1, settleTime: 0.6, settle: 0.05, closeMost: 0.3, ahead: 0.4, kneeFollow: HUMAN_MANNER.kneeFollow, pushKnee: HUMAN_MANNER.kneeLeast };

/**
 * A walk along a way whose pace changes, from standing: `path` is where the body is over the floor at a time (model
 * space; its first point is where it stands), over `seconds`. Where the path stays put the body comes to rest and stands;
 * where it moves again the body sets off. The walk is taken at each time's pace (its step, cadence and shape follow the
 * pace), and its phase goes by the distance gone. Coming to rest, the phase goes by time through the braking and is bent
 * so that the last foot to strike has just landed as the body stops, on the stance's own place about where it stops; the
 * foot behind is then stepped beside it. Setting off
 * another way than it faces, it turns as it starts. The frames travel.
 * `begin`: the stance it stands in at first (a point of the floor, in the same space as the path's first point taken as the
 * body's own place, and a heading; and the standing pose, facing along heading 0 about the body's own place, where it is
 * not the stance's own: the end of a turn; and the foot that steps first where it sets off straight ahead, 0 the left, 1
 * the right: none, the right); none: about where it stands, facing its way. `end`: the stance it ends in, if it comes to
 * rest at the end.
 */
export function walkAlong(
    body: Body, path: (t: number) => V3, seconds: number,
    style: AlongStyle = ALONG_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE, fps = 60,
    begin?: { pivot: V3; heading: number; stand?: GaitFrame; steps?: number },
): { plan: CarryPlan; frames: GaitFrame[]; end: { pivot: V3; heading: number } | null } {
    const { up, fwd, left } = body;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const floorAt = add(origin, scale(up, body.floor));
    // The way, finely: where the body is, how far it has gone, how fast it goes.
    const n = Math.max(2, Math.ceil(seconds * 240)), dt = seconds / n;
    const flat = (p: V3) => sub(p, scale(up, dot(p, up)));
    const length = (v: V3) => Math.hypot(v[0], v[1], v[2]);
    const p0 = flat(path(0));
    const P: V3[] = [], S: number[] = [];
    for (let k = 0; k <= n; k++) {
        P.push(add(origin, sub(flat(path(k * dt)), p0)));
        S.push(k ? S[k - 1] + length(sub(P[k], P[k - 1])) : 0);
    }
    // (The pace over a 48th of a second either way: a body's pace does not change within one sample, and over one the
    // points' own rounding would set it dithering between the walks of neighbouring paces.)
    const w = Math.max(1, Math.round(1 / (48 * dt)));
    const V = S.map((_, k) => (S[Math.min(n, k + w)] - S[Math.max(0, k - w)]) / ((Math.min(n, k + w) - Math.max(0, k - w)) * dt));
    const at = (list: number[], t: number) => { const u = clamp(t / dt, 0, n), k = Math.min(n - 1, Math.floor(u)); return list[k] + (list[k + 1] - list[k]) * (u - k); };
    // The way by distance: where along it, and which way it goes (from the stretches that move; straight on past its ends).
    const knots: { s: number; at: V3; heading: number }[] = [];
    let last = 0, anchor = 0;
    for (let k = 1; k <= n; k++) {
        // (A knot every 5 mm of the way at least: over less, the points' own rounding turns the way about.)
        const d = sub(P[k], P[anchor]);
        // (Its first direction over 2 cm: setting off from a corner it rested at, its first millimetres may still lie on the
        // way in, and would set it off turned.)
        if (length(d) < (knots.length ? 0.005 : 0.02)) continue;
        let heading = Math.atan2(dot(d, left), dot(d, fwd));
        if (knots.length) heading = last + Math.atan2(Math.sin(heading - last), Math.cos(heading - last));
        if (!knots.length) knots.push({ s: S[anchor], at: P[anchor], heading });
        knots.push({ s: S[k], at: P[k], heading });
        last = heading;
        anchor = k;
    }
    if (!knots.length) knots.push({ s: 0, at: P[0], heading: 0 }, { s: 1e-6, at: P[0], heading: 0 });
    // (Counted from the way the body stands at first, whole turns off, so that it turns to its way the short way round.)
    if (begin) { const whole = 2 * Math.PI * Math.round((begin.heading - knots[0].heading) / (2 * Math.PI)); for (const k of knots) k.heading += whole; }
    const way = (s: number) => {
        const a = knots[0], z = knots[knots.length - 1];
        if (s <= a.s) return { at: add(a.at, scale(along(body, a.heading), s - a.s)), heading: a.heading };
        if (s >= z.s) return { at: add(z.at, scale(along(body, z.heading), s - z.s)), heading: z.heading };
        let lo = 0, hi = knots.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (knots[mid].s <= s) lo = mid; else hi = mid; }
        const x = knots[lo], y = knots[hi], u = (s - x.s) / Math.max(1e-12, y.s - x.s);
        return { at: add(x.at, scale(sub(y.at, x.at), u)), heading: x.heading + (y.heading - x.heading) * u };
    };
    // The walk at each pace (one walk for each half cm/s: the same pace asks for the same walk, and the next is so near
    // that going from one to the next does not jolt the hips).
    // (The walk's top pace: where its stance share falls to half, both feet about to leave the floor. A walk is never taken
    // faster, and a run never slower than where it goes back to a walk.)
    const vTop = (() => { const [d0, d1] = gaitStyle.walk.duty, root = Math.max(0, (d0 - 0.505) / d1); return Math.sqrt(root * root * GRAVITY * body.hipHeight); })();
    const walks = new Map<string, Gait>();
    // (A run's arms with so much effort, in twentieths: gait.ts armsAt. A walk's are its own.)
    const walkAt = (v: number, kind: GaitKind = 'walk', effort = 1) => {
        const pace = Math.round(Math.max(kind === 'walk' ? Math.min(v, vTop) : Math.max(v, vTop), style.least) * 200);
        const held = kind === 'run' ? Math.round(clamp(effort, 0, 1) * 20) : 20, key = kind + pace + ':' + held;
        let w = walks.get(key);
        if (!w) {
            w = gaitFor(body, pace / 200, gaitStyle, kind);
            if (held < 20) w = { ...w, mode: armsAt(w.mode, gaitStyle.walk, held / 20) };
            walks.set(key, w);
        }
        return w;
    };
    const strideOf = (g: Gait) => g.speed * g.stride;
    /** The stance's two places about a point of the floor, turned to a heading. */
    const stance = (pivot: V3, heading: number): [Stand, Stand] =>
        stanceFeet(body, turnStyle.stance, floorAt).map((st) => ({
            at: add(pivot, rotate(axisAngle(up, heading), sub(st.at, floorAt))),
            heading: st.heading + heading,
        })) as [Stand, Stand];
    // Standing at first: the left foot stays, the right steps first. The walk's phase begins where the walk would have the
    // left foot where it stands (as a start does), so that the left leg still reaches it until its toes leave.
    const startPivot = begin?.pivot ?? floorAt, startHeading = begin?.heading ?? way(0).heading;
    const firstPair = stance(startPivot, startHeading);
    // Setting off another way than it faces, the foot on the side it turns to steps first.
    const turnBy = Math.atan2(Math.sin(way(0).heading - startHeading), Math.cos(way(0).heading - startHeading));
    const stays = turnBy > 5 * DEG ? 1 : turnBy < -5 * DEG ? 0 : begin?.steps === 0 ? 1 : 0, steps = 1 - stays;
    const ahead0 = dot(sub(firstPair[stays].at, way(0).at), along(body, way(0).heading));
    /**
     * The phase it begins at in a gait: where that gait would have the foot that stays where it stands. Into a walk, as the
     * start rule has it: so much earlier or later in the step (START_STYLE.phase), a foot that stands ahead of the hips
     * taken as under them (it is no help to push off from), and no later than its first footfall allows.
     */
    const phaseIn = (g: Gait) => g.kind === 'walk'
        ? 0.5 * stays + clamp((g.lead - Math.min(0, ahead0)) / strideOf(g) + START_STYLE.phase, 0.02, 0.42)
        : 0.5 * stays + style.settle + clamp((g.lead - ahead0) / strideOf(g), 0, 0.4);
    // Each step is a walk's, or a run's from where the walk would leave the floor with both feet. It goes over from one to the
    // other at a footfall (the next after the pace asks), and back again only well below where it went over, so that it does
    // not go to and fro. Walking, the phase goes by the distance gone, in the stride of the walk at the pace; running, by
    // time, at the run's cadence (slower than the run's least pace, its steps shorten).
    const switches: { at: number; kind: GaitKind; sharp: boolean }[] = [];
    // A walking step is taken as the walk at the pace the body comes to within a step's time from here: setting off or
    // speeding up, a step is planned for the pace the body will have as it lands (the leg swings in its own time). So the
    // first step from standing is a whole one of the walk it sets off into where it is up to pace within that step, not a
    // slow walk's short step; and setting off gently, a shorter one, not a long step the body would hang over.
    // (The window is the time of a step of the walk at that pace: found twice over, from the pace there.)
    const stepPaces: number[] = new Array(n + 1);
    for (let k = 0; k <= n; k++) {
        let v = V[k];
        for (let pass = 0; pass < 2; pass++) {
            const last = Math.min(n, k + Math.round(walkAt(v).stride / 2 / dt));
            let most = V[k];
            for (let j = k + 1; j <= last; j++) if (V[j] > most) most = V[j];
            v = most;
        }
        stepPaces[k] = v;
    }
    /** The pace a walking step is taken at (see above). */
    const stepPace = (k: number) => stepPaces[k];
    /** The gait of the step a phase is in. */
    const kindAt = (p: number): GaitKind => { let kind: GaitKind = 'walk'; for (const sw of switches) if (p >= sw.at - 1e-9) kind = sw.kind; return kind; };
    /** (Sharp: the trunk goes over at once; setting off from standing, the standing pose's own blend carries it over.) */
    // (One asked for at a footfall where another already is takes its place; one to the kind it already has there is none.)
    const switchAt = (at: number, kind: GaitKind, sharp = false) => {
        for (let i = switches.length - 1; i >= 0; i--) if (Math.abs(switches[i].at - at) < 1e-9) switches.splice(i, 1);
        if (kindAt(at - 1e-6) === kind) return;
        switches.push({ at, kind, sharp });
        switches.sort((x, y) => x.at - y.at);
    };
    let wants: GaitKind = 'walk';
    // (Walking, a foot in the air lands within the walk's own swing time from when it left: where the body goes on too
    // slowly for that, setting off gently, the phase is hurried on, and the step is a shorter one: the body does not hang
    // over a long, slow step on one leg. Where it left: the time and the phase; none while it stands or the body rests.)
    const lifts: ({ t: number; p: number } | null)[] = [null, null];
    /** The phase at a sample from the one before. */
    const advance = (k: number) => {
        const p = phases[k - 1], v = V[k - 1];
        // (At rest no gait is asked for: it keeps the one it has.)
        const want: GaitKind = v < 1e-3 ? wants : wants === 'walk' ? (v > style.runFrom * vTop ? 'run' : 'walk') : v < vTop ? 'walk' : 'run';
        if (want !== wants) { wants = want; switchAt(Math.floor(p * 2 + 1e-9) / 2 + 0.5, want); }
        const kind = kindAt(p), g = walkAt(kind === 'walk' ? stepPace(k - 1) : v, kind);
        if (kind !== 'walk' || v < 1e-3) { lifts[0] = lifts[1] = null; phases.push(p + (kind === 'walk' || v < 1e-3 ? 0 : dt / g.stride)); return; }
        let next = p + (S[k] - S[k - 1]) / strideOf(g);
        for (let i = 0; i < 2; i++) {
            const into = (((p - 0.5 * i) % 1) + 1) % 1;
            if (into < g.duty - 1e-9) { lifts[i] = null; continue; }
            const lift = (lifts[i] ??= { t: (k - 1) * dt, p }), strike = p + (1 - into);
            next = Math.max(next, Math.min(strike, lift.p + ((strike - lift.p) * (k * dt - lift.t)) / Math.max(dt, (1 - g.duty) * g.stride)));
        }
        phases.push(next);
    };
    /**
     * Setting off from rest at a sample and a phase: where the pace asks for a run before the walk's first footfall would
     * come, the first step is the run's own; the run it gets up to (at the pace where it stops rising), or none.
     */
    const runsOff = (k0: number, p0: number): Gait | null => {
        const next = Math.floor(p0 * 2 + 1e-9) / 2 + 0.5;
        let p = p0;
        for (let k = k0 + 1; k <= n && p < next; k++) {
            if (V[k - 1] > style.runFrom * vTop) {
                while (k < n && V[k + 1] > V[k] + 1e-9) k++;
                return walkAt(V[k], 'run');
            }
            p += (S[k] - S[k - 1]) / strideOf(walkAt(stepPace(k - 1)));
        }
        return null;
    };
    const runFirst = runsOff(0, phaseIn(walkAt(stepPace(0))));
    const phase0 = phaseIn(runFirst ?? walkAt(stepPace(0)));
    const resting = (k: number) => V[k] < 1e-3;
    const rests: [number, number][] = [];
    for (let k = 1; k <= n; k++) if (resting(k) && !resting(k - 1)) { let e = k; while (e < n && resting(e + 1)) e++; rests.push([k, e]); }
    // Coming to rest, the last foot is so far into its stance as the body stops: at least `settle`, and as far as the walk
    // at rest has it lying flat (from then on it does not move).
    const settle = (() => {
        const g = walkAt(0), pose = gaitPoser(body, g, gaitStyle);
        for (let p = style.settle; p <= 0.3; p += 0.0025) { const f = pose(p * g.stride).feet[0]; if (f.standing && Math.abs(f.pitch) < 1e-4 && Math.abs(f.toes) < 1e-4) return p; }
        return style.settle;
    })();
    const phases: number[] = [phase0];
    /** The runs set off from standing: from the sample it stands at, at the phase it stands at. */
    const runOffs: { from: number; at: number }[] = [];
    if (runFirst) { wants = 'run'; switchAt(phase0 + 1e-6, 'run', true); runOffs.push({ from: 0, at: phase0 }); }
    let from = 0;
    const stops: { at: number; until: number; strike: number; run: boolean; brakes: number }[] = [];
    for (const [a, b] of rests) {
        // Where the braking begins (going back from the stop, as long as the pace was higher before), and a little before that.
        let brakes = a;
        while (brakes > from + 1 && V[brakes - 1] > V[brakes] + 1e-9) brakes--;
        const w0 = Math.max(from, brakes - Math.round(style.ahead / dt));
        for (let k = phases.length; k <= w0; k++) advance(k);
        // At the cadence it had there, by time, it would be so far into the walk at the stop; bent to the nearest strike
        // (the next one where the nearest would slow the feet too far).
        const start = phases[w0];
        const cadence = (w0 > 0 ? phases[w0] - phases[w0 - 1] : (S[1] - S[0]) / strideOf(walkAt(V[0], kindAt(start)))) / dt;
        // (Braking from a run, the last foot lands `brakeOn` before the body comes to rest, and the body brakes on it: the bent
        // phase reaches that strike there, then eases on to its rest. Walking, the body comes to rest as the last foot lies flat.)
        const runStop = kindAt(start) !== 'walk';
        const strikeAt = runStop ? Math.max(w0 + 1, a - Math.round(Math.min(style.brakeOn, 0.5 * (a - w0) * dt) / dt)) : a;
        const T = Math.max(dt, (strikeAt - w0) * dt);
        const natural = start + cadence * T;
        const bendFor = (m: number) => m / 2 + (runStop ? 0 : settle) - natural;
        /** Where the foot before the last comes down, against where the body stops (how far the foot behind is from its stance). */
        const behindBy = (m: number) => {
            const p = (m - 1) / 2;
            let k = w0;
            if (p < start) { while (k > 0 && phases[k] > p) k--; } else while (k < a && start + cadence * (k - w0) * dt + bendFor(m) * minJerk(((k - w0) * dt) / T) < p) k++;
            return S[a] - (S[k] + walkAt(V[k], kindAt(p)).lead);
        };
        let m = Math.round((natural - (runStop ? 0 : settle)) * 2);
        if (cadence + (bendFor(m) * 1.875) / T < 0.4 * cadence) m += 1;
        // One more step while the foot behind would be dragged far (but the steps no more than two and a half times as quick).
        // (Not braking from a run: it brakes on its long last step, and the foot behind is brought up after.)
        if (!runStop) while (behindBy(m) > style.closeMost && cadence + (bendFor(m + 1) * 1.875) / T <= 2.5 * cadence) m += 1;
        const bend = bendFor(m);
        for (let k = w0 + 1; k <= strikeAt; k++) { const tau = (k - w0) * dt; phases.push(start + cadence * tau + bend * minJerk(tau / T)); }
        // (On the last foot, from its strike to rest: at the cadence it had, easing to a stop; no quicker at first than eases
        // without going past.)
        if (a > strikeAt) {
            const D = (a - strikeAt) * dt, s0 = Math.min(3, (cadence * D) / Math.max(1e-6, settle));
            for (let k = strikeAt + 1; k <= a; k++) { const u = ((k - strikeAt) * dt) / D; phases.push(m / 2 + settle * (s0 * u + (3 - 2 * s0) * u * u + (s0 - 2) * u * u * u)); }
        }
        for (let k = a + 1; k <= b; k++) phases.push(phases[k - 1]);
        // (Braking from a walk, the steps are the walk's and the body comes to rest on the walk's last step. Braking from a
        // run, the last step is the run's own: the body sinks on it as a run's stance does, it does not vault up over it as a
        // walk would; it goes over to the walk once at rest, for setting off again.)
        if (runStop) switchAt(m / 2 + settle + 1e-6, 'walk');
        else {
            const braking = Math.min(m / 2, Math.ceil(phases[Math.max(w0, brakes)] * 2 - 1e-9) / 2);
            for (const sw of switches.slice()) if (sw.at >= braking - 1e-9 && sw.at <= m / 2 + 1e-9) switches.splice(switches.indexOf(sw), 1);
            if (kindAt(braking) !== 'walk') switchAt(braking, 'walk');
        }
        stops.push({ at: a * dt, until: b * dt, strike: m, run: runStop, brakes: brakes * dt });
        from = b;
        wants = 'walk';
        if (runsOff(b, phases[b])) { wants = 'run'; switchAt(phases[b] + 1e-6, 'run'); runOffs.push({ from: b, at: phases[b] }); }
    }
    for (let k = phases.length; k <= n; k++) advance(k);
    // (The legs' rhythm does not change its pace from one instant to the next: where it does above (a foot hurried down,
    // a stop's bending), the phase is evened out over a tenth of a second, so that the walk's sway and swing go on smoothly.
    // Its ends stay where they are.)
    {
        const half = Math.max(1, Math.round(0.05 / dt)), even = phases.slice();
        for (let k = 1; k < n; k++) {
            const r = Math.min(half, k, n - k);
            let sum = 0;
            for (let j = -r; j <= r; j++) sum += phases[k + j];
            even[k] = sum / (2 * r + 1);
        }
        for (let k = 0; k <= n; k++) phases[k] = even[k];
    }
    // (Past the end, on at the rate it ends at, as timeOf has it: a footfall after the end is swung toward in its own phase.)
    const phase = (t: number) => (t > n * dt ? phases[n] + ((phases[n] - phases[n - 1]) / dt) * (t - n * dt) : at(phases, t));
    const timeOf = (p: number) => {
        if (p <= phases[0]) return -Infinity;
        // (Past the end, on at the rate it ends at: a path that ends moving has footfalls after it to swing toward.)
        if (p > phases[n]) { const rate = (phases[n] - phases[n - 1]) / dt; return rate > 1e-9 ? n * dt + (p - phases[n]) / rate : Infinity; }
        let lo = 0, hi = n;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (phases[mid] < p) lo = mid; else hi = mid; }
        const u = (p - phases[lo]) / Math.max(1e-12, phases[hi] - phases[lo]);
        return (lo + clamp(u, 0, 1)) * dt;
    };
    const travelled = (t: number) => at(S, t);
    const paceAt = (t: number) => at(V, t);
    // The way's forward acceleration as the body feels it, in g: speeding up above zero, braking below.
    const felt = (() => {
        const out: number[] = [];
        const r = style.answer > 0 ? 1 - Math.exp(-dt / style.answer) : 1;
        let f1 = 0, f2 = 0;
        for (let k = 0; k <= n; k++) {
            const a = (V[Math.min(n, k + 1)] - V[Math.max(0, k - 1)]) / ((Math.min(n, k + 1) - Math.max(0, k - 1)) * dt);
            f1 += (a - f1) * r;
            f2 += (f1 - f2) * r;
            out.push(f2 / GRAVITY);
        }
        return out;
    })();
    const pushAt = (t: number) => Math.max(0, at(felt, t)), brakeAt = (t: number) => Math.max(0, -at(felt, t));
    // How hard a run drives its arms just now: wholly while the body speeds up (a push off the floor takes the arms with it)
    // and while it brakes to rest within a stride (they brace); slowing into a walk, by its pace (they are let go).
    const effortAt = (t: number) => {
        const v = paceAt(t), stride = gaitFor(body, Math.max(v, vTop), gaitStyle, 'run').stride;
        return pushAt(t) > 0.02 || paceAt(Math.min(seconds, t + stride)) < 0.05 ? 1 : armEffort(body, v, gaitStyle);
    };
    /** How fast the way turns where the body is, radians a metre (to the left above zero). */
    const bendAt = (s: number) => (way(s + 0.1).heading - way(s - 0.1).heading) / 0.2;

    // Where the feet stand: the walk's footfalls along the way, each as far ahead of where the body is as it strikes as
    // that time's walk has it, to its side of the way, pointing along it.
    const footfall = (foot: number, cycle: number): Hold => {
        const strike = cycle + 0.5 * foot;
        const on = timeOf(strike);
        const kind = kindAt(strike), g = walkAt(kind === 'walk' ? at(stepPaces, clamp(on, 0, seconds)) : paceAt(clamp(on, 0, seconds)), kind);
        // (Where the body has gone over to another kind of gait by the time the toes would leave, they leave as that one's do:
        // a walk's foot is not held down through a run's long stride.)
        const then = kindAt(strike + g.duty);
        // (A running foot stands no longer than the run's stance, though the steps slow: the body would leave it far behind.)
        const off = Math.min(timeOf(strike + g.duty), then === kindAt(strike) ? Infinity : timeOf(strike + walkAt(paceAt(clamp(on, 0, seconds)), then).duty), g.kind === 'walk' ? Infinity : on + g.duty * g.stride);
        // (A running foot landing as the body brakes is put out further ahead, to hold the body back.)
        const stopsOn = stops.some((x) => x.run && Math.abs(x.strike / 2 - strike) < 1e-9);
        const held = g.kind === 'walk' ? 0 : (stopsOn ? style.stopLead : style.brakeLead) * body.hipHeight * brakeAt(clamp(on, 0, seconds));
        const s = (on > seconds ? S[n] + V[n] * (on - seconds) : travelled(Math.max(0, on))) + g.lead + held;
        const here = way(s);
        const across = rotate(axisAngle(up, here.heading), left);
        // (Where the way bends, set in from the walk's line (BEND_STYLE): the inner foot by track[0], the outer by track[1]. Running,
        // not: with no time on both feet there is nothing to carry the body over a foot set in, it lands under the body.)
        const bendL = bendAt(s) * body.hipHeight, inner = bendL >= 0 ? 0 : 1;
        const setIn = g.kind === 'walk' ? bendL * BEND_STYLE.track[foot === inner ? 0 : 1] * body.hipHeight : 0;
        return { on, off, stand: { at: add(here.at, scale(across, ((foot ? -1 : 1) * g.width) / 2 + setIn)), heading: here.heading + (foot ? -1 : 1) * g.toeOut }, cycle, own: false, along: s, gait: g, byTime: g.kind !== 'walk' };
    };
    const holds: [Hold[], Hold[]] = [[], []];
    const top = Math.ceil(phases[n]) + 1;
    for (let foot = 0; foot < 2; foot++) for (let cycle = 0; cycle <= top; cycle++) {
        const hold = footfall(foot, cycle);
        if (hold.off > 0 && hold.on < seconds + 1) holds[foot].push(hold);
    }
    // Standing at first, the hips are over the stance, not over where the body's way is; setting off, back over the way.
    // (Coming to rest, the stance is taken about where the way stops: the hips are over it there.)
    const leans: { from: number; to: number; by: V3 }[] = [];
    const leanOver = (pivot: V3, t: number, from: number, to: number) => {
        leans.push({ from, to, by: sub(flat(pivot), flat(way(travelled(t)).at)) });
    };
    const firstMove = (() => { let k = 0; while (k < n && V[k] < 1e-3) k++; return k * dt; })();
    /** When the walk next has all the pose's weight after a time. */
    const fullAfter = (t: number) => { let k = Math.ceil(t / dt); while (k < n && V[k] < style.full) k++; return k * dt; };
    /** How far the body has come round to its way, setting off: 0 to 1. */
    // (Into a run, at once and settling, in `runTurn`; into a walk, as a start turns (START_STYLE.turn): at once, at a
    // steady rate, settling at the end.)
    const turnTime = runFirst ? style.runTurn : START_STYLE.turn[0];
    const turnedBy = (t: number) => {
        if (!runFirst) return steady(t - firstMove, START_STYLE.turn[0], START_STYLE.turn[1], START_STYLE.turn[2]);
        const u = clamp((t - firstMove) / Math.max(1e-3, turnTime), 0, 1);
        return 1 - (1 - u) * (1 - u);
    };
    // The foot that stays, swivelling with the body until it leaves; the one that steps, from beside it, its first footfall
    // still turned partly toward where it stood.
    // (Setting off into a run, it turns with the body as it pushes, pivoting on its ball: the knee over it stays over the foot.)
    // (Into a walk, bearing the weight until the other foot is down, it pivots on its ball with the pelvis where the pelvis
    // would be twisted against it further than it can be (`twistMost`): so long as that pivot is no more than the leg turns
    // in the hip. Further round, it leaves at that twist and shuffles to its first footfall, as a start's foot does.)
    // (And once it is down, the walk's own time on both feet, while this foot pushes and the weight goes over to the other.)
    const firstHold = holds[steps].find((x) => x.cycle !== null && x.cycle + 0.5 * steps > phase0), firstGait = firstHold?.gait;
    const firstDown = firstHold?.on ?? firstMove, bothDown = firstGait ? Math.max(0, firstGait.duty - 0.5) * firstGait.stride : 0;
    const pivots = !runFirst && Math.abs(turnBy) * turnedBy(firstDown) - START_STYLE.twistMost * DEG <= HUMAN_RANGES.hip.turn * DEG;
    holds[stays][0] = { ...holds[stays][0], on: -Infinity, stand: firstPair[stays], own: true, swivel: (t) => {
        const turned = Math.abs(turnBy) * turnedBy(t);
        return Math.sign(turnBy) * (runFirst ? turned : pivots ? Math.max(START_STYLE.swivel * turned, turned - START_STYLE.twistMost * DEG) : START_STYLE.swivel * turned);
    } };
    // (Into a walk, as a start does: the foot that stays leaves when the walk's would, or sooner, when the pelvis has turned
    // as far against it as it can (START_STYLE.twistMost); dragged round, it shuffles to its first footfall; and the first
    // footfall of the other lands a little wide of the walk's line.)
    if (!runFirst) {
        const most = START_STYLE.twistMost * DEG, against = Math.abs(turnBy) * (1 - clamp(START_STYLE.swivel, 0, 0.95));
        if (against > most) {
            let lo = firstMove, hi = firstMove + START_STYLE.turn[0];
            for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (against * turnedBy(mid) < most) lo = mid; else hi = mid; }
            // (Pivoting, not before the other is down: a walk never has both feet off the floor.)
            holds[stays][0] = { ...holds[stays][0], off: Math.min(holds[stays][0].off, Math.max((lo + hi) / 2, pivots ? firstDown + bothDown : 0)) };
        }
        const share = Math.abs(turnBy) / Math.PI, next = holds[stays].findIndex((x, i) => i > 0 && x.cycle !== null);
        if (share > 0 && next > 0) holds[stays][next] = { ...holds[stays][next], soft: [clamp(1 - START_STYLE.shuffle * share * share, 0, 1), clamp(1 - START_STYLE.shuffle * share, 0, 1)] };
    }
    // (Setting off into a run, it pushes off as the run's foot does, for a whole stance of the run's from when the body
    // moves: from where the run would have it at the phase it stands at, through to its toes leaving, by time.)
    if (runFirst) {
        const off = timeOf(phase0 + runFirst.duty), p0 = clamp((phase0 - 0.5 * stays) / runFirst.duty, 0, 0.9);
        // (It stands from the first: where the body waits before it moves, the roll it would have by then is not seen, standing.)
        holds[stays][0] = { ...holds[stays][0], gait: runFirst, off, on: Math.min(-1e-6, firstMove - (p0 * (off - firstMove)) / (1 - p0)), byTime: true };
    }
    // (Turned far from its way, it hops round: the foot behind is not left where it stood, to be turned on and left far behind
    // the body. It leaves the floor with the other, comes down under the body as the body is turned by then, and pushes off.)
    if (runFirst && Math.abs(turnBy) > style.hopTurn * DEG) {
        const firstFall = timeOf(Math.floor(phase0 * 2 + 1e-9) / 2 + 0.5);
        const touch = Math.max(firstMove + 0.05, firstFall - style.hop[0]), push = firstFall + style.hop[1];
        const here = way(travelled(touch));
        const faces = here.heading - turnBy * (1 - turnedBy(touch));
        const side = stays ? -1 : 1;
        const stand = { at: add(here.at, scale(rotate(axisAngle(up, faces), left), (side * runFirst.width) / 2)), heading: faces + side * runFirst.toeOut };
        holds[stays].splice(0, 1,
            { on: -Infinity, off: firstMove, stand: firstPair[stays], cycle: null, own: true },
            { on: touch, off: push, stand, cycle: null, own: true, place: true, byTime: true, gait: runFirst, clear: [style.hopLift * body.leg, 0.5], swivel: (t) => turnBy * (turnedBy(t) - turnedBy(touch)) });
        const fi = holds[steps].findIndex((x) => x.cycle !== null && x.cycle + 0.5 * steps > phase0);
        if (fi >= 0) holds[steps][fi] = { ...holds[steps][fi], clear: [style.hopLift * body.leg, 0.5] };
    }
    holds[steps] = holds[steps].filter((x) => x.cycle === null || x.cycle + 0.5 * steps > phase0);
    // (A run's first footfall lands along the way: the body is round by then.)
    if (holds[steps].length) {
        const first = holds[steps][0], wide = runFirst ? 0 : (START_STYLE.landOut[0] + START_STYLE.landOut[1] * Math.abs(turnBy)) * body.hipHeight;
        const across = rotate(axisAngle(up, way(first.along ?? travelled(Math.max(0, first.on))).heading), left);
        holds[steps][0] = { ...first, stand: { at: add(first.stand.at, scale(across, (steps ? -1 : 1) * wide)), heading: first.stand.heading - (runFirst ? 0 : START_STYLE.landTurn) * turnBy } };
    }
    // Setting off into a run (at first, or after a rest): the first step is set down the low, smooth way (from standing the
    // foot has none of the run's swing behind it to kick up, it skims forward to its footfall), and the first swing of the
    // foot that pushed off keeps only a share of the run's lift.
    for (const { at } of runOffs) {
        const first = Math.floor(at * 2 + 1e-9) / 2 + 0.5, stepper = Math.round(first * 2) % 2, pusher = 1 - stepper;
        const i = holds[stepper].findIndex((x) => x.cycle !== null && Math.abs(x.cycle + 0.5 * stepper - first) < 1e-9);
        if (i >= 0) holds[stepper][i] = { ...holds[stepper][i], place: true };
        const j = holds[pusher].findIndex((x) => x.cycle !== null && x.cycle + 0.5 * pusher > first);
        if (j >= 0) holds[pusher][j] = { ...holds[pusher][j], soft: [style.firstLift, 1] };
    }
    holds[steps].unshift({ on: -Infinity, off: firstMove, stand: firstPair[steps], cycle: null, own: true });
    leanOver(startPivot, 0, -Infinity, fullAfter(firstMove));
    let end: { pivot: V3; heading: number } | null = null;
    // Each stop: the foot that struck last stands on; the one behind is set beside it, where the stance has it. Until that
    // foot behind leaves the body walks (a body already standing up could not reach the last footfall), then it stands up.
    const settles: [number, number][] = [];
    // (Coming to rest from a walk, as a stop does: while the foot behind is set beside the other, the hips lean to the side
    // toward the foot that stands, over the point of its sole the weight counts at (STOP_STYLE.shift).)
    const shifts: { from: number; to: number; by: V3 }[] = [];
    for (const stop of stops) {
        const struck = stop.strike % 2 === 0 ? 0 : 1, behind = 1 - struck;
        const front = holds[struck].findIndex((x) => x.cycle !== null && Math.abs(x.cycle + 0.5 * struck - stop.strike / 2) < 1e-9);
        const back = holds[behind].findIndex((x) => x.cycle !== null && Math.abs(x.cycle + 0.5 * behind - (stop.strike / 2 - 0.5)) < 1e-9);
        if (front < 0 || back < 0) continue;
        // The last footfall is the stance's own place about where the body comes to rest, stepped onto by the walk (the one
        // before it is the walk's own: aimed at the stance too, it would reach out ahead of a body still braking).
        const here = way(travelled(stop.at));
        const pivot = add(here.at, scale(up, body.floor));
        const pair = stance(pivot, here.heading);
        // (Braking gently, the walk's lead would put the foot before the last down further on than its own place in the
        // stance, and it would then have to be stepped back: it is set down no further on than that place, its step and its
        // swing shortened to it.)
        if (!stop.run) {
            const was0 = holds[behind][back], ahead = along(body, here.heading), over = dot(sub(flat(was0.stand.at), flat(pair[behind].at)), ahead);
            if (over > 0) holds[behind][back] = { ...was0, stand: { ...was0.stand, at: sub(was0.stand.at, scale(ahead, over)) }, squeeze: true };
        }
        // (It is flat by the time the body stops, and stays as the walk has it then: it does not move again. Braking from a run,
        // it lands where the run puts it, ahead of the body, which brakes on it: it is stepped back into the stance below.)
        if (!stop.run) holds[struck][front] = { ...holds[struck][front], stand: pair[struck], squeeze: true };
        // (The foot it brakes on stands until the body sets off again, rolling by the phase, which comes to rest: not cut to a
        // run's stance time.)
        else { const h = holds[struck][front]; holds[struck][front] = { ...h, byTime: false, off: timeOf(stop.strike / 2 + (h.gait?.duty ?? 0.5)) }; }
        // Then the foot behind is stepped beside it, where the stance has it. The pose stays the walk's until that foot leaves
        // (a body already standing up could not reach the last footfall), then it stands up over where it stopped.
        // (It stands beside the other until the body sets off again.)
        const was = holds[behind][back];
        // (Braking from a run it is already in the air: it comes down beside the last foot shortly after that lands.)
        const fromRun = !!was.gait && was.gait.kind !== 'walk';
        // (Coming to rest from a walk, it bears part of the weight while the body brakes, and leaves once the body has stopped,
        // as a stop has it: the body does not go on over the foot ahead for the walk's toe-off to come.)
        // (As the stop rule steps it: STOP_STYLE.close, how long after it leaves and how long the step takes.)
        const leave = fromRun ? Math.min(was.off, stop.at) : stop.at;
        const land = fromRun ? Math.max(leave + style.closeAfter, holds[struck][front].on + style.closeAfter) : leave + STOP_STYLE.close;
        const setsOff = timeOf(stop.strike / 2 + settle + 1e-6);
        let slowing = Math.floor(stop.at / dt);
        while (slowing > 0 && V[slowing] < style.full) slowing--;
        if (land < stop.until) {
            holds[behind].splice(back, 1, { ...was, off: leave }, { on: land, off: setsOff, stand: pair[behind], cycle: null, own: true });
            if (!fromRun) {
                const reach = body.sole.heel + turnStyle.support * (body.sole.tip - body.sole.heel);
                const support = add(pair[struck].at, scale(along(body, pair[struck].heading), reach));
                // (In the walk's own sway time: over a stride of the walk it stops from, at its height as the foot behind is
                // midway. Quicker, the floor would have to push from outside the sole that stands.)
                const across = rotate(axisAngle(up, here.heading), left), mid = (leave + land) / 2, half = walkAt(V[Math.round(stop.brakes / dt)]).stride / 2;
                shifts.push({ from: mid - half, to: mid + half, by: scale(across, dot(sub(support, pivot), across) * STOP_STYLE.shift) });
            }
            end = { pivot, heading: here.heading };
            // (Braking from a run: once the foot behind is down and the body has stopped, the first foot is stepped back into
            // the stance, as the walk's foot behind is (STOP_STYLE.close). The body
            // stays down over its feet until that foot leaves: standing up sooner, its leg could not reach the foot ahead.)
            const first = holds[struck][front];
            const back2 = Math.max(land, stop.at), down2 = back2 + STOP_STYLE.close;
            const rePlace = stop.run && down2 < stop.until;
            if (rePlace) holds[struck].splice(front, 1, { ...first, off: back2 }, { on: down2, off: first.off, stand: pair[struck], cycle: null, own: true });
            settles.push([slowing * dt, Math.max(slowing * dt, leave, first.on, rePlace ? back2 : 0)]);
        } else {
            settles.push([slowing * dt, Math.max(slowing * dt, holds[struck][front].on)]);
            end = null;
        }
    }
    // Setting off into a walk, as a start does: the trunk bows forward and the head with it, and turning, the body leans
    // toward the foot that stays (START_STYLE.bow, .shift).
    const startBow = (t: number) => (runFirst ? 0 : (START_STYLE.bow[0] + START_STYLE.bow[1] * Math.abs(turnBy)) * DEG * hump((t - firstMove) / Math.max(1e-3, START_STYLE.bow[2])));
    const startLean = scale(sub(flat(firstPair[stays].at), flat(startPivot)), runFirst ? 0 : START_STYLE.shift * Math.sin(Math.abs(turnBy) / 2));
    /** How much the body runs just now: 1 running, 0 walking, and going over between them, the run's share of the pose. */
    const runShare = (t: number) => {
        const mix = plan.mixAt?.(t), running = kindAt(phase(t)) !== 'walk';
        if (!mix || (mix.other.kind !== 'walk') === running) return running ? 1 : 0;
        return running ? 1 - mix.share : mix.share;
    };
    /** How far into a walk's stop's tuck (0 to 1 and back), or null outside every one. */
    const tuckAt = (t: number): number | null => {
        for (const stop of stops) {
            if (stop.run) continue;
            // (Setting off again sooner, it is drawn in to end as the body moves.)
            const from = stop.brakes - STOP_STYLE.brakeAt + STOP_STYLE.tuck[2], to = Math.min(stop.brakes - STOP_STYLE.brakeAt + STOP_STYLE.tuck[3], stop.until);
            if (t > from && t < to) return hump((t - from) / (to - from));
        }
        return null;
    };
    // Setting off into a run, the limbs take the first step to come into the run's pose (the pace is up so soon that by the
    // pace alone they would be thrown into it).
    const intoRun = runOffs.map(({ from, at }) => { let k = from; while (k < n && V[k] < 1e-3) k++; return [k * dt, timeOf(Math.floor(at * 2 + 1e-9) / 2 + 0.5)] as const; });
    const blend = (t: number) => {
        let w = minJerk(clamp(paceAt(t) / Math.max(1e-3, style.full), 0, 1));
        // (Setting off into a walk, the pose comes into the walk's as a start's does, in `START_STYLE.blend` seconds, if the
        // pace is slower to: the body is down in the walk as its first foot comes down, its leg not stretched to reach it.)
        // (Until it comes to rest again, where the stop's own settling takes over.)
        if (!runFirst && t >= firstMove && t < (settles.length ? settles[0][0] : Infinity)) w = Math.max(w, minJerk((t - firstMove) / Math.max(1e-3, START_STYLE.blend)));
        for (const [moves, lands] of intoRun) if (t >= moves && t < lands) w = Math.min(w, minJerk((t - moves) / Math.max(1e-3, lands - moves)));
        for (const [from, landed] of settles) if (t >= from) w = Math.max(w, t <= landed ? 1 : 1 - minJerk((t - landed) / Math.max(1e-3, style.settleTime)));
        return w;
    };
    const plan: CarryPlan = {
        seconds, gait: walkAt(Math.max(...V)), gaitAt: (t, kind) => { const k = kind ?? kindAt(phase(t)); return walkAt(k === 'walk' ? at(stepPaces, t) : paceAt(t), k, effortAt(t)); }, origin, way, travelled, phase, blend,
        paceAt, walkTop: vTop,
        // Going over from a walk to a run or back, the trunk and the arms take a moment.
        mixAt: (t) => {
            const p = phase(t);
            for (let i = switches.length - 1; i >= 0; i--) {
                const sw = switches[i];
                if (p < sw.at - 1e-9) continue;
                const before: GaitKind = i > 0 ? switches[i - 1].kind : 'walk', since = t - timeOf(sw.at);
                if (before === sw.kind || sw.sharp || !(since < style.mixTime)) return null;
                // (The gait it comes from as it was there: a run's arms with the effort they had.)
                return { other: walkAt(paceAt(t), before, effortAt(t)), share: 1 - minJerk(since / style.mixTime) };
            }
            return null;
        },
        // Standing at first the body faces as its stance does; setting off, it comes round to its way.
        facing: (t) => -turnBy * (1 - turnedBy(t)),
        stand: begin?.stand ?? standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: turnStyle.kneeFollow, placeLift: turnStyle.lift,
        // Braking, the trunk tilts back; either way the spine curls forward. (Coming to rest from a walk, as a stop does: the
        // pelvis tucks back and the chest comes forward over it, from as the stop begins, `STOP_STYLE.brakeAt` before the body
        // brakes (STOP_STYLE.tuck).)
        bow: (t) => { const k = tuckAt(t); return startBow(t) + (k === null ? -style.tilt * DEG * brakeAt(t) : -STOP_STYLE.tuck[0] * DEG * k); }, headBow: 0,
        // (The head takes its share of the start's bow: the trunk's tilt braking it does not.)
        nod: (t) => startBow(t),
        // (Running, the spine curls into a push; walking, the body leans into its first step as a start does, above.)
        curl: (t) => { const k = tuckAt(t), pushed = runShare(t) * pushAt(t); return k === null ? style.curl * DEG * (pushed + brakeAt(t)) : (STOP_STYLE.tuck[0] + STOP_STYLE.tuck[1]) * DEG * k + style.curl * DEG * pushed; },
        lean: (t) => {
            // Into the bend, by the sideways pull there (its pace times how fast the way turns: v² times its turn a metre).
            const gone = travelled(t), v = paceAt(t), bent = bendAt(gone);
            // (Running, the hips crouch into a push; braking from a run, they are carried on over the foot put out ahead; going
            // over to a walk, less and less.)
            const running = runShare(t);
            const into = add(scale(rotate(axisAngle(up, way(gone).heading), left), Math.sign(bent) * BEND_STYLE.bank * body.hipHeight * sidePull(v, v * bent)), scale(up, -style.crouch * running * pushAt(t) * body.hipHeight));
            const surged = add(into, scale(along(body, way(gone).heading), running * style.brakeSurge * body.hipHeight * brakeAt(t)));
            let shifted = add(surged, scale(startLean, hump((t - firstMove) / Math.max(1e-3, START_STYLE.turn[0]))));
            for (const sh of shifts) if (t > sh.from && t < sh.to) shifted = add(shifted, scale(sh.by, hump((t - sh.from) / (sh.to - sh.from))));
            const near = leans.find((l) => t >= l.from && t <= l.to);
            if (!near) return shifted;
            return add(shifted, scale(near.by, 1 - blend(t)));
        },
        pushKnee: style.pushKnee * DEG,
        rollOwn: true,
        // (Running, a leg in the air is a working one: it keeps the body's least bend and is never snapped straight behind a
        // body that vaults on; walking, it straightens as it reaches for its footfall.)
        airKnee: (kind) => (kind === 'run' ? HUMAN_MANNER.kneeLeast * DEG : 0),
    };
    const restsAtEnd = stops.length > 0 && stops[stops.length - 1].until >= n * dt - 1e-9;
    return { plan, frames: carryFrames(body, plan, gaitStyle, fps), end: restsAtEnd ? end : null };
}
