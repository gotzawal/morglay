// A body's surface, read from the skinned meshes of its GLB at rest: enough to
// measure where the soles touch the floor (a boot's heel and tip are not
// joints, and a platform sole is nothing like a bare foot's proportions).

import type { SkeletonBone } from '../retarget';
import { dot, type V3 } from '../rigMotion';
import type { Body, Sole } from './body';

export interface SkinnedPoints {
    /** x, y, z of every vertex, in model space at rest. */
    positions: Float32Array;
    /** The node of the joint that moves each vertex most. */
    joints: Int32Array;
}

type Mat = Float64Array;

function compose(t: number[] | undefined, r: number[] | undefined, s: number[] | undefined): Mat {
    const [x, y, z, w] = r ?? [0, 0, 0, 1];
    const [sx, sy, sz] = s ?? [1, 1, 1];
    const m = new Float64Array(16);
    m[0] = (1 - 2 * (y * y + z * z)) * sx; m[1] = 2 * (x * y + z * w) * sx; m[2] = 2 * (x * z - y * w) * sx;
    m[4] = 2 * (x * y - z * w) * sy; m[5] = (1 - 2 * (x * x + z * z)) * sy; m[6] = 2 * (y * z + x * w) * sy;
    m[8] = 2 * (x * z + y * w) * sz; m[9] = 2 * (y * z - x * w) * sz; m[10] = (1 - 2 * (x * x + y * y)) * sz;
    m[12] = t?.[0] ?? 0; m[13] = t?.[1] ?? 0; m[14] = t?.[2] ?? 0; m[15] = 1;
    return m;
}

function multiply(a: Mat, b: ArrayLike<number>): Mat {
    const m = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return m;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Every skinned vertex of a GLB where it is at rest (null for a file that is not a GLB or keeps its data elsewhere or compressed). */
export function skinnedPoints(glb: ArrayBuffer): SkinnedPoints | null {
    const dv = new DataView(glb);
    if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return null;
    const jsonLength = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(glb, 20, jsonLength)));
    const binStart = 20 + jsonLength + 8;
    if (binStart > glb.byteLength) return null;
    const nodes: any[] = json.nodes ?? [];

    const read = (index: number): { get(i: number, c: number): number; count: number } | null => {
        const acc = json.accessors?.[index];
        const view = acc && json.bufferViews?.[acc.bufferView];
        if (!acc || !view || acc.sparse || view.extensions || (view.buffer ?? 0) !== 0) return null;
        const n = COMPONENTS[acc.type as string];
        const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType as number];
        if (!n || !size) return null;
        const stride = view.byteStride || n * size;
        const start = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const norm = acc.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[acc.componentType as number] ?? 1 : 1;
        const get = (i: number, c: number) => {
            const at = start + i * stride + c * size;
            switch (acc.componentType) {
                case 5126: return dv.getFloat32(at, true);
                case 5123: return dv.getUint16(at, true) / norm;
                case 5121: return dv.getUint8(at) / norm;
                case 5125: return dv.getUint32(at, true);
                case 5122: return dv.getInt16(at, true) / norm;
                default: return dv.getInt8(at) / norm;
            }
        };
        return { get, count: acc.count };
    };

    // Every node's place in the model at rest.
    const parent = new Array<number>(nodes.length).fill(-1);
    nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => (parent[c] = i)));
    const world: (Mat | null)[] = nodes.map(() => null);
    const worldOf = (i: number): Mat => {
        if (world[i]) return world[i]!;
        const n = nodes[i];
        const local = n.matrix ? Float64Array.from(n.matrix as number[]) : compose(n.translation, n.rotation, n.scale);
        return (world[i] = parent[i] >= 0 ? multiply(worldOf(parent[i]), local) : local);
    };

    const positions: number[] = [], joints: number[] = [];
    for (const node of nodes) {
        const mesh = node.mesh !== undefined ? json.meshes?.[node.mesh] : null;
        const skin = node.skin !== undefined ? json.skins?.[node.skin] : null;
        if (!mesh || !skin) continue;
        const ibm = skin.inverseBindMatrices !== undefined ? read(skin.inverseBindMatrices) : null;
        const matrices: Mat[] = (skin.joints as number[]).map((j, k) => {
            if (!ibm) return worldOf(j);
            const inv = new Float64Array(16);
            for (let c = 0; c < 16; c++) inv[c] = ibm.get(k, c);
            return multiply(worldOf(j), inv);
        });
        for (const prim of mesh.primitives ?? []) {
            const P = read(prim.attributes?.POSITION), J = read(prim.attributes?.JOINTS_0), W = read(prim.attributes?.WEIGHTS_0);
            if (!P || !J || !W) continue;
            for (let v = 0; v < P.count; v++) {
                const x = P.get(v, 0), y = P.get(v, 1), z = P.get(v, 2);
                let sx = 0, sy = 0, sz = 0, total = 0, best = 0, most = -1;
                for (let k = 0; k < 4; k++) {
                    const w = W.get(v, k);
                    if (!(w > 0)) continue;
                    const j = J.get(v, k);
                    const m = matrices[j];
                    if (!m) continue;
                    sx += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
                    sy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
                    sz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
                    total += w;
                    if (w > best) { best = w; most = skin.joints[j]; }
                }
                if (most < 0 || total <= 0) continue;
                positions.push(sx / total, sy / total, sz / total);
                joints.push(most);
            }
        }
    }
    return positions.length ? { positions: Float32Array.from(positions), joints: Int32Array.from(joints) } : null;
}

/**
 * The under side of a set of points seen from the side: of (x along, z up) points, the convex
 * chain a flat floor could touch as the shape rolls on it, from the rearmost point to the
 * foremost. Points closer than `grain` are merged.
 */
export function underside(points: [number, number][], grain: number): [number, number][] {
    const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const hull: [number, number][] = [];
    for (const p of sorted) {
        // Keep only left turns: a point on or above the line through its neighbours is not under.
        while (hull.length >= 2) {
            const a = hull[hull.length - 2], b = hull[hull.length - 1];
            if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0) break;
            hull.pop();
        }
        hull.push(p);
    }
    const out: [number, number][] = [];
    hull.forEach((p, i) => {
        const last = out[out.length - 1];
        if (!last || i === hull.length - 1 || Math.hypot(p[0] - last[0], p[1] - last[1]) >= grain) out.push(p);
    });
    return out;
}

/**
 * The soles of a body from its mesh: the vertices the feet (and the bones under them) move,
 * measured along each foot's own forward from its ankle. Its ends are those within 2 cm of
 * the lowest; its outline is the under side of the two feet laid over each other, up to the
 * ankle's height (x along the foot from the ankle, z over the floor). Null when the feet
 * move no vertices.
 */
export function soleFromMesh(points: SkinnedPoints, skeleton: SkeletonBone[], body: Body, restAnkles: [V3, V3]): { sole: Pick<Sole, 'heel' | 'tip' | 'half' | 'outline'>; floor: number } | null {
    const under = (root: number) => {
        const set = new Set<number>([root]);
        for (let grown = true; grown; ) {
            grown = false;
            skeleton.forEach((b, i) => { if (!set.has(i) && set.has(b.parent)) { set.add(i); grown = true; } });
        }
        return set;
    };
    const feet = [under(body.roles.leftFoot), under(body.roles.rightFoot)];
    const mine: { foot: number; p: V3 }[] = [];
    for (let v = 0; v < points.joints.length; v++) {
        const foot = feet[0].has(points.joints[v]) ? 0 : feet[1].has(points.joints[v]) ? 1 : -1;
        if (foot >= 0) mine.push({ foot, p: [points.positions[v * 3], points.positions[v * 3 + 1], points.positions[v * 3 + 2]] });
    }
    if (mine.length < 8) return null;
    const floor = Math.min(...mine.map((m) => dot(m.p, body.up)));
    const side: [number, number][] = [];
    const ends = [0, 1].map((foot) => {
        const yaw = body.footYaw[foot];
        const f: V3 = [body.fwd[0] * Math.cos(yaw) + body.left[0] * Math.sin(yaw), 0, body.fwd[2] * Math.cos(yaw) + body.left[2] * Math.sin(yaw)];
        const own = mine.filter((m) => m.foot === foot).map((m): [number, number] => [dot([m.p[0] - restAnkles[foot][0], 0, m.p[2] - restAnkles[foot][2]], f), dot(m.p, body.up) - floor]);
        for (const p of own) if (p[1] <= body.ankleHeight) side.push(p);
        const along = own.filter((p) => p[1] <= 0.02).map((p) => p[0]);
        // (Across the foot: what touches the floor, from one side to the other.)
        const n: V3 = [-f[2], 0, f[0]];
        const across = mine.filter((m) => m.foot === foot && dot(m.p, body.up) - floor <= 0.02).map((m) => dot([m.p[0] - restAnkles[foot][0], 0, m.p[2] - restAnkles[foot][2]], n));
        return along.length ? { heel: Math.min(...along), tip: Math.max(...along), half: across.length ? (Math.max(...across) - Math.min(...across)) / 2 : 0 } : null;
    });
    const found = ends.filter((e): e is { heel: number; tip: number; half: number } => !!e);
    if (!found.length) return null;
    return {
        sole: { heel: found.reduce((s, e) => s + e.heel, 0) / found.length, tip: found.reduce((s, e) => s + e.tip, 0) / found.length, half: found.reduce((s, e) => s + e.half, 0) / found.length, outline: underside(side, 0.002 * body.hipHeight) },
        floor,
    };
}
