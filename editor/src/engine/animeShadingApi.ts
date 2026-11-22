import type { Material } from '@orillusion/core';
import type { AnimeInput, AnimeMapKey, AnimeValues } from '../core/anime';
import type { TextureRole } from '../core/types';

/** A texture of an anime material that can come from a texture asset: which field, which texture of the shader, how it is read. */
export interface AnimeMapSlot {
    key: AnimeMapKey;
    slot: string;
    role: TextureRole;
    /** Shader define that turns the map on. */
    define: string;
}

/** The head's frame in the world for an anime material: its right, up and front axes, and the face's front and right. */
export interface AnimeHead {
    x: [number, number, number];
    y: [number, number, number];
    z: [number, number, number];
    front: [number, number, number];
    right: [number, number, number];
}

/**
 * A cel shading for the anime material: how its passes are made and how the settings reach them.
 * The editor's own is engine/celShading.ts; a local shading pack can stand in for it (vite.config.js).
 */
export interface AnimeShading {
    /** A name for the console. */
    name: string;
    /** A new material; with `outline` it has the outline pass too. */
    createAnimeMaterial(ctx: any, outline: boolean): Material;
    /** Writes the settings into a material made by createAnimeMaterial. */
    applyAnime(mat: Material, a: AnimeValues, transparent: boolean): void;
    /** The head's frame, per frame (faces, hair and eyes turn with it). */
    setAnimeHead(mat: Material, head: AnimeHead): void;
    /** Cut-out drawing (the Mask alpha mode). */
    setAnimeCutout(mat: Material, cutout: boolean): void;
    /** Takes over the normal, mask and emission maps of the model material it replaces. */
    inheritModelMaps(mat: Material, source: Material, ctx: any): void;
    /** The settings' maps and the shader textures they go to. */
    maps: AnimeMapSlot[];
    /** Every define of the passes (each has a value before the first compile). */
    defines: readonly string[];
    /** The full WGSL of the two passes. */
    sources(): { surface: string; outline: string };
}

/** What the editor hands a shading: its settings resolver and the engine's material plumbing. */
export interface ShadingDeps {
    resolveAnime: (a: AnimeInput) => AnimeValues;
    /** The engine's uniform fields every material struct starts with. */
    ENGINE_FIELDS: string;
    /** Gives a new shader the engine's default textures and defines. */
    setEngineDefaults: (shader: any, ctx: any) => void;
}
