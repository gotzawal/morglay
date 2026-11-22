import type { Material } from '@orillusion/core';
import { makeShading } from 'virtual:morglay-shading-pack';
import { animeMapRole, animeMapsShown, resolveAnime, type AnimeInput, type AnimeValues } from '../core/anime';
import type { AnimeHead, AnimeMapSlot, AnimeShading } from './animeShadingApi';
import { makeCelShading } from './celShading';
import { ENGINE_FIELDS, setEngineDefaults } from './shaders';

// The anime material: cel shading for characters. The shading itself (its passes, uniforms and
// WGSL) is engine/celShading.ts; a local shading pack that the dev server was given stands in for
// it (vite.config.js, shadingPack). Everything else here is the same for both.

export type { AnimeHead, AnimeMapSlot } from './animeShadingApi';

const deps = { resolveAnime, ENGINE_FIELDS, setEngineDefaults };

/** `?shading=own` in the page address leaves a local shading pack out (to compare the two). */
const ownOnly = typeof location !== 'undefined' && new URLSearchParams(location.search).get('shading') === 'own';

/** The cel shading in use. */
export const shading: AnimeShading = (!ownOnly && makeShading?.(deps)) || makeCelShading(deps);
if (makeShading && !ownOnly) console.info(`[editor] Anime materials use the local shading pack (${shading.name}).`);

/** The cel shading's own maps (AnimeDoc fields) and the shader textures they go to. */
export const ANIME_MAPS: AnimeMapSlot[] = shading.maps;
/** The defines of the two passes: every one has a value before the first compile. */
export const ANIME_DEFINES: readonly string[] = shading.defines;
/** The full sources of the two passes. */
export const animeSources = (): { surface: string; outline: string } => shading.sources();
/** A new anime material. With `outline` it has the outline pass too; a material without one (an eye, a width of 0) draws once. */
export const createAnimeMaterial = (ctx: any, outline: boolean): Material => shading.createAnimeMaterial(ctx, outline);
/** Writes the cel shading settings into an anime material. */
export const applyAnime = (mat: Material, a: AnimeValues, transparent: boolean): void => shading.applyAnime(mat, a, transparent);
/** Sets the head's frame an anime material turns faces, hair and eyes with (per frame, from the head bone). */
export const setAnimeHead = (mat: Material, head: AnimeHead): void => shading.setAnimeHead(mat, head);
/** A cut-out anime material (the Mask alpha mode): cut edges by alpha to coverage where the scene is multisampled. */
export const setAnimeCutout = (mat: Material, cutout: boolean): void => shading.setAnimeCutout(mat, cutout);
/** Gives a new anime material the normal, metallic-roughness and emission maps of the model material it replaces. */
export const inheritModelMaps = (mat: Material, source: Material, ctx: any): void => shading.inheritModelMaps(mat, source, ctx);

/** Whether an anime material draws its outline: a width above 0 (see-through ones too: their Outline sets it). */
export function animeOutlined(a: Pick<AnimeValues, 'outline'>, _transparent?: boolean): boolean {
    return a.outline > 0;
}

/**
 * The cel shading's maps as some settings show them: each slot with how its
 * texture is read (core/anime.ts animeMapRole) and the texture asset it
 * shows, the settings' own as far as a pass has room (animeMapsShown). The
 * ones past that are left out and named once in the console.
 */
export function animeMapAssets(a: AnimeInput): { map: AnimeMapSlot; asset: string | null }[] {
    const shown = animeMapsShown(a);
    const dropped = ANIME_MAPS.filter((m) => a?.[m.key] && !shown.has(m.key)).map((m) => m.key);
    if (dropped.length) warnOnce(`An anime material has more maps than one pass can sample: ${dropped.join(', ')} left out.`);
    return ANIME_MAPS.map((m) => ({ map: { ...m, role: animeMapRole(m.key, a) }, asset: shown.has(m.key) ? (a?.[m.key] ?? null) : null }));
}

const warned = new Set<string>();
function warnOnce(message: string) {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
}
