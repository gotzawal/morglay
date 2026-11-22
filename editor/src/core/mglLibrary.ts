// The character format's shared texture library (editor/CHARACTERS.md): ramps,
// matcaps, strand patterns and color tables made by our own generator
// (editor/scripts/make-mgl-library.mjs), CC0, served with the
// editor under mgl-library/ (editor/mgl-library, not in public/: players get
// the textures inside character files). Files name them by
// `library:<kind>/<name>` URIs; the inspector offers them for the material's
// maps (rampMap, shadeLut, matcapMap, hairMap).

import type { AnimeMapKey } from './anime';

export interface LibraryTexture {
    /** `library:ramp/soft` */
    uri: string;
    /** Where it is under mgl-library/: `ramp/soft.png`. */
    file: string;
    /** The material map it is made for. */
    use: AnimeMapKey;
    space: 'linear' | 'srgb';
    size: [number, number];
    description: string;
}

export const LIBRARY_PREFIX = 'library:';
export const LIBRARY_LICENSE = 'CC0-1.0';

const base = () => (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
/** The URL the editor serves a library file at. */
export const libraryUrl = (file: string) => new URL(`mgl-library/${file}`, base()).href;
/** The file of a `library:` URI (`library:ramp/soft` is `ramp/soft.png`), or null for another URI. */
export const libraryFile = (uri: string) => (uri.startsWith(LIBRARY_PREFIX) ? `${uri.slice(LIBRARY_PREFIX.length).replace(/[^a-z0-9/_-]/gi, '')}.png` : null);

let items: Promise<LibraryTexture[]> | null = null;

/** The library's textures (an empty list when the editor is served without them). */
export function sharedLibrary(): Promise<LibraryTexture[]> {
    items ??= fetch(libraryUrl('library.json'))
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((j) => (Array.isArray(j?.items) ? (j.items as LibraryTexture[]) : []))
        .catch(() => []);
    return items;
}

/** The library's textures for one of the material's maps. */
export async function libraryFor(use: AnimeMapKey): Promise<LibraryTexture[]> {
    return (await sharedLibrary()).filter((i) => i.use === use);
}
