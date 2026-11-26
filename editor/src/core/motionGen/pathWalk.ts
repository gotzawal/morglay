// A walk made for a model from a path: where its capsule goes over the floor and when (a path file,
// core/motionPath.ts). The model's body is measured from its own skeleton (and its mesh, for the
// sole), the motion formulas walk the path on that body (locomotion.ts locoPath), and the frames
// become a clip on the model's bones. Nothing is played from a stored clip: a path and a model are
// all it takes, so any humanoid walks the same path. The editor makes these clips when it loads a
// model whose animation names a path (core/clipSources.ts); the model's file is never changed.
//
// The formulas and what they do on a path: editor/MOTION.md (section 1.1).

import { guessHumanoid } from '../humanoid';
import type { MotionPath } from '../motionPath';
import { parentsFirst, readGlbClips, stillBones, worldPose, type Clip, type Vec3 } from '../retarget';
import { clipOntoModel, framesToClipOnce } from './bake';
import { canonicalSkeleton, measureBody, type Body, type Canonical } from './body';
import { ALONG_STYLE } from './carry';
import { GAIT_STYLE } from './gait';
import { LOCO_STYLE, locoPath } from './locomotion';
import { skinnedPoints, soleFromMesh } from './mesh';

/** A model's GLB as read for its clips (core/retarget.ts readGlbClips). */
export type GlbModel = NonNullable<ReturnType<typeof readGlbClips>>;

/** A model measured for walking: its skeleton and clips, its body, and the plain skeleton the formulas pose. */
export interface Walker {
    model: GlbModel;
    body: Body;
    canon: Canonical;
}

/** A walk made on a model. */
export interface WalkMade {
    /** The model's GLB with the walk added as a clip (a copy: the bytes given are not changed). */
    glb: Uint8Array;
    /** The clip's name, and how long it is, seconds. */
    name: string;
    seconds: number;
}

/**
 * Measures the body of the model in `glb` (a humanoid with a skeleton: a VRM, a GLB): its lengths from the
 * skeleton, its sole from the mesh where it has one, and a stiff toe where its own clips never bend it.
 * Throws where the model is not a GLB or has no humanoid legs to walk on.
 */
export function walkerOf(glb: ArrayBuffer, model: GlbModel | null = readGlbClips(glb)): Walker {
    if (!model) throw new Error('the model is not a GLB');
    const roles = guessHumanoid(model.skeleton).bones as Record<string, number>;
    for (const r of ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']) if (roles[r] === undefined) throw new Error(`the model has no ${r} to walk on`);
    const still = stillBones(model.skeleton, model.clips);
    const stiffToes = roles.leftToes !== undefined && still.has(roles.leftToes) && still.has(roles.rightToes);
    let body = measureBody(model.skeleton, { roles, stiffToes });
    const rest = worldPose(model.skeleton, parentsFirst(model.skeleton), model.skeleton.map((b) => b.translation), model.skeleton.map((b) => b.rotation)).p;
    const points = skinnedPoints(glb);
    const sole = points ? soleFromMesh(points, model.skeleton, body, [rest[roles.leftFoot], rest[roles.rightFoot]]) : null;
    if (sole) body = measureBody(model.skeleton, { roles, stiffToes, sole: sole.sole, floor: sole.floor });
    return { model, body, canon: canonicalSkeleton(model.skeleton, body) };
}

/** The path as the body's: a point of the floor in the model's space at a time ([left, ahead] along the body's own left and forward). */
export function pathOnBody(path: MotionPath, body: Pick<Body, 'left' | 'fwd' | 'leg'>): (t: number) => Vec3 {
    // A body takes a corner over about a step: the way its centre goes is the drawn path with every corner rounded, each
    // point the mean of the path over a leg's length (about a step) to either side of it (along the path; within its ends, or round
    // again when it is closed), weighted to fade toward the ends of that reach so that the rounded way is smooth (an even
    // mean of a few points would be a polygon, turning a little each time one of them passes the corner). Where the path
    // is smooth on that scale, the way is the path itself. A corner where the body comes to rest is not walked through: it
    // walks straight into its stop along the way it came, and sets off from it along the way it goes (turning as it sets
    // off). So the reach shrinks to nothing at a rest, as at an open path's ends.
    // (Worked out once along the path every 5 mm: the weighted mean over the reach is a sum along those points, and the
    // way between them is read on the line from one to the next.)
    const reach = body.leg, step = 0.005;
    const count = Math.max(1, Math.ceil(path.length / step)), h = path.length / count, K = Math.max(1, Math.round(reach / h));
    const raw = Array.from({ length: count + 1 }, (_, i) => path.at(i * h));
    const weight = Array.from({ length: K + 1 }, (_, j) => 0.5 * (1 + Math.cos((Math.PI * j) / (K + 1))));
    // (Where it rests, in steps of the table; and how many steps a point is from the nearest, round again when closed.)
    const rests = path.rests.map((d) => d / h);
    const fromRest = (i: number) => rests.reduce((most, r) => { const d = Math.abs(i - r); return Math.min(most, Math.floor(path.closed ? Math.min(d, count - d) : d)); }, Infinity);
    const table = raw.map((_, i) => {
        // (An open path's ends are where the body sets off and comes to rest: nearer them, the reach shrinks to nothing; and
        // so nearer a rest.)
        const k = Math.min(path.closed ? K : Math.min(K, i, count - i), fromRest(i));
        let x = 0, z = 0, sum = 0;
        for (let j = -k; j <= k; j++) {
            const w = weight[Math.abs(j)], p = raw[path.closed ? (((i + j) % count) + count) % count : i + j];
            x += w * p[0]; z += w * p[1]; sum += w;
        }
        return [x / sum, z / sum] as [number, number];
    });
    const rounded = (d: number): [number, number] => {
        let u = d / h;
        if (path.closed) u = ((u % count) + count) % count; else u = Math.min(count, Math.max(0, u));
        const i = Math.min(count - 1, Math.floor(u)), f2 = u - i, a = table[i], b = table[i + 1];
        return [a[0] + (b[0] - a[0]) * f2, a[1] + (b[1] - a[1]) * f2];
    };
    return (t: number) => {
        const [left, ahead] = rounded(path.distance(t));
        return [body.left[0] * left + body.fwd[0] * ahead, body.left[1] * left + body.fwd[1] * ahead, body.left[2] * left + body.fwd[2] * ahead];
    };
}

/** Where the capsule is, sampled: a point every 1/`hz` second as [left, ahead] metres (the walk files before path files; tools still write them). */
export interface Trail {
    hz: number;
    points: [number, number][];
}

/**
 * A walk along `path` as a clip called `name` on the walker's bones, a key every 1/`fps` second. It lasts
 * the path's timing, and longer where a turn on the spot takes more than the rest before it. The body stands at
 * first where the path begins, facing ahead as the path file has it (its z), and sets off turning to its way; a
 * closed path ends facing as it began, so its clip closes on itself.
 */
export function walkClip(walker: Walker, path: MotionPath, name = 'Walk Path', fps = 60): { clip: Clip; seconds: number } {
    const { model, body, canon } = walker;
    // (Headings as the way's are counted: 0 along the body's forward, which the file's ahead is laid on.)
    const startHeading = 0, endHeading = path.closed ? startHeading : undefined;
    const frames = locoPath(body, pathOnBody(path, body), path.duration, LOCO_STYLE, ALONG_STYLE, GAIT_STYLE, fps, undefined, undefined, undefined, undefined, undefined, endHeading, startHeading);
    const onto = clipOntoModel(model, body, canon, framesToClipOnce(canon, frames, name));
    return { clip: onto.clip, seconds: frames[frames.length - 1].time };
}

/**
 * The path drawn on the floor: a ribbon `width` metres wide a little over it, a point every 2 cm along it,
 * as the positions (x, y, z, two a point) and triangles of a mesh. The path's [left, ahead] are the editor's
 * x and z, a character facing +z at the origin.
 */
export function pathRibbon(path: MotionPath, width = 0.04, lift = 0.004): { positions: Float32Array; indices: Uint32Array } {
    const steps = Math.max(2, Math.ceil(path.length / 0.02));
    const positions = new Float32Array((steps + 1) * 6), indices = new Uint32Array(steps * 6);
    for (let i = 0; i <= steps; i++) {
        const s = (path.length * i) / steps;
        const [x, z] = path.at(s), [dx, dz] = path.direction(s);
        positions.set([x - dz * (width / 2), lift, z + dx * (width / 2), x + dz * (width / 2), lift, z - dx * (width / 2)], i * 6);
        if (i > 0) indices.set([2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i], (i - 1) * 6);
    }
    return { positions, indices };
}
