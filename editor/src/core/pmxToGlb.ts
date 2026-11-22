// Turns a PMX model (core/pmx.ts) into a binary glTF the engine loads as any
// model, with what a cel-shaded character needs that the PMX does not have:
// tangents, the smoothed normals its outline goes out along (_OUTLINE_NORMAL)
// and, for every material slot, anime settings guessed from the material
// (its kind from the name, the outline from MMD's edge, overlays from flat
// see-through materials, the toon mask layout where a mask came along, the
// split normal layout for a hair's _HN). Units become meters (MMD's unit is
// 8 cm), the axes glTF's (Z mirrored, the model faces +Z), one mesh per material.
//
// Not carried over (yet): morphs, SDEF's curve (read as BDEF2), MMD's toon
// and sphere maps, its per-vertex edge scale, physics, IK and inherited
// rotations (clips given to it, retargeted ones, are baked for every bone they
// move, so they need neither).

import { guessAnimeKind, resolveAnime } from './anime';
import { computeOutlineNormals, computeTangents } from './meshTools';
import { layerPass } from './mglMaterial';
import type { AnimeDoc, SlotPassDoc } from './model';
import type { PmxMaterial, PmxModel } from './pmx';
import type { Clip, SkeletonBone } from './retarget';

/**
 * The model's bones as the GLB has them: meters, glTF's axes (Z mirrored),
 * each at its place relative to its parent and not turned at rest.
 */
export function pmxSkeleton(pmx: PmxModel, scale = 0.08): SkeletonBone[] {
    const B = pmx.bones.length;
    const pos = pmx.bones.map((b) => [b.position[0] * scale, b.position[1] * scale, -b.position[2] * scale] as [number, number, number]);
    return pmx.bones.map((b, i) => {
        const parent = b.parent >= 0 && b.parent < B && b.parent !== i ? b.parent : -1;
        const p = parent >= 0 ? pos[parent] : [0, 0, 0];
        return { name: b.name || b.nameEn || `bone_${i}`, parent, translation: [pos[i][0] - p[0], pos[i][1] - p[1], pos[i][2] - p[2]], rotation: [0, 0, 0, 1] };
    });
}

/** An image file for the glTF: PNG or JPEG bytes. */
export interface PmxImage {
    bytes: Uint8Array;
    mimeType: 'image/png' | 'image/jpeg';
}

export interface PmxGlbOptions {
    /** Meters per MMD unit (MMD's convention: 0.08). */
    scale?: number;
    /** Clips for the model's bones (by bone index, as pmxSkeleton has them), e.g. retargeted ones (core/retarget.ts). */
    animations?: Clip[];
    /** The image of a texture path of the PMX (paths as the file writes them, backslashes and all), or null when it is missing. */
    image: (path: string) => PmxImage | null;
    /**
     * A map that goes with a color texture by name (sets named _D with _N, _P, _E, and a hair's _HN),
     * or null; the converter asks for the path of the color texture and a suffix.
     */
    companion?: (path: string, suffix: 'N' | 'P' | 'E' | 'HN') => PmxImage | null;
    /** Whether an eye's color texture has no alpha inside its iris circle (core/pmxMaps.ts): its slot keeps Iris Alpha Tint neutral, and the report says so. */
    opaqueIris?: (path: string) => boolean;
}

/** The settings the converter suggests for one material slot of the model. */
export interface PmxSlot {
    /** The slot's key: the material's name in the glTF. */
    material: string;
    anime: Partial<AnimeDoc>;
    alphaMode: 'opaque' | 'blend' | 'mask' | 'multiply';
    opacity: number;
    /** A color (sRGB hex) the slot should have instead of the file's (overlays). */
    color?: string;
    doubleSide: boolean;
    /** Draw order, depth and stencil tests (the layering of an anime character). */
    pass?: SlotPassDoc;
    /** Copies of the mesh drawn as slots of their own, named `<material>_<suffix>` (hair's see-through second layer). */
    layers?: (Omit<PmxSlot, 'material' | 'layers' | 'drop'> & { suffix: string })[];
    /** Left out of the model: a mesh only MMD's morphs show (expression decals). */
    drop?: boolean;
}

// How an anime character's slots layer (the character format's layers, core/mglMaterial.ts): the
// body (face, skin, clothes), eyes and brows that show through the hair, the hair, its see-through
// second layer over the eyes, and shadow cards that darken the eyes or the body.

const BROW = /眉|まゆ|睫|まつげ|まつ毛|二重|brow|lash|eyeline/i;
const EYE_WHITE = /白目|目白|sclera|eye ?white|white ?eye/i;
const EYE_NAME = /瞳|眼|目|eye|iris|pupil/i;
const SEE_THROUGH = /alpha|透明|半透明|trans/i;
const DECALS = /表情|emotion|expression/i;

export interface PmxGlb {
    glb: Uint8Array;
    slots: PmxSlot[];
    report: string[];
}

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** A material's name in the glTF: its own, made unique. */
function materialNames(materials: PmxMaterial[]): string[] {
    const seen = new Map<string, number>();
    return materials.map((m, i) => {
        const base = (m.name || m.nameEn || `material_${i}`).trim() || `material_${i}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return n ? `${base}_${n}` : base;
    });
}

/**
 * A flat see-through material with no texture, dark (MMD's shadow cards
 * under the eyes or a mask): MMD blends black over what is behind at its
 * alpha, which darkens it by (1 - alpha) on the screen, a multiply overlay.
 */
function isShadowCard(m: PmxMaterial): boolean {
    return m.texture < 0 && m.diffuse[3] < 0.999 && Math.max(m.diffuse[0], m.diffuse[1], m.diffuse[2]) < 0.05;
}

/**
 * The anime settings of a PMX material: its kind from the names, the outline from MMD's edge,
 * and how it layers (eyes and brows through hair, hair's second layer, shadow cards).
 */
export function pmxSlot(m: PmxMaterial, name: string, hasAlphaTexture = false, texturePath = ''): PmxSlot {
    const names = `${m.name} ${m.nameEn}`;
    if (isShadowCard(m)) {
        // Display colors multiply by (1 - alpha): an overlay of that grey (its color stored encoded).
        // Under the eyes it darkens the white and the iris; elsewhere (under a mask) the body only.
        const k = 1 - m.diffuse[3];
        const eye = EYE_NAME.test(names) && !/面具|mask/i.test(names);
        return {
            material: name, anime: { kind: 'overlay' }, alphaMode: 'multiply', opacity: 1, color: '#' + hex2(k) + hex2(k) + hex2(k), doubleSide: m.doubleSided,
            pass: eye ? layerPass({ layer: 'overlay' }) : layerPass({ layer: 'overlay', target: ['body'], depthBias: -5 }),
        };
    }
    // Expression decals MMD keeps hidden (alpha 0) until a morph shows them: left out, as morphs are
    // not carried over. One that shows from the start stays.
    const decals = (DECALS.test(names) || DECALS.test(texturePath)) && m.diffuse[3] < 0.01;
    let kind = /面具|mask/i.test(names) ? 'cloth' : guessAnimeKind(m.name, m.nameEn);
    if (BROW.test(names)) kind = 'eye';
    else if (EYE_WHITE.test(names)) kind = 'face';
    // MMD's edge size is relative, 1 being a model's usual line: it scales the kind's usual Outline.
    // A starting value (MMD draws its edge in units of its own), not a measured match.
    const outline = m.edge && kind !== 'eye' ? Math.round(Math.max(0, m.edgeSize) * resolveAnime({ kind } as any).outline * 1000) / 1000 : 0;
    const anime: Partial<AnimeDoc> = { kind, outline, outlineNormals: 'baked' };
    const seeThrough = SEE_THROUGH.test(names);
    const blend = m.diffuse[3] < 0.999 || hasAlphaTexture || seeThrough;
    const slot: PmxSlot = { material: name, anime, alphaMode: blend ? 'blend' : 'opaque', opacity: Math.min(1, Math.max(0, m.diffuse[3])), doubleSide: m.doubleSided };
    if (decals) slot.drop = true;
    if (kind === 'eye') slot.pass = layerPass({ layer: 'eye' });
    else if (kind === 'hair') {
        slot.pass = layerPass({ layer: 'hair' });
        // Over the eyes the hair is drawn again, half see-through (less where its texture's alpha
        // is), so the eyes show through the bangs.
        slot.layers = [{ suffix: '2', anime: { ...anime }, alphaMode: 'blend', opacity: Math.min(slot.opacity, 0.5), doubleSide: m.doubleSided, pass: layerPass({ layer: 'hairOver' }) }];
    } else if (seeThrough) slot.pass = layerPass({ layer: 'transparent' });
    else slot.pass = layerPass({ layer: 'body' });
    return slot;
}

const HIGHLIGHT = /HL|highlight|ハイライト|高光/i;

/** An eye material that shows an iris (not a brow, a lash, the white or a highlight): where its map's alpha matters. */
export function isIrisMaterial(m: PmxMaterial, texturePath = ''): boolean {
    const names = `${m.name} ${m.nameEn}`;
    if (isShadowCard(m) || BROW.test(names) || EYE_WHITE.test(names) || HIGHLIGHT.test(names)) return false;
    return pmxSlot(m, '', false, texturePath).anime.kind === 'eye';
}

class BinWriter {
    chunks: Uint8Array[] = [];
    length = 0;
    views: any[] = [];
    accessors: any[] = [];

    view(data: ArrayBufferView, target?: number): number {
        const pad = (4 - (this.length % 4)) % 4;
        if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, ...(target ? { target } : {}) });
        this.chunks.push(bytes.slice());
        this.length += bytes.length;
        return this.views.length - 1;
    }

    accessor(data: Float32Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', target?: number, minMax = false): number {
        const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
        const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125;
        const acc: any = { bufferView: this.view(data, target), componentType, count: data.length / n, type };
        if (minMax) {
            const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
            for (let i = 0; i < data.length; i++) { const k = i % n; if (data[i] < min[k]) min[k] = data[i]; if (data[i] > max[k]) max[k] = data[i]; }
            acc.min = min; acc.max = max;
        }
        this.accessors.push(acc);
        return this.accessors.length - 1;
    }
}

export function pmxToGlb(pmx: PmxModel, options: PmxGlbOptions): PmxGlb {
    const scale = options.scale ?? 0.08;
    const report: string[] = [];
    const bin = new BinWriter();

    // ---- materials and textures
    const names = materialNames(pmx.materials);
    const images: any[] = [];
    const textures: any[] = [];
    const imageOf = new Map<string, number>();
    const textureOf = (key: string, img: PmxImage | null): number | undefined => {
        if (!img) return undefined;
        let index = imageOf.get(key);
        if (index === undefined) {
            images.push({ name: key.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''), bufferView: bin.view(img.bytes), mimeType: img.mimeType });
            textures.push({ sampler: 0, source: images.length - 1 });
            index = textures.length - 1;
            imageOf.set(key, index);
        }
        return index;
    };
    const missing = new Set<string>();
    // Per material: whether it took a mask (read in the toon layout) and a hair's two normals (split).
    const mapsOf: { mask: boolean; split: boolean }[] = [];
    const materials = pmx.materials.map((m, i) => {
        const path = m.texture >= 0 ? pmx.textures[m.texture] : undefined;
        const base = path !== undefined ? textureOf(path, options.image(path)) : undefined;
        if (path !== undefined && base === undefined) missing.add(path);
        const mat: any = {
            name: names[i],
            pbrMetallicRoughness: { baseColorFactor: [m.diffuse[0], m.diffuse[1], m.diffuse[2], m.diffuse[3]], metallicFactor: 0, roughnessFactor: 1, ...(base !== undefined ? { baseColorTexture: { index: base } } : {}) },
            doubleSided: m.doubleSided,
            ...(m.diffuse[3] < 0.999 ? { alphaMode: 'BLEND' } : {}),
            extras: { pmx: { edge: m.edge, edgeSize: m.edgeSize, edgeColor: m.edgeColor, toon: m.toon, sphere: m.sphere >= 0 ? pmx.textures[m.sphere] : null, sphereMode: m.sphereMode, nameEn: m.nameEn } },
        };
        // The maps that go with a color texture named _D: normal (a hair's _HN, two normals, before
        // _N), metallic-roughness (its mask, packed in the toon layout), emission.
        mapsOf[i] = { mask: false, split: false };
        if (path !== undefined && base !== undefined && options.companion) {
            const split = textureOf(path + '#HN', options.companion(path, 'HN'));
            const normal = split ?? textureOf(path + '#N', options.companion(path, 'N'));
            const mask = textureOf(path + '#P', options.companion(path, 'P'));
            const glow = textureOf(path + '#E', options.companion(path, 'E'));
            if (normal !== undefined) mat.normalTexture = { index: normal };
            if (mask !== undefined) mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: mask };
            if (glow !== undefined) { mat.emissiveTexture = { index: glow }; mat.emissiveFactor = [1, 1, 1]; }
            mapsOf[i] = { mask: mask !== undefined, split: split !== undefined };
        }
        return mat;
    });
    if (missing.size) report.push(`textures not found: ${[...missing].join(', ')}`);

    // ---- bones: one node each, at the bone's place relative to its parent (no rotation at rest)
    const B = pmx.bones.length;
    const conv = (x: number, y: number, z: number): [number, number, number] => [x * scale, y * scale, -z * scale];
    const bonePos = pmx.bones.map((b) => conv(b.position[0], b.position[1], b.position[2]));
    const boneNames = new Map<string, number>();
    const nodes: any[] = pmx.bones.map((b, i) => {
        const p = b.parent >= 0 && b.parent < B && b.parent !== i ? bonePos[b.parent] : [0, 0, 0];
        const raw = (b.name || b.nameEn || `bone_${i}`).trim() || `bone_${i}`;
        const n = boneNames.get(raw) ?? 0;
        boneNames.set(raw, n + 1);
        return { name: n ? `${raw}_${n}` : raw, translation: [bonePos[i][0] - p[0], bonePos[i][1] - p[1], bonePos[i][2] - p[2]], children: [] as number[] };
    });
    // MMD models have several top bones (操作中心, 全ての親...): one joint over them all is the
    // skeleton's root (skin.skeleton), so a loader that takes one root joint gets every bone.
    const topBones: number[] = [];
    pmx.bones.forEach((b, i) => {
        if (b.parent >= 0 && b.parent < B && b.parent !== i) nodes[b.parent].children.push(i);
        else topBones.push(i);
    });
    for (const n of nodes) if (!n.children.length) delete n.children;
    const rootChildren: number[] = [];
    let skin: any;
    if (B) {
        nodes.push({ name: 'PMX_root', children: topBones });
        const rootJoint = nodes.length - 1;
        rootChildren.push(rootJoint);
        const ibm = new Float32Array((B + 1) * 16);
        for (let i = 0; i < B; i++) ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bonePos[i][0], -bonePos[i][1], -bonePos[i][2], 1], i * 16);
        ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], B * 16);
        // The root joint last, so the vertices' joint numbers are the bones'.
        skin = { name: 'skin', joints: [...pmx.bones.map((_, i) => i), rootJoint], skeleton: rootJoint, inverseBindMatrices: bin.accessor(ibm, 'MAT4') };
    }

    // ---- one mesh per material, with its own vertices
    const meshes: any[] = [];
    const slots: PmxSlot[] = [];
    const dropped: string[] = [];
    const opaqueIris: string[] = [];
    let start = 0;
    let tris = 0;
    pmx.materials.forEach((m, mi) => {
        const end = Math.min(pmx.indices.length, start + m.indexCount);
        const local = new Map<number, number>();
        const order: number[] = [];
        const idx: number[] = [];
        for (let f = start; f + 2 < end; f += 3) {
            // Mirroring Z turns the winding: swap two corners back.
            for (const v of [pmx.indices[f], pmx.indices[f + 2], pmx.indices[f + 1]]) {
                let l = local.get(v);
                if (l === undefined) { l = order.length; local.set(v, l); order.push(v); }
                idx.push(l);
            }
        }
        start = end;
        const texPath = m.texture >= 0 ? pmx.textures[m.texture] : '';
        const slot = pmxSlot(m, names[mi], false, texPath);
        if (slot.drop) {
            dropped.push(names[mi]);
            return;
        }
        // How the slot reads the maps it took (its second hair layer reads them alike).
        for (const anime of [slot.anime, ...(slot.layers ?? []).map((l) => l.anime)]) {
            if (mapsOf[mi]?.mask) anime.maskLayout = 'toon';
            if (mapsOf[mi]?.split) anime.normalLayout = 'split';
        }
        if (texPath && options.opaqueIris?.(texPath) && isIrisMaterial(m, texPath)) opaqueIris.push(names[mi]);
        slots.push(slot);
        if (!idx.length) return;
        tris += idx.length / 3;
        const n = order.length;
        const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2), J = new Uint16Array(n * 4), W = new Float32Array(n * 4);
        order.forEach((v, l) => {
            const p = conv(pmx.positions[v * 3], pmx.positions[v * 3 + 1], pmx.positions[v * 3 + 2]);
            P.set(p, l * 3);
            N.set([pmx.normals[v * 3], pmx.normals[v * 3 + 1], -pmx.normals[v * 3 + 2]], l * 3);
            UV.set([pmx.uvs[v * 2], pmx.uvs[v * 2 + 1]], l * 2);
            J.set(pmx.joints.subarray(v * 4, v * 4 + 4), l * 4);
            W.set(pmx.weights.subarray(v * 4, v * 4 + 4), l * 4);
        });
        const I = n > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx);
        const attributes: any = {
            POSITION: bin.accessor(P, 'VEC3', 34962, true),
            NORMAL: bin.accessor(N, 'VEC3', 34962),
            TEXCOORD_0: bin.accessor(UV, 'VEC2', 34962),
            TANGENT: bin.accessor(computeTangents(P, N, UV, I), 'VEC4', 34962),
            _OUTLINE_NORMAL: bin.accessor(computeOutlineNormals(P, I, N, 1e-5), 'VEC3', 34962),
        };
        if (skin) {
            attributes.JOINTS_0 = bin.accessor(J, 'VEC4', 34962);
            attributes.WEIGHTS_0 = bin.accessor(W, 'VEC4', 34962);
        }
        const indices = bin.accessor(I, 'SCALAR', 34963);
        meshes.push({ name: names[mi], primitives: [{ attributes, indices, material: mi, mode: 4 }] });
        nodes.push({ name: names[mi], mesh: meshes.length - 1, ...(skin ? { skin: 0 } : {}) });
        rootChildren.push(nodes.length - 1);
        // A layer: the same vertices again under a material (slot) of its own.
        for (const { suffix, ...layer } of slot.layers ?? []) {
            const lname = `${names[mi]}_${suffix}`;
            materials.push({ ...materials[mi], name: lname });
            meshes.push({ name: lname, primitives: [{ attributes, indices, material: materials.length - 1, mode: 4 }] });
            nodes.push({ name: lname, mesh: meshes.length - 1, ...(skin ? { skin: 0 } : {}) });
            rootChildren.push(nodes.length - 1);
            slots.push({ material: lname, ...layer });
        }
    });
    nodes.push({ name: pmx.name || pmx.nameEn || 'pmx', children: rootChildren });
    const root = nodes.length - 1;

    // ---- clips: a sampler a track, the key times written once where tracks share them
    const animations: any[] = [];
    for (const clip of options.animations ?? []) {
        const inputs = new Map<Float32Array, number>();
        const samplers: any[] = [];
        const channels: any[] = [];
        for (const tr of clip.tracks) {
            if (tr.bone < 0 || tr.bone >= B || !tr.times.length) continue;
            let input = inputs.get(tr.times);
            if (input === undefined) {
                input = bin.accessor(tr.times, 'SCALAR', undefined, true);
                inputs.set(tr.times, input);
            }
            samplers.push({ input, output: bin.accessor(tr.values, tr.path === 'rotation' ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' });
            channels.push({ sampler: samplers.length - 1, target: { node: tr.bone, path: tr.path } });
        }
        if (channels.length) animations.push({ name: clip.name, samplers, channels });
    }

    report.push(`${pmx.positions.length / 3} vertices, ${tris} triangles in ${meshes.length} meshes, ${B} bones, ${images.length} images`);
    if (dropped.length) report.push(`left out (only MMD's morphs show them): ${dropped.join(', ')}`);
    if (opaqueIris.length) report.push(`iris maps without alpha (with Iris Circle on, an Iris Alpha Tint would cover the whole iris): ${opaqueIris.join(', ')}`);
    report.push('material kinds guessed from their names: check them');
    for (const a of animations) report.push(`clip ${a.name}: ${a.channels.length} tracks`);
    if (pmx.sdef) report.push(`${pmx.sdef} SDEF vertices read as BDEF2`);
    if (pmx.morphs.length) report.push(`${pmx.morphs.length} vertex morphs not carried over`);

    const json: any = {
        asset: { version: '2.0', generator: 'Morglay PMX import' },
        scene: 0,
        scenes: [{ name: pmx.name, nodes: [root] }],
        nodes,
        meshes,
        materials,
        ...(skin ? { skins: [skin] } : {}),
        ...(animations.length ? { animations } : {}),
        ...(images.length ? { images, textures, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
        accessors: bin.accessors,
        bufferViews: bin.views,
        buffers: [{ byteLength: 0 }],
    };
    // ---- the GLB
    const pad = (4 - (bin.length % 4)) % 4;
    const binLength = bin.length + pad;
    json.buffers[0].byteLength = binLength;
    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length + jsonPad, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
    let at = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(at, binLength, true);
    dv.setUint32(at + 4, 0x004e4942, true);
    at += 8;
    for (const c of bin.chunks) { out.set(c, at); at += c.length; }
    jsonBytes = new Uint8Array(0);
    return { glb: out, slots, report };
}

/** An sRGB hex color for a linear one. */
export function hexOfLinear(c: [number, number, number]): string {
    return '#' + c.map((v) => hex2(encode(v))).join('');
}
