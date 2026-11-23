// A walk made for a model from a trail: where its capsule goes over time. The model's body is measured from its own
// skeleton (and its mesh, for the sole), the motion formulas walk the trail on that body (locomotion.ts locoPath), and the
// frames become a clip written into a copy of the model's GLB. Nothing is played from a stored clip: a trail and a model
// are all it takes, so any humanoid walks the same path.
//
// The formulas and what they do on a path: editor/MOTION.md (section 1.1).

import { appendAnimations } from '../clipImport';
import { guessHumanoid } from '../humanoid';
import { parentsFirst, readGlbClips, stillBones, worldPose, type Vec3 } from '../retarget';
import { clipOntoModel, framesToClipOnce } from './bake';
import { canonicalSkeleton, measureBody, type Body } from './body';
import { ALONG_STYLE } from './carry';
import { GAIT_STYLE } from './gait';
import { LOCO_STYLE, locoPath } from './locomotion';
import { skinnedPoints, soleFromMesh } from './mesh';

/**
 * Where the capsule is over the floor at a time: a point every 1/`hz` of a second, in metres as [to the left, ahead]
 * of where it begins, the body facing ahead at first. It rests where it stays put, and sets off again.
 */
export interface Trail {
    hz: number;
    points: [number, number][];
    /** Degrees to the left of where it began facing: it turns on the spot to face this way after its last stop (0: as it began). None: it stays as it stopped. */
    endHeading?: number;
}

/** A walk made on a model. */
export interface WalkMade {
    /** The model's GLB with the walk added as a clip. */
    glb: Uint8Array;
    /** The clip's name, and how long it is, seconds. */
    name: string;
    seconds: number;
}

/** The trail as a path of the body: a point of the floor in the model's space at a time, between the samples as a line. */
export function trailPath(trail: Trail, body: Pick<Body, 'left' | 'fwd'>): (t: number) => Vec3 {
    const n = trail.points.length - 1;
    return (t: number) => {
        const u = Math.min(n, Math.max(0, t * trail.hz)), k = Math.min(n - 1, Math.floor(u)), f = u - k;
        const a = trail.points[k], b = trail.points[Math.min(n, k + 1)];
        const left = a[0] + (b[0] - a[0]) * f, ahead = a[1] + (b[1] - a[1]) * f;
        return [body.left[0] * left + body.fwd[0] * ahead, body.left[1] * left + body.fwd[1] * ahead, body.left[2] * left + body.fwd[2] * ahead];
    };
}

/**
 * A walk along `trail` on the model in `glb` (a humanoid with a skeleton: a VRM, a GLB), added to a copy of it as a clip
 * called `name`. Throws where the model is not a GLB or has no humanoid legs to walk on.
 */
export function walkOnModel(glb: ArrayBuffer, trail: Trail, name = 'Walk Path', fps = 60): WalkMade {
    const model = readGlbClips(glb);
    if (!model) throw new Error('the model is not a GLB');
    const roles = guessHumanoid(model.skeleton).bones as Record<string, number>;
    for (const r of ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']) if (roles[r] === undefined) throw new Error(`the model has no ${r} to walk on`);
    // The body: its lengths from the skeleton, its sole from the mesh where it has one, and a stiff toe where its own clips never bend it.
    const still = stillBones(model.skeleton, model.clips);
    const stiffToes = roles.leftToes !== undefined && still.has(roles.leftToes) && still.has(roles.rightToes);
    let body = measureBody(model.skeleton, { roles, stiffToes });
    const rest = worldPose(model.skeleton, parentsFirst(model.skeleton), model.skeleton.map((b) => b.translation), model.skeleton.map((b) => b.rotation)).p;
    const points = skinnedPoints(glb);
    const sole = points ? soleFromMesh(points, model.skeleton, body, [rest[roles.leftFoot], rest[roles.rightFoot]]) : null;
    if (sole) body = measureBody(model.skeleton, { roles, stiffToes, sole: sole.sole, floor: sole.floor });
    const canon = canonicalSkeleton(model.skeleton, body);

    const seconds = (trail.points.length - 1) / trail.hz;
    const frames = locoPath(body, trailPath(trail, body), seconds, LOCO_STYLE, ALONG_STYLE, GAIT_STYLE, fps, undefined, undefined, undefined, undefined, undefined, trail.endHeading === undefined ? undefined : (trail.endHeading * Math.PI) / 180);
    const onto = clipOntoModel(model, body, canon, framesToClipOnce(canon, frames, name));
    return { glb: appendAnimations(new Uint8Array(glb), [onto.clip]), name, seconds: frames[frames.length - 1].time };
}

/**
 * The trail drawn on the floor: a ribbon `width` metres wide a little over it, a point every 2 cm of the trail, as a GLB
 * (unlit orange, both faces). The trail's [left, ahead] are the editor's x and z, a character facing +z at the origin.
 */
export function trailRibbon(trail: Trail, width = 0.04, lift = 0.004): Uint8Array {
    const pts: [number, number][] = [];
    for (const p of trail.points) {
        const q = pts[pts.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.02) pts.push(p);
    }
    const pos = new Float32Array(pts.length * 6), idx: number[] = [];
    pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        pos.set([p[0] - dz * (width / 2), lift, p[1] + dx * (width / 2), p[0] + dz * (width / 2), lift, p[1] - dx * (width / 2)], i * 6);
        if (i > 0) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    });
    const ind = Uint32Array.from(idx);
    const range = (c: number) => { let lo = Infinity, hi = -Infinity; for (let i = c; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); } return [lo, hi]; };
    const mins = [0, 1, 2].map((c) => range(c)[0]), maxs = [0, 1, 2].map((c) => range(c)[1]);
    const data = new Uint8Array(pos.byteLength + ind.byteLength);
    data.set(new Uint8Array(pos.buffer), 0);
    data.set(new Uint8Array(ind.buffer), pos.byteLength);
    const gltf = {
        asset: { version: '2.0', generator: 'morglay walk path' },
        extensionsUsed: ['KHR_materials_unlit'],
        scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'walk-path', mesh: 0 }],
        meshes: [{ name: 'walk-path', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
        materials: [{ name: 'path', pbrMetallicRoughness: { baseColorFactor: [1, 0.45, 0.1, 1], metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} }, doubleSided: true }],
        buffers: [{ byteLength: data.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: pos.byteLength, byteLength: ind.byteLength, target: 34963 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mins, max: maxs }, { bufferView: 1, componentType: 5125, count: ind.length, type: 'SCALAR' }],
    };
    const text = new TextEncoder().encode(JSON.stringify(gltf));
    const json = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
    json.set(text);
    const bin = new Uint8Array(Math.ceil(data.length / 4) * 4);
    bin.set(data);
    const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
    dv.setUint32(20 + json.length, bin.length, true); dv.setUint32(24 + json.length, 0x004e4942, true); out.set(bin, 28 + json.length);
    return out;
}
