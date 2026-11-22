// Writes a character file of the format v1 (MGL, editor/CHARACTERS.md section 4)
// from a model's GLB: the format's extensions are set (the anime materials with their
// textures and draw layers, the character data, the springs), the outline directions a
// model brings are kept and every other outlined mesh gets the smoothed normal (_OUTLINE,
// float xyz and a reserved 1 in w), every material keeps a
// plain PBR fallback, and the result is checked (core/mgl.ts). Meshes, skins and
// clips stay as the GLB has them.

import { resolveAnime, type AnimeMapKey } from './anime';
import { guessHumanoid } from './humanoid';
import { computeOutlineNormals } from './meshTools';
import {
    checkMgl, MGL_CHARACTER, MGL_SPEC_VERSION, MGL_SPRINGS, MGL_TOON, parentsOf, readAccessor, splitGlb, type MglCharacter, type MglReport, type MglSprings, type TextureInfo,
} from './mgl';
import { mapAnimeMaps, materialJson, materialOfJson, type MglMaterialExt } from './mglMaterial';

/** An image to put into the file. */
export interface MglImage {
    bytes: Uint8Array;
    mimeType: string;
    name?: string;
}

export interface MglWriteInput {
    glb: ArrayBuffer | Uint8Array;
    /** The format's materials by the glTF material's name (trimmed): settings with their maps as images, and the layer. */
    materials?: Map<string, MglMaterialExt<MglImage>>;
    /** Color textures by the glTF material's name (trimmed): an image takes the place of the file's, null takes it away. */
    baseColor?: Map<string, MglImage | null>;
    /** The character data; the humanoid bones are guessed from the bones' names when not given. */
    character: Omit<MglCharacter, 'specVersion' | 'humanoid'> & { humanoid?: MglCharacter['humanoid'] };
    springs?: MglSprings | null;
}

export interface MglWritten {
    glb: Uint8Array;
    report: MglReport;
    /** What was made or left out on the way (guessed bones, computed outlines...). */
    notes: string[];
}

const align4 = (n: number) => (n + 3) & ~3;

/** A GLB of a JSON document and its binary chunk. */
export function joinGlb(json: unknown, bin: Uint8Array | null): Uint8Array {
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = align4(text.byteLength);
    const binLength = bin ? align4(bin.byteLength) : 0;
    const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // glTF
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true); // JSON
    out.set(text, 20);
    out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
    if (bin) {
        const at = 20 + jsonLength;
        dv.setUint32(at, binLength, true);
        dv.setUint32(at + 4, 0x004e4942, true); // BIN
        out.set(bin, at + 8);
    }
    return out;
}

/** The binary chunk growing: the file's bytes, then what is added (each at a multiple of 4). */
class Bin {
    parts: Uint8Array[] = [];
    length = 0;
    constructor(start: Uint8Array | null) {
        if (start) this.push(start);
    }
    push(bytes: Uint8Array): number {
        const at = this.length;
        this.parts.push(bytes);
        this.length = align4(at + bytes.byteLength);
        if (this.length > at + bytes.byteLength) this.parts.push(new Uint8Array(this.length - at - bytes.byteLength));
        return at;
    }
    bytes(): Uint8Array {
        const out = new Uint8Array(this.length);
        let at = 0;
        for (const p of this.parts) {
            out.set(p, at);
            at += p.byteLength;
        }
        return out;
    }
}

/** How each map is sampled by viewers that sample per texture: lookups and matcaps are clamped and not mipmapped, maps on the UVs repeat. */
const CLAMPED = new Set<AnimeMapKey>(['rampMap', 'shadeLut', 'specularMap', 'matcapMap', 'faceMap', 'faceGlowMap']);

export function writeMgl(input: MglWriteInput): MglWritten {
    const { json: source, bin: sourceBin } = splitGlb(input.glb);
    const json = JSON.parse(JSON.stringify(source));
    const notes: string[] = [];
    if ((json.buffers ?? []).some((b: any, i: number) => i > 0 || typeof b?.uri === 'string')) throw new Error('the model keeps data outside the GLB');
    const bin = new Bin(sourceBin);
    json.bufferViews ??= [];
    json.accessors ??= [];

    // ---- toon materials and their textures
    json.images ??= [];
    json.textures ??= [];
    json.samplers ??= [];
    let repeat = -1;
    let clamp = -1;
    const sampler = (clamped: boolean) => {
        if (clamped) return clamp >= 0 ? clamp : (clamp = json.samplers.push({ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }) - 1);
        return repeat >= 0 ? repeat : (repeat = json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }) - 1);
    };
    const images = new Map<MglImage, number>();
    const textures = new Map<string, number>();
    const textureOf = (img: MglImage, clamped: boolean): number => {
        let image = images.get(img);
        if (image === undefined) {
            const view = json.bufferViews.push({ buffer: 0, byteOffset: bin.push(img.bytes), byteLength: img.bytes.byteLength }) - 1;
            image = json.images.push({ bufferView: view, mimeType: img.mimeType, ...(img.name ? { name: img.name } : {}) }) - 1;
            images.set(img, image);
        }
        const key = `${image}:${clamped}`;
        let tex = textures.get(key);
        if (tex === undefined) textures.set(key, (tex = json.textures.push({ source: image, sampler: sampler(clamped) }) - 1));
        return tex;
    };
    const outlined = new Set<number>();
    let toonCount = 0;
    (json.materials ?? []).forEach((m: any, i: number) => {
        // A plain PBR look for viewers without the extension (CHARACTERS.md, section 4).
        m.pbrMetallicRoughness ??= { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 };
        const name = typeof m.name === 'string' ? m.name.trim() : '';
        // The color texture a slot gave it instead of the file's (or none): the material's own from now on.
        if (input.baseColor?.has(name)) {
            const img = input.baseColor.get(name);
            const pbr = m.pbrMetallicRoughness;
            if (img) pbr.baseColorTexture = { ...(pbr.baseColorTexture ?? {}), index: textureOf(img, false) };
            else delete pbr.baseColorTexture;
        }
        m.extensions ??= {};
        const mat = input.materials?.get(name);
        if (!mat) {
            delete m.extensions[MGL_TOON];
            if (!Object.keys(m.extensions).length) delete m.extensions;
            return;
        }
        toonCount++;
        const anime = mapAnimeMaps<MglImage, TextureInfo>(mat.anime, (img, key) => ({ index: textureOf(img, CLAMPED.has(key)) }));
        m.extensions[MGL_TOON] = materialJson({ anime, draw: mat.draw });
        if (resolveAnime(mat.anime as any).outline > 0) outlined.add(i);
    });
    for (const name of new Set([...(input.materials?.keys() ?? []), ...(input.baseColor?.keys() ?? [])])) {
        if (!(json.materials ?? []).some((m: any) => typeof m.name === 'string' && m.name.trim() === name)) notes.push(`no material named ${name} in the model`);
    }
    if ((json.materials ?? []).some((m: any) => m.extensions?.KHR_materials_emissive_strength)) (json.extensionsUsed ??= []).includes('KHR_materials_emissive_strength') || json.extensionsUsed.push('KHR_materials_emissive_strength');
    if (!json.images.length) delete json.images;
    if (!json.textures.length) delete json.textures;
    if (!json.samplers.length) delete json.samplers;

    // ---- the outline attribute (_OUTLINE, CHARACTERS.md section 4): the smoothed normal, w a reserved 1, on outlined meshes
    let made = 0;
    for (const mesh of json.meshes ?? []) {
        for (const prim of mesh.primitives ?? []) {
            const a = prim.attributes ?? {};
            const old = a._OUTLINE_NORMAL;
            delete a._OUTLINE_NORMAL;
            // Outline directions the model brings are kept (as _OUTLINE) on every mesh; new ones are made only where an outline is drawn.
            if (a._OUTLINE !== undefined || (old === undefined && !outlined.has(prim.material))) continue;
            let dirs: { values: Float32Array; n: number } | null = old !== undefined ? readAccessor(json, sourceBin, old) : null;
            if (!dirs && a.POSITION !== undefined && a.NORMAL !== undefined) {
                const P = readAccessor(json, sourceBin, a.POSITION);
                const N = readAccessor(json, sourceBin, a.NORMAL);
                const I = prim.indices !== undefined ? readAccessor(json, sourceBin, prim.indices) : null;
                if (P && N) {
                    const count = P.values.length / 3;
                    const index = I ? I.values : Float32Array.from({ length: count }, (_, k) => k);
                    dirs = { values: computeOutlineNormals(P.values, index, N.values, 1e-5), n: 3 };
                    made++;
                }
            }
            if (!dirs) {
                notes.push(`mesh ${mesh.name ?? ''}: no outline directions (its normals cannot be read)`);
                continue;
            }
            // As floats (normalized shorts would be smaller; the reader takes both): the directions as the model has them, to the last bit.
            const count = dirs.values.length / dirs.n;
            const out = new Float32Array(count * 4);
            for (let v = 0; v < count; v++) {
                out[v * 4] = dirs.values[v * dirs.n];
                out[v * 4 + 1] = dirs.values[v * dirs.n + 1];
                out[v * 4 + 2] = dirs.values[v * dirs.n + 2];
                out[v * 4 + 3] = dirs.n === 4 ? Math.max(0, dirs.values[v * 4 + 3]) : 1;
            }
            const view = json.bufferViews.push({ buffer: 0, byteOffset: bin.push(new Uint8Array(out.buffer)), byteLength: out.byteLength, target: 34962 }) - 1;
            a._OUTLINE = json.accessors.push({ bufferView: view, componentType: 5126, count, type: 'VEC4' }) - 1;
        }
    }
    if (made) notes.push(`${made} mesh(es): outline directions computed from the surface`);

    // ---- the character
    const parent = parentsOf(json);
    let humanoid = input.character.humanoid;
    if (!humanoid) {
        const guess = guessHumanoid((json.nodes ?? []).map((n: any, i: number) => ({ name: n?.name ?? '', parent: parent[i] })));
        humanoid = { bones: Object.fromEntries(Object.entries(guess.bones).map(([role, node]) => [role, { node }])) };
        notes.push(`humanoid bones found by their names: ${Object.keys(guess.bones).length}${guess.missing.length ? ` (missing: ${guess.missing.join(', ')})` : ''}`);
    }
    const character: MglCharacter = { specVersion: MGL_SPEC_VERSION, ...input.character, humanoid };
    json.extensions ??= {};
    json.extensions[MGL_CHARACTER] = character;
    if (input.springs && (input.springs.chains.length || input.springs.colliders?.length)) json.extensions[MGL_SPRINGS] = input.springs;
    else delete json.extensions[MGL_SPRINGS];
    const used = new Set<string>((json.extensionsUsed ?? []).filter((e: string) => !e.startsWith('MGL_')));
    used.add(MGL_CHARACTER);
    if (toonCount) used.add(MGL_TOON);
    if (json.extensions[MGL_SPRINGS]) used.add(MGL_SPRINGS);
    json.extensionsUsed = [...used];
    if (json.extensionsRequired) {
        json.extensionsRequired = json.extensionsRequired.filter((e: string) => !e.startsWith('MGL_'));
        if (!json.extensionsRequired.length) delete json.extensionsRequired;
    }
    json.asset = { ...(json.asset ?? {}), version: '2.0', generator: 'Morglay character export (MGL 1.0-draft)' };

    const out = compact(json, bin.bytes());
    if (out.byteLength) json.buffers = [{ byteLength: out.byteLength }];
    if (!json.bufferViews.length) delete json.bufferViews;
    if (!json.accessors.length) delete json.accessors;
    const report = checkMgl(json, out);
    return { glb: joinGlb(json, out.byteLength ? out : null), report, notes };
}

/** Extensions whose data lives only where glTF itself points (no buffer views of their own). */
const PLAIN_EXTENSIONS = /^(MGL_|KHR_materials_|KHR_texture_transform$|KHR_texture_basisu$|KHR_mesh_quantization$|KHR_lights_punctual$)/;

/**
 * The binary chunk with only what the file still uses (an older outline
 * attribute the file had is left behind when it is replaced): unused
 * accessors and buffer views go, the rest are numbered again. A file using
 * an extension that may point into the buffer itself is left as it is.
 */
function compact(json: any, bin: Uint8Array): Uint8Array {
    if ((json.extensionsUsed ?? []).some((e: string) => !PLAIN_EXTENSIONS.test(e))) return bin;
    const accessors: any[] = json.accessors ?? [];
    const views: any[] = json.bufferViews ?? [];
    // ---- accessors in use, numbered again
    const used = new Set<number>();
    const prims = (json.meshes ?? []).flatMap((m: any) => m.primitives ?? []);
    for (const p of prims) {
        for (const i of Object.values(p.attributes ?? {})) used.add(i as number);
        if (p.indices !== undefined) used.add(p.indices);
        for (const t of p.targets ?? []) for (const i of Object.values(t)) used.add(i as number);
    }
    for (const s of json.skins ?? []) if (s.inverseBindMatrices !== undefined) used.add(s.inverseBindMatrices);
    for (const a of json.animations ?? []) for (const s of a.samplers ?? []) used.add(s.input), used.add(s.output);
    const accessorAt = new Map<number, number>();
    const keptAccessors: any[] = [];
    accessors.forEach((a, i) => used.has(i) && accessorAt.set(i, keptAccessors.push(a) - 1));
    const remapAccessor = (i: number) => accessorAt.get(i)!;
    for (const p of prims) {
        for (const k of Object.keys(p.attributes ?? {})) p.attributes[k] = remapAccessor(p.attributes[k]);
        if (p.indices !== undefined) p.indices = remapAccessor(p.indices);
        for (const t of p.targets ?? []) for (const k of Object.keys(t)) t[k] = remapAccessor(t[k]);
    }
    for (const s of json.skins ?? []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = remapAccessor(s.inverseBindMatrices);
    for (const a of json.animations ?? []) for (const s of a.samplers ?? []) (s.input = remapAccessor(s.input)), (s.output = remapAccessor(s.output));
    json.accessors = keptAccessors;
    // ---- buffer views in use, their bytes packed again
    const viewRefs: { holder: any; key: string }[] = [];
    for (const a of keptAccessors) {
        if (a.bufferView !== undefined) viewRefs.push({ holder: a, key: 'bufferView' });
        if (a.sparse?.indices?.bufferView !== undefined) viewRefs.push({ holder: a.sparse.indices, key: 'bufferView' });
        if (a.sparse?.values?.bufferView !== undefined) viewRefs.push({ holder: a.sparse.values, key: 'bufferView' });
    }
    for (const img of json.images ?? []) if (img.bufferView !== undefined) viewRefs.push({ holder: img, key: 'bufferView' });
    const viewAt = new Map<number, number>();
    const keptViews: any[] = [];
    const packed = new Bin(null);
    for (const ref of viewRefs) {
        const old = ref.holder[ref.key];
        let at = viewAt.get(old);
        if (at === undefined) {
            const v = views[old];
            const start = v.byteOffset ?? 0;
            const offset = packed.push(bin.subarray(start, start + v.byteLength));
            at = keptViews.push({ ...v, buffer: 0, byteOffset: offset }) - 1;
            viewAt.set(old, at);
        }
        ref.holder[ref.key] = at;
    }
    json.bufferViews = keptViews;
    return packed.bytes();
}

/** The URI of a texture's image when the file names it instead of holding it (a shared library's `library:` URI). */
export function mglImageUri(json: any, texture: number): string | null {
    const t = json.textures?.[texture];
    const img = json.images?.[t?.extensions?.KHR_texture_basisu?.source ?? t?.source];
    return typeof img?.uri === 'string' ? img.uri : null;
}

/** The embedded image of a texture of a file: its bytes and type (null when it is not in the file). */
export function mglImage(json: any, bin: Uint8Array | null, texture: number): MglImage | null {
    const t = json.textures?.[texture];
    const src = t?.extensions?.KHR_texture_basisu?.source ?? t?.source;
    const img = json.images?.[src];
    const view = img ? json.bufferViews?.[img.bufferView] : undefined;
    if (!view || !bin || (view.buffer ?? 0) !== 0) return null;
    const start = view.byteOffset ?? 0;
    return { bytes: bin.slice(start, start + view.byteLength), mimeType: img.mimeType ?? 'image/png', ...(img.name ? { name: img.name } : {}) };
}

/**
 * The format's materials of a file by material name (as the editor keys a
 * model's slots: the name trimmed), their maps by texture index. A material
 * without a name has no slot key the file can say: it is left out.
 */
export function mglMaterialsByName(json: any): { materials: Map<string, MglMaterialExt<number>>; unnamed: number } {
    const materials = new Map<string, MglMaterialExt<number>>();
    let unnamed = 0;
    for (const m of json.materials ?? []) {
        const t = m?.extensions?.[MGL_TOON];
        if (!t || typeof t !== 'object') continue;
        const name = typeof m.name === 'string' ? m.name.trim() : '';
        if (!name) {
            unnamed++;
            continue;
        }
        const ext = materialOfJson<TextureInfo>(t);
        materials.set(name, { anime: mapAnimeMaps<TextureInfo, number>(ext.anime, (info) => (Number.isInteger(info?.index) ? info.index : null)), draw: ext.draw });
    }
    return { materials, unnamed };
}
