// What a motion formula needs to know about a body, measured from the model's
// skeleton: its axes, the lengths of its legs and arms, how high the ankle
// stands over the floor, where the sole touches the ground. Every length a
// gait uses is a ratio of these, so one set of numbers walks any body.
//
// The canonical skeleton is the same body with plain axes: the model's
// humanoid joints where they are in the reference pose (arms out level, legs
// straight down: core/retarget.ts retargetPose), every bone unturned. A
// formula writes world turns from that pose on it, and core/retarget.ts
// copies them onto the model's own bones, whatever their axes.

import { guessHumanoid } from '../humanoid';
import { parentsFirst, retargetPose, worldPose, type SkeletonBone } from '../retarget';
import { cross, dot, normalize, qinv, qmul, qnormalize, sub, type Quat, type V3 } from '../rigMotion';

/** Where the sole meets the ground, from the ankle along the foot's own forward, metres. */
export interface Sole {
    /** The back end of the heel (negative: behind the ankle). */
    heel: number;
    /** Where toes that bend begin (the ball of the foot). */
    ball: number;
    /** The front end. */
    tip: number;
    /** Half its width, from the line of the foot out to each side. */
    half: number;
    /**
     * The sole seen from the side, where it is known (the mesh: motionGen/mesh.ts): the points
     * a flat floor touches as the foot rolls on it, from behind the heel to the front, each
     * [along the foot from the ankle, over the floor with the foot flat]. Without it the foot
     * stands flat from `heel` to its front and turns on those two points.
     */
    outline?: [number, number][];
}

/**
 * A body's joints: how far they go and where they rest, degrees. A human's unless the body
 * says otherwise. (The formulas ask the body, not the style, what a joint can do.)
 */
export interface Joints {
    /** The most the shin leans forward over the foot (the ankle bent up): past it the heel has to come off the floor. A human's is about 20. */
    ankleUp: number;
    /** How far the toes hang down from a relaxed ankle: a foot's in the air. */
    ankleRest: number;
    /** The most that toes bend back. */
    toesBack: number;
}

export const HUMAN_JOINTS: Joints = { ankleUp: 18, ankleRest: 20, toesBack: 60 };

export interface Body {
    /** Unit axes of the model standing at rest. */
    left: V3;
    up: V3;
    fwd: V3;
    /** Bone index by humanoid role. */
    roles: Record<string, number>;
    /** Where each role's joint is in the reference pose, model space. */
    ref: Record<string, V3>;
    /** The floor's height in model space. */
    floor: number;
    /** Hip sockets over the floor standing; thigh, shin and their sum (hip to ankle). */
    hipHeight: number;
    thigh: number;
    shin: number;
    leg: number;
    /** The ankle over the floor standing. */
    ankleHeight: number;
    /** Each foot's heading at rest, as a turn about up from forward (positive toward the left): left foot, right foot. */
    footYaw: [number, number];
    sole: Sole;
    /** Toes that do not bend (a stiff boot): the foot rolls over its tip instead of its ball. */
    stiffToes: boolean;
    joints: Joints;
    /** The centre of mass over hip height, standing: a human's is a little above the hip joints. */
    massHeight: number;
}

export interface BodyOptions {
    /** Bone index by humanoid role; guessed from the names by default. */
    roles?: Record<string, number>;
    /** Sole contact measured elsewhere (the mesh: motionGen/mesh.ts); else from the foot's proportions. */
    sole?: Partial<Sole>;
    stiffToes?: boolean;
    floor?: number;
    joints?: Partial<Joints>;
    massHeight?: number;
}

const NEEDED = [
    'hips', 'head',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
];

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The pose the formulas' turns are measured from, as local rotations by bone: the
 * reference pose of core/retarget.ts (arms out level, legs straight down), but each
 * foot turned as it stands at rest, flat on the floor. Straightening a leg that rests
 * a little bent or apart would otherwise tip its foot with it.
 */
export function gaitReference(skeleton: SkeletonBone[], roles: Record<string, number>): Quat[] {
    const order = parentsFirst(skeleton);
    const T = skeleton.map((b) => b.translation);
    const local = retargetPose(skeleton, roles);
    const rest = worldPose(skeleton, order, T, skeleton.map((b) => b.rotation)).r as Quat[];
    const ref = worldPose(skeleton, order, T, local).r as Quat[];
    for (const role of ['leftFoot', 'rightFoot']) {
        const foot = roles[role];
        if (foot === undefined) continue;
        const parent = skeleton[foot].parent;
        local[foot] = qnormalize(parent >= 0 ? qmul(qinv(ref[parent]), rest[foot]) : rest[foot]);
    }
    return local;
}

/** Measures a humanoid skeleton (standing at its rest pose, feet on the floor). */
export function measureBody(skeleton: SkeletonBone[], options: BodyOptions = {}): Body {
    const roles = options.roles ?? guessHumanoid(skeleton).bones;
    for (const r of NEEDED) if (roles[r] === undefined) throw new Error(`no ${r} bone: not a body these formulas can move`);
    const order = parentsFirst(skeleton);
    const T = skeleton.map((b) => b.translation);
    const rest = worldPose(skeleton, order, T, skeleton.map((b) => b.rotation)).p as V3[];
    const refPose = worldPose(skeleton, order, T, gaitReference(skeleton, roles)).p as V3[];
    const at = (role: string) => rest[roles[role]];

    const up: V3 = [0, 1, 0];
    const across = sub(at('leftUpperLeg'), at('rightUpperLeg'));
    const left = normalize([across[0], 0, across[2]], [1, 0, 0]);
    const fwd = cross(left, up);
    const floor = options.floor ?? 0;

    const mean = (a: string, b: string, f: (role: string) => number) => (f(a) + f(b)) / 2;
    const thigh = mean('leftUpperLeg', 'rightUpperLeg', (r) => dist(at(r), at(r.replace('Upper', 'Lower'))));
    const shin = mean('leftLowerLeg', 'rightLowerLeg', (r) => dist(at(r), at(r.replace('LowerLeg', 'Foot'))));
    const ankleHeight = mean('leftFoot', 'rightFoot', (r) => at(r)[1]) - floor;
    const hipHeight = mean('leftUpperLeg', 'rightUpperLeg', (r) => at(r)[1]) - floor;

    // The foot's own forward: to its toe joint, flat on the floor; else the body's.
    const heading = (side: 'left' | 'right'): { yaw: number; reach: number } => {
        const toes = roles[`${side}Toes`];
        if (toes === undefined) return { yaw: 0, reach: 0 };
        const d = sub(rest[toes], at(`${side}Foot`));
        const f = dot(d, fwd), l = dot(d, left);
        return { yaw: Math.atan2(l, f), reach: Math.hypot(f, l) };
    };
    const hl = heading('left'), hr = heading('right');
    const reach = (hl.reach + hr.reach) / 2;
    // Without a measured sole: a foot's usual proportions around the ankle and the toe joint
    // (heel end about a quarter of the foot's length behind the ankle, toes about three tenths).
    const ball = options.sole?.ball ?? (reach > 0.02 ? reach : 0.45 * ankleHeight + 0.08);
    const sole: Sole = {
        ball,
        heel: options.sole?.heel ?? -0.48 * ball,
        tip: options.sole?.tip ?? 1.6 * ball,
        // (A foot is about a third as wide as it is long.)
        half: options.sole?.half ?? 0.18 * ((options.sole?.tip ?? 1.6 * ball) - (options.sole?.heel ?? -0.48 * ball)),
        ...(options.sole?.outline && options.sole.outline.length >= 2 ? { outline: options.sole.outline } : {}),
    };

    const ref: Record<string, V3> = {};
    for (const [role, i] of Object.entries(roles)) ref[role] = refPose[i];
    return {
        left, up, fwd, roles, ref, floor,
        hipHeight, thigh, shin, leg: thigh + shin, ankleHeight,
        footYaw: [hl.yaw, hr.yaw],
        sole,
        stiffToes: options.stiffToes ?? false,
        joints: { ...HUMAN_JOINTS, ...options.joints },
        massHeight: options.massHeight ?? 1.06,
    };
}

/** The roles a gait writes, parents before children. */
export const GAIT_ROLES = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
] as const;

export interface Canonical {
    bones: SkeletonBone[];
    /** Canonical bone index by role. */
    index: Record<string, number>;
    /** Each canonical bone's role, and its parent's role (null for the hips). */
    roles: string[];
    parents: (string | null)[];
}

/**
 * The body's humanoid joints as a skeleton with plain axes: each joint where the
 * model has it in the reference pose, no bone turned, a role under the nearest
 * role above it in the model.
 */
export function canonicalSkeleton(skeleton: SkeletonBone[], body: Body): Canonical {
    const present = GAIT_ROLES.filter((r) => body.roles[r] !== undefined);
    const roleOfBone = new Map<number, string>(present.map((r) => [body.roles[r], r]));
    const index: Record<string, number> = {};
    present.forEach((r, i) => (index[r] = i));
    const parents: (string | null)[] = present.map((r) => {
        for (let p = skeleton[body.roles[r]].parent, guard = 0; p >= 0 && guard < skeleton.length; p = skeleton[p].parent, guard++) {
            const role = roleOfBone.get(p);
            if (role !== undefined) return role;
        }
        return null;
    });
    const bones: SkeletonBone[] = present.map((r, i) => {
        const parent = parents[i];
        const p = body.ref[r];
        const from: V3 = parent ? body.ref[parent] : [0, 0, 0];
        return { name: r, parent: parent ? index[parent] : -1, translation: [p[0] - from[0], p[1] - from[1], p[2] - from[2]], rotation: [0, 0, 0, 1] };
    });
    return { bones, index, roles: [...present], parents };
}
