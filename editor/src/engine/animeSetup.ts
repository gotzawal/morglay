import { VertexAttributeName } from '@orillusion/core';
import { compactAnime, guessAnimeKind } from '../core/anime';
import type { AnimeDoc, AnimeKind, Vec3 } from '../core/types';
import type { ModelInfo, ModelPart } from './modelParts';

// Setting a whole model up as an anime character: every material slot gets
// cel shading of the kind its name says (face, hair, eye, skin, cloth), and
// the kinds that turn with the head (face, hair, eye) learn where the head
// is and which way it faces, measured from the face's own meshes.

type Axis = NonNullable<AnimeDoc['front']>;
type Up = NonNullable<AnimeDoc['up']>;

const UNNAMED = /^Material \d+$/;

function attribute(part: ModelPart, name: string): ArrayLike<number> | null {
    return (part.renderer.geometry?.getAttribute(name)?.data as ArrayLike<number> | undefined) ?? null;
}

/** The middle of the box around some parts' vertices, in the meshes' own space. */
function middle(parts: ModelPart[]): Vec3 | null {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
        const pos = attribute(part, VertexAttributeName.position);
        if (!pos) continue;
        for (let i = 0; i + 2 < pos.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                const v = pos[i + k];
                if (v < lo[k]) lo[k] = v;
                if (v > hi[k]) hi[k] = v;
            }
        }
    }
    if (!Number.isFinite(lo[0])) return null;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return [r((lo[0] + hi[0]) / 2), r((lo[1] + hi[1]) / 2), r((lo[2] + hi[2]) / 2)];
}

/**
 * Which way some parts face: the level axis most of their normals point
 * along. Level is square to `up`: x and z of a Y-up mesh, x and y of a Z-up one.
 */
function facing(parts: ModelPart[], up: Up = '+y'): Axis | null {
    const sum = [0, 0, 0];
    for (const part of parts) {
        const n = attribute(part, VertexAttributeName.normal);
        if (!n) continue;
        for (let i = 0; i + 2 < n.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += n[i + k];
    }
    const depth = up === '+z' ? 1 : 2;
    const x = sum[0];
    const d = sum[depth];
    if (Math.abs(x) < 1e-6 && Math.abs(d) < 1e-6) return null;
    const name = depth === 1 ? 'y' : 'z';
    return (Math.abs(d) >= Math.abs(x) ? `${d >= 0 ? '+' : '-'}${name}` : x >= 0 ? '+x' : '-x') as Axis;
}

/**
 * Which axis of the skinned meshes' space points up: the one the head lies
 * along from the middle of the whole figure. A skinned mesh keeps the axes
 * its vertices were stored with (its skin turns it upright), and some are
 * stored Z-up.
 */
function upAxis(head: ModelPart[], all: ModelPart[]): Up {
    const top = middle(head);
    const mid = middle(all);
    if (!top || !mid) return '+y';
    const dy = top[1] - mid[1];
    const dz = top[2] - mid[2];
    return dz > Math.abs(dy) && dz > Math.abs(top[0] - mid[0]) ? '+z' : '+y';
}

/** The kind of a slot, from its material's name (from its meshes' names when the file left the material unnamed). */
export function slotAnimeKind(info: ModelInfo, key: string): AnimeKind {
    const slot = info.slot(key);
    if (!slot || !UNNAMED.test(key)) return guessAnimeKind(key);
    return guessAnimeKind(...slot.parts.map((p) => info.part(p)?.name));
}

/**
 * Cel shading for every slot of a model, as the overrides to store: the
 * kind of each, and for faces, hair and eyes the head's front and up axes.
 * The head is where the face's meshes are (the eyes', then the hair's, when
 * no slot is a face); a slot whose meshes are not skinned measures its own.
 */
export function animeSetup(info: ModelInfo): Record<string, AnimeDoc> {
    const kinds = new Map(info.slots.map((s) => [s.key, slotAnimeKind(info, s.key)]));
    const partsOf = (kind: AnimeKind, skinned: boolean) => info.parts.filter((p) => kinds.get(p.slot) === kind && p.skinned === skinned);
    // Skinned meshes share one space (the pose they were bound in), so one head serves them all.
    const head = (['face', 'eye', 'hair'] as const).map((k) => partsOf(k, true)).find((list) => list.length) ?? [];
    const up = upAxis(head, info.parts.filter((p) => p.skinned));
    const front = facing(partsOf('face', true), up) ?? facing(partsOf('eye', true), up);
    const out: Record<string, AnimeDoc> = {};
    for (const slot of info.slots) {
        const kind = kinds.get(slot.key)!;
        const values: Partial<AnimeDoc> & { kind: AnimeKind } = { kind };
        if (kind === 'face' || kind === 'hair' || kind === 'eye') {
            const own = slot.parts.map((p) => info.part(p)).filter((p): p is ModelPart => !!p);
            const skinned = own.some((p) => p.skinned);
            // A mesh that is not skinned stands as its node places it: Y-up, as the scene.
            const toward = skinned ? front : facing(own);
            if (toward) values.front = toward;
            if (skinned) values.up = up;
        }
        out[slot.key] = compactAnime(values);
    }
    return out;
}
