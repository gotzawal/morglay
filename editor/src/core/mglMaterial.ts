// The character format's material (editor/CHARACTERS.md sections 2 and 4):
// the anime material's settings (core/anime.ts) with its own maps as the file's
// textures, and the layer it draws in.
//
// Layers name what the stencil marks and draw orders of a layered character do
// (eyes seen through hair, shadows painted onto skin), so files carry no engine
// numbers; layerPass gives back the exact pass state the editor's slots use, and
// layerOfPass reads a slot's pass state as a layer again.

import { ANIME_MAP_KEYS, compactAnime, type AnimeMapKey } from './anime';
import type { AnimeDoc, MaterialOverride, SlotPassDoc, StencilTestDoc } from './model';

export const DRAW_LAYERS = ['body', 'eye', 'hair', 'afterHair', 'overlay', 'hairOver', 'transparent'] as const;
export type DrawLayer = (typeof DRAW_LAYERS)[number];
/** What an overlay may darken: the marks the layers below leave. */
export const OVERLAY_MARKS = ['body', 'eye', 'hair'] as const;
export type OverlayMark = (typeof OVERLAY_MARKS)[number];

export interface MglDraw {
    layer: DrawLayer;
    /** An overlay's marks (default: all three). */
    target?: OverlayMark[];
    /** An overlay's depth offset toward the camera, in depth steps (default -1). */
    depthBias?: number;
}

// The marks, as stencil bits: 1 says a character drew here, 2 an eye, 4 hair. Only these three
// bits are written, so other users of the stencil keep the rest.
const CHARACTER = 1;
const EYE_BIT = 2;
const HAIR_BIT = 4;
const MARKS = CHARACTER | EYE_BIT | HAIR_BIT;
const BODY: StencilTestDoc = { ref: CHARACTER, read: MARKS, write: MARKS, compare: 'always', pass: 'replace' };
const EYE: StencilTestDoc = { ref: CHARACTER | EYE_BIT, read: MARKS, write: MARKS, compare: 'always', pass: 'replace' };
// Hair draws where no eye is (so eyes show through it), marking its own bits and leaving the eye bit be.
const HAIR: StencilTestDoc = { ref: CHARACTER | HAIR_BIT, read: EYE_BIT, write: CHARACTER | HAIR_BIT, compare: 'equal', pass: 'replace' };
const NOT_EYE: StencilTestDoc = { ref: EYE_BIT, read: EYE_BIT, write: 0, compare: 'not-equal', pass: 'keep' };

/**
 * Draw orders of the layers drawn after the opaque ones, in the order they go: hair, what goes over
 * it, the overlays (their order among themselves does not matter: they multiply), hair over the
 * eyes, see-through parts last.
 */
export const LAYER_ORDER = { hair: 3200, afterHair: 3210, overlay: 3300, hairOver: 3400, transparent: 3500 } as const;

/** The stencil test of an overlay that darkens only where `marks` are (one equal test: some sets cannot be told apart). */
function overlayStencil(marks: readonly OverlayMark[] | undefined): StencilTestDoc | undefined {
    const m = new Set(marks?.length ? marks : OVERLAY_MARKS);
    const test = (ref: number, read: number): StencilTestDoc => ({ ref, read, write: 0, compare: 'equal', pass: 'keep' });
    const b = m.has('body'), e = m.has('eye'), h = m.has('hair');
    if (b && e && h) return test(CHARACTER, CHARACTER);
    if (b && h) return test(CHARACTER, CHARACTER | EYE_BIT);
    if (b && e) return test(CHARACTER, CHARACTER | HAIR_BIT);
    if (b) return test(CHARACTER, MARKS);
    if (e) return test(CHARACTER | EYE_BIT, CHARACTER | EYE_BIT);
    if (h) return test(CHARACTER | HAIR_BIT, MARKS);
    return test(CHARACTER, CHARACTER);
}

/**
 * An overlay's draw order: cards that darken the body only go after the others. Multiplying is the
 * same in any order but for rounding; a fixed order keeps every frame the same.
 */
function overlayOrder(marks: readonly OverlayMark[] | undefined): number {
    const bodyOnly = !!marks?.length && marks.every((m) => m === 'body');
    return LAYER_ORDER.overlay + (bodyOnly ? 10 : 0);
}

/** The pass state of a layer: what the editor's slots of a layered character use. */
export function layerPass(draw: MglDraw): SlotPassDoc {
    switch (draw.layer) {
        case 'eye':
            return { stencil: { ...EYE } };
        case 'hair':
            return { order: LAYER_ORDER.hair, stencil: { ...HAIR }, outlineDepthCompare: 'less', outlineStencil: { ...NOT_EYE } };
        case 'afterHair':
            return { order: LAYER_ORDER.afterHair, stencil: { ...BODY } };
        case 'overlay':
            return { order: overlayOrder(draw.target), depthWrite: false, depthBias: draw.depthBias ?? -1, depthBiasSlope: -1, stencil: overlayStencil(draw.target) };
        case 'hairOver':
            return { order: LAYER_ORDER.hairOver, depthCompare: 'less', depthWrite: true, outlineDepthCompare: 'less', outlineStencil: { ...NOT_EYE } };
        case 'transparent':
            return { order: LAYER_ORDER.transparent, depthWrite: false };
        default:
            return { stencil: { ...BODY } };
    }
}

/** The marks an overlay's stencil test lets it darken. */
function marksOf(s: StencilTestDoc | undefined): OverlayMark[] {
    if (!s || s.compare !== 'equal') return [...OVERLAY_MARKS];
    const key = `${s.ref & s.read}/${s.read}`;
    const known: Record<string, OverlayMark[]> = {
        [`${CHARACTER}/${CHARACTER}`]: ['body', 'eye', 'hair'],
        [`${CHARACTER}/${CHARACTER | EYE_BIT}`]: ['body', 'hair'],
        [`${CHARACTER}/${CHARACTER | HAIR_BIT}`]: ['body', 'eye'],
        [`${CHARACTER}/${MARKS}`]: ['body'],
        [`${CHARACTER | EYE_BIT}/${CHARACTER | EYE_BIT}`]: ['eye'],
        [`${CHARACTER | HAIR_BIT}/${MARKS}`]: ['hair'],
    };
    return known[key] ?? [...OVERLAY_MARKS];
}

/** A slot's layer, read from its pass state (and its alpha mode and kind). */
export function layerOfPass(o: Pick<MaterialOverride, 'pass' | 'alphaMode' | 'anime'>): MglDraw {
    const p = o.pass;
    if (o.anime?.kind === 'overlay' || o.alphaMode === 'multiply') {
        const draw: MglDraw = { layer: 'overlay', target: marksOf(p?.stencil) };
        if (p?.depthBias !== undefined && p.depthBias !== -1) draw.depthBias = p.depthBias;
        return draw;
    }
    if (!p) return { layer: 'body' };
    if (p.order === LAYER_ORDER.hairOver || (p.depthCompare === 'less' && p.depthWrite)) return { layer: 'hairOver' };
    if (p.stencil?.ref === HAIR.ref && p.stencil.compare === 'equal') return { layer: 'hair' };
    if (p.stencil?.ref === EYE.ref) return { layer: 'eye' };
    if (p.order !== undefined && p.order >= 3000 && p.order < LAYER_ORDER.overlay && p.stencil?.ref === BODY.ref) return { layer: 'afterHair' };
    if (p.order !== undefined && p.order >= LAYER_ORDER.transparent && p.depthWrite === false) return { layer: 'transparent' };
    return { layer: 'body' };
}

/** A value as JSON with its keys sorted (undefined fields left out): for comparing. */
const canonical = (v: unknown): string =>
    v === null || typeof v !== 'object'
        ? JSON.stringify(v)
        : Array.isArray(v)
          ? `[${v.map(canonical).join(',')}]`
          : `{${Object.entries(v as Record<string, unknown>)
                .filter(([, x]) => x !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
                .join(',')}}`;

/** Whether a pass state is exactly what its layer gives (else the file cannot say it). */
export function passIsLayer(pass: SlotPassDoc | undefined, draw: MglDraw): boolean {
    const want = layerPass(draw);
    const got = pass ?? {};
    // An overlay's order among overlays does not change what it shows (they multiply).
    return canonical(draw.layer === 'overlay' ? { ...got, order: want.order } : got) === canonical(want);
}

// ---------------------------------------------------------------- the settings with their maps

/** Anime settings whose maps are named some other way (asset ids <-> textures <-> images). */
export type AnimeWith<T> = Omit<AnimeDoc, AnimeMapKey> & Partial<Record<AnimeMapKey, T | null>>;

/** The same settings with every map named another way; the other values are copied. */
export function mapAnimeMaps<A, B>(doc: AnimeWith<A> | Partial<AnimeWith<A>>, f: (t: A, key: AnimeMapKey) => B | null): AnimeWith<B> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc ?? {})) {
        if ((ANIME_MAP_KEYS as readonly string[]).includes(k)) out[k] = v === null || v === undefined ? v : f(v as A, k as AnimeMapKey);
        else out[k] = v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out as AnimeWith<B>;
}

/** The stored form of settings (only what differs from the kind's values), maps kept as they are named. */
export function compactAnimeWith<T>(doc: AnimeWith<T>): AnimeWith<T> {
    const maps: Partial<Record<AnimeMapKey, T | null>> = {};
    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc ?? {})) {
        if ((ANIME_MAP_KEYS as readonly string[]).includes(k)) {
            if (v !== undefined && v !== null) maps[k as AnimeMapKey] = v as T;
        } else plain[k] = v;
    }
    return { ...(compactAnime(plain as AnimeDoc) as Omit<AnimeDoc, AnimeMapKey>), ...maps } as AnimeWith<T>;
}

/** The file's material extension: the settings, maps as textures, and the layer. */
export interface MglMaterialExt<T> {
    anime: AnimeWith<T>;
    draw: MglDraw;
}

/** The extension's JSON (settings at the top, the layer under `draw`). */
export function materialJson<T>(m: MglMaterialExt<T>): Record<string, unknown> {
    const draw: Record<string, unknown> = { layer: m.draw.layer };
    if (m.draw.layer === 'overlay') {
        const target = m.draw.target ?? [...OVERLAY_MARKS];
        if (target.length !== OVERLAY_MARKS.length) draw.target = [...target];
        if (m.draw.depthBias !== undefined && m.draw.depthBias !== -1) draw.depthBias = m.draw.depthBias;
    }
    return { ...compactAnimeWith(m.anime), ...(m.draw.layer === 'body' ? {} : { draw }) };
}

/** The extension read back: settings and layer (a missing layer is the body's). */
export function materialOfJson<T>(json: Record<string, any>): MglMaterialExt<T> {
    const { draw, ...anime } = json ?? {};
    const layer: DrawLayer = (DRAW_LAYERS as readonly string[]).includes(draw?.layer) ? draw.layer : 'body';
    const out: MglDraw = { layer };
    if (layer === 'overlay') {
        if (Array.isArray(draw?.target)) out.target = draw.target.filter((m: unknown) => (OVERLAY_MARKS as readonly unknown[]).includes(m));
        if (typeof draw?.depthBias === 'number') out.depthBias = draw.depthBias;
    }
    return { anime: anime as AnimeWith<T>, draw: out };
}
