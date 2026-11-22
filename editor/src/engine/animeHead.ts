import type { AnimatorComponent, Material, Object3D } from '@orillusion/core';
import { animeFaceFront, animeFront, animeRight, animeUp, type AnimeValues } from '../core/anime';
import { setAnimeHead, type AnimeHead } from './animeMaterial';

// The head's frame of a character's anime materials, from its head bone each
// frame: faces read their face shadow map by where the light stands around
// the head, hair lays its strands up the head, eyes are lit level with it.
//
// The frame is the head joint's skin matrix (its world matrix times its
// inverse bind matrix): what takes a direction of the meshes' own space at
// rest to the world now. The material's Front and Up axes (and the face's
// Front Tilt) say which directions of that space the head's are. It runs in
// the animator's update, after the clip and the springs have posed the
// bones, so the frame is this frame's.

/** Names of a head bone, most likely first: "Bip001 Head", "Head", "J_Bip_C_Head", "mixamorig:Head"; not its end or top. */
// The head bone by its name: English rigs, and MMD's (頭, Chinese 头).
const HEAD_NAMES = [/(^|[^a-z0-9])head$/i, /^head/i, /head(?!.*(end|nub|top|tip|jnt|local))/i, /^(頭|头)$/];

export interface AnimeHeadSkin {
    joints: string[];
    inverseBinds: Float32Array[];
}

/** Picks the head joint of some skins: the name most like a head bone's, with its inverse bind matrix. */
export function findHeadJoint(skins: AnimeHeadSkin[]): { name: string; inverseBind: Float32Array } | null {
    for (const re of HEAD_NAMES) {
        for (const skin of skins) {
            const i = skin.joints.findIndex((n) => re.test(n));
            if (i >= 0 && skin.inverseBinds[i]) return { name: skin.joints[i], inverseBind: skin.inverseBinds[i] };
        }
    }
    return null;
}

type V3 = [number, number, number];

/** Column-major 4×4 times 4×4, the upper 3×3 of the product (row r, column c at [c * 3 + r]). */
export function rotationOf(world: ArrayLike<number>, inverseBind: ArrayLike<number>): number[] {
    const out = new Array<number>(9);
    for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 3; r++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += world[k * 4 + r] * inverseBind[c * 4 + k];
            out[c * 3 + r] = s;
        }
    }
    return out;
}

function turn(m: number[], v: V3): V3 {
    const x = m[0] * v[0] + m[3] * v[1] + m[6] * v[2];
    const y = m[1] * v[0] + m[4] * v[1] + m[7] * v[2];
    const z = m[2] * v[0] + m[5] * v[1] + m[8] * v[2];
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
}

/** The frame an anime material turns with, for the head's skin matrix `m` (mesh space at rest to the world). */
export function animeHeadFrame(m: number[], a: Pick<AnimeValues, 'front' | 'up' | 'frontTilt'>): AnimeHead {
    const right = turn(m, animeRight(a.front, a.up));
    return {
        x: right,
        y: turn(m, animeUp(a.up)),
        z: turn(m, animeFront(a.front, a.up)),
        front: turn(m, animeFaceFront(a.front, a.up, a.frontTilt)),
        right,
    };
}

export class AnimeHeadFrame {
    private joint: Object3D | null;

    constructor(
        private animator: AnimatorComponent,
        private head: { name: string; inverseBind: Float32Array },
        private materials: () => { material: Material; anime: AnimeValues }[],
    ) {
        this.joint = animator.getJointObject(head.name) ?? null;
        animator.addIK(this);
    }

    dispose() {
        this.animator.removeIK(this);
    }

    /** Called by the animator once the clip has posed the bones. */
    solve() {
        if (!this.joint) return;
        const m = rotationOf(this.joint.transform.worldMatrix.rawData, this.head.inverseBind);
        for (const { material, anime } of this.materials()) {
            if (anime.kind !== 'face' && anime.kind !== 'hair' && anime.kind !== 'eye') continue;
            setAnimeHead(material, animeHeadFrame(m, anime));
        }
    }
}
