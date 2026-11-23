// A generated motion as a clip: first on the canonical skeleton (plain axes,
// the model's own joint places), then on the model's bones.

import { driveHelpers, retargetClip, stillBones, type Clip, type ClipTrack, type Helper, type RetargetPair, type SkeletonBone } from '../retarget';
import { qinv, qmul, qnormalize, type Quat } from '../rigMotion';
import { gaitReference, type Body, type Canonical } from './body';
import type { GaitFrame } from './gait';

/** The frames at the given keys as tracks on the canonical skeleton: every role's turn under its parent's, and the hips' place. */
function tracksOf(canon: Canonical, keys: number, times: Float32Array, frameAt: (k: number) => GaitFrame, hipsAt: (k: number) => ArrayLike<number>): ClipTrack[] {
    const tracks: ClipTrack[] = [];
    canon.roles.forEach((role, bone) => {
        const parent = canon.parents[bone];
        const values = new Float32Array(keys * 4);
        let last: Quat | null = null;
        for (let k = 0; k < keys; k++) {
            const f = frameAt(k);
            const world = f.world[role] ?? (parent ? f.world[parent] : [0, 0, 0, 1]);
            const above: Quat = parent ? f.world[parent] ?? [0, 0, 0, 1] : [0, 0, 0, 1];
            let q = qnormalize(qmul(qinv(above), world));
            if (last && q[0] * last[0] + q[1] * last[1] + q[2] * last[2] + q[3] * last[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
            values.set(q, k * 4);
            last = q;
        }
        tracks.push({ bone, path: 'rotation', times, values });
    });
    const move = new Float32Array(keys * 3);
    for (let k = 0; k < keys; k++) move.set(hipsAt(k), k * 3);
    tracks.push({ bone: canon.index.hips, path: 'translation', times, values: move });
    return tracks;
}

/**
 * The frames of a stride as a clip on the canonical skeleton. It closes on itself:
 * the last key is the first again, one `duration` later. `inPlace` takes the travel off
 * the hips (the character's own movement carries a looping clip).
 */
export function framesToClip(canon: Canonical, body: Body, frames: GaitFrame[], duration: number, name: string, inPlace = true): Clip {
    const keys = frames.length + 1;
    const times = new Float32Array(keys);
    frames.forEach((f, k) => (times[k] = f.time));
    times[keys - 1] = duration;
    const stride = duration * (frames.length > 1 ? (frames[1].travel - frames[0].travel) / (frames[1].time - frames[0].time) : 0);
    const tracks = tracksOf(canon, keys, times, (k) => frames[k % frames.length], (k) => {
        const f = frames[k % frames.length];
        // The closing key is the first frame one stride on.
        const travel = inPlace ? f.travel : k === frames.length ? -stride : 0;
        return [f.hips[0] - body.fwd[0] * travel, f.hips[1] - body.fwd[1] * travel, f.hips[2] - body.fwd[2] * travel];
    });
    return { name, tracks };
}

/**
 * The frames of a motion that is played once (a turn on the spot) as a clip on the canonical
 * skeleton: a key a frame, the hips where the frames have them.
 */
export function framesToClipOnce(canon: Canonical, frames: GaitFrame[], name: string): Clip {
    const times = new Float32Array(frames.length);
    frames.forEach((f, k) => (times[k] = f.time));
    return { name, tracks: tracksOf(canon, frames.length, times, (k) => frames[k], (k) => frames[k].hips) };
}

/**
 * A clip of the canonical skeleton on the model's own bones: every role's world turn from
 * the reference pose copied (core/retarget.ts), then what the model's own clips teach
 * about it: joints they keep still stay still (a stiff boot's toes), helper bones move as
 * they move them. The joints land where the formulas put them, the two skeletons being
 * the same body.
 */
export function clipOntoModel(
    model: { skeleton: SkeletonBone[]; clips: Clip[]; joints?: number[] },
    body: Body,
    canon: Canonical,
    clip: Clip,
): { clip: Clip; held: string[]; helpers: Helper[] } {
    const all: RetargetPair[] = canon.roles.map((role, source) => ({ target: body.roles[role], source }));
    const still = stillBones(model.skeleton, model.clips);
    still.delete(body.roles.hips);
    const pairs = all.filter((p) => !still.has(p.target));
    const copied = retargetClip(canon.bones, clip, model.skeleton, pairs, {
        root: { target: body.roles.hips, source: canon.index.hips },
        scale: 1,
        targetReference: gaitReference(model.skeleton, body.roles),
    });
    const skinned = model.joints?.length ? new Set(model.joints) : undefined;
    // Helpers are the bones that are no humanoid joint at all: a finger or a held toe the
    // formulas leave alone keeps its rest, it is not fitted to its neighbours.
    const joints = new Set([...pairs.map((p) => p.target), ...Object.values(body.roles)]);
    const driven = driveHelpers(model.skeleton, model.clips, copied, joints, skinned);
    return { clip: driven.clip, held: all.filter((p) => still.has(p.target)).map((p) => model.skeleton[p.target].name), helpers: driven.helpers };
}
