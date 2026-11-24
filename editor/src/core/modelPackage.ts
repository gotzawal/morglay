// A model package dropped as a .zip, as it came (a PMX with its texture folders, a
// glTF with its buffers and images, a VRM): unpacked into the files the import
// takes, as if they had been dropped together. A project file (.zip with a
// project.json at its root) is not a package.
//
// The files keep their paths in the package (packagePathOf), so a model that names
// a texture through folders gets that one when two folders hold a file of the same
// name. Names the zip does not mark as UTF-8 are read in the encoding that matches
// most of the texture names the package's PMX models give (their names are stored
// as Unicode in the PMX), else in the first encoding that reads them all.

import { isPmx, parsePmx } from './pmx';
import { listZip, zipEntryName, zipNameEncodings, type ZipListing } from './zip';

/**
 * What the import pickers offer for models: the model files, a package of them as a .zip,
 * and the files a glTF or PMX names (picked together with it).
 */
export const MODEL_FILES = '.glb,.gltf,.vrm,.pmx,.zip,.bin,image/*,.bmp,.tga,.spa,.sph';

/** Model files the import takes. */
const MODEL = /\.(pmx|gltf|glb|vrm)$/i;
/** Files a model may name: buffers and images (MMD's sphere maps are images named .spa / .sph). */
const PART = /\.(bin|png|jpe?g|bmp|gif|webp|avif|ktx2|tga|dds|spa|sph)$/i;
/** What zip tools of other systems add. */
const JUNK = /(^|[\\/])(__MACOSX[\\/]|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

const paths = new WeakMap<File, string>();

/** A file's path in the package it came from, or in the folder a browser picked it from. */
export function packagePathOf(file: File): string {
    return paths.get(file) ?? (file.webkitRelativePath || file.name);
}

/** A path with forward slashes, without a leading ./ or slash, in lower case: for comparing. */
export function comparablePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
}

/**
 * Of the files named like the last part of `path`, the one whose own path ends with `path`
 * (the model's folder above it may differ); else the first of that name.
 */
export function fileByPath(files: readonly File[], path: string): File | undefined {
    const want = comparablePath(path);
    const name = want.split('/').pop()!;
    const same = files.filter((f) => f.name.toLowerCase() === name);
    if (same.length < 2) return same[0];
    return same.find((f) => {
        const own = comparablePath(packagePathOf(f));
        return own === want || own.endsWith(`/${want}`);
    }) ?? same[0];
}

export interface ModelPackage {
    /** The model files and the files they may name, each named by the last part of its path. */
    files: File[];
    /** The paths of the model files. */
    models: string[];
    /** How names the zip does not mark were read. */
    encoding: string;
    /** Paths left out: other formats, readme files, what zip tools add. */
    skipped: string[];
}

const baseName = (path: string) => path.split(/[\\/]/).pop()!;

/** The type a file of the package gets, by its extension. */
function typeOf(name: string): string {
    const ext = name.split('.').pop()!.toLowerCase();
    const types: Record<string, string> = {
        glb: 'model/gltf-binary', vrm: 'model/gltf-binary', gltf: 'model/gltf+json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ktx2: 'image/ktx2',
    };
    return types[ext] ?? 'application/octet-stream';
}

/**
 * Of the encodings every name reads in, the one under which the most texture names the
 * PMX models give are file names of the package (ties keep the encodings' order).
 */
export function encodingForTextures(entries: readonly ZipListing[], encodings: readonly string[], textures: readonly string[]): string {
    if (encodings.length < 2 || !textures.length) return encodings[0] ?? 'utf-8';
    const wanted = textures.map((t) => baseName(t).toLowerCase());
    let best = encodings[0];
    let bestScore = -1;
    for (const encoding of encodings) {
        const names = new Set(entries.map((e) => baseName(zipEntryName(e, encoding)).toLowerCase()));
        const score = wanted.filter((t) => names.has(t)).length;
        if (score > bestScore) {
            best = encoding;
            bestScore = score;
        }
    }
    return best;
}

/**
 * The model package in a .zip, unpacked; null when the zip is a project file (a
 * project.json at its root). A zip without a model gives a package without models.
 */
export async function unpackModelPackage(zip: Blob): Promise<ModelPackage | null> {
    const entries = (await listZip(zip)).filter((e) => !e.folder);
    const encodings = zipNameEncodings(entries);
    const first = encodings[0] ?? 'utf-8';
    if (entries.some((e) => zipEntryName(e, first) === 'project.json')) return null;
    const read = new Map<ZipListing, Blob>();
    const data = async (e: ZipListing) => {
        let blob = read.get(e);
        if (!blob) read.set(e, (blob = await e.read()));
        return blob;
    };
    // PMX models name their textures in Unicode: the reading of the zip's names that finds them.
    const textures: string[] = [];
    if (encodings.length > 1) {
        for (const e of entries) {
            if (!/\.pmx$/i.test(zipEntryName(e, first))) continue;
            try {
                const buffer = await (await data(e)).arrayBuffer();
                if (isPmx(buffer)) textures.push(...parsePmx(buffer).textures);
            } catch {
                // An unreadable model is reported by the import.
            }
        }
    }
    const encoding = encodingForTextures(entries, encodings, textures);
    const named = entries.map((e) => ({ e, path: zipEntryName(e, encoding) })).filter(({ path }) => !JUNK.test(path));
    // Only a PMX or a .gltf names other files; beside a GLB or VRM, images are previews.
    const withParts = named.some(({ path }) => /\.(pmx|gltf)$/i.test(path));
    const files: File[] = [];
    const models: string[] = [];
    const skipped: string[] = entries.map((e) => zipEntryName(e, encoding)).filter((path) => JUNK.test(path));
    for (const { e, path } of named) {
        const name = baseName(path);
        if (!name || !(MODEL.test(name) || (withParts && PART.test(name)))) {
            skipped.push(path);
            continue;
        }
        const file = new File([await data(e)], name, { type: typeOf(name) });
        paths.set(file, path);
        files.push(file);
        if (MODEL.test(name)) models.push(path);
    }
    return { files, models, encoding, skipped };
}
