// Moves a clip made for one skeleton onto another (retargeting). Each bone of
// the target that stands for a bone of the source turns, in the world, as that
// bone turns away from its own rest pose in the clip; the other bones keep
// their rest place under their parents. The two skeletons may rest
// differently (an MMD model's arms hang lower than a game body's): where a
// pair also names a child of each bone, the target bone is first turned so it
// points where the source bone pointed at rest. Rotations carry over, and the
// root's move (scaled by the two bodies' leg lengths); bone lengths stay the
// target's.
//
// Both skeletons are in glTF's axes (Y up), the character facing the same
// way. The result is baked: one key per key time of the clip, every bone the
// pairs name written as its local rotation, so a player needs no IK or MMD
// inherited rotations to play it.

import { guessHumanoid } from './humanoid';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface SkeletonBone {
    name: string;
    /** Index of the parent bone, -1 for a top bone. */
    parent: number;
    /** Rest pose, relative to the parent. */
    translation: Vec3;
    rotation: Quat;
}

export interface ClipTrack {
    bone: number;
    path: 'translation' | 'rotation';
    times: Float32Array;
    /** Three numbers a key for a translation, four (x y z w) for a rotation. */
    values: Float32Array;
}

export interface Clip {
    name: string;
    tracks: ClipTrack[];
}

export interface RetargetPair {
    target: number;
    source: number;
    /** A child of each, to line the target bone up with the source bone at rest. */
    aim?: { target: number; source: number };
}

export interface RetargetOptions {
    /** The target bone that takes the move of a source bone (an MMD center from the pelvis). */
    root?: { target: number; source: number };
    /** Target size over source size for the move; by default the ratio of the legs, else 1. */
    scale?: number;
    /** The legs measured for the default scale: [hip, ankle] of each. */
    legs?: { target: [number, number]; source: [number, number] };
    /**
     * Target bones that touch the ground (feet, toes): the root's move is lowered or raised
     * by one height for the whole clip, so the lowest of them over the clip is as low as at
     * the target's rest. Legs and feet shaped unlike the source's otherwise float or sink.
     */
    ground?: number[];
    /**
     * Each side's reference pose (local rotations by bone, as retargetPose makes them): the
     * two bodies in the same posture, which the clip's turns are measured from and put on.
     * By default each side's rest pose. A bone the clip leaves out still rests at its rest.
     */
    sourceReference?: Quat[];
    targetReference?: Quat[];
}

// ---------------------------------------------------------------- math

const qmul = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q: Quat): Quat => {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

export function rotate(q: Quat, v: Vec3): Vec3 {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1;
    d *= s;
    if (d > 0.9995) return qnorm([a[0] + (s * b[0] - a[0]) * t, a[1] + (s * b[1] - a[1]) * t, a[2] + (s * b[2] - a[2]) * t, a[3] + (s * b[3] - a[3]) * t]);
    const th = Math.acos(d);
    const k0 = Math.sin((1 - t) * th) / Math.sin(th);
    const k1 = (s * Math.sin(t * th)) / Math.sin(th);
    return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
}

/** The smallest rotation taking direction `u` to direction `v` (both unit). */
export function rotationBetween(u: Vec3, v: Vec3): Quat {
    const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    if (d < -0.999999) {
        // Opposite: half a turn about any axis across u.
        const a: Vec3 = Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [-u[2], 0, u[0]];
        const l = Math.hypot(a[0], a[1], a[2]);
        return [a[0] / l, a[1] / l, a[2] / l, 0];
    }
    return qnorm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0], 1 + d]);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

// ---------------------------------------------------------------- poses

/** Bones in an order where every parent comes before its children. */
export function parentsFirst(bones: SkeletonBone[]): number[] {
    const kids = bones.map(() => [] as number[]);
    const tops: number[] = [];
    bones.forEach((b, i) => (b.parent >= 0 && b.parent < bones.length && b.parent !== i ? kids[b.parent].push(i) : tops.push(i)));
    const order: number[] = [];
    const stack = tops.reverse();
    while (stack.length) {
        const i = stack.pop()!;
        order.push(i);
        for (let k = kids[i].length - 1; k >= 0; k--) stack.push(kids[i][k]);
    }
    return order;
}

export interface WorldPose {
    p: Vec3[];
    r: Quat[];
}

export function worldPose(bones: SkeletonBone[], order: number[], t: Vec3[], r: Quat[]): WorldPose {
    const p = new Array<Vec3>(bones.length);
    const q = new Array<Quat>(bones.length);
    for (const i of order) {
        const parent = bones[i].parent;
        if (parent >= 0 && q[parent]) {
            const o = rotate(q[parent], t[i]);
            p[i] = [p[parent][0] + o[0], p[parent][1] + o[1], p[parent][2] + o[2]];
            q[i] = qnorm(qmul(q[parent], r[i]));
        } else {
            p[i] = t[i];
            q[i] = r[i];
        }
    }
    return { p, r: q };
}

function sampleTrack(tr: ClipTrack, t: number, out: number[]) {
    const n = tr.path === 'rotation' ? 4 : 3;
    const T = tr.times;
    const k = T.length;
    if (k === 0) return false;
    let i = 0;
    if (t <= T[0]) i = 0;
    else if (t >= T[k - 1]) i = k - 1;
    else {
        let lo = 0, hi = k - 1;
        while (hi - lo > 1) {
            const m = (lo + hi) >> 1;
            if (T[m] <= t) lo = m; else hi = m;
        }
        const f = (t - T[lo]) / (T[hi] - T[lo] || 1);
        const a = Array.from(tr.values.subarray(lo * n, lo * n + n));
        const b = Array.from(tr.values.subarray(hi * n, hi * n + n));
        if (n === 4) out.splice(0, 4, ...slerp(a as Quat, b as Quat, f));
        else out.splice(0, 3, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
        return true;
    }
    out.splice(0, n, ...Array.from(tr.values.subarray(i * n, i * n + n)));
    return true;
}

/** Every key time of the clip, in order, nearly equal ones taken once. */
function keyTimes(clip: Clip): number[] {
    const all = clip.tracks.flatMap((t) => Array.from(t.times)).sort((a, b) => a - b);
    const out: number[] = [];
    for (const t of all) if (!out.length || t - out[out.length - 1] > 1e-5) out.push(t);
    return out;
}

// ---------------------------------------------------------------- retarget

export function retargetClip(source: SkeletonBone[], clip: Clip, target: SkeletonBone[], pairs: RetargetPair[], options: RetargetOptions = {}): Clip {
    const srcOrder = parentsFirst(source);
    const dstOrder = parentsFirst(target);
    // The poses turns are measured from (source) and put on (target): the references, or the rests.
    const srcRest = worldPose(source, srcOrder, source.map((b) => b.translation), options.sourceReference ?? source.map((b) => b.rotation));
    const dstRest = worldPose(target, dstOrder, target.map((b) => b.translation), options.targetReference ?? target.map((b) => b.rotation));
    // The target standing at rest, for the ground.
    const dstStand = options.targetReference ? worldPose(target, dstOrder, target.map((b) => b.translation), target.map((b) => b.rotation)) : dstRest;

    // How each target bone turns to line up with its source bone at rest; a bone without
    // an aim takes its nearest paired ancestor's (a fingertip as the finger), else none.
    const pairOf = new Map<number, RetargetPair>();
    for (const p of pairs) if (p.target >= 0 && p.source >= 0) pairOf.set(p.target, p);
    const line = new Map<number, Quat>();
    for (const i of dstOrder) {
        const p = pairOf.get(i);
        if (!p) continue;
        if (p.aim && p.aim.target >= 0 && p.aim.source >= 0) {
            const dS = unit(sub(srcRest.p[p.aim.source], srcRest.p[p.source]));
            const dT = unit(sub(dstRest.p[p.aim.target], dstRest.p[p.target]));
            line.set(i, rotationBetween(dS, dT));
        } else {
            let a = target[i].parent;
            while (a >= 0 && !line.has(a)) a = target[a].parent;
            line.set(i, a >= 0 ? line.get(a)! : [0, 0, 0, 1]);
        }
    }

    let scale = options.scale ?? 1;
    if (options.scale === undefined && options.legs) {
        const lt = Math.hypot(...sub(dstRest.p[options.legs.target[0]], dstRest.p[options.legs.target[1]]));
        const ls = Math.hypot(...sub(srcRest.p[options.legs.source[0]], srcRest.p[options.legs.source[1]]));
        if (lt > 1e-6 && ls > 1e-6) scale = lt / ls;
    }

    const byBone = new Map<number, ClipTrack[]>();
    for (const tr of clip.tracks) {
        if (tr.bone < 0 || tr.bone >= source.length) continue;
        (byBone.get(tr.bone) ?? byBone.set(tr.bone, []).get(tr.bone)!).push(tr);
    }
    const times = keyTimes(clip);
    const mapped = dstOrder.filter((i) => pairOf.has(i));
    const rotations = new Map<number, Float32Array>(mapped.map((i) => [i, new Float32Array(times.length * 4)]));
    const root = options.root && options.root.target >= 0 && options.root.source >= 0 ? options.root : undefined;
    const moves = root ? new Float32Array(times.length * 3) : null;

    const sT = source.map((b) => [...b.translation] as Vec3);
    const sR = source.map((b) => [...b.rotation] as Quat);
    const tmp: number[] = [0, 0, 0, 0];
    const worldR = new Array<Quat>(target.length);
    times.forEach((t, k) => {
        // The source posed at this time: its rest where the clip has nothing.
        source.forEach((b, i) => {
            sT[i] = [...b.translation];
            sR[i] = [...b.rotation];
            for (const tr of byBone.get(i) ?? []) {
                if (!sampleTrack(tr, t, tmp)) continue;
                if (tr.path === 'rotation') sR[i] = qnorm([tmp[0], tmp[1], tmp[2], tmp[3]]);
                else sT[i] = [tmp[0], tmp[1], tmp[2]];
            }
        });
        const src = worldPose(source, srcOrder, sT, sR);
        for (const i of dstOrder) {
            const parent = target[i].parent;
            const parentR: Quat = parent >= 0 && worldR[parent] ? worldR[parent] : [0, 0, 0, 1];
            const p = pairOf.get(i);
            if (!p) {
                worldR[i] = qmul(parentR, target[i].rotation);
                continue;
            }
            // How the source bone turned from rest, applied to the target bone lined up with it.
            const turn = qmul(src.r[p.source], qinv(srcRest.r[p.source]));
            const R = qnorm(qmul(qmul(turn, qinv(line.get(i)!)), dstRest.r[i]));
            worldR[i] = R;
            let local = qnorm(qmul(qinv(parentR), R));
            const out = rotations.get(i)!;
            if (k > 0) {
                // The short way from the last key.
                const d = out[(k - 1) * 4] * local[0] + out[(k - 1) * 4 + 1] * local[1] + out[(k - 1) * 4 + 2] * local[2] + out[(k - 1) * 4 + 3] * local[3];
                if (d < 0) local = [-local[0], -local[1], -local[2], -local[3]];
            }
            out.set(local, k * 4);
        }
        if (root && moves) {
            const d = sub(src.p[root.source], srcRest.p[root.source]);
            const parent = target[root.target].parent;
            const parentR: Quat = parent >= 0 && worldR[parent] ? worldR[parent] : [0, 0, 0, 1];
            const m = rotate(qinv(parentR), [d[0] * scale, d[1] * scale, d[2] * scale]);
            const rest = target[root.target].translation;
            moves.set([rest[0] + m[0], rest[1] + m[1], rest[2] + m[2]], k * 3);
        }
    });

    const ground = (options.ground ?? []).filter((i) => i >= 0 && i < target.length);
    if (root && moves && ground.length && times.length) {
        const lowest = (pose: WorldPose) => Math.min(...ground.map((i) => pose.p[i][1]));
        const tT = target.map((b) => [...b.translation] as Vec3);
        const tR = target.map((b) => [...b.rotation] as Quat);
        let low = Infinity;
        times.forEach((_, k) => {
            for (const [i, v] of rotations) tR[i] = [v[k * 4], v[k * 4 + 1], v[k * 4 + 2], v[k * 4 + 3]];
            tT[root.target] = [moves[k * 3], moves[k * 3 + 1], moves[k * 3 + 2]];
            low = Math.min(low, lowest(worldPose(target, dstOrder, tT, tR)));
        });
        // The lift, in the world, turned into the root's parent space (a top root: as is).
        const lift: Vec3 = [0, lowest(dstStand) - low, 0];
        const parent = target[root.target].parent;
        let parentRest: Quat = [0, 0, 0, 1];
        if (parent >= 0) parentRest = dstRest.r[parent];
        const m = rotate(qinv(parentRest), lift);
        for (let k = 0; k < times.length; k++) for (let c = 0; c < 3; c++) moves[k * 3 + c] += m[c];
    }

    const keyTimesF = Float32Array.from(times);
    const tracks: ClipTrack[] = mapped.map((i) => ({ bone: i, path: 'rotation' as const, times: keyTimesF, values: rotations.get(i)! }));
    if (root && moves) tracks.push({ bone: root.target, path: 'translation', times: keyTimesF, values: moves });
    return { name: clip.name, tracks };
}

// ---------------------------------------------------------------- MMD and Biped

/** Names compared without case, spaces, underscores or full-width digits. */
export function boneKey(name: string): string {
    return name.normalize('NFKC').toLowerCase().replace(/[\s_.\-:]+/g, '');
}

type Entry = [mmd: string, biped: string[], aim?: [mmd: string, biped: string]];

// MMD's standard bone names (their D bones and twist bones too) and the Biped bones they stand for.
// {J} is 左 or 右, {s} l or r. The arm, hand and finger pairs line up by a child: MMD models
// rest with their arms lower than game bodies do.
const MMD_BIPED: Entry[] = [
    ['下半身', ['bip001pelvis']],
    ['上半身', ['bip001spine']],
    ['上半身1', ['bip001spine1']],
    ['上半身2', ['bip001spine2']],
    ['首', ['bip001neck']],
    ['頭', ['bip001head']],
    ['{J}足', ['bip001{s}thigh']],
    ['{J}足D', ['bip001{s}thigh']],
    ['{J}ひざ', ['bip001{s}calf']],
    ['{J}ひざD', ['bip001{s}calf']],
    ['{J}足首', ['bip001{s}foot']],
    ['{J}足首D', ['bip001{s}foot']],
    ['{J}足先EX', ['bip001{s}toe0']],
    ['{J}肩', ['bip001{s}clavicle'], ['{J}腕', 'bip001{s}upperarm']],
    ['{J}腕', ['bip001{s}upperarm'], ['{J}ひじ', 'bip001{s}forearm']],
    ['{J}腕捩', ['bip001{s}uparmtwist', 'bip001{s}upperarmtwist', 'bip001{s}upperarm'], ['{J}ひじ', 'bip001{s}forearm']],
    ['{J}腕捩1', ['bip001{s}uparmtwist1', 'bip001{s}upperarmtwist1', 'bip001{s}uparmtwist', 'bip001{s}upperarm'], ['{J}ひじ', 'bip001{s}forearm']],
    ['{J}ひじ', ['bip001{s}forearm'], ['{J}手首', 'bip001{s}hand']],
    ['{J}手捩', ['bip001{s}foretwist', 'bip001{s}forearmtwist', 'bip001{s}forearm'], ['{J}手首', 'bip001{s}hand']],
    ['{J}手捩1', ['bip001{s}foretwist1', 'bip001{s}forearmtwist1', 'bip001{s}foretwist', 'bip001{s}forearm'], ['{J}手首', 'bip001{s}hand']],
    ['{J}手首', ['bip001{s}hand'], ['{J}中指1', 'bip001{s}finger2']],
    ['{J}親指0', ['bip001{s}finger0'], ['{J}親指1', 'bip001{s}finger01']],
    ['{J}親指1', ['bip001{s}finger01'], ['{J}親指2', 'bip001{s}finger02']],
    ['{J}親指2', ['bip001{s}finger02']],
    ['{J}人指1', ['bip001{s}finger1'], ['{J}人指2', 'bip001{s}finger11']],
    ['{J}人指2', ['bip001{s}finger11'], ['{J}人指3', 'bip001{s}finger12']],
    ['{J}人指3', ['bip001{s}finger12']],
    ['{J}中指1', ['bip001{s}finger2'], ['{J}中指2', 'bip001{s}finger21']],
    ['{J}中指2', ['bip001{s}finger21'], ['{J}中指3', 'bip001{s}finger22']],
    ['{J}中指3', ['bip001{s}finger22']],
    ['{J}薬指1', ['bip001{s}finger3'], ['{J}薬指2', 'bip001{s}finger31']],
    ['{J}薬指2', ['bip001{s}finger31'], ['{J}薬指3', 'bip001{s}finger32']],
    ['{J}薬指3', ['bip001{s}finger32']],
    ['{J}小指1', ['bip001{s}finger4'], ['{J}小指2', 'bip001{s}finger41']],
    ['{J}小指2', ['bip001{s}finger41'], ['{J}小指3', 'bip001{s}finger42']],
    ['{J}小指3', ['bip001{s}finger42']],
];

export interface BoneMap {
    pairs: RetargetPair[];
    root?: { target: number; source: number };
    legs?: { target: [number, number]; source: [number, number] };
    /** Target names of the table with no bone on one side or the other. */
    unmatched: string[];
}

/** The pairs of an MMD skeleton (target) and a Biped one (Bip001, the source), by name. */
export function mmdFromBiped(target: SkeletonBone[], source: SkeletonBone[]): BoneMap {
    const T = new Map<string, number>();
    target.forEach((b, i) => { const k = boneKey(b.name); if (!T.has(k)) T.set(k, i); });
    const S = new Map<string, number>();
    source.forEach((b, i) => { const k = boneKey(b.name); if (!S.has(k)) S.set(k, i); });
    const pairs: RetargetPair[] = [];
    const unmatched: string[] = [];
    const tIndex = (name: string) => T.get(boneKey(name)) ?? -1;
    const sIndex = (names: string[]) => { for (const n of names) { const i = S.get(n); if (i !== undefined) return i; } return -1; };
    for (const [mmd, biped, aim] of MMD_BIPED) {
        const sides: [string, string][] = mmd.includes('{J}') ? [['左', 'l'], ['右', 'r']] : [['', '']];
        for (const [J, s] of sides) {
            const t = tIndex(mmd.replace('{J}', J));
            const src = sIndex(biped.map((n) => n.replace('{s}', s)));
            if (t < 0 || src < 0) { unmatched.push(mmd.replace('{J}', J)); continue; }
            const pair: RetargetPair = { target: t, source: src };
            if (aim) {
                const at = tIndex(aim[0].replace('{J}', J));
                const as = S.get(aim[1].replace('{s}', s)) ?? -1;
                if (at >= 0 && as >= 0) pair.aim = { target: at, source: as };
            }
            pairs.push(pair);
        }
    }
    const center = tIndex('センター');
    const pelvis = S.get('bip001pelvis') ?? -1;
    const legT: [number, number] = [tIndex('左足'), tIndex('左足首')];
    const legS: [number, number] = [S.get('bip001lthigh') ?? -1, S.get('bip001lfoot') ?? -1];
    return {
        pairs,
        ...(center >= 0 && pelvis >= 0 ? { root: { target: center, source: pelvis } } : {}),
        ...(legT.every((i) => i >= 0) && legS.every((i) => i >= 0) ? { legs: { target: legT, source: legS } } : {}),
        unmatched,
    };
}

// ---------------------------------------------------------------- any two humanoids
//
// The method: bones paired by their humanoid roles, both
// bodies put in one reference posture (arms out level, legs straight down, fingers along
// the hand; everything else as built), each paired bone turned as its source turns from
// that posture, the hips' move scaled by the legs, then what the model's own clips teach:
// joints they keep still, twist bones by their share of the joint's twist, corrective
// bones within the range the clips show.

/**
 * The pairs of two skeletons by their humanoid bones (core/humanoid.ts guesses them from
 * the names: Mixamo, Biped, MMD, VRoid, Unreal...), or by roles given for either side.
 */
export function humanoidPairs(
    target: SkeletonBone[],
    source: SkeletonBone[],
    roles: { target?: Record<string, number>; source?: Record<string, number> } = {},
): BoneMap & { roles: string[]; ground: number[]; targetRoles: Record<string, number>; sourceRoles: Record<string, number> } {
    const T = roles.target ?? guessHumanoid(target).bones;
    const S = roles.source ?? guessHumanoid(source).bones;
    const pairs: RetargetPair[] = [];
    const unmatched: string[] = [];
    const matched: string[] = [];
    for (const role of new Set([...Object.keys(T), ...Object.keys(S)])) {
        const t = T[role], s = S[role];
        if (t === undefined || s === undefined) { unmatched.push(role); continue; }
        pairs.push({ target: t, source: s });
        matched.push(role);
    }
    const legT: [number, number] = [T.leftUpperLeg ?? -1, T.leftFoot ?? -1];
    const legS: [number, number] = [S.leftUpperLeg ?? -1, S.leftFoot ?? -1];
    return {
        pairs,
        ...(T.hips !== undefined && S.hips !== undefined ? { root: { target: T.hips, source: S.hips } } : {}),
        ...(legT.every((i) => i >= 0) && legS.every((i) => i >= 0) ? { legs: { target: legT, source: legS } } : {}),
        unmatched,
        roles: matched,
        ground: ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map((r) => T[r]).filter((i): i is number => i !== undefined),
        targetRoles: T,
        sourceRoles: S,
    };
}

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;

/**
 * A humanoid skeleton's reference pose for retargeting, as local rotations by bone: its rest
 * with the upper and lower arms out level to its sides (left +X when it faces +Z; the side is
 * read from the skeleton), the thighs and shins straight down and the fingers but the thumbs
 * along the hand. What differs by build, not by posture, stays as it rests: collarbones,
 * spine, neck, head, hands, feet, toes, thumbs. Each bone is turned the shortest way onto
 * its direction, parents first.
 */
export function retargetPose(skeleton: SkeletonBone[], roles: Record<string, number>): Quat[] {
    const order = parentsFirst(skeleton);
    const L = skeleton.map((b) => [...b.rotation] as Quat);
    const rest = worldPose(skeleton, order, skeleton.map((b) => b.translation), L);
    let side = 1;
    for (const [l, r] of [['leftUpperArm', 'rightUpperArm'], ['leftUpperLeg', 'rightUpperLeg']]) {
        if (roles[l] === undefined || roles[r] === undefined) continue;
        side = Math.sign(rest.p[roles[l]][0] - rest.p[roles[r]][0]) || 1;
        break;
    }
    const P: Vec3[] = new Array(skeleton.length);
    const W: Quat[] = new Array(skeleton.length);
    /** Where bone `c` is, through the bones from `i` down to it at their current turns. */
    const placeOf = (i: number, c: number): Vec3 | null => {
        const path: number[] = [];
        let k = c;
        while (k >= 0 && k !== i && path.length <= skeleton.length) { path.push(k); k = skeleton[k].parent; }
        if (k !== i) return null;
        let p = P[i], q = W[i];
        for (const n of path.reverse()) {
            const o = rotate(q, skeleton[n].translation);
            p = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
            q = qmul(q, L[n]);
        }
        return p;
    };
    // bone → [the child it points at, where it should point]
    const aims = new Map<number, [number, () => Vec3 | null]>();
    const aim = (role: string, child: string, dir: () => Vec3 | null) => {
        if (roles[role] !== undefined && roles[child] !== undefined) aims.set(roles[role], [roles[child], dir]);
    };
    for (const s of ['left', 'right'] as const) {
        const x = s === 'left' ? side : -side;
        aim(`${s}UpperArm`, `${s}LowerArm`, () => [x, 0, 0]);
        aim(`${s}LowerArm`, `${s}Hand`, () => [x, 0, 0]);
        aim(`${s}UpperLeg`, `${s}LowerLeg`, () => [0, -1, 0]);
        aim(`${s}LowerLeg`, `${s}Foot`, () => [0, -1, 0]);
        const hand = roles[`${s}Hand`], middle = roles[`${s}MiddleProximal`];
        const along = (): Vec3 | null => {
            if (hand === undefined || middle === undefined || !W[hand]) return null;
            const m = placeOf(hand, middle);
            return m ? unit(sub(m, P[hand])) : null;
        };
        for (const f of FINGERS) {
            aim(`${s}${f}Proximal`, `${s}${f}Intermediate`, along);
            aim(`${s}${f}Intermediate`, `${s}${f}Distal`, along);
        }
    }
    for (const i of order) {
        const p = skeleton[i].parent;
        const top = p < 0 || !W[p];
        W[i] = top ? L[i] : qnorm(qmul(W[p], L[i]));
        P[i] = top ? [...skeleton[i].translation] : (() => { const o = rotate(W[p], skeleton[i].translation); return [P[p][0] + o[0], P[p][1] + o[1], P[p][2] + o[2]] as Vec3; })();
        const a = aims.get(i);
        if (!a) continue;
        const goal = a[1]();
        const c = placeOf(i, a[0]);
        if (!goal || !c) continue;
        const d = sub(c, P[i]);
        if (Math.hypot(d[0], d[1], d[2]) < 1e-6) continue;
        W[i] = qnorm(qmul(rotationBetween(unit(d), unit(goal)), W[i]));
        L[i] = top ? W[i] : qnorm(qmul(qinv(W[p]), W[i]));
    }
    return L;
}

/**
 * The bones a model's own clips never turn by more than `degrees` from rest (a boot's
 * toes, a stiff hem): a clip made for another body should not bend them either. Empty
 * when the model has no clips to tell.
 */
export function stillBones(skeleton: SkeletonBone[], clips: Clip[], degrees = 1): Set<number> {
    if (!clips.length) return new Set();
    const most = new Float64Array(skeleton.length);
    for (const clip of clips) {
        for (const tr of clip.tracks) {
            if (tr.path !== 'rotation' || tr.bone < 0 || tr.bone >= skeleton.length) continue;
            const r = skeleton[tr.bone].rotation;
            for (let k = 0; k < tr.times.length; k++) {
                const v = tr.values.subarray(k * 4, k * 4 + 4);
                const d = Math.min(1, Math.abs(v[0] * r[0] + v[1] * r[1] + v[2] * r[2] + v[3] * r[3]));
                most[tr.bone] = Math.max(most[tr.bone], (2 * Math.acos(d) * 180) / Math.PI);
            }
        }
    }
    const out = new Set<number>();
    most.forEach((a, i) => a <= degrees && out.add(i));
    return out;
}

/** A rotation as a rotation vector (axis times angle, radians), the short way. */
function logQ(q: Quat): Vec3 {
    const s = q[3] < 0 ? -1 : 1;
    const v: Vec3 = [q[0] * s, q[1] * s, q[2] * s];
    const sin = Math.hypot(v[0], v[1], v[2]);
    if (sin < 1e-9) return [2 * v[0], 2 * v[1], 2 * v[2]];
    const a = 2 * Math.atan2(sin, q[3] * s);
    return [(v[0] / sin) * a, (v[1] / sin) * a, (v[2] / sin) * a];
}
function expQ(v: Vec3): Quat {
    const a = Math.hypot(v[0], v[1], v[2]);
    if (a < 1e-9) return qnorm([v[0] / 2, v[1] / 2, v[2] / 2, 1]);
    const s = Math.sin(a / 2) / a;
    return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a / 2)];
}
/** The angle a rotation turns about a unit axis (its twist), radians in (-π, π]. */
function twistAngle(q: Quat, axis: Vec3): number {
    const p = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
    let a = 2 * Math.atan2(p, q[3]);
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a <= -Math.PI) a += 2 * Math.PI;
    return a;
}
/** The weights W (features × outputs) that fit X W to Y best, a little ridge keeping it solvable. */
function leastSquares(X: number[][], Y: number[][]): number[][] {
    const n = X[0].length, m = Y[0].length;
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n + m }, (_, j) => {
        if (j < n) return X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j ? 1e-6 * X.length : 0);
        return X.reduce((s, x, r) => s + x[i] * Y[r][j - n], 0);
    }));
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        [A[c], A[p]] = [A[p], A[c]];
        const d = A[c][c] || 1e-12;
        for (let j = c; j < n + m; j++) A[c][j] /= d;
        for (let r = 0; r < n; r++) {
            if (r === c || !A[r][c]) continue;
            const f = A[r][c];
            for (let j = c; j < n + m; j++) A[r][j] -= f * A[c][j];
        }
    }
    return A.map((row) => row.slice(n));
}

export interface Helper {
    name: string;
    /**
     * share: turns about its own length by a share of the joints' twist (fits the model's
     * clips within a degree); fitted: anything else, kept within the clips' range.
     */
    kind: 'share' | 'fitted';
}

/**
 * Moves a model's helper bones in a retargeted clip as its own clips move them. Game rigs
 * keep the skin in shape with bones driven from the joints; a clip from another body has
 * nothing for them, so the skin creases. A helper is a skin joint (`skinned`, when given)
 * the model's clips move that the pairs leave out, with no paired bone under it, under a
 * paired joint A (its nearest paired ancestor) with C its paired child, if any; it learns
 * only from clips that have a track for it:
 * - share: a bone that only turns about its own length (90% of its turning), whose twist is
 *   a·(A's twist) + b·(C's twist about A's length) within a degree on every key of the
 *   model's clips (a forearm twist taking a third of the wrist's); on another clip at most
 *   twice the most the clips show.
 * - fitted: anything else (corrective bones that push the skin out at a bend, twist bones that also follow
 *   the swing): each value (a move from rest, or a turn from rest as a rotation vector) a
 *   straight function of A's and C's turns as rotation vectors, their sizes and squares;
 *   kept within the clips' range and a quarter of it more each way.
 */
export function driveHelpers(skeleton: SkeletonBone[], own: Clip[], clip: Clip, paired: Set<number>, skinned?: Set<number>): { clip: Clip; helpers: Helper[] } {
    if (!own.length) return { clip, helpers: [] };
    const kids = skeleton.map(() => [] as number[]);
    skeleton.forEach((b, i) => b.parent >= 0 && b.parent < skeleton.length && kids[b.parent].push(i));
    const pairedBelow = (i: number): boolean => kids[i].some((k) => paired.has(k) || pairedBelow(k));
    const ancestor = (i: number) => {
        let a = skeleton[i].parent;
        while (a >= 0 && !paired.has(a)) a = skeleton[a].parent;
        return a;
    };
    const index = (c: Clip) => new Map(c.tracks.map((tr) => [`${tr.bone}:${tr.path}`, tr]));
    const ownIndex = own.map(index);
    const ownTimes = own.map(keyTimes);
    // The bones the model's clips move, by path.
    const moved = new Map<number, Set<'translation' | 'rotation'>>();
    for (const c of own) {
        for (const tr of c.tracks) {
            const rest = tr.path === 'rotation' ? skeleton[tr.bone]?.rotation : skeleton[tr.bone]?.translation;
            if (!rest) continue;
            const n = rest.length;
            let most = 0;
            for (let k = 0; k < tr.times.length; k++) for (let j = 0; j < n; j++) most = Math.max(most, Math.abs(tr.values[k * n + j] - rest[j]));
            if (most > 1e-4) (moved.get(tr.bone) ?? moved.set(tr.bone, new Set()).get(tr.bone)!).add(tr.path);
        }
    }
    const helpers = [...moved.keys()].filter((i) => (!skinned || skinned.has(i)) && !paired.has(i) && !pairedBelow(i) && ancestor(i) >= 0);
    if (!helpers.length) return { clip, helpers: [] };

    const local = (byBone: Map<string, ClipTrack>, bone: number, path: 'translation' | 'rotation', t: number): number[] => {
        const tr = byBone.get(`${bone}:${path}`);
        const out: number[] = path === 'rotation' ? [...skeleton[bone].rotation] : [...skeleton[bone].translation];
        if (tr) sampleTrack(tr, t, out);
        return out;
    };
    const delta = (bone: number, q: number[]) => qmul(qinv(skeleton[bone].rotation), q as Quat);
    const newIndex = index(clip);
    const times = keyTimes(clip);
    const keyTimesF = Float32Array.from(times);
    const tracks: ClipTrack[] = [];
    const out: Helper[] = [];

    for (const h of helpers) {
        const A = ancestor(h);
        const C = kids[A].find((k) => paired.has(k));
        // The keys of the model's clips that move this helper.
        const keys: { ci: number; t: number }[] = [];
        own.forEach((_, ci) => {
            if (![...moved.get(h)!].some((p) => ownIndex[ci].has(`${h}:${p}`))) return;
            for (const t of ownTimes[ci]) keys.push({ ci, t });
        });
        if (!keys.length) continue;

        // Its own length, in its parent's space: where it sits from its parent, else A's length.
        const th = skeleton[h].translation;
        const axisParent: Vec3 | null = Math.hypot(th[0], th[1], th[2]) > 1e-5 ? unit(th) : C !== undefined ? unit(skeleton[C].translation) : null;
        const axisOwn = axisParent ? rotate(qinv(skeleton[h].rotation), axisParent) : null;
        const axisA: Vec3 | null = C !== undefined ? unit(skeleton[C].translation) : null;
        const axisC: Vec3 | null = C !== undefined && axisA ? rotate(qinv(skeleton[C].rotation), axisA) : null;

        let twisting = false;
        if (axisOwn && !moved.get(h)!.has('translation')) {
            let twist = 0, all = 0;
            for (const { ci, t } of keys) {
                const d = delta(h, local(ownIndex[ci], h, 'rotation', t));
                twist += Math.abs(twistAngle(d, axisOwn));
                all += Math.hypot(...logQ(d));
            }
            twisting = all > 1e-6 && twist >= 0.9 * all;
        }

        if (twisting && axisOwn && axisA) {
            const feats = (idx: Map<string, ClipTrack>, t: number) => [
                twistAngle(delta(A, local(idx, A, 'rotation', t)), axisA),
                C !== undefined && axisC ? twistAngle(delta(C, local(idx, C, 'rotation', t)), axisC) : 0,
            ];
            const X = keys.map(({ ci, t }) => feats(ownIndex[ci], t));
            const Y = keys.map(({ ci, t }) => [twistAngle(delta(h, local(ownIndex[ci], h, 'rotation', t)), axisOwn)]);
            const w = leastSquares(X, Y);
            // A share only where it is one: within a degree on every key, else fitted below.
            const miss = Math.max(...X.map((x, r) => Math.abs(w[0][0] * x[0] + w[1][0] * x[1] - Y[r][0])));
            if (miss > Math.PI / 180) twisting = false;
        }
        if (twisting && axisOwn && axisA) {
            const feats = (idx: Map<string, ClipTrack>, t: number) => [
                twistAngle(delta(A, local(idx, A, 'rotation', t)), axisA),
                C !== undefined && axisC ? twistAngle(delta(C, local(idx, C, 'rotation', t)), axisC) : 0,
            ];
            const X = keys.map(({ ci, t }) => feats(ownIndex[ci], t));
            const Y = keys.map(({ ci, t }) => [twistAngle(delta(h, local(ownIndex[ci], h, 'rotation', t)), axisOwn)]);
            const w = leastSquares(X, Y);
            const most = Math.max(...Y.map((y) => Math.abs(y[0])));
            const values = new Float32Array(times.length * 4);
            let prev: Quat | null = null;
            times.forEach((t, k) => {
                const f = feats(newIndex, t);
                const a = Math.max(-2 * most, Math.min(2 * most, w[0][0] * f[0] + w[1][0] * f[1]));
                let q = qnorm(qmul(skeleton[h].rotation, expQ([axisOwn[0] * a, axisOwn[1] * a, axisOwn[2] * a])));
                if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
                values.set(q, k * 4);
                prev = q;
            });
            tracks.push({ bone: h, path: 'rotation', times: keyTimesF, values });
            out.push({ name: skeleton[h].name, kind: 'share' });
            continue;
        }

        // The joints it may follow: A alone, with its paired child, with its paired parent, or all.
        const P = ancestor(A);
        const sets = [[A], ...(C !== undefined ? [[A, C]] : []), ...(P >= 0 ? [[A, P]] : []), ...(C !== undefined && P >= 0 ? [[A, C, P]] : [])];
        const featsOf = (bones: number[]) => (idx: Map<string, ClipTrack>, t: number) => {
            const out = [1];
            for (const b of bones) {
                const v = logQ(delta(b, local(idx, b, 'rotation', t)));
                out.push(...v, ...v.map(Math.abs), ...v.map((x) => x * x));
            }
            return out;
        };
        for (const p of moved.get(h)!) {
            const rows = keys.filter((key) => ownIndex[key.ci].has(`${h}:${p}`));
            if (!rows.length) continue;
            const Y = rows.map((key) => {
                const v = local(ownIndex[key.ci], h, p, key.t);
                return p === 'rotation' ? logQ(delta(h, v)) : sub(v as Vec3, skeleton[h].translation);
            });
            // Pick the joints by how well each set predicts keys it did not learn from (every
            // fifth key held out in turn, the mean square miss); a bigger set only when it
            // misses a fifth less than the simplest. Then fit the pick to every key.
            let feats = featsOf(sets[0]);
            let X = rows.map((key) => feats(ownIndex[key.ci], key.t));
            if (sets.length > 1 && rows.length >= 20) {
                const missOf = (Xs: number[][]) => {
                    let sum = 0;
                    for (let fold = 0; fold < 5; fold++) {
                        const train = Xs.map((_, r) => r).filter((r) => r % 5 !== fold);
                        const w = leastSquares(train.map((r) => Xs[r]), train.map((r) => Y[r]));
                        Xs.forEach((x, r) => {
                            if (r % 5 !== fold) return;
                            const y = [0, 1, 2].map((j) => w.reduce((s, row, i) => s + row[j] * x[i], 0));
                            sum += (y[0] - Y[r][0]) ** 2 + (y[1] - Y[r][1]) ** 2 + (y[2] - Y[r][2]) ** 2;
                        });
                    }
                    return sum / Xs.length;
                };
                let best = missOf(X) * 0.8 ** 2;
                for (const set of sets.slice(1)) {
                    const f = featsOf(set);
                    const Xs = rows.map((key) => f(ownIndex[key.ci], key.t));
                    const m = missOf(Xs);
                    if (m < best) { best = m; feats = f; X = Xs; }
                }
            }
            const F = times.map((t) => feats(newIndex, t));
            const w = leastSquares(X, Y);
            // Each value within the clips' range and half of it more each way, and the whole
            // turn (or move) at most twice the most the clips show.
            const lo = [0, 1, 2].map((j) => Math.min(...Y.map((y) => y[j])));
            const hi = [0, 1, 2].map((j) => Math.max(...Y.map((y) => y[j])));
            const most = Math.max(...Y.map((y) => Math.hypot(y[0], y[1], y[2])));
            const values = new Float32Array(times.length * (p === 'rotation' ? 4 : 3));
            let prev: Quat | null = null;
            F.forEach((f, k) => {
                let y = [0, 1, 2].map((j) => {
                    const v = w.reduce((s, row, i) => s + row[j] * f[i], 0);
                    const margin = (hi[j] - lo[j]) * 0.5;
                    return Math.max(lo[j] - margin, Math.min(hi[j] + margin, v));
                }) as Vec3;
                const size = Math.hypot(y[0], y[1], y[2]);
                if (size > 2 * most && size > 0) y = y.map((x) => (x * 2 * most) / size) as Vec3;
                if (p === 'rotation') {
                    let q = qnorm(qmul(skeleton[h].rotation, expQ(y)));
                    if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
                    values.set(q, k * 4);
                    prev = q;
                } else {
                    const r = skeleton[h].translation;
                    values.set([r[0] + y[0], r[1] + y[1], r[2] + y[2]], k * 3);
                }
            });
            tracks.push({ bone: h, path: p, times: keyTimesF, values });
        }
        out.push({ name: skeleton[h].name, kind: 'fitted' });
    }
    return { clip: { ...clip, tracks: [...clip.tracks, ...tracks] }, helpers: out };
}

/** The lowest each ankle and toe joint goes in a model's own clips (none: an empty map). */
export function footFloors(model: { skeleton: SkeletonBone[]; clips: Clip[] }, roles: Record<string, number>): Map<number, number> {
    const bones = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map((r) => roles[r]).filter((i): i is number => i !== undefined);
    const out = new Map<number, number>();
    if (!bones.length) return out;
    const order = parentsFirst(model.skeleton);
    const tmp = [0, 0, 0, 0];
    for (const clip of model.clips) {
        const byBone = new Map<number, ClipTrack[]>();
        for (const tr of clip.tracks) (byBone.get(tr.bone) ?? byBone.set(tr.bone, []).get(tr.bone)!).push(tr);
        for (const t of keyTimes(clip)) {
            const T = model.skeleton.map((b) => [...b.translation] as Vec3);
            const R = model.skeleton.map((b) => [...b.rotation] as Quat);
            for (const [i, trs] of byBone) for (const tr of trs) {
                if (!sampleTrack(tr, t, tmp)) continue;
                if (tr.path === 'rotation') R[i] = qnorm([tmp[0], tmp[1], tmp[2], tmp[3]]); else T[i] = [tmp[0], tmp[1], tmp[2]];
            }
            const p = worldPose(model.skeleton, order, T, R).p;
            for (const b of bones) out.set(b, Math.min(out.get(b) ?? Infinity, p[b][1]));
        }
    }
    return out;
}

/** How high a hand's lowest joint sits when the hand is on the floor: a finger's half thickness, metres. */
export const HAND_ON_FLOOR = 0.012;

/**
 * Puts the feet and hands of a retargeted clip where the source's touch the floor (the IK
 * pass after the turns are copied). Both reach by two-bone IK in the plane the knee or elbow
 * already bends in, and keep the foot's or hand's turn.
 * - feet: each key, each ankle goes to the source's ankle, its place from the hips scaled
 *   by `scale` across and its height measured from the floor (the target's standing ankle
 *   height plus the source's lift over its own, scaled), so a body on platform soles or with
 *   other proportions stands, kneels and steps where the source does. Where a leg cannot
 *   reach, the hips come down as far as needed.
 * - hands: only near the floor. Where the source's wrist is below 25 cm, the target's wrist
 *   is drawn to the source's height scaled, fully below 12 cm (a hand on the floor), its
 *   place across left as copied; higher, the arm stays as copied.
 * `clip` must have a key for every paired bone at every key time (retargetClip's output
 * does) and a move track on the hips.
 */
export function plantContacts(
    target: SkeletonBone[],
    clip: Clip,
    source: SkeletonBone[],
    sourceClip: Clip,
    roles: { target: Record<string, number>; source: Record<string, number> },
    scale: number,
    which: { feet?: boolean; hands?: boolean } = {},
    /** The lowest a bone (an ankle, toes) may go, by bone: the lowest the model's own clips put it. */
    floors: Map<number, number> = new Map(),
): Clip {
    const T = roles.target, S = roles.source;
    const chain = (up: string, low: string, end: string) =>
        (['left', 'right'] as const)
            .map((s) => ({ up: T[`${s}${up}`], low: T[`${s}${low}`], end: T[`${s}${end}`], src: S[`${s}${end}`], srcUp: S[`${s}${up}`] }))
            .filter((l) => [l.up, l.low, l.end, l.src, l.srcUp].every((i) => i !== undefined) && target[l.low].parent === l.up && target[l.end].parent === l.low);
    const legs = which.feet === false ? [] : chain('UpperLeg', 'LowerLeg', 'Foot').map((l) => {
        const toes = T[l.end === T.leftFoot ? 'leftToes' : 'rightToes'];
        return { ...l, toes: toes !== undefined && target[toes].parent === l.end ? toes : undefined };
    });
    // Each hand's joints (the wrist and its fingers), on both sides.
    const handOf = (r: Record<string, number>, side: string) => Object.entries(r).filter(([k]) => k === `${side}Hand` || (k.startsWith(side) && /Thumb|Index|Middle|Ring|Little/.test(k))).map(([, i]) => i);
    const arms = which.hands === false ? [] : chain('UpperArm', 'LowerArm', 'Hand').map((l) => {
        const side = target[l.end] && T.leftHand === l.end ? 'left' : 'right';
        return { ...l, hand: handOf(T, side), srcHand: handOf(S, side) };
    });
    const hips = T.hips, srcHips = S.hips;
    if ((!legs.length && !arms.length) || hips === undefined || srcHips === undefined) return clip;
    const tracks = clip.tracks.map((tr) => ({ ...tr, values: tr.values.slice() }));
    const rotOf = new Map(tracks.filter((t) => t.path === 'rotation').map((t) => [t.bone, t]));
    const move = tracks.find((t) => t.bone === hips && t.path === 'translation');
    if (!move || [...legs, ...arms].some((l) => !rotOf.has(l.up) || !rotOf.has(l.low) || !rotOf.has(l.end))) return clip;

    const dstOrder = parentsFirst(target), srcOrder = parentsFirst(source);
    const tRest = worldPose(target, dstOrder, target.map((b) => b.translation), target.map((b) => b.rotation));
    const sRest = worldPose(source, srcOrder, source.map((b) => b.translation), source.map((b) => b.rotation));
    const srcBy = new Map<number, ClipTrack[]>();
    for (const tr of sourceClip.tracks) (srcBy.get(tr.bone) ?? srcBy.set(tr.bone, []).get(tr.bone)!).push(tr);
    const times = Array.from(move.times);
    const tmp = [0, 0, 0, 0];
    const across = (v: Vec3, u: Vec3): Vec3 => { const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; return [v[0] - u[0] * d, v[1] - u[1] * d, v[2] - u[2] * d]; };

    const posed = (k: number) => {
        const tT = target.map((b) => [...b.translation] as Vec3);
        const tR = target.map((b) => [...b.rotation] as Quat);
        for (const tr of tracks) {
            const n = tr.path === 'rotation' ? 4 : 3;
            const j = Math.min(k, tr.times.length - 1);
            const v = Array.from(tr.values.subarray(j * n, j * n + n));
            if (n === 4) tR[tr.bone] = v as Quat; else tT[tr.bone] = v as Vec3;
        }
        return worldPose(target, dstOrder, tT, tR);
    };
    const put = (bone: number, k: number, q: Quat) => {
        const tr = rotOf.get(bone)!;
        let v = qnorm(q);
        if (k > 0 && v[0] * tr.values[(k - 1) * 4] + v[1] * tr.values[(k - 1) * 4 + 1] + v[2] * tr.values[(k - 1) * 4 + 2] + v[3] * tr.values[(k - 1) * 4 + 3] < 0) v = [-v[0], -v[1], -v[2], -v[3]];
        tr.values.set(v, k * 4);
    };
    /** Two-bone IK: the chain's end to `goal` (as near as the bones reach), bending as it bends now, else toward `bendTo`. */
    const reach = (pose: WorldPose, k: number, l: { up: number; low: number; end: number }, goal: Vec3, bendTo: Vec3) => {
        const H = pose.p[l.up], K = pose.p[l.low], A = pose.p[l.end];
        const l1 = Math.hypot(...sub(K, H)), l2 = Math.hypot(...sub(A, K));
        const toGoal = sub(goal, H);
        const d = Math.max(Math.abs(l1 - l2) + 1e-5, Math.min(l1 + l2 - 1e-5, Math.hypot(...toGoal)));
        const u = unit(toGoal);
        const kh = sub(K, H);
        let bend = across(kh, u);
        if (Math.hypot(...bend) < 1e-6) bend = across(bendTo, u);
        const b = unit(bend);
        const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
        const hgt = Math.sqrt(Math.max(0, l1 * l1 - a * a));
        const K2: Vec3 = [H[0] + u[0] * a + b[0] * hgt, H[1] + u[1] * a + b[1] * hgt, H[2] + u[2] * a + b[2] * hgt];
        const G: Vec3 = [H[0] + u[0] * d, H[1] + u[1] * d, H[2] + u[2] * d];
        const q1 = rotationBetween(unit(kh), unit(sub(K2, H)));
        const upW = qnorm(qmul(q1, pose.r[l.up]));
        const o = rotate(q1, sub(A, K));
        const A1: Vec3 = [K2[0] + o[0], K2[1] + o[1], K2[2] + o[2]];
        const q2 = rotationBetween(unit(sub(A1, K2)), unit(sub(G, K2)));
        const lowW = qnorm(qmul(q2, qmul(q1, pose.r[l.low])));
        const parent = target[l.up].parent;
        const parentW: Quat = parent >= 0 ? pose.r[parent] : [0, 0, 0, 1];
        put(l.up, k, qmul(qinv(parentW), upW));
        put(l.low, k, qmul(qinv(upW), lowW));
        put(l.end, k, qmul(qinv(lowW), pose.r[l.end]));
    };

    // The source at every key.
    const srcPoses = times.map((t) => {
        const sT = source.map((b) => [...b.translation] as Vec3);
        const sR = source.map((b) => [...b.rotation] as Quat);
        for (const [i, trs] of srcBy) for (const tr of trs) {
            if (!sampleTrack(tr, t, tmp)) continue;
            if (tr.path === 'rotation') sR[i] = qnorm([tmp[0], tmp[1], tmp[2], tmp[3]]); else sT[i] = [tmp[0], tmp[1], tmp[2]];
        }
        return worldPose(source, srcOrder, sT, sR);
    });
    // Each source hand's lowest point (its wrist or any finger joint) at every key, and the lowest over the clip.
    const srcLow = arms.map((l) => srcPoses.map((p) => Math.min(...l.srcHand.map((i) => p.p[i][1]))));
    const srcBase = srcLow.map((ys) => Math.min(...ys));
    // A hand's centre (its wrist and finger joints), for hands meeting.
    const centre = (p: WorldPose, ids: number[]): Vec3 => ids.reduce((a, i) => [a[0] + p.p[i][0] / ids.length, a[1] + p.p[i][1] / ids.length, a[2] + p.p[i][2] / ids.length], [0, 0, 0] as Vec3);

    times.forEach((_, k) => {
        const src = srcPoses[k];
        let pose = posed(k);
        const forward = rotate(pose.r[hips], rotate(qinv(tRest.r[hips]), [0, 0, 1]));

        // Where each foot goes, and each hand near the floor (fixed in the world: lowering the hips does not move them).
        // Each ankle from its hip socket (the thigh's root), scaled: a straight source leg makes a
        // straight target leg. Its height: a foot on the floor (the source's within 4 cm of its
        // standing height) keeps its height from the floor; a foot in the air (8 cm up and more)
        // goes with the body; between, a blend. So a body lowered for its hands takes its raised feet along.
        const legGoals = () => legs.map((l) => {
            const s = src.p[l.src], h = src.p[l.srcUp], H = pose.p[l.up];
            const lift = s[1] - sRest.p[l.src][1];
            const onFloor = Math.max(0, Math.min(1, (0.08 - lift) / 0.04));
            const floorY = tRest.p[l.end][1] + lift * scale;
            const bodyY = H[1] + (s[1] - h[1]) * scale;
            // Never under the floor: the ankle and the toes no lower than the model ever puts them
            // (`floors`: the lowest in its own clips; else where they stand). The foot keeps its
            // turn, so a toe pointed down on a longer or thicker foot would otherwise go through,
            // and a raised foot going with a lowered body could too.
            let y = floorY * onFloor + bodyY * (1 - onFloor);
            y = Math.max(y, floors.get(l.end) ?? tRest.p[l.end][1]);
            if (l.toes !== undefined) y = Math.max(y, (floors.get(l.toes) ?? tRest.p[l.toes][1]) - rotate(pose.r[l.end], target[l.toes].translation)[1]);
            return [H[0] + (s[0] - h[0]) * scale, y, H[2] + (s[2] - h[2]) * scale] as Vec3;
        });
        let footGoals = legGoals();
        // A hand on the floor: the clip's lowest place for it, if that is low (under 15 cm), and the
        // keys within 3 cm of it (fading out by 5 cm). Clips float their hands (Mixamo's breakdance
        // never brings a finger joint under 8.6 cm), so the target's hand goes onto its floor, its
        // lowest joint at HAND_ON_FLOOR, rather than to the source's height.
        const armGoals = arms.map((l, a) => {
            if (srcBase[a] > 0.15) return null;
            const w = Math.max(0, Math.min(1, (srcBase[a] + 0.05 - srcLow[a][k]) / 0.02));
            if (w <= 0) return null;
            const p = pose.p[l.end];
            const ty = Math.min(...l.hand.map((i) => pose.p[i][1]));
            const goal: Vec3 = [p[0], p[1] + (HAND_ON_FLOOR - ty) * w, p[2]];
            return Math.abs(goal[1] - p[1]) < 1e-5 ? null : goal;
        });
        // Hips down as far as the longest reach needs, a leg's or a hand's (a few passes: the
        // drop also changes the reach across). The legs then bend deeper with the feet planted.
        for (let pass = 0; pass < 3; pass++) {
            const limbs = [...legs.map((l, i) => ({ l, goal: footGoals[i] })), ...arms.map((l, i) => ({ l, goal: armGoals[i] }))];
            let drop = 0;
            for (const { l, goal } of limbs) {
                if (!goal) continue;
                const length = (Math.hypot(...sub(pose.p[l.low], pose.p[l.up])) + Math.hypot(...sub(pose.p[l.end], pose.p[l.low]))) * 0.999;
                const d = sub(goal, pose.p[l.up]);
                if (Math.hypot(d[0], d[1], d[2]) > length) {
                    const side = Math.hypot(d[0], d[2]);
                    drop = Math.max(drop, side >= length ? 0 : -d[1] - Math.sqrt(length * length - side * side));
                }
            }
            if (drop <= 1e-6) break;
            const parent = target[hips].parent;
            const m = rotate(qinv(parent >= 0 ? pose.r[parent] : [0, 0, 0, 1]), [0, -drop, 0]);
            for (let c = 0; c < 3; c++) move.values[k * 3 + c] += m[c];
            pose = posed(k);
            footGoals = legGoals();
        }
        legs.forEach((l, i) => reach(pose, k, l, footGoals[i], forward));
        arms.forEach((l, i) => armGoals[i] && reach(pose, k, l, armGoals[i]!, [-forward[0], -forward[1], -forward[2]]));

        // Hands meeting (a clap, hands held): where the source's hand centres come within 8 cm
        // (fully within 4 cm), the target's are set the source's way apart, scaled, each hand
        // moving half the difference. Arms of other lengths and shoulders of other widths
        // otherwise pass through each other or stop short.
        if (arms.length === 2) {
            const gapS = sub(centre(src, arms[1].srcHand), centre(src, arms[0].srcHand));
            const w = Math.max(0, Math.min(1, (0.08 - Math.hypot(...gapS)) / 0.04));
            if (w > 0) {
                pose = posed(k);
                const gapT = sub(centre(pose, arms[1].hand), centre(pose, arms[0].hand));
                const fix: Vec3 = [(gapS[0] * scale - gapT[0]) * w / 2, (gapS[1] * scale - gapT[1]) * w / 2, (gapS[2] * scale - gapT[2]) * w / 2];
                if (Math.hypot(...fix) > 1e-5) {
                    const back: Vec3 = [-forward[0], -forward[1], -forward[2]];
                    const p0 = pose.p[arms[0].end], p1 = pose.p[arms[1].end];
                    reach(pose, k, arms[0], [p0[0] - fix[0], p0[1] - fix[1], p0[2] - fix[2]], back);
                    reach(pose, k, arms[1], [p1[0] + fix[0], p1[1] + fix[1], p1[2] + fix[2]], back);
                }
            }
        }

    });
    return { ...clip, tracks };
}


/**
 * The whole method for one clip: `source` and its clip onto `target`, whose own clips (if
 * any) teach the still joints and the helpers. Returns the clip and what was done, for a log.
 */
export function retargetHumanoid(
    target: { skeleton: SkeletonBone[]; clips: Clip[]; joints?: number[] },
    source: SkeletonBone[],
    clip: Clip,
    map = humanoidPairs(target.skeleton, source),
    /** feet, hands: the IK passes that put the feet, and hands near the floor, where the source's are (on unless false). */
    options: { feet?: boolean; hands?: boolean } = {},
): { clip: Clip; held: string[]; helpers: Helper[] } {
    const still = stillBones(target.skeleton, target.clips);
    if (map.root) still.delete(map.root.target);
    const pairs = map.pairs.filter((p) => !still.has(p.target));
    const sourceReference = retargetPose(source, map.sourceRoles);
    const targetReference = retargetPose(target.skeleton, map.targetRoles);
    // The feet pass holds the floor key by key; without it, one height for the clip does.
    const ground = options.feet === false ? map.ground : undefined;
    const copied = retargetClip(source, clip, target.skeleton, pairs, { root: map.root, legs: map.legs, ground, sourceReference, targetReference });
    // The size of the target against the source: their legs, hip to ankle, in the reference pose.
    let scale = 1;
    if (map.legs) {
        const lengthOf = (sk: SkeletonBone[], ref: Quat[], [a, b]: [number, number]) => {
            const p = worldPose(sk, parentsFirst(sk), sk.map((x) => x.translation), ref).p;
            return Math.hypot(...sub(p[a], p[b]));
        };
        const ls = lengthOf(source, sourceReference, map.legs.source);
        if (ls > 1e-6) scale = lengthOf(target.skeleton, targetReference, map.legs.target) / ls;
    }
    const bare = options.feet === false && options.hands === false
        ? copied
        : plantContacts(target.skeleton, copied, source, clip, { target: map.targetRoles, source: map.sourceRoles }, scale, options, footFloors(target, map.targetRoles));
    const skinned = target.joints?.length ? new Set(target.joints) : undefined;
    const driven = driveHelpers(target.skeleton, target.clips, bare, new Set(pairs.map((p) => p.target)), skinned);
    const held = map.pairs.filter((p) => still.has(p.target)).map((p) => target.skeleton[p.target].name);
    return { clip: driven.clip, held, helpers: driven.helpers };
}


// ---------------------------------------------------------------- clips in a GLB

/** The node tree (as a skeleton, at the nodes' own pose) and the animations of a GLB. */
export function readGlbClips(glb: ArrayBuffer): { skeleton: SkeletonBone[]; clips: Clip[]; meshes: number; joints: number[] } | null {
    const dv = new DataView(glb);
    if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return null;
    const jsonLength = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(glb, 20, jsonLength)));
    const binStart = 20 + jsonLength + 8;
    const binLength = binStart <= glb.byteLength ? dv.getUint32(20 + jsonLength, true) : 0;
    const nodes: any[] = json.nodes ?? [];
    const parent = new Array<number>(nodes.length).fill(-1);
    nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => (parent[c] = i)));
    const skeleton: SkeletonBone[] = nodes.map((n, i) => ({
        name: n.name ?? `node_${i}`,
        parent: parent[i],
        translation: (n.translation ?? [0, 0, 0]) as Vec3,
        rotation: (n.rotation ?? [0, 0, 0, 1]) as Quat,
    }));
    const floats = (index: number): Float32Array => {
        const acc = json.accessors[index];
        const view = json.bufferViews[acc.bufferView];
        const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type as string] ?? 1;
        if (acc.componentType !== 5126) throw new Error('only float animation data is read');
        const stride = view.byteStride && view.byteStride !== n * 4 ? view.byteStride : 0;
        const start = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        if (start + acc.count * (stride || n * 4) > binStart + binLength) throw new Error('animation data outside the buffer');
        if (!stride) return new Float32Array(glb.slice(start, start + acc.count * n * 4));
        const out = new Float32Array(acc.count * n);
        for (let i = 0; i < acc.count; i++) for (let j = 0; j < n; j++) out[i * n + j] = dv.getFloat32(start + i * stride + j * 4, true);
        return out;
    };
    const clips: Clip[] = (json.animations ?? []).map((a: any, ai: number) => ({
        name: a.name ?? `clip_${ai}`,
        tracks: (a.channels ?? [])
            .filter((c: any) => (c.target?.path === 'rotation' || c.target?.path === 'translation') && c.target.node !== undefined)
            .map((c: any) => {
                const s = a.samplers[c.sampler];
                let values = floats(s.output);
                if (s.interpolation === 'CUBICSPLINE') {
                    // In-tangent, value, out-tangent a key: the values.
                    const n = c.target.path === 'rotation' ? 4 : 3;
                    const keys = values.length / (3 * n);
                    const v = new Float32Array(keys * n);
                    for (let k = 0; k < keys; k++) v.set(values.subarray((k * 3 + 1) * n, (k * 3 + 2) * n), k * n);
                    values = v;
                }
                return { bone: c.target.node, path: c.target.path, times: floats(s.input), values } as ClipTrack;
            }),
    }));
    // The skin joints (of every skin): the bones that move the mesh.
    const joints = [...new Set<number>((json.skins ?? []).flatMap((s: { joints?: number[] }) => s.joints ?? []))];
    return { skeleton, clips, meshes: (json.meshes ?? []).length, joints };
}
