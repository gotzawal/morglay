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
// The formulas, how their values were fitted and which to change for which look: editor/MOTION.md.

import { add, dot, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import { chainFollow, chainOf, type ChainStyle } from './chain';
import { GAIT_STYLE, gaitFor, gaitPoser, type Gait, type GaitFrame, type GaitPose, type GaitStyle } from './gait';
import { footTurn, legPose, legSpan } from './limbs';
import { rolled, soleRoll } from './sole';
import { axisAngle, clamp, DEG, minJerk, slerp, viaCurve } from './tools';
import { along, stanceFeet, standFrame, TURN_STYLE, turnedAbout, type Stand, type TurnStyle } from './turn';

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
    /** Where the walk itself would have planted it, where the plan aims the foot elsewhere once it has begun (the foot is already in the air as the plan starts). */
    walk?: Stand;
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
}

/** A walk carried along a way, planned. */
export interface CarryPlan {
    seconds: number;
    /** The plan repeats every `seconds` (one stride of a walk that goes on): what is asked of a time before or after is as good as within. */
    loop?: boolean;
    /** The walk that is carried. */
    gait: Gait;
    /** A way whose pace changes: the walk at the pace of a time (each a walk of `gaitFor`; the same one for the same pace). None: `gait` throughout. */
    gaitAt?: (t: number) => Gait;
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
    /** How high the ankle of a foot set down without the walk's swing goes, share of leg length; how much of that is its heel lifting. */
    placeLift: number;
    heel: number;
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
     * be stretched straight.
     */
    airKnee?: number;
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
    /** In the air: how far through its time there, 0 to 1. */
    through?: number;
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
        const W = walkAt(plan.phase(t), gaitOf(t));
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
    /** How far a leg in the air reaches, and one that lands. */
    const airSpan = plan.airKnee ? legSpan(body, plan.airKnee) : body.leg;
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
            const G = gaitOf(t);
            const p = clamp((plan.phase(t) - (hold.cycle + 0.5 * foot)) / G.duty, 0, 1 - 1e-6);
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
        const reach = hold.own ? straight + (legSpan(body, plan.pushKnee) - straight) * passed : plan.airKnee ? legSpan(body, plan.airKnee) : straight;
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
        return now;
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
            const rise = inAir ? 0 : plan.placeLift * body.leg * hump(u);
            const pitch = -plan.heel * Math.asin(clamp(rise / body.sole.tip, 0, 1)) + from.pitch * (1 - fade);
            const heading = from.heading + (to.heading - from.heading) * fade;
            return {
                ankle: add(add(from.ankle, scale(sub(to.ankle, from.ankle), fade)), scale(up, rise)), pitch, toes: pitch, heading, way: heading, standing: false,
                floor: Math.min(from.floor ?? 0, to.floor ?? 0), through: u,
            };
        }
        // (Where the pace changes, each pose of the walk is of its own time's walk, measured from that walk's own place.)
        const Gn = gaitOf(t), G0 = gaitOf(began), G1 = gaitOf(b.on);
        const gaitIn = (w: GaitPose) => (w === now ? Gn : w === w0 ? G0 : G1);
        const flatIn = (w: GaitPose) => walkFlat(foot, b.cycle!, gaitIn(w));
        // The walk's swing, set down on the place: as a whole, or (a way that bends or climbs) following the way, each point
        // as far along it, as far to its side and as far over it as the walk has it from where it lands.
        const bent = plan.way && b.along !== undefined ? { way: plan.way, along: b.along, at: plan.way(b.along) } : null;
        const aside = bent ? dot(sub(flatOf(b.stand), bent.at.at), rotate(axisAngle(up, bent.at.heading), left)) : 0;
        const level = body.floor + h + (b.up ?? 0);
        const veer = (w: GaitPose) => (bent ? bent.way(bent.along + dot(sub(w.ankles[foot], flatIn(w)), fwd)).heading - bent.at.heading : 0);
        const placed = (w: GaitPose): V3 => {
            const d = sub(w.ankles[foot], flatIn(w));
            if (!bent) return add(flatOn(b), rotate(axisAngle(up, b.stand.heading - SIDE[foot] * gaitIn(w).toeOut), d));
            const here = bent.way(bent.along + dot(d, fwd));
            const across = rotate(axisAngle(up, here.heading), left);
            const climbed = dot(here.at, up) - dot(bent.at.at, up);
            return add(add(sub(here.at, scale(up, dot(here.at, up))), scale(across, aside + dot(d, left))), scale(up, level + climbed + dot(d, up)));
        };
        // The walk's swing at this time. (A foot that lands later than the walk's would is over its place in the walk's
        // time, and from then on as low as its leg lets it: it comes down with the hips.)
        const now = walkAt(plan.phase(t), Gn), w0 = walkAt(plan.phase(began), G0), w1 = walkAt(plan.phase(b.on), G1);
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
        let ankle = add(add(placed(now), scale(sub(from.ankle, placed(w0)), 1 - fade)), scale(sub(to.ankle, placed(w1)), fade));
        const [keepLift, keepPitch] = b.soft ?? [1, 1];
        // A shuffling step keeps only part of the walk's lift over the line between where it left and where it lands.
        if (keepLift !== 1) {
            const line = dot(from.ankle, up) + (dot(to.ankle, up) - dot(from.ankle, up)) * fade;
            ankle = add(ankle, scale(up, (keepLift - 1) * (dot(ankle, up) - line)));
        }
        // Lifted clear of what lies between (the edge of a step): up and down once more, over the walk's own lift.
        if (b.clear && b.clear[0]) ankle = add(ankle, scale(up, b.clear[0] * humpAt(b.clear[1])(u)));
        // Which way the leg goes: as it will stand, turned with the way under it where the way bends; what it left with fades out.
        const way = b.stand.heading + veer(now) + (from.way - b.stand.heading - veer(w0)) * (1 - fade) - veer(w1) * fade;
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
            floor: Math.min(from.floor ?? 0, to.floor ?? 0), through: u,
        };
    };

    // A foot stands only where its leg reaches. It lands when the leg first reaches the place, if the plan has it land
    // sooner (the body still too high over a step down), and it leaves the floor when the leg can no longer reach it,
    // if the plan has it stay longer. (A plan that repeats is looked at through each hold's whole time, so that every
    // round of it is the same.)
    const holds = plan.holds.map((list, foot) => list.map((hold) => {
        let from = plan.loop ? hold.on : Math.max(0, hold.on);
        const to = plan.loop ? hold.off : Math.min(hold.off, plan.seconds);
        if (!(to > from)) return hold;
        const step = 1 / 120;
        let held = hold;
        if ((plan.loop || hold.on >= 0) && !reached(foot, hold, from, airSpan)) {
            let t = from + step;
            while (t < to && !reached(foot, hold, t, airSpan)) t += step;
            // (Never within reach: it is not stood on.)
            if (!(t < to)) return { ...hold, off: hold.on };
            let lo = t - step, hi = t;
            for (let n = 0; n < 20; n++) { const mid = (lo + hi) / 2; if (reached(foot, hold, mid, airSpan)) hi = mid; else lo = mid; }
            held = { ...hold, on: hi };
            from = hi;
        }
        // (A foot of the walk's, where the plan keeps knees bent: within reach of the leg bent so.)
        const span = hold.own ? body.leg : airSpan;
        for (let t = from; t < to; t += step) {
            if (reached(foot, held, t, span)) continue;
            let lo = Math.max(from, t - step), hi = t;
            if (!reached(foot, held, lo, span)) return { ...held, off: lo };
            for (let n = 0; n < 20; n++) { const mid = (lo + hi) / 2; if (reached(foot, held, mid, span)) lo = mid; else hi = mid; }
            return { ...held, off: lo };
        }
        return held;
    }));
    const footAt = (foot: number, t: number): FootNow => {
        const list = holds[foot];
        let before: Hold | null = null;
        for (const hold of list) {
            if (t >= hold.on && t < hold.off) return planted(foot, hold, t);
            if (hold.off <= t) before = hold;
            else if (before || plan.airborne?.[foot]) return swinging(foot, before, hold, t);
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
            const leg = f.standing || !plan.airKnee ? legPose(body, socketAt(i, t), want, along(body, knee)) : legPose(body, socketAt(i, t), want, along(body, knee), airSpan);
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
    /** How long the body takes to reach the walk's speed, seconds. */
    accel: number;
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
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
    /** The trunk bows forward as the body starts: degrees, degrees per radian of the turn, how long it lasts (seconds), and the share of it the head takes. */
    bow: [number, number, number, number];
    /** The foot that stays swivels where it stands, dragged round by the pelvis: the share of the body's turn it follows. */
    swivel: number;
    /** While it turns the body leans toward the foot that stays: the share of the way to it, at a half turn. */
    shift: number;
    /** The first footfall lands wide of the walk's line: share of hip height, and per radian of the turn. */
    landOut: [number, number];
    /** The foot that stays, dragged round, shuffles to its first footfall: how much of the walk's swing it loses at a half turn (of its heel's pitch; of its lift, by the square of the angle). */
    shuffle: number;
    /** It keeps its knee bent by this as its heel rises behind the body, degrees. */
    pushKnee: number;
}

export const START_STYLE: StartStyle = {
    accel: 0.19, blend: 0.45, turn: [0.9, 0.05, 0.26], twistMost: 19, landTurn: 0.14, phase: -0.017, kneeFollow: 0.55,
    bow: [2.5, 0.7, 1.6, 1], swivel: 0.2, shift: 0.25, landOut: [0.025, 0.0045], shuffle: 0.6, pushKnee: 16,
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

/** Beginning from a walk instead of standing (a turn right about): the walk's phase then, counted from the strike of the foot that stands, and how the foot in the air is put down. */
interface FromWalk {
    phase: number;
    /** When it is down (seconds), how far ahead in the way the body was going (share of a step) and to its own side (share of hip height). */
    drop: [number, number, number];
}

/** The plan of a start (walkStart), or of a turn right about begun from a walk (walkPivot). */
function startPlan(
    body: Body, speed: number, angle: number, toLeft: boolean, seconds: number,
    style: StartStyle, gaitStyle: GaitStyle, turnStyle: TurnStyle, walking?: FromWalk, chain?: ChainStyle,
): CarryPlan {
    const { up, fwd, left } = body;
    const g = gaitFor(body, speed, gaitStyle);
    const stride = g.speed * g.stride;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const pivot = add(origin, scale(up, body.floor));
    const near = toLeft ? 0 : 1, far = 1 - near;
    const back = axisAngle(up, -angle);
    const about = (p: V3): V3 => add(pivot, rotate(back, sub(p, pivot)));

    // Where it begins: standing, facing away from its way by the angle; or walking the other way, one foot under it and one in the air.
    let feet: [Stand, Stand];
    let stand: GaitFrame;
    let airborne: [FootNow | null, FootNow | null] | undefined;
    if (!walking) {
        const stood = stanceFeet(body, turnStyle.stance, pivot);
        feet = [turnedAbout(body, stood[0], pivot, -angle), turnedAbout(body, stood[1], pivot, -angle)];
        stand = standFrame(body, turnStyle);
    } else {
        const w = gaitPoser(body, g, gaitStyle)((0.5 * near + walking.phase) * g.stride);
        const inPlace = (p: V3): V3 => sub(p, scale(fwd, w.travel));
        const { feet: _feet, legTurn: _legTurn, ...frame } = w;
        stand = { ...frame, hips: inPlace(w.hips) };
        const side = far ? -1 : 1;
        // The foot in the air is put down at once: a little ahead in the way the body was going, out to its own side.
        const dropped: Stand = {
            at: add(add(pivot, scale(rotate(back, fwd), walking.drop[1] * g.step)), scale(rotate(back, left), side * walking.drop[2] * body.hipHeight)),
            heading: side * g.toeOut - angle,
        };
        const standing: Stand = { at: about(inPlace(w.feet[near].flat)), heading: w.feet[near].heading - angle };
        feet = near === 0 ? [standing, dropped] : [dropped, standing];
        airborne = [null, null];
        airborne[far] = { ankle: about(inPlace(w.ankles[far])), pitch: w.feet[far].pitch, toes: w.feet[far].toes, heading: w.feet[far].heading - angle, way: side * g.toeOut - angle, standing: false };
    }

    // The way: up to speed the smoothest way, then steady.
    const T = Math.max(1e-3, style.accel);
    const travelled = (t: number) => (t <= 0 ? 0 : t < T ? g.speed * T * ramp(t / T) : g.speed * (t - T / 2));
    const timeAt = (s: number) => {
        if (s >= (g.speed * T) / 2) return s / g.speed + T / 2;
        let lo = 0, hi = T;
        for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (travelled(mid) < s) lo = mid; else hi = mid; }
        return (lo + hi) / 2;
    };
    // The walk begins part-way through a step: the foot that stays is where the walk would have its standing foot.
    // (A foot that stands ahead of the hips is no help to push off from: the walk starts as if it stood under them.)
    const farAlong = Math.min(0, dot(sub(feet[far].at, pivot), fwd));
    const firstStrike = (near === 0 ? 1 : 0) + 0.5 * near;
    const phase0 = clamp(0.5 * far + (g.lead - farAlong) / stride + style.phase, 0.5 * far + 0.02, firstStrike - 0.08);
    const phase = (t: number) => phase0 + travelled(t) / stride;
    const timeOf = (p: number) => timeAt((p - phase0) * stride);

    // The turn: the body is already turning as it starts, and settles facing its way.
    const turnedBy = (t: number) => steady(t, style.turn[0], style.turn[1], style.turn[2]);
    // (With a chain this is the line the legs walk on: the pelvis, the chest and the head follow the look, the way ahead, by their springs.)
    const line = (t: number) => -angle * (1 - turnedBy(t));
    const follow = chain ? chainFollow(chain, (t) => chainOf(chain, angle * (1 - turnedBy(t)), { pelvis: 0, chest: 0, toes: [0, 0] }, false), seconds) : null;
    const facing = (t: number) => line(t) + (follow ? follow(t).pelvis : 0);
    // The foot that stays leaves when the walk's foot would, or sooner: when the pelvis has turned as far against it as it can.
    let leave = timeOf(0.5 * far + g.duty);
    const most = style.twistMost * DEG;
    const follows = clamp(style.swivel, 0, 0.95);
    if (Math.abs(angle) * (1 - follows) > most) {
        let lo = 0, hi = style.turn[0];
        for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (Math.abs(angle) * (1 - follows) * turnedBy(mid) < most) lo = mid; else hi = mid; }
        leave = Math.min(leave, (lo + hi) / 2);
    }

    /** Where the walk plants a foot in its `cycle`-th stride, on this way. */
    const walkStand = (foot: number, cycle: number): Stand => ({
        at: add(add(pivot, scale(fwd, stride * (cycle + 0.5 * foot - phase0) + g.lead)), scale(left, ((foot ? -1 : 1) * g.width) / 2)),
        heading: (foot ? -1 : 1) * g.toeOut,
    });
    const holds: [Hold[], Hold[]] = [[], []];
    const swivel = (t: number) => follows * angle * turnedBy(t);
    holds[near].push({ on: -Infinity, off: 0, stand: feet[near], cycle: null, own: true });
    if (walking) {
        // It is down for a moment at least before the turn takes it up again.
        const down = Math.max(0.02, walking.drop[0]);
        holds[far].push({ on: down, off: Math.max(down + 0.05, leave), stand: feet[far], cycle: 0, own: true, place: true, swivel });
    } else holds[far].push({ on: -Infinity, off: Math.max(0, leave), stand: feet[far], cycle: 0, own: true, swivel });
    for (const foot of [near, far]) {
        for (let cycle = foot === near ? (near === 0 ? 1 : 0) : 1; ; cycle++) {
            const on = timeOf(cycle + 0.5 * foot);
            if (on > seconds + g.stride) break;
            const next = walkStand(foot, cycle);
            // The first footfall is still turned a little toward where the foot stood, and a little wide.
            if (foot === near && holds[near].length === 1) {
                next.heading -= style.landTurn * angle;
                next.at = add(next.at, scale(left, (near ? -1 : 1) * (style.landOut[0] + style.landOut[1] * Math.abs(angle)) * body.hipHeight));
            }
            const turnShare = Math.abs(angle) / Math.PI;
            const soft: [number, number] | undefined = foot === far && holds[far].length === 1 && angle !== 0
                ? [clamp(1 - style.shuffle * turnShare * turnShare, 0, 1), clamp(1 - style.shuffle * turnShare, 0, 1)] : undefined;
            holds[foot].push({ on, off: timeOf(cycle + 0.5 * foot + g.duty), stand: next, cycle, own: false, ...(soft ? { soft } : {}) });
        }
    }

    return {
        seconds, gait: g, origin, travelled, phase,
        blend: (t) => minJerk(t / Math.max(1e-3, style.blend)),
        facing,
        stand,
        holds,
        // (Begun from a walk, the pose it begins in has the walk's own knees.)
        kneeFollow: style.kneeFollow, standKnee: walking ? 0 : turnStyle.kneeFollow, placeLift: turnStyle.lift, heel: turnStyle.heel,
        bow: (t) => (style.bow[0] + style.bow[1] * Math.abs(angle)) * DEG * hump(t / Math.max(1e-3, style.bow[2])), headBow: style.bow[3],
        // While it turns the body leans toward the foot that stays.
        lean: (t) => scale(sub(feet[far].at, pivot), style.shift * Math.sin(Math.abs(angle) / 2) * hump(t / Math.max(1e-3, style.turn[0]))),
        pushKnee: style.pushKnee * DEG,
        ...(airborne ? { airborne } : {}),
        ...(follow ? { look: (t: number): [number, number] => { const f = follow(t); return [f.chest, f.chest + f.head]; } } : {}),
    };
}

/**
 * A start: from standing to walking at `speed` (metres a second) along the body's forward,
 * the body turned by `angle` (radians, positive to the left) to face that way. It stands
 * facing away from its way by the angle, takes its first step with the foot of the side it
 * turns to, and is the walk itself once it is up to speed and turned.
 */
export function walkStart(
    body: Body, speed: number, angle: number, toLeft: boolean = angle >= 0, seconds = 1.7,
    style: StartStyle = START_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE, chain?: ChainStyle,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const plan = startPlan(body, speed, angle, toLeft, seconds, style, gaitStyle, turnStyle, undefined, chain);
    return { plan, frames: carryFrames(body, plan, gaitStyle) };
}

/** The numbers of a turn right about while walking: those of a start, and how it begins from the walk. */
export interface PivotStyle extends StartStyle {
    /** The walk's phase as it begins, counted from the strike of the foot that stands just then (the foot of the side it turns to), strides. */
    from: number;
    /** The foot in the air is put down at once: when it is down (seconds), how far ahead in the way the body was going (share of a step), and how far out to its own side (share of hip height). */
    drop: [number, number, number];
}

export const PIVOT_STYLE: PivotStyle = {
    ...START_STYLE,
    accel: 0.3, blend: 0.27, turn: [0.9, 0.05, 0.28], landTurn: 0.15, phase: -0.012, bow: [2.3, 0.65, 1.6, 1],
    swivel: 0.38, shift: 0.14, landOut: [0.019, 0.0045], shuffle: 0.6,
    from: 0.25, drop: [0.13, 0.1, 0.12],
};

/**
 * A turn right about while walking at `speed`: the body walks one way, and within a second
 * and a half walks the other. It begins on the foot of the side it turns to (`toLeft`), the
 * other foot in the air; that one is put down at once, and from there it is a start by a half
 * turn. The frames are given in place, as a walk's stride is: `travel` says how far the
 * body has gone on its new way, and is taken off the hips and the feet.
 */
export function walkPivot(
    body: Body, speed: number, toLeft: boolean, seconds = 1.7,
    style: PivotStyle = PIVOT_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE, chain?: ChainStyle,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const plan = startPlan(body, speed, toLeft ? Math.PI : -Math.PI, toLeft, seconds, style, gaitStyle, turnStyle, { phase: style.from, drop: style.drop }, chain);
    const back = (p: V3, s: number): V3 => sub(p, scale(body.fwd, s));
    const frames = carryFrames(body, plan, gaitStyle).map((f) => ({ ...f, hips: back(f.hips, f.travel), ankles: [back(f.ankles[0], f.travel), back(f.ankles[1], f.travel)] as [V3, V3] }));
    return { plan, frames };
}

/** The numbers of a stop. */
export interface StopStyle {
    /** The walk's phase as the stop begins, counted from the strike of the foot that stands just then, strides. */
    phase: number;
    /** The body goes on at its pace for so long, then slows to a stand within so long, seconds. */
    brakeAt: number;
    brake: number;
    /** When the foot that stood is set down where the body will stand, seconds. */
    land: number;
    /** The foot in the air lands short of where the walk would put it: share of a step. */
    short: number;
    /** The pose goes from the walk's to the standing one between these times, seconds. */
    blend: [number, number];
    /** The foot that landed first is then set beside the other: how long after the other has landed it leaves, and how long it takes, seconds; how high its ankle goes, share of leg length. */
    close: [number, number];
    closeLift: number;
    /** Meanwhile the hips lean toward the foot that stands: the share of the way to it. */
    shift: number;
    /** Braking, the pelvis tips back and the chest comes forward over it: degrees of each, from and to (seconds), and the share of the chest's the head takes. */
    tuck: [number, number, number, number, number];
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
    /** A foot left behind keeps its knee bent by this as its heel rises, degrees. */
    pushKnee: number;
}

export const STOP_STYLE: StopStyle = {
    phase: 0.25, brakeAt: 0.3, brake: 0.6, land: 1, short: 0.027, blend: [0.24, 1.2], close: [0, 0.65], closeLift: 0.045,
    shift: 0.65, tuck: [5.5, 4, 0.24, 2, 0.16], kneeFollow: 0.5, pushKnee: 16,
};

/**
 * A stop: from walking at `speed` (metres a second) to standing. `standing`: the foot that
 * stands under the body as the stop begins (0 the left, 1 the right); the other is in the air.
 * That one lands a little short; the foot that stood takes one more step, onto where the body
 * will stand; the first is then set beside it. The frames begin as the walk itself.
 */
export function walkStop(
    body: Body, speed: number, standing: number, seconds = 2.5,
    style: StopStyle = STOP_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const { up, fwd, left } = body;
    const g = gaitFor(body, speed, gaitStyle);
    const stride = g.speed * g.stride;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const pivot = add(origin, scale(up, body.floor));
    const other = 1 - standing;
    const phase0 = 0.5 * standing + style.phase;
    // The foot in the air strikes next (its stride and phase), then the foot that stands, one stride after its last strike.
    const cycleNext = other === 1 ? 0 : 1;
    const strikeNext = cycleNext + 0.5 * other, strikeLast = 1 + 0.5 * standing;

    // The way: on at its pace, then down to nothing the smoothest way.
    const travelled = (t: number) => g.speed * (t - gone(t - style.brakeAt, Math.max(1e-3, style.brake)));
    const whole = g.speed * (style.brakeAt + style.brake / 2);
    // The walk's phase: as the walk has it until the foot in the air lands, then on to the last footfall, which is set down (no pace left).
    const t1 = (strikeNext - phase0) * g.stride, t2 = Math.max(style.land, t1 + 0.15);
    // Then the first foot is set beside it: once the other is down.
    const closeFrom = t2 + Math.max(0, style.close[0]), closeTo = closeFrom + Math.max(0.1, style.close[1]);
    const course = viaCurve(phase0, t2 / g.stride, 0, strikeLast, 0, 0, t1 / t2, strikeNext);
    const phase = (t: number) => (t <= 0 ? phase0 + t / g.stride : t >= t2 ? strikeLast : course(t / t2));
    const timeOf = (p: number) => {
        if (p <= phase0) return (p - phase0) * g.stride;
        let lo = 0, hi = t2;
        for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (phase(mid) < p) lo = mid; else hi = mid; }
        return (lo + hi) / 2;
    };

    const end = add(pivot, scale(fwd, whole));
    const stood = stanceFeet(body, turnStyle.stance, end);
    const walkStand = (foot: number, cycle: number): Stand => ({
        at: add(add(pivot, scale(fwd, stride * (cycle + 0.5 * foot - phase0) + g.lead)), scale(left, ((foot ? -1 : 1) * g.width) / 2)),
        heading: (foot ? -1 : 1) * g.toeOut,
    });
    const aimed = walkStand(other, cycleNext);
    const holds: [Hold[], Hold[]] = [[], []];
    // The foot that stands: the walk's own stance until its toes leave, then its last step, onto where it will stand.
    holds[standing] = [
        { on: -Infinity, off: timeOf(0.5 * standing + g.duty), stand: walkStand(standing, 0), cycle: 0, own: false },
        { on: t2, off: Infinity, stand: stood[standing], cycle: 1, own: true },
    ];
    // The foot in the air: it lands a little short of where the walk would put it, and is later set beside the other.
    holds[other] = [
        { on: -Infinity, off: (cycleNext - 1 + 0.5 * other + g.duty - phase0) * g.stride, stand: walkStand(other, cycleNext - 1), cycle: cycleNext - 1, own: false },
        { on: t1, off: closeFrom, stand: { at: sub(aimed.at, scale(fwd, style.short * g.step)), heading: aimed.heading }, cycle: cycleNext, own: true, walk: aimed },
        { on: closeTo, off: Infinity, stand: stood[other], cycle: null, own: true },
    ];

    // While the first foot is set beside it, the hips lean toward the foot that stands (over the point of its sole the weight counts at).
    const reach = body.sole.heel + turnStyle.support * (body.sole.tip - body.sole.heel);
    const support = add(stood[standing].at, scale(along(body, stood[standing].heading), reach));
    const early = Math.min(turnStyle.shiftEarly, closeFrom);
    const plan: CarryPlan = {
        seconds, gait: g, origin, travelled, phase,
        blend: (t) => 1 - minJerk((t - style.blend[0]) / Math.max(1e-3, style.blend[1] - style.blend[0])),
        facing: () => 0,
        stand: standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: turnStyle.kneeFollow, placeLift: style.closeLift, heel: turnStyle.heel,
        bow: (t) => -style.tuck[0] * DEG * hump((t - style.tuck[2]) / Math.max(1e-3, style.tuck[3] - style.tuck[2])), headBow: style.tuck[4],
        curl: (t) => (style.tuck[0] + style.tuck[1]) * DEG * hump((t - style.tuck[2]) / Math.max(1e-3, style.tuck[3] - style.tuck[2])),
        // (To the side only: it does not lean back onto a foot that stands behind.)
        lean: (t) => scale(left, dot(sub(support, end), left) * style.shift * hump((t - closeFrom + early) / (closeTo - closeFrom + early))),
        pushKnee: style.pushKnee * DEG,
    };
    return { plan, frames: carryFrames(body, plan, gaitStyle) };
}

/** The numbers of a walk round a circle. */
export interface ArcStyle {
    /** How far the way turns in a stride, radians. */
    turn: number;
    /** The walk's phase at the first frame, strides (0: the left heel strikes). */
    phase: number;
    /** The hips lean in toward the middle of the circle: share of hip height. */
    bank: number;
    /** The footfalls are set in toward the middle of the circle from the walk's own line: the inner foot's and the outer foot's, shares of hip height. */
    track: [number, number];
    /** The feet point into the turn, off the way where they stand: the inner foot and the outer foot, degrees. */
    toe: [number, number];
    /** The body faces off its way (above zero: into the turn), and over that the chest and the head look into the turn, degrees. */
    face: number;
    look: [number, number];
    /** The spine curls forward, degrees at the chest; and the share of it the head takes. */
    curl: [number, number];
    /** The chest and the head roll into the turn, degrees. */
    roll: [number, number];
    /** The arms are held further out from the sides, the inner one and the outer one, degrees; and their elbows more bent. */
    armOut: [number, number];
    elbow: [number, number];
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
}

export const ARC_STYLE: ArcStyle = {
    turn: 1.3, phase: 0.25, bank: 0.07, track: [0.05, -0.033], toe: [10, -0.9], face: -4, look: [10, 20], curl: [6.5, 0.85],
    roll: [1.6, 2.7], armOut: [0.5, 7], elbow: [6.5, 6.5], kneeFollow: 0.5,
};

/**
 * A walk round a circle at `speed` (metres a second), to the left or to the right: one
 * stride of it as `count` + 1 frames (the last is the first again), given in place as a
 * straight walk's stride is, the body facing along its way. It is the straight walk carried
 * along a way that bends; the inner foot's steps come out shorter by themselves.
 */
export function walkArc(
    body: Body, speed: number, toLeft: boolean, count = 64,
    style: ArcStyle = ARC_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const { up, fwd, left } = body;
    const g = gaitFor(body, speed, gaitStyle);
    const stride = g.speed * g.stride;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const sign = toLeft ? 1 : -1, inner = toLeft ? 0 : 1;
    // The circle: its radius from how far the way turns in a stride (to the left above zero).
    const radius = (sign * stride) / Math.max(1e-6, style.turn);
    const way = (gone: number) => {
        const a = gone / radius;
        return { at: add(origin, scale(add(scale(left, 1 - Math.cos(a)), scale(fwd, Math.sin(a))), radius)), heading: a };
    };
    const travelled = (t: number) => g.speed * t;
    const phase = (t: number) => style.phase + t / g.stride;
    const holds: [Hold[], Hold[]] = [[], []];
    for (let foot = 0; foot < 2; foot++) {
        const side = foot ? -1 : 1;
        for (let cycle = -2; cycle <= 3; cycle++) {
            const on = (cycle + 0.5 * foot - style.phase) * g.stride;
            const along = stride * (cycle + 0.5 * foot - style.phase) + g.lead;
            const here = way(along);
            const across = rotate(axisAngle(up, here.heading), left);
            const k = foot === inner ? 0 : 1;
            holds[foot].push({
                on, off: on + g.duty * g.stride,
                stand: {
                    at: add(here.at, scale(across, (side * g.width) / 2 + sign * style.track[k] * body.hipHeight)),
                    heading: here.heading + side * g.toeOut + sign * style.toe[k] * DEG,
                },
                cycle, own: false, along,
            });
        }
    }
    const plan: CarryPlan = {
        seconds: g.stride, loop: true, gait: g, origin, way, travelled, phase,
        blend: () => 1,
        facing: () => sign * style.face * DEG,
        stand: standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: 0, placeLift: turnStyle.lift, heel: turnStyle.heel,
        bow: () => 0, headBow: style.curl[1],
        curl: () => style.curl[0] * DEG,
        // Leaning in: toward the middle of the circle, as the way stands now.
        lean: (t) => scale(rotate(axisAngle(up, way(travelled(t)).heading), left), sign * style.bank * body.hipHeight),
        look: () => [sign * style.look[0] * DEG, sign * style.look[1] * DEG],
        // Rolled into the turn: the side toward the middle of the circle down.
        roll: () => [-sign * style.roll[0] * DEG, -sign * style.roll[1] * DEG],
        arms: () => {
            const of = (foot: number): [number, number] => { const k = foot === inner ? 0 : 1; return [style.armOut[k] * DEG, style.elbow[k] * DEG]; };
            return [of(0), of(1)];
        },
        pushKnee: 0,
    };
    // In place: every frame seen from where the body is on its way, facing along it.
    const frames = carryFrames(body, plan, gaitStyle, count / g.stride).map((f) => {
        const here = way(f.travel);
        const back = axisAngle(up, -here.heading);
        const seen = (p: V3): V3 => add(origin, rotate(back, sub(p, here.at)));
        const world: Record<string, Quat> = {};
        for (const r of Object.keys(f.world)) world[r] = qmul(back, f.world[r]);
        return { ...f, travel: 0, hips: seen(f.hips), ankles: [seen(f.ankles[0]), seen(f.ankles[1])] as [V3, V3], world };
    });
    return { plan, frames };
}

/** The numbers of a walk up a slope, or of one down it: for the slope `SlopeStyle.grade`; a gentler slope has as much less of them. */
export interface SlopeSide {
    /** A foot lands later than the walk's would, share of a stride (below zero: sooner), and stays down longer. */
    late: number;
    stay: number;
    /** How much of the walk's heel-up pitch a foot in the air keeps. */
    heel: number;
    /**
     * The body's weight goes from the level of one footfall to the next one's: beginning this share of a step
     * after the foot has landed there (below zero: before it lands), and taking this share of a step.
     */
    carry: [number, number];
    /** The hips ride lower than the walk's over the level that carries them, and further forward on the way: shares of hip height. */
    sink: number;
    fore: number;
    /** The hips' own to and fro along the way with each step: share of hip height, and when they are furthest forward (share of a step after a foot lands). */
    surge: [number, number];
    /** How much of the walk's own rise and fall is left. */
    bob: number;
    /** A foot in the air is lifted over the walk's own lift: share of leg length at most, and most at this share of the swing's time. */
    clear: [number, number];
    /** The pelvis tips forward, the spine curls forward over it (at the chest), the head nods down: degrees. */
    bow: number;
    curl: number;
    nod: number;
    /** The pelvis tips to and fro with each step, the spine taking it up (the chest keeps its lean): degrees, and when it is furthest forward (share of a stride after a heel would strike). */
    tip: [number, number];
    /** The head nods with each step: degrees, and when it is furthest down (share of a stride after a heel would strike). */
    nods: [number, number];
    /**
     * Once a stride, over what the walk has: the pelvis lists (its left side up) and turns (to the left), the chest
     * turns and lists: degrees, and when each is so most (share of a stride after the left heel would strike).
     */
    list: [number, number];
    hipTurn: [number, number];
    chestTurn: [number, number];
    chestList: [number, number];
    /** The footfalls are set further apart to the sides: share of hip height, each side. */
    wide: number;
    /** The body faces off its way, and the feet point off it over the walk's own toes out (the left, the right): degrees to the left. */
    face: number;
    toe: [number, number];
    /** The arms are held further out from the sides and further forward (they hang, where the chest leans): degrees. */
    armOut: number;
    armFore: number;
    /** They swing further than the walk's, each with its own swing: degrees, and how much later (share of a stride). */
    armSwing: [number, number];
    /** The elbows are more bent, and more again as an arm comes forward: degrees. */
    elbow: number;
    elbowSwing: number;
}

/** The numbers of a walk on a slope. */
export interface SlopeStyle {
    /** The slope the numbers are for: rise over run. */
    grade: number;
    /** The walk's phase at the first frame, strides (0: the left heel strikes). */
    phase: number;
    up: SlopeSide;
    down: SlopeSide;
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
    /** A leg in the air keeps its knee bent by at least this, degrees (reaching down for a step, it is not locked straight). */
    airKnee: number;
}

export const SLOPE_STYLE: SlopeStyle = {
    grade: 0.6, phase: 0.25, airKnee: 12,
    up: {
        late: -0.011, stay: 0.027, heel: 1, carry: [-0.055, 0.8], sink: -0.035, fore: -0.07, surge: [0.025, 0.5], bob: -0.28, clear: [0.13, 0.75],
        wide: 0.025, face: 2.5, toe: [-3.5, 0.45], bow: 3.3, curl: 20, nod: 4.5, tip: [4.5, 0.25], nods: [-3.5, 0.18], list: [5.5, -0.07],
        hipTurn: [6, 0.8], chestTurn: [2.2, 0.8], chestList: [5, 0.65], armOut: 7, armFore: 11, armSwing: [9.5, -0.17], elbow: 0.19, elbowSwing: 28,
    },
    down: {
        late: 0.08, stay: -0.04, heel: 0.9, carry: [-0.5, 1], sink: 0.1, fore: 0.04, surge: [0.01, 0.12], bob: 0.55, clear: [0.18, 0.8],
        wide: 0.03, face: -3.5, toe: [0.2, -11], bow: -6, curl: 9, nod: 11, tip: [-2.5, 0.55], nods: [1.5, -0.085], list: [4.5, 0.6],
        hipTurn: [5, 0.8], chestTurn: [-5, 1.1], chestList: [-0.8, 0.3], armOut: 2.5, armFore: -4.5, armSwing: [0.75, 0.14], elbow: 7.5, elbowSwing: 16,
    },
    kneeFollow: 0.5,
};

/**
 * A walk at `speed` (metres a second along the slope) up or down a slope of `grade` (rise
 * over run; below zero: down): one stride of it as `count` + 1 frames (the last is the
 * first again), given in place: the body seen from where it is on its way. It is the level
 * walk carried along a way that climbs, as far along the slope each stride as on the level;
 * every footfall stands level on a height of its own, as on the steps of a stair.
 */
export function walkSlope(
    body: Body, speed: number, grade: number, count = 64,
    style: SlopeStyle = SLOPE_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE,
): { plan: CarryPlan; frames: GaitFrame[] } {
    const { up, fwd, left } = body;
    const g = gaitFor(body, speed, gaitStyle);
    const stride = g.speed * g.stride;
    const origin = sub(body.ref.hips, scale(up, dot(body.ref.hips, up)));
    const side = grade >= 0 ? style.up : style.down;
    // How much of the style's numbers this slope asks for.
    const q = clamp(Math.abs(grade) / Math.max(1e-9, style.grade), 0, 1);
    // The way climbs: so far along it is so far forward and so far up.
    const angle = Math.atan(grade), run = Math.cos(angle), rise = Math.sin(angle);
    const way = (gone: number) => ({ at: add(origin, add(scale(fwd, gone * run), scale(up, gone * rise))), heading: 0 });
    const travelled = (t: number) => g.speed * t;
    const phase = (t: number) => style.phase + t / g.stride;
    const late = q * side.late * g.stride;
    const holds: [Hold[], Hold[]] = [[], []];
    for (let foot = 0; foot < 2; foot++) {
        const sign = foot ? -1 : 1;
        for (let cycle = -2; cycle <= 3; cycle++) {
            // Where and when the walk would strike; the foot comes down there, later or sooner.
            const strike = (cycle + 0.5 * foot - style.phase) * g.stride;
            const along = stride * (cycle + 0.5 * foot - style.phase) + g.lead;
            const here = way(along);
            holds[foot].push({
                on: strike + late, off: strike + (g.duty + q * side.stay) * g.stride,
                stand: { at: add(here.at, scale(left, sign * (g.width / 2 + q * side.wide * body.hipHeight))), heading: sign * g.toeOut + q * side.toe[foot] * DEG },
                cycle, own: false, along, up: dot(here.at, up) - dot(origin, up),
                clear: [q * side.clear[0] * body.leg, side.clear[1]],
                soft: [1, 1 - q * (1 - side.heel)],
            });
        }
    }
    // The level that carries the body: each footfall's own, gone over to in a smooth step some time after (or before) the foot lands.
    const stepTime = g.stride / 2, stepRise = (stride / 2) * rise;
    const first = -style.phase * g.stride + late;
    const [carryFrom, carryOver] = [side.carry[0], Math.max(0.05, side.carry[1])];
    const reach = 3 + Math.ceil(Math.abs(carryFrom) + carryOver);
    /** How far the hips are over (or under) the height of the way where the body is, for the levels that carry it. */
    const carried = (t: number) => {
        const steps = (t - first) / stepTime;
        const base = Math.floor(steps);
        let done = 0;
        for (let n = base - reach; n <= base + reach; n++) done += minJerk(clamp((steps - n - carryFrom) / carryOver, 0, 1)) - (n <= base ? 1 : 0);
        // (Counted from the footfall last landed: that one's level is the way's height where it stands.)
        return stepRise * (done + base - steps) + (g.lead - g.speed * late) * rise;
    };
    // The walk's own rise and fall about its mean height: less of it is left the steeper the way.
    const pose = gaitPoser(body, g, gaitStyle);
    let mean = 0;
    for (let k = 0; k < 32; k++) mean += dot(pose((k * g.stride) / 32).hips, up) / 32;
    const bobLeft = 1 - q * (1 - side.bob);
    /** A turn that comes and goes once a stride: radians at a time. */
    const once = (pair: [number, number], t: number) => q * pair[0] * DEG * Math.cos(2 * Math.PI * (phase(t) - pair[1]));
    /** The pelvis' own tipping with each step, degrees. */
    const tipped = (t: number) => side.tip[0] * Math.cos(4 * Math.PI * (phase(t) - side.tip[1]));
    const plan: CarryPlan = {
        seconds: g.stride, loop: true, gait: g, origin, way, travelled, phase,
        blend: () => 1,
        facing: () => q * side.face * DEG,
        stand: standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: 0, placeLift: turnStyle.lift, heel: turnStyle.heel,
        // The trunk leans into the climb from the pelvis up; the head keeps its own level and nods as it has to.
        bow: (t) => q * (side.bow + tipped(t)) * DEG, headBow: 0,
        curl: (t) => q * (side.curl - tipped(t)) * DEG,
        nod: (t) => q * (side.nod + side.nods[0] * Math.cos(4 * Math.PI * (phase(t) - side.nods[1]))) * DEG,
        pelvis: (t) => [once(side.list, t), once(side.hipTurn, t)],
        look: (t) => [once(side.chestTurn, t), 0],
        roll: (t) => [once(side.chestList, t), 0],
        arms: (t) => {
            // Each arm's own swing as the walk has it (forward above zero), a little later.
            const turn = 2 * Math.PI * (phase(t) - g.mode.armLag - side.armSwing[1]);
            const of = (i: number): [number, number, number] => {
                const swung = -(i ? -1 : 1) * Math.cos(turn);
                return [q * side.armOut * DEG, q * (side.elbow + (side.elbowSwing * (1 + swung)) / 2) * DEG, q * (side.armFore + side.armSwing[0] * swung) * DEG];
            };
            return [of(0), of(1)];
        },
        lean: (t) => {
            const steps = (t - first) / stepTime;
            const less = bobLeft === 1 ? 0 : (1 - bobLeft) * (dot(pose(phase(t) * g.stride).hips, up) - mean);
            const high = carried(t) - q * side.sink * body.hipHeight - less;
            const ahead = q * body.hipHeight * (side.fore + side.surge[0] * Math.cos(2 * Math.PI * (steps - side.surge[1])));
            return add(scale(up, high), scale(fwd, ahead));
        },
        pushKnee: 0,
        airKnee: q * style.airKnee * DEG,
    };
    // In place: every frame seen from where the body is on its way.
    const frames = carryFrames(body, plan, gaitStyle, count / g.stride).map((f) => {
        const here = way(f.travel);
        const seen = (p: V3): V3 => add(origin, sub(p, here.at));
        return { ...f, travel: 0, hips: seen(f.hips), ankles: [seen(f.ankles[0]), seen(f.ankles[1])] as [V3, V3] };
    });
    return { plan, frames };
}

/** The numbers of a walk along a way whose pace changes, coming to rest and setting off again. */
export interface AlongStyle {
    /** The walk's shape is taken at no less than this pace, metres a second: slower, its steps keep that length and come further apart in time. */
    least: number;
    /** Setting off, the pose is all the walk's from this pace up and all the standing one at rest, the smoothest way between, metres a second. */
    full: number;
    /** Coming to rest, the pose stays the walk's until the foot behind leaves to come beside the other (or, with no time for that, until the last foot is down), then goes over to the standing one in so long, seconds. */
    settleTime: number;
    /** Once at rest the foot behind is stepped beside the other: how long after the body stops it leaves, and how long the step takes, seconds. */
    close: [number, number];
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
    /** Setting off another way than it faces: how long the body takes to come round, seconds; how much of the angle the first foot still lands turned toward where it stood; how much of the body's turn the foot that stays swivels before it leaves. */
    turnTime: number;
    landTurn: number;
    swivel: number;
    /** A knee points between where its foot points and where the body faces: the share of the way to the body. */
    kneeFollow: number;
    /** A foot left behind keeps its knee bent by this as its heel rises, degrees. */
    pushKnee: number;
    /**
     * Where the way bends: the hips lean into the bend by this share of hip height for each g of sideways pull, and the
     * footfalls are set in from the walk's line by these shares of hip height (the inner foot, the outer) for each radian
     * the way turns in a stride (the one formula's turning walk: locomotion.ts LOCO_STYLE.turning).
     */
    bank: number;
    track: [number, number];
    /** Walking, the hips ride this share of hip height lower than the walk's own: room for the legs where the hips lean or the feet are set in. */
    sink: number;
}

export const ALONG_STYLE: AlongStyle = { bank: 0.35, track: [0.038, -0.025], sink: 0, least: 0.3, full: 1, settleTime: 0.6, settle: 0.05, close: [0.05, 0.5], closeMost: 0.3, ahead: 0.4, turnTime: 1, landTurn: 0.15, swivel: 0.2, kneeFollow: 0.5, pushKnee: 16 };

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
 * not the stance's own: the end of a turn); none: about where it stands, facing its way. `end`: the stance it ends in,
 * if it comes to rest at the end.
 */
export function walkAlong(
    body: Body, path: (t: number) => V3, seconds: number,
    style: AlongStyle = ALONG_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, turnStyle: TurnStyle = TURN_STYLE, fps = 60,
    begin?: { pivot: V3; heading: number; stand?: GaitFrame },
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
    const V = S.map((_, k) => (S[Math.min(n, k + 1)] - S[Math.max(0, k - 1)]) / ((Math.min(n, k + 1) - Math.max(0, k - 1)) * dt));
    const at = (list: number[], t: number) => { const u = clamp(t / dt, 0, n), k = Math.min(n - 1, Math.floor(u)); return list[k] + (list[k + 1] - list[k]) * (u - k); };
    // The way by distance: where along it, and which way it goes (from the stretches that move; straight on past its ends).
    const knots: { s: number; at: V3; heading: number }[] = [];
    let last = 0, anchor = 0;
    for (let k = 1; k <= n; k++) {
        // (A knot every 5 mm of the way at least: over less, the points' own rounding turns the way about.)
        const d = sub(P[k], P[anchor]);
        if (length(d) < 0.005) continue;
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
    const walks = new Map<number, Gait>();
    const walkAt = (v: number) => {
        const key = Math.round(Math.max(v, style.least) * 200);
        let w = walks.get(key);
        if (!w) { w = gaitFor(body, key / 200, gaitStyle); walks.set(key, w); }
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
    const stays = turnBy > 5 * DEG ? 1 : 0, steps = 1 - stays;
    const g0 = walkAt(0);
    const ahead0 = dot(sub(firstPair[stays].at, way(0).at), along(body, way(0).heading));
    const phase0 = 0.5 * stays + style.settle + clamp((g0.lead - ahead0) / strideOf(g0), 0, 0.4);
    // The phase by distance.
    const inc = S.map((s, k) => (k < n ? (S[k + 1] - s) / strideOf(walkAt(V[k])) : 0));
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
    let from = 0;
    const stops: { at: number; until: number; strike: number }[] = [];
    for (const [a, b] of rests) {
        // Where the braking begins (going back from the stop, as long as the pace was higher before), and a little before that.
        let brakes = a;
        while (brakes > from + 1 && V[brakes - 1] > V[brakes] + 1e-9) brakes--;
        const w0 = Math.max(from, brakes - Math.round(style.ahead / dt));
        for (let k = phases.length; k <= w0; k++) phases.push(phases[k - 1] + inc[k - 1]);
        // At the cadence it had there, by time, it would be so far into the walk at the stop; bent to the nearest strike
        // (the next one where the nearest would slow the feet too far).
        const start = phases[w0], cadence = inc[w0] / dt, T = Math.max(dt, (a - w0) * dt);
        const natural = start + cadence * T;
        const bendFor = (m: number) => m / 2 + settle - natural;
        /** Where the foot before the last comes down, against where the body stops (how far the foot behind is from its stance). */
        const behindBy = (m: number) => {
            const p = (m - 1) / 2;
            let k = w0;
            if (p < start) { while (k > 0 && phases[k] > p) k--; } else while (k < a && start + cadence * (k - w0) * dt + bendFor(m) * minJerk(((k - w0) * dt) / T) < p) k++;
            return S[a] - (S[k] + walkAt(V[k]).lead);
        };
        let m = Math.round((natural - settle) * 2);
        if (cadence + (bendFor(m) * 1.875) / T < 0.4 * cadence) m += 1;
        // One more step while the foot behind would be dragged far (but the steps no more than two and a half times as quick).
        while (behindBy(m) > style.closeMost && cadence + (bendFor(m + 1) * 1.875) / T <= 2.5 * cadence) m += 1;
        const bend = bendFor(m);
        for (let k = w0 + 1; k <= a; k++) { const tau = (k - w0) * dt; phases.push(start + cadence * tau + bend * minJerk(tau / T)); }
        for (let k = a + 1; k <= b; k++) phases.push(phases[k - 1]);
        stops.push({ at: a * dt, until: b * dt, strike: m });
        from = b;
    }
    for (let k = phases.length; k <= n; k++) phases.push(phases[k - 1] + inc[k - 1]);
    const phase = (t: number) => at(phases, t);
    const timeOf = (p: number) => {
        if (p <= phases[0]) return -Infinity;
        if (p > phases[n]) return Infinity;
        let lo = 0, hi = n;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (phases[mid] < p) lo = mid; else hi = mid; }
        const u = (p - phases[lo]) / Math.max(1e-12, phases[hi] - phases[lo]);
        return (lo + clamp(u, 0, 1)) * dt;
    };
    const travelled = (t: number) => at(S, t);
    const paceAt = (t: number) => at(V, t);
    /** How fast the way turns where the body is, radians a metre (to the left above zero). */
    const bendAt = (s: number) => (way(s + 0.1).heading - way(s - 0.1).heading) / 0.2;

    // Where the feet stand: the walk's footfalls along the way, each as far ahead of where the body is as it strikes as
    // that time's walk has it, to its side of the way, pointing along it.
    const footfall = (foot: number, cycle: number): Hold => {
        const strike = cycle + 0.5 * foot;
        const on = timeOf(strike);
        const g = walkAt(paceAt(clamp(on, 0, seconds)));
        const off = timeOf(strike + g.duty);
        const s = travelled(clamp(on, 0, seconds)) + g.lead;
        const here = way(s);
        const across = rotate(axisAngle(up, here.heading), left);
        // (Where the way bends, set in from the walk's line: the inner foot by track[0], the outer by track[1].)
        const turns = bendAt(s) * strideOf(g), inner = turns >= 0 ? 0 : 1;
        const setIn = turns * style.track[foot === inner ? 0 : 1] * body.hipHeight;
        return { on, off, stand: { at: add(here.at, scale(across, ((foot ? -1 : 1) * g.width) / 2 + setIn)), heading: here.heading + (foot ? -1 : 1) * g.toeOut }, cycle, own: false, along: s };
    };
    const holds: [Hold[], Hold[]] = [[], []];
    const top = Math.ceil(phases[n]) + 1;
    for (let foot = 0; foot < 2; foot++) for (let cycle = 0; cycle <= top; cycle++) {
        const hold = footfall(foot, cycle);
        if (hold.off > 0 && hold.on < seconds) holds[foot].push(hold);
    }
    // Standing, the hips are over the stance, not over where the body's way is: from the start, or, coming to rest, as
    // the foot behind is set beside the other (till then they stay between the two feet); setting off, back over the way.
    const leans: { from: number; to: number; by: V3; close?: [number, number]; until?: number }[] = [];
    const leanOver = (pivot: V3, t: number, from: number, to: number, close?: [number, number], until?: number) => {
        leans.push({ from, to, by: sub(flat(pivot), flat(way(travelled(t)).at)), close, until });
    };
    const firstMove = (() => { let k = 0; while (k < n && V[k] < 1e-3) k++; return k * dt; })();
    /** When the walk next has all the pose's weight after a time. */
    const fullAfter = (t: number) => { let k = Math.ceil(t / dt); while (k < n && V[k] < style.full) k++; return k * dt; };
    /** How far the body has come round to its way, setting off: 0 to 1. */
    const turnedBy = (t: number) => minJerk((t - firstMove) / Math.max(1e-3, style.turnTime));
    // The foot that stays, swivelling with the body until it leaves; the one that steps, from beside it, its first footfall
    // still turned partly toward where it stood.
    holds[stays][0] = { ...holds[stays][0], on: -Infinity, stand: firstPair[stays], own: true, swivel: (t) => style.swivel * turnBy * turnedBy(t) };
    holds[steps] = holds[steps].filter((x) => x.cycle === null || x.cycle + 0.5 * steps > phase0);
    if (holds[steps].length) holds[steps][0] = { ...holds[steps][0], stand: { ...holds[steps][0].stand, heading: holds[steps][0].stand.heading - style.landTurn * turnBy } };
    holds[steps].unshift({ on: -Infinity, off: firstMove, stand: firstPair[steps], cycle: null, own: true });
    leanOver(startPivot, 0, -Infinity, fullAfter(firstMove));
    let end: { pivot: V3; heading: number } | null = null;
    // Each stop: the foot that struck last stands on; the one behind is set beside it, where the stance has it. Until that
    // foot behind leaves the body walks (a body already standing up could not reach the last footfall), then it stands up.
    const settles: [number, number][] = [];
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
        // (It is flat by the time the body stops, and stays as the walk has it then: it does not move again.)
        holds[struck][front] = { ...holds[struck][front], stand: pair[struck] };
        // Then the foot behind is stepped beside it, where the stance has it. The pose stays the walk's until that foot leaves
        // (a body already standing up could not reach the last footfall), then it stands up over where it stopped.
        // (It leaves when the walk has it leave, or soon after the body stops; it stands there until the body sets off again.)
        const was = holds[behind][back];
        const leave = Math.min(was.off, stop.at + style.close[0]), land = leave + style.close[1];
        const setsOff = timeOf(stop.strike / 2 + settle + 1e-6);
        let slowing = Math.floor(stop.at / dt);
        while (slowing > 0 && V[slowing] < style.full) slowing--;
        if (land < stop.until) {
            holds[behind].splice(back, 1, { ...was, off: leave }, { on: land, off: setsOff, stand: pair[behind], cycle: null, own: true });
            settles.push([slowing * dt, Math.max(slowing * dt, leave)]);
            end = { pivot, heading: here.heading };
        } else {
            settles.push([slowing * dt, Math.max(slowing * dt, holds[struck][front].on)]);
            end = null;
        }
    }
    const comeRound = firstMove + style.turnTime;
    const blend = (t: number) => {
        let w = minJerk(clamp(paceAt(t) / Math.max(1e-3, style.full), 0, 1));
        for (const [from, landed] of settles) if (t >= from) w = Math.max(w, t <= landed ? 1 : 1 - minJerk((t - landed) / Math.max(1e-3, style.settleTime)));
        return w;
    };
    const plan: CarryPlan = {
        seconds, gait: walkAt(Math.max(...V)), gaitAt: (t) => walkAt(paceAt(t)), origin, way, travelled, phase, blend,
        // Standing at first the body faces as its stance does; setting off, it comes round to its way.
        facing: (t) => (t < comeRound ? -turnBy * (1 - turnedBy(t)) : 0),
        stand: begin?.stand ?? standFrame(body, turnStyle),
        holds,
        kneeFollow: style.kneeFollow, standKnee: turnStyle.kneeFollow, placeLift: turnStyle.lift, heel: turnStyle.heel,
        bow: () => 0, headBow: 0,
        lean: (t) => {
            // Into the bend, by the sideways pull there (v² times how fast the way turns a metre).
            const gone = travelled(t), v = paceAt(t);
            const into = add(scale(rotate(axisAngle(up, way(gone).heading), left), style.bank * body.hipHeight * ((v * v * bendAt(gone)) / 9.81)), scale(up, -style.sink * body.hipHeight * blend(t)));
            const near = leans.find((l) => t >= l.from && t <= l.to);
            if (!near) return into;
            const share = near.close && t < near.close[1] ? minJerk((t - near.close[0]) / Math.max(1e-3, near.close[1] - near.close[0]))
                : near.until !== undefined && t < near.until ? 1 : 1 - blend(t);
            return add(into, scale(near.by, share));
        },
        pushKnee: style.pushKnee * DEG,
        rollOwn: true,
    };
    const restsAtEnd = stops.length > 0 && stops[stops.length - 1].until >= n * dt - 1e-9;
    return { plan, frames: carryFrames(body, plan, gaitStyle, fps), end: restsAtEnd ? end : null };
}
