// What a character file of the format v1 (core/mgl.ts) is in the editor and back:
// - reading: the slot changes it makes (toon materials, their textures still as the
//   file's texture numbers), the motion (springs, colliders, expressions) and the
//   license data (CharacterInfo),
// - writing: what core/mglWrite.ts needs from a model object (its slots, motion and
//   license data, the textures as images).
// The editor keeps the face's forward tilt with each face, hair and eye material
// (their toon values' face.forwardTilt); files keep it once, in MGL_character.face.

import { resolveAnime } from './anime';
import { CharacterInfo, type CharacterInfoDoc, type MaterialOverride, type ModelDoc, type MotionDoc, type SlotPassDoc } from './model';
import { MGL_TOON, readMgl, type MglCharacter, type MglMeta, type MglSprings, type TextureInfo } from './mgl';
import { layerOfPass, layerPass, mapAnimeMaps, passIsLayer, type AnimeWith, type MglMaterialExt } from './mglMaterial';
import { mglFromMotion, motionFromMgl, type MotionFromFile } from './mglMotion';
import { joinGlb, mglMaterialsByName, type MglImage, type MglWriteInput } from './mglWrite';
import { vrmToMgl } from './vrm';

// ---------------------------------------------------------------- license data

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The editor's license data of a file's meta (missing fields at their most restrictive). */
export function infoFromMeta(meta: Partial<MglMeta> | null | undefined, fallbackName = ''): CharacterInfoDoc {
    const m = meta ?? {};
    return CharacterInfo.parse({
        ...m,
        name: m.name || fallbackName,
        authors: Array.isArray(m.authors) ? m.authors.join(', ') : '',
        originalWork: m.derivative?.originalWork ?? '',
        rightsHolder: m.derivative?.rightsHolder ?? '',
    });
}

/** A file's meta of the editor's license data. */
export function metaFromInfo(info: CharacterInfoDoc | undefined, fallbackName: string): MglMeta {
    const i = CharacterInfo.parse(info ?? {});
    const optional = <K extends keyof CharacterInfoDoc>(k: K) => (i[k] ? { [k]: i[k] } : {});
    return {
        name: i.name || fallbackName,
        ...optional('version'),
        authors: list(i.authors),
        ...optional('copyrightInformation'),
        ...optional('contactInformation'),
        licenseUrl: i.licenseUrl,
        avatarPermission: i.avatarPermission,
        commercialUsage: i.commercialUsage,
        allowExcessivelyViolentUsage: i.allowExcessivelyViolentUsage,
        allowExcessivelySexualUsage: i.allowExcessivelySexualUsage,
        allowPoliticalOrReligiousUsage: i.allowPoliticalOrReligiousUsage,
        allowAntisocialOrHateUsage: i.allowAntisocialOrHateUsage,
        creditNotation: i.creditNotation,
        allowRedistribution: i.allowRedistribution,
        modification: i.modification,
        ...optional('otherLicenseUrl'),
        ...(i.originalWork ? { derivative: { originalWork: i.originalWork, ...(i.rightsHolder ? { rightsHolder: i.rightsHolder } : {}) } } : {}),
        partExtraction: i.partExtraction,
        ...optional('sourceTerms'),
    };
}

// ---------------------------------------------------------------- reading

/** The kinds whose shading turns with the head (and so use the face's forward tilt). */
const HEAD_KINDS = new Set(['face', 'hair', 'eye']);

/** A slot's settings from a file: the anime shading, its maps as the file's texture numbers, its layer's pass state. */
export interface MglSlotPlan {
    shading: 'anime';
    anime: AnimeWith<number>;
    pass: SlotPassDoc;
    /** Overlays multiply; the file's glTF alpha mode cannot say it. */
    alphaMode?: 'multiply';
    /** An overlay written as black at an alpha (as plain viewers darken by it): the grey it multiplies by, at full opacity. */
    color?: string;
    opacity?: number;
    /** What the file's material has that the slot would not read from it by itself. */
    normalScale?: number;
    emissiveIntensity?: number;
}

export interface MglImportPlan {
    /** Slot changes by slot key. */
    slots: Record<string, MglSlotPlan>;
    /** The texture numbers the slots use (each becomes a texture asset). */
    textures: number[];
    motion: MotionFromFile | null;
    character: CharacterInfoDoc | null;
    notes: string[];
}

/** Whether a GLB is a character file (it has the format's character data or materials). */
export function isMgl(json: any): boolean {
    return !!json?.extensions?.MGL_character || (json?.materials ?? []).some((m: any) => !!m?.extensions?.[MGL_TOON]);
}

/**
 * The format's data of a file: its own (MGL_character, MGL_springs, the
 * materials) or, for a VRM 1.0 file without it, the VRM's converted.
 */
export function characterOf(json: any): { character: MglCharacter | null; springs: MglSprings | null; materials: Map<string, MglMaterialExt<number>>; unnamed: number; notes: string[] } | null {
    if (isMgl(json)) {
        const { materials, unnamed } = mglMaterialsByName(json);
        return { character: json.extensions?.MGL_character ?? null, springs: json.extensions?.MGL_springs ?? null, materials, unnamed, notes: [] };
    }
    const vrm = vrmToMgl(json);
    if (!vrm) return null;
    const materials = new Map<string, MglMaterialExt<number>>();
    let unnamed = 0;
    for (const [i, m] of vrm.materials) {
        const name = typeof json.materials?.[i]?.name === 'string' ? json.materials[i].name.trim() : '';
        if (!name) unnamed++;
        else materials.set(name, { anime: mapAnimeMaps<TextureInfo, number>(m.anime, (t) => (Number.isInteger(t?.index) ? t.index : null)), draw: m.draw });
    }
    return { character: vrm.character, springs: vrm.springs, materials, unnamed, notes: [`VRM 1.0: ${vrm.character.meta.name || 'unnamed'}`, ...vrm.notes] };
}

/** What importing a character file (or a VRM 1.0) puts into the scene; null when the GLB is neither. */
export function mglImportPlan(glb: ArrayBuffer | Uint8Array, fallbackName = ''): MglImportPlan | null {
    const file = readMgl(glb);
    const src = characterOf(file.json);
    if (!src) return null;
    const notes: string[] = [...src.notes];
    const { materials, unnamed } = src;
    if (unnamed) notes.push(`${unnamed} material(s) without a name: the editor cannot tell their slots`);
    const slots: MglImportPlan['slots'] = {};
    const textures = new Set<number>();
    for (const [name, m] of materials) {
        mapAnimeMaps(m.anime, (t) => (textures.add(t), t));
        const plan: MglSlotPlan = { shading: 'anime', anime: m.anime, pass: layerPass(m.draw) };
        const fileMat = (file.json.materials ?? []).find((x: any) => typeof x?.name === 'string' && x.name.trim() === name);
        if (m.draw.layer === 'overlay') {
            plan.alphaMode = 'multiply';
            // Written as black at an alpha (pbrPatch): back as the grey multiply that darkens as much.
            const f = fileMat?.pbrMetallicRoughness?.baseColorFactor;
            if (Array.isArray(f) && f.length >= 4 && Math.max(f[0], f[1], f[2]) < 1e-4) {
                plan.color = greyHex(linearToSrgb(1 - f[3]));
                plan.opacity = 1;
            }
        }
        if (typeof fileMat?.normalTexture?.scale === 'number') plan.normalScale = fileMat.normalTexture.scale;
        // The engine's glTF loader leaves this at 1: the slot takes it from the file.
        const strength = fileMat?.extensions?.KHR_materials_emissive_strength?.emissiveStrength;
        if (typeof strength === 'number' && strength !== 1) plan.emissiveIntensity = strength;
        slots[name] = plan;
    }
    const motion = src.character || src.springs ? motionFromMgl(file.json, src.character, src.springs) : null;
    if (motion) notes.push(...motion.notes);
    return { slots, textures: [...textures], motion, character: src.character ? infoFromMeta(src.character.meta, fallbackName) : null, notes };
}

// ---------------------------------------------------------------- writing

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hexToDisplay = (hex: string): [number, number, number] => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const hexToLinear = (hex: string): [number, number, number] => hexToDisplay(hex).map(srgbToLinear) as [number, number, number];
const greyHex = (v: number) => '#' + Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0').repeat(3);

/** The plain PBR values a slot's changes give its material in the file (what viewers without the extension show, and what the slot starts from again). */
function pbrPatch(o: MaterialOverride, material: any) {
    const pbr = { ...(material.pbrMetallicRoughness ?? {}) };
    const base: number[] = pbr.baseColorFactor ?? [1, 1, 1, 1];
    if (o.color) pbr.baseColorFactor = [...hexToLinear(o.color), base[3]];
    if (o.opacity !== undefined) pbr.baseColorFactor = [...(pbr.baseColorFactor ?? base).slice(0, 3), o.opacity];
    if (o.metallic !== undefined) pbr.metallicFactor = o.metallic;
    if (o.roughness !== undefined) pbr.roughnessFactor = o.roughness;
    material.pbrMetallicRoughness = pbr;
    if (o.emissive) material.emissiveFactor = hexToLinear(o.emissive);
    if (o.emissiveIntensity !== undefined && o.emissiveIntensity !== 1) {
        material.extensions = { ...(material.extensions ?? {}), KHR_materials_emissive_strength: { emissiveStrength: o.emissiveIntensity } };
    }
    if (o.normalScale !== undefined && material.normalTexture) material.normalTexture = { ...material.normalTexture, scale: o.normalScale };
    if (o.doubleSide !== undefined) material.doubleSided = o.doubleSide;
    // A multiply overlay darkens what is under it to mix(1, its color, opacity) as the screen shows
    // it. A plain viewer only blends (under × (1 − alpha) in linear light), so it goes out as black at
    // the alpha that darkens as much; mglImportPlan reads it back as that multiply.
    if (o.alphaMode === 'multiply') {
        const shown = hexToDisplay(o.color ?? '#ffffff');
        const factor = 1 - (o.opacity ?? base[3]) * (1 - (0.2126 * shown[0] + 0.7152 * shown[1] + 0.0722 * shown[2]));
        pbr.baseColorFactor = [0, 0, 0, 1 - srgbToLinear(Math.min(1, Math.max(0, factor)))];
    }
    // glTF knows opaque, cut-out and blended; overlays multiply by their layer.
    if (o.alphaMode === 'opaque') material.alphaMode = 'OPAQUE';
    else if (o.alphaMode === 'mask') {
        material.alphaMode = 'MASK';
        if (o.alphaCutoff !== undefined) material.alphaCutoff = o.alphaCutoff;
    } else if (o.alphaMode === 'blend' || o.alphaMode === 'multiply' || o.alphaMode === 'additive') material.alphaMode = 'BLEND';
}

export interface ExportSource {
    /** The model's GLB. */
    glb: Uint8Array;
    name: string;
    model: ModelDoc;
    motion?: MotionDoc;
    /** The images of the texture assets the slots use (their color textures and cel-shading maps), by asset id. */
    images: Map<string, MglImage>;
}

/** What core/mglWrite.ts writes for a model object, with what was left out on the way. */
export function mglExportInput(src: ExportSource): { input: MglWriteInput; notes: string[] } {
    const file = readMgl(src.glb);
    const json = file.json;
    const notes: string[] = [];
    const out = new Map<string, MglMaterialExt<MglImage>>();
    const baseColor = new Map<string, MglImage | null>();
    let tilt: number | undefined;
    let tiltFrom = '';
    const materials: any[] = JSON.parse(JSON.stringify(json.materials ?? []));
    for (const [key, o] of Object.entries(src.model.materials ?? {})) {
        const material = materials.find((m) => typeof m?.name === 'string' && m.name.trim() === key);
        if (material) pbrPatch(o, material);
        // A color texture the slot puts in place of the file's (or none): the material's own in the file.
        if (o.map === null) baseColor.set(key, null);
        else if (o.map !== undefined) {
            const img = src.images.get(o.map);
            if (img) baseColor.set(key, img);
            else notes.push(`${key}: its color texture is missing`);
        }
        if (o.shading !== 'anime') continue;
        const values = resolveAnime(o.anime);
        // The forward tilt is the character's too: taken once, from a face first (the materials keep their own).
        if (HEAD_KINDS.has(values.kind) && values.frontTilt && (tilt === undefined || (values.kind === 'face' && tiltFrom !== 'face'))) {
            tilt = values.frontTilt;
            tiltFrom = values.kind;
        }
        const draw = layerOfPass(o);
        if (o.pass && !passIsLayer(o.pass, draw)) notes.push(`${key}: its pass state is not one the format's layers give (written as layer ${draw.layer})`);
        out.set(key, {
            anime: mapAnimeMaps<string, MglImage>({ ...(o.anime ?? {}), kind: values.kind } as AnimeWith<string>, (id, mapKey) => {
                const img = src.images.get(id);
                if (!img) notes.push(`${key}: the texture of ${mapKey} is missing`);
                return img ?? null;
            }),
            draw,
        });
    }
    const patched = { ...json, materials, nodes: JSON.parse(JSON.stringify(json.nodes ?? [])), meshes: JSON.parse(JSON.stringify(json.meshes ?? [])) };
    dropHiddenParts(patched, src.model, notes);
    // The file's own character data, or its VRM's (bones, expressions, look-at).
    const base = file.character ?? characterOf(json)?.character ?? null;
    const motion = mglFromMotion(patched, src.motion, base?.expressions);
    notes.push(...motion.notes);
    const character: MglWriteInput['character'] = {
        ...(base ? { ...base } : {}),
        meta: metaFromInfo(src.model.character ?? (base ? infoFromMeta(base.meta) : undefined), src.name),
        ...(base?.humanoid && Object.keys(base.humanoid.bones ?? {}).length ? { humanoid: base.humanoid } : {}),
        ...(tilt || base?.face ? { face: { ...(base?.face ?? {}), ...(tilt ? { forwardTilt: tilt } : {}) } } : {}),
        expressions: motion.expressions,
    };
    if (!character.expressions) delete character.expressions;
    delete (character as Partial<MglCharacter>).specVersion;
    return { input: { glb: joinGlb(patched, file.bin), materials: out, ...(baseColor.size ? { baseColor } : {}), character, springs: motion.springs }, notes };
}

/**
 * Leaves out of the file the parts hidden in the editor (a model's part
 * overrides with visible false). A part's path ends in its node's name and
 * its object's, the mesh's name and the primitive's number ("…/Mask/Mask0");
 * a mesh with no primitive left goes with its node's reference to it.
 */
export function dropHiddenParts(json: any, model: Pick<ModelDoc, 'parts'>, notes: string[]) {
    const hidden = Object.entries(model.parts ?? {}).filter(([, p]) => p?.visible === false).map(([path]) => path);
    if (!hidden.length) return;
    const nodes: any[] = json.nodes ?? [];
    const meshes: any[] = json.meshes ?? [];
    const gone = new Map<number, Set<number>>();
    let unknown = 0;
    for (const path of hidden) {
        const seg = path.split('/').map((s) => s.replace(/~\d+$/, ''));
        const last = seg[seg.length - 1];
        const nodeName = seg[seg.length - 2] ?? '';
        const node = nodes.find((n) => n.mesh !== undefined && (n.name || 'node').replace(/\//g, '_') === nodeName && last.startsWith(meshes[n.mesh]?.name ?? ''));
        const mesh = node ? meshes[node.mesh] : undefined;
        const i = mesh ? Number(last.slice((mesh.name ?? '').length)) : NaN;
        if (!mesh || !Number.isInteger(i) || !mesh.primitives?.[i]) {
            unknown++;
            continue;
        }
        (gone.get(node.mesh) ?? gone.set(node.mesh, new Set()).get(node.mesh)!).add(i);
    }
    let count = 0;
    const meshAt = new Map<number, number>();
    const kept: any[] = [];
    meshes.forEach((m, i) => {
        const drop = gone.get(i);
        if (drop) {
            count += drop.size;
            m.primitives = m.primitives.filter((_: unknown, k: number) => !drop.has(k));
        }
        if (m.primitives?.length) meshAt.set(i, kept.push(m) - 1);
    });
    json.meshes = kept;
    for (const n of nodes) {
        if (n.mesh === undefined) continue;
        const at = meshAt.get(n.mesh);
        if (at === undefined) {
            delete n.mesh;
            delete n.skin;
        } else n.mesh = at;
    }
    if (count) notes.push(`${count} hidden part(s) left out of the file`);
    if (unknown) notes.push(`${unknown} hidden part(s) not found in the file (kept)`);
}
