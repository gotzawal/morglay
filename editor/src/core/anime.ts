// The anime material's settings as the engine uses them: every field has a
// value. A material stores only what was set; the rest comes from its kind
// (skin shades warm with an edge tint, hair has its strand lobes, an eye
// takes no cast shadows and has no outline), and what a kind leaves alone
// from the schema's defaults (the cloth kind's).

import { Anime, ANIME_KINDS, type AnimeDoc, type AnimeKind } from './model';
import { fieldDefault } from './schema';

/**
 * Constants of the cel shading's own model that other code has to agree with: engine/celShading.ts
 * draws with them and core/vrm.ts converts MToon through them (CEL-SHADING.md, section 2, says what
 * each changes).
 */
export const CEL_SHADING = {
    /** The form shadow: this much of the shade color the settings make. */
    formShade: 0.75,
    /** Cloth's form shadow this much lighter. */
    clothShade: 1.1,
    /** Outline 1: this many meters wide at a meter's distance. */
    lineWidth: 0.00125,
    /** The power of the distance by which outlines thin on the screen (perspective's would be 1). */
    lineThinning: 0.75,
    /** An outline's color: the base color at this much of Outline Brightness. */
    lineShare: 0.35,
} as const;

/** An anime material's settings, each with a value. */
export type AnimeValues = Required<AnimeDoc>;
/** The stored form: only `kind` (it may be missing on a model's slot) and what was set. */
export type AnimeInput = Partial<AnimeDoc> | null | undefined;

export const ANIME_KIND_LABELS: Record<AnimeKind, string> = { cloth: 'Cloth', skin: 'Skin', face: 'Face', hair: 'Hair', eye: 'Eye', overlay: 'Overlay' };

/** Every field at the schema's default: the cloth kind. */
const BASE = Object.fromEntries(Object.entries(Anime.unwrap().shape).map(([k, s]) => [k, fieldDefault(s)])) as AnimeValues;

/** Skin: a warmer, more saturated shade, an edge tint and a soft sheen. */
const SKIN: Partial<AnimeValues> = {
    shadeBrightness: 0.65,
    shadeSaturation: 1.3,
    shadeTint: [1.15, 0.95, 0.85],
    edge: 0.6,
    reflectance: 0.5,
};

/** What each kind changes from the cloth kind. */
export const ANIME_KIND_PRESETS: Record<AnimeKind, Partial<AnimeValues>> = {
    cloth: {},
    skin: SKIN,
    // A face shades as the body's skin does, so no seam shows where the two meet; a thinner line.
    face: { ...SKIN, outline: 0.4 },
    hair: {
        hair: 0.9,
        hairShift2: 0.42,
        hairFacing: 4,
        outline: 0.4,
        outlineBrightness: 0.55,
        outlineSaturation: 1.1,
    },
    eye: {
        shadeBrightness: 0.65,
        shadeSaturation: 1.3,
        shadows: 0,
        highlight: 'none',
        saturateLit: false,
        outline: 0,
    },
    overlay: {
        shadows: 0,
        highlight: 'none',
        saturateLit: false,
        outline: 0,
    },
};

const isKind = (v: unknown): v is AnimeKind => typeof v === 'string' && (ANIME_KINDS as readonly string[]).includes(v);

/** The settings of an anime material: what it sets, over its kind's values, over the defaults. */
export function resolveAnime(doc: AnimeInput): AnimeValues {
    const kind = isKind(doc?.kind) ? doc.kind : 'cloth';
    const out: Record<string, unknown> = { ...BASE, ...ANIME_KIND_PRESETS[kind], kind };
    for (const [k, v] of Object.entries(doc ?? {})) if (v !== undefined && k in BASE) out[k] = v;
    out.kind = kind;
    return out as AnimeValues;
}

/** What the kind gives a field (what it shows when it is not set). */
export function animeKindValue<K extends keyof AnimeValues>(kind: AnimeKind, key: K): AnimeValues[K] {
    return (key in ANIME_KIND_PRESETS[kind] ? ANIME_KIND_PRESETS[kind][key] : BASE[key]) as AnimeValues[K];
}

/** The settings as stored: fields equal to what the kind gives are left out. */
export function compactAnime(values: Partial<AnimeValues> & { kind?: AnimeKind }): AnimeDoc {
    const kind = isKind(values.kind) ? values.kind : 'cloth';
    const out: Record<string, unknown> = { kind };
    for (const [k, v] of Object.entries(values)) {
        if (k === 'kind' || v === undefined || !(k in BASE)) continue;
        if (JSON.stringify(v) !== JSON.stringify(animeKindValue(kind, k as keyof AnimeValues))) out[k] = v;
    }
    return out as AnimeDoc;
}

const AXES: Record<AnimeValues['front'], [number, number, number]> = {
    '+x': [1, 0, 0],
    '-x': [-1, 0, 0],
    '+y': [0, 1, 0],
    '-y': [0, -1, 0],
    '+z': [0, 0, 1],
    '-z': [0, 0, -1],
};

/** The head's up axis in a mesh's own space. */
export function animeUp(axis: AnimeValues['up']): [number, number, number] {
    return AXES[axis] ?? AXES['+y'];
}

/**
 * The head's forward axis in a mesh's own space. A front along the up axis
 * is no front: it falls back to the axis such meshes face (+Z of a Y-up
 * mesh, -Y of a Z-up one).
 */
export function animeFront(axis: AnimeValues['front'], up: AnimeValues['up'] = '+y'): [number, number, number] {
    const f = AXES[axis] ?? AXES['+z'];
    const u = animeUp(up);
    if (Math.abs(f[0] * u[0] + f[1] * u[1] + f[2] * u[2]) > 0.5) return up === '+z' ? AXES['-y'] : AXES['+z'];
    return f;
}

/**
 * The face's front in a mesh's own space: the Front Axis leaned down (away
 * from the Up Axis) by `tilt` degrees.
 */
export function animeFaceFront(axis: AnimeValues['front'], up: AnimeValues['up'], tilt: number): [number, number, number] {
    const f = animeFront(axis, up);
    const u = animeUp(up);
    const t = (tilt * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [f[0] * c - u[0] * s, f[1] * c - u[1] * s, f[2] * c - u[2] * s];
}

/** The head's right in a mesh's own space: up × front. */
export function animeRight(axis: AnimeValues['front'], up: AnimeValues['up']): [number, number, number] {
    const f = animeFront(axis, up);
    const u = animeUp(up);
    // + 0 turns a -0 into 0.
    return [u[1] * f[2] - u[2] * f[1] + 0, u[2] * f[0] - u[0] * f[2] + 0, u[0] * f[1] - u[1] * f[0] + 0];
}

/**
 * The texture fields of the anime settings, the ones a material can least do
 * without first (a pass has room for ANIME_MAP_BUDGET of the surface's), and
 * how each is read: colors are decoded from sRGB, data is taken as it is.
 */
export const ANIME_MAP_KEYS = ['rampMap', 'faceMap', 'shadeLut', 'faceMaskMap', 'specularMap', 'hairMap', 'faceGlowMap', 'matcapMap', 'overlayMap', 'outlineMap'] as const;
export type AnimeMapKey = (typeof ANIME_MAP_KEYS)[number];
export const ANIME_MAP_ROLES: Record<AnimeMapKey, 'color' | 'lookup'> = {
    rampMap: 'lookup',
    faceMap: 'lookup',
    shadeLut: 'lookup',
    faceMaskMap: 'lookup',
    specularMap: 'lookup',
    hairMap: 'lookup',
    faceGlowMap: 'lookup',
    matcapMap: 'color',
    overlayMap: 'lookup',
    outlineMap: 'lookup',
};

/** How a map of some settings is read. */
export function animeMapRole(key: AnimeMapKey, _a?: unknown): 'color' | 'lookup' {
    return ANIME_MAP_ROLES[key];
}
/** The outline's own map is read by the outline pass, which has room of its own. */
export const ANIME_OUTLINE_MAP_KEYS: readonly AnimeMapKey[] = ['outlineMap'];
/**
 * How many of the surface's maps of ANIME_MAP_KEYS one material shows: a
 * pass samples 16 textures and the lights, shadows, sky and PBR maps take ten.
 */
export const ANIME_MAP_BUDGET = 6;

/** The maps of the settings a material shows, most needed first, with the ones past the budget left out. */
export function animeMapsShown(a: Partial<Record<AnimeMapKey, string | null | undefined>> | null | undefined): Set<AnimeMapKey> {
    const shown = new Set<AnimeMapKey>();
    let surface = 0;
    for (const key of ANIME_MAP_KEYS) {
        if (!a?.[key]) continue;
        if (ANIME_OUTLINE_MAP_KEYS.includes(key)) shown.add(key);
        else if (surface++ < ANIME_MAP_BUDGET) shown.add(key);
    }
    return shown;
}

/**
 * A guess at what a material is on a character, from its name and the names
 * of the meshes showing it (model files name them in many languages and
 * habits): for setting up a whole model at once. Unknown names are cloth.
 */
export function guessAnimeKind(...names: (string | undefined)[]): AnimeKind {
    const text = names.filter(Boolean).join(' ');
    // Words of the names: "HairBack_00_HAIR" is hair, back, 00, hair. Whole words only, so "Footwear" has no ear.
    const words = new Set(
        text
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
    );
    const any = (list: string) => list.split(' ').some((w) => words.has(w));
    const cjk = (re: RegExp) => re.test(text);
    // Clothes and props whose names hold a body or face character (a seam's 目, a cuff's 口, a
    // glove's 手, a tabi's 足, gym clothes' 体, a mask's 面, a hair ornament's 髪) are cloth.
    if (cjk(/縫い目|袖口|手袋|足袋|体操服|仮面|髪飾|飾り|服|靴/)) return 'cloth';
    // Brows, lashes and eyelines lie on the face and are drawn as it is.
    if (any('brow brows eyebrow eyebrows lash lashes eyelash eyelashes eyeline eyeliner') || cjk(/眉|まゆ|睫|まつげ|まつ毛|二重/)) return 'face';
    if (any('eye eyes iris pupil pupils sclera eyeball eyeballs') || cjk(/瞳|眼|白目|目/)) return 'eye';
    // Japanese 髪, Chinese 发 / 髮.
    if (any('hair hairs bangs ponytail twintail twintails braid braids ahoge fringe') || cjk(/髪|かみ|发|髮/)) return 'hair';
    // A mask (面具) is not the face (面).
    if (any('face facial mouth lip lips teeth tooth tongue cheek cheeks head') || cjk(/顔|口|歯|舌|表情|面(?!具)/)) return 'face';
    if (any('skin body hand hands arm arms leg legs foot feet neck ear ears') || cjk(/肌|体|手|足|腕|脚|皮肤/)) return 'skin';
    return 'cloth';
}
