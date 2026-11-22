// The character format v1 (MGL, editor/CHARACTERS.md section 4): the data of its
// glTF extensions (MGL_character, MGL_materials_toon, MGL_springs), reading them out
// of a GLB, and the format's checks. Bones, expressions and the
// license data follow VRM 1.0's names; the toon material's settings are core/anime.ts's
// (kinds and their values) as core/mglMaterial.ts stores them.

import { ANIME_MAP_KEYS } from './anime';
import { DRAW_LAYERS, materialOfJson, type MglMaterialExt } from './mglMaterial';

export const MGL_SPEC_VERSION = '1.0-draft';
export const MGL_CHARACTER = 'MGL_character';
export const MGL_TOON = 'MGL_materials_toon';
export const MGL_SPRINGS = 'MGL_springs';
/** The texture roles read as color (sRGB); every other role is data (linear). */
const SRGB_ROLES: ReadonlySet<string> = new Set(['baseColorTexture', 'emissiveTexture', 'matcapMap']);

/** A texture as a glTF material names it. */
export interface TextureInfo {
    index: number;
    texCoord?: number;
    extensions?: Record<string, unknown>;
}

// ------------------------------------------------------------------ MGL_character

export interface MglMeta {
    name: string;
    version?: string;
    authors: string[];
    copyrightInformation?: string;
    contactInformation?: string;
    references?: string[];
    thumbnailImage?: number;
    licenseUrl: string;
    avatarPermission: 'onlyAuthor' | 'onlySeparatelyLicensedPerson' | 'everyone';
    commercialUsage: 'personalNonProfit' | 'personalProfit' | 'corporation';
    allowExcessivelyViolentUsage: boolean;
    allowExcessivelySexualUsage: boolean;
    allowPoliticalOrReligiousUsage: boolean;
    allowAntisocialOrHateUsage: boolean;
    creditNotation: 'required' | 'unnecessary';
    allowRedistribution: boolean;
    modification: 'prohibited' | 'allowModification' | 'allowModificationRedistribution';
    otherLicenseUrl?: string;
    derivative?: { originalWork: string; rightsHolder?: string };
    partExtraction?: boolean;
    sourceTerms?: string;
}

/** VRM 1.0's humanoid bones: the fifteen every model has, then the others. */
export const HUMANOID_REQUIRED = [
    'hips', 'spine', 'head',
    'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
] as const;

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const fingerBones = (side: 'left' | 'right') =>
    FINGERS.flatMap((f) => (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map((s) => `${side}${f}${s}`));

export const HUMANOID_OPTIONAL = [
    'chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder', 'leftToes', 'rightToes', 'leftEye', 'rightEye', 'jaw',
    ...fingerBones('left'), ...fingerBones('right'),
] as const;
export const HUMANOID_BONES: readonly string[] = [...HUMANOID_REQUIRED, ...HUMANOID_OPTIONAL];

/** For a bone, the bones one of which (the first present) must be its ancestor. */
export function humanoidParents(bone: string): string[] {
    const side = bone.startsWith('left') ? 'left' : bone.startsWith('right') ? 'right' : '';
    const rest = side ? bone.slice(side.length) : bone;
    const s = (b: string) => side + b;
    switch (rest) {
        case 'spine': return ['hips'];
        case 'chest': return ['spine'];
        case 'upperChest': return ['chest'];
        case 'neck': return ['upperChest', 'chest', 'spine'];
        case 'head': return ['neck', 'upperChest', 'chest', 'spine'];
        case 'jaw': return ['head'];
        case 'Eye': return ['head'];
        case 'Shoulder': return ['upperChest', 'chest', 'spine'];
        case 'UpperArm': return [s('Shoulder'), 'upperChest', 'chest', 'spine'];
        case 'LowerArm': return [s('UpperArm')];
        case 'Hand': return [s('LowerArm')];
        case 'UpperLeg': return ['hips'];
        case 'LowerLeg': return [s('UpperLeg')];
        case 'Foot': return [s('LowerLeg')];
        case 'Toes': return [s('Foot')];
    }
    const m = /^(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate|Distal)$/.exec(rest);
    if (m) {
        const chain = m[1] === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
        const i = chain.indexOf(m[2]);
        return i > 0 ? [s(m[1] + chain[i - 1])] : [s('Hand')];
    }
    return [];
}

export interface MglHumanoid {
    bones: Record<string, { node: number }>;
    twist?: { of: string; node: number; weight: number }[];
    restPose?: 'T' | 'A' | 'other';
}

export const EXPRESSION_PRESETS = [
    'neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh',
    'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight',
] as const;

export type OverrideMode = 'none' | 'block' | 'blend';

export interface MglExpression {
    morphTargetBinds?: { node: number; index: number; weight: number }[];
    boneBinds?: { node: number; translation?: [number, number, number]; rotation?: [number, number, number, number] }[];
    materialColorBinds?: { material: number; type: 'color' | 'emissionColor' | 'shadeColor' | 'rimColor' | 'outlineColor' | 'matcapColor'; targetValue: [number, number, number, number] }[];
    textureTransformBinds?: { material: number; scale?: [number, number]; offset?: [number, number] }[];
    layerBinds?: { material: number; visible: boolean }[];
    isBinary?: boolean;
    overrideBlink?: OverrideMode;
    overrideLookAt?: OverrideMode;
    overrideMouth?: OverrideMode;
}

export interface MglCharacter {
    specVersion: string;
    meta: MglMeta;
    humanoid: MglHumanoid;
    face?: { forwardTilt?: number };
    bodyType?: string;
    expressions?: {
        preset?: Partial<Record<(typeof EXPRESSION_PRESETS)[number], MglExpression>>;
        custom?: Record<string, MglExpression>;
        default?: string;
        blink?: { expression?: string; interval?: [number, number]; duration?: number };
    };
    lookAt?: { type: 'bone' | 'expression'; offsetFromHeadBone?: [number, number, number]; yaw?: { inner: number; outer: number }; pitch?: { up: number; down: number } };
}

// ------------------------------------------------------------------ MGL_springs

export interface MglSprings {
    chains: { name?: string; root: number; period: number; damping: number; gravity: number; drag: number; maxAngle: number; radius: number; colliders?: string[] }[];
    colliders?: { name: string; node: number; shape: 'sphere' | 'capsule'; offset?: [number, number, number]; tail?: [number, number, number]; radius: number }[];
}

// ------------------------------------------------------------------ reading a GLB

export interface GlbParts {
    json: any;
    bin: Uint8Array | null;
}

/** The JSON and binary chunks of a GLB. */
export function splitGlb(glb: ArrayBuffer | Uint8Array): GlbParts {
    const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
    let at = 12;
    let json: any = null;
    let bin: Uint8Array | null = null;
    while (at + 8 <= bytes.byteLength) {
        const len = dv.getUint32(at, true);
        const type = dv.getUint32(at + 4, true);
        const data = bytes.subarray(at + 8, at + 8 + len);
        if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder('utf-8').decode(data));
        else if (type === 0x004e4942 && !bin) bin = data;
        at += 8 + len;
    }
    if (!json) throw new Error('GLB without JSON');
    return { json, bin };
}

export interface MglFile {
    json: any;
    bin: Uint8Array | null;
    character: MglCharacter | null;
    springs: MglSprings | null;
    /** The format's materials by material index (settings and layer), textures as the file names them. */
    materials: Map<number, MglMaterialExt<TextureInfo>>;
}

export function readMgl(glb: ArrayBuffer | Uint8Array): MglFile {
    const { json, bin } = splitGlb(glb);
    const materials = new Map<number, MglMaterialExt<TextureInfo>>();
    (json.materials ?? []).forEach((m: any, i: number) => {
        const t = m?.extensions?.[MGL_TOON];
        if (t && typeof t === 'object') materials.set(i, materialOfJson<TextureInfo>(t));
    });
    return { json, bin, character: json.extensions?.[MGL_CHARACTER] ?? null, springs: json.extensions?.[MGL_SPRINGS] ?? null, materials };
}

// ------------------------------------------------------------------ accessors

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** An accessor's values as floats (normalized integers scaled to -1..1 or 0..1); null when it cannot be read. */
export function readAccessor(json: any, bin: Uint8Array | null, index: number): { values: Float32Array; n: number } | null {
    const acc = json.accessors?.[index];
    if (!acc || acc.bufferView === undefined || !bin || acc.sparse) return null;
    const view = json.bufferViews?.[acc.bufferView];
    if (!view || (view.buffer ?? 0) !== 0) return null;
    const n = COMPONENTS[acc.type] ?? 1;
    const size = SIZE[acc.componentType];
    if (!size) return null;
    const stride = view.byteStride || n * size;
    const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    if (start + (acc.count - 1) * stride + n * size > bin.byteLength) return null;
    const out = new Float32Array(acc.count * n);
    for (let i = 0; i < acc.count; i++) {
        for (let j = 0; j < n; j++) {
            const o = start + i * stride + j * size;
            let v: number;
            switch (acc.componentType) {
                case 5126: v = dv.getFloat32(o, true); break;
                case 5125: v = dv.getUint32(o, true); break;
                case 5123: v = dv.getUint16(o, true); if (acc.normalized) v /= 65535; break;
                case 5122: v = dv.getInt16(o, true); if (acc.normalized) v = Math.max(v / 32767, -1); break;
                case 5121: v = dv.getUint8(o); if (acc.normalized) v /= 255; break;
                default: v = dv.getInt8(o); if (acc.normalized) v = Math.max(v / 127, -1);
            }
            out[i * n + j] = v;
        }
    }
    return { values: out, n };
}

// ------------------------------------------------------------------ checks (CHARACTERS.md, section 4)

export interface MglReport {
    errors: string[];
    warnings: string[];
}

const META_ENUMS: Record<string, readonly string[]> = {
    avatarPermission: ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone'],
    commercialUsage: ['personalNonProfit', 'personalProfit', 'corporation'],
    creditNotation: ['required', 'unnecessary'],
    modification: ['prohibited', 'allowModification', 'allowModificationRedistribution'],
};
const META_FLAGS = ['allowExcessivelyViolentUsage', 'allowExcessivelySexualUsage', 'allowPoliticalOrReligiousUsage', 'allowAntisocialOrHateUsage', 'allowRedistribution'];

/** Each node's parent (-1 for none). */
export function parentsOf(json: any): number[] {
    const parent = new Array<number>((json.nodes ?? []).length).fill(-1);
    (json.nodes ?? []).forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => (parent[c] = i)));
    return parent;
}

function isAncestor(parent: number[], a: number, b: number): boolean {
    let p = parent[b];
    for (let guard = 0; p >= 0 && guard < parent.length; guard++) {
        if (p === a) return true;
        p = parent[p];
    }
    return false;
}

/** The nodes' world matrices at rest (their default transforms), column-major 4×4. */
export function restMatrices(json: any, parent = parentsOf(json)): number[][] {
    const nodes: any[] = json.nodes ?? [];
    const world = new Array<number[] | null>(nodes.length).fill(null);
    const local = (n: any): number[] => {
        if (n.matrix) return n.matrix;
        const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
        const [sx, sy, sz] = n.scale ?? [1, 1, 1];
        const [tx, ty, tz] = n.translation ?? [0, 0, 0];
        return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
    };
    const mul = (a: number[], b: number[]) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; };
    const get = (i: number): number[] => {
        if (world[i]) return world[i]!;
        const m = parent[i] >= 0 ? mul(get(parent[i]), local(nodes[i])) : local(nodes[i]);
        world[i] = m;
        return m;
    };
    return nodes.map((_, i) => get(i));
}

/** The rotation of a 4×4 matrix (its columns made unit length) as a quaternion [x, y, z, w]. */
export function matrixRotation(m: readonly number[]): [number, number, number, number] {
    const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
    const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
    const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
    const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
    const t = r00 + r11 + r22;
    let q: [number, number, number, number];
    if (t > 0) {
        const s = Math.sqrt(t + 1) * 2;
        q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
    } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
        q = [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
    } else if (r11 > r22) {
        const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
        q = [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
    } else {
        const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
        q = [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
    }
    const l = Math.hypot(...q) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** World positions of the nodes at rest. */
function restPositions(json: any, parent: number[]): [number, number, number][] {
    return restMatrices(json, parent).map((m) => [m[12], m[13], m[14]]);
}

/** Checks a file's MGL data (and, given its binary chunk, its skins and vertex attributes). */
export function checkMgl(json: any, bin: Uint8Array | null = null): MglReport {
    const errors: string[] = [];
    const warnings: string[] = [];
    const nodes: any[] = json.nodes ?? [];
    const meshes: any[] = json.meshes ?? [];
    const materials: any[] = json.materials ?? [];
    const textures: any[] = json.textures ?? [];
    const validNode = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < nodes.length;
    const ch: MglCharacter | undefined = json.extensions?.[MGL_CHARACTER];
    const used: string[] = json.extensionsUsed ?? [];

    if (json.asset?.version !== '2.0') errors.push('asset.version must be 2.0');
    for (const ext of [MGL_CHARACTER, MGL_TOON, MGL_SPRINGS]) {
        if ((json.extensionsRequired ?? []).includes(ext)) errors.push(`${ext} must not be in extensionsRequired`);
    }
    if (!ch) errors.push(`${MGL_CHARACTER} is missing`);
    else {
        if (!used.includes(MGL_CHARACTER)) errors.push(`${MGL_CHARACTER} is not in extensionsUsed`);
        if (typeof ch.specVersion !== 'string') errors.push('specVersion is missing');
        else if (!/^1\./.test(ch.specVersion)) warnings.push(`specVersion ${ch.specVersion} is not 1.x`);

        // meta
        const meta: any = ch.meta;
        if (!meta || typeof meta !== 'object') errors.push('meta is missing');
        else {
            if (!meta.name) errors.push('meta.name is missing');
            if (!Array.isArray(meta.authors) || !meta.authors.length) errors.push('meta.authors is missing');
            if (!meta.licenseUrl) errors.push('meta.licenseUrl is missing');
            for (const [k, values] of Object.entries(META_ENUMS)) if (!values.includes(meta[k])) errors.push(`meta.${k} must be one of ${values.join(', ')}`);
            for (const k of META_FLAGS) if (typeof meta[k] !== 'boolean') errors.push(`meta.${k} must be true or false`);
        }

        // humanoid
        const bones = ch.humanoid?.bones ?? {};
        const parent = parentsOf(json);
        for (const b of HUMANOID_REQUIRED) if (!bones[b]) errors.push(`humanoid.${b} is missing`);
        for (const [b, ref] of Object.entries(bones)) {
            if (!HUMANOID_BONES.includes(b)) { warnings.push(`humanoid.${b} is not a humanoid bone`); continue; }
            if (!validNode(ref?.node)) { errors.push(`humanoid.${b} points to no node`); continue; }
            const up = humanoidParents(b).find((p) => bones[p] && validNode(bones[p].node));
            if (up && !isAncestor(parent, bones[up].node, ref.node)) errors.push(`humanoid.${b} is not under ${up}`);
        }
        const seen = new Map<number, string>();
        for (const [b, ref] of Object.entries(bones)) {
            if (!validNode(ref?.node)) continue;
            if (seen.has(ref.node)) errors.push(`humanoid.${b} and ${seen.get(ref.node)} are the same node`);
            seen.set(ref.node, b);
        }
        for (const t of ch.humanoid?.twist ?? []) {
            if (!bones[t.of]) errors.push(`twist of ${t.of}: no such humanoid bone`);
            if (!validNode(t.node)) errors.push(`twist of ${t.of}: no such node`);
        }

        // where it stands (warnings)
        if (bones.hips && bones.head && validNode(bones.hips.node) && validNode(bones.head.node)) {
            const pos = restPositions(json, parent);
            const head = pos[bones.head.node], hips = pos[bones.hips.node];
            if (head[1] < 0.6 || head[1] > 2.5) warnings.push(`head stands ${head[1].toFixed(2)} m high (expected 0.6-2.5 m, Y up)`);
            if (Math.abs(hips[0]) > 0.3 || Math.abs(hips[2]) > 0.3) warnings.push('hips are not above the origin');
            const foot = bones.leftFoot && pos[bones.leftFoot.node], toes = bones.leftToes && pos[bones.leftToes.node];
            if (foot && toes && toes[2] < foot[2]) warnings.push('toes point to -Z: the model should face +Z');
        }

        // expressions
        const exprs = { ...(ch.expressions?.preset ?? {}), ...(ch.expressions?.custom ?? {}) } as Record<string, MglExpression>;
        for (const name of Object.keys(ch.expressions?.preset ?? {})) if (!(EXPRESSION_PRESETS as readonly string[]).includes(name)) errors.push(`expression preset ${name} is not a preset name (put it under custom)`);
        for (const [name, e] of Object.entries(exprs)) {
            for (const b of e.morphTargetBinds ?? []) {
                const mesh = validNode(b.node) ? meshes[nodes[b.node].mesh] : undefined;
                const targets = mesh?.primitives?.[0]?.targets?.length ?? 0;
                if (!mesh) errors.push(`expression ${name}: morph bind on node ${b.node} without a mesh`);
                else if (!(b.index >= 0 && b.index < targets)) errors.push(`expression ${name}: morph target ${b.index} does not exist`);
            }
            for (const b of e.boneBinds ?? []) if (!validNode(b.node)) errors.push(`expression ${name}: bone bind on no node`);
            for (const b of [...(e.materialColorBinds ?? []), ...(e.textureTransformBinds ?? []), ...(e.layerBinds ?? [])]) {
                if (!(b.material >= 0 && b.material < materials.length)) errors.push(`expression ${name}: no material ${b.material}`);
            }
        }
        const def = ch.expressions?.default;
        if (def && !exprs[def]) errors.push(`default expression ${def} does not exist`);
        const blink = ch.expressions?.blink?.expression;
        if (blink && !exprs[blink]) errors.push(`blink expression ${blink} does not exist`);
        if (ch.lookAt?.type === 'bone' && (!bones.leftEye || !bones.rightEye)) warnings.push('lookAt by bone without leftEye/rightEye bones');
    }

    // springs
    const springs: MglSprings | undefined = json.extensions?.[MGL_SPRINGS];
    if (springs) {
        if (!used.includes(MGL_SPRINGS)) errors.push(`${MGL_SPRINGS} is not in extensionsUsed`);
        const names = new Set((springs.colliders ?? []).map((c) => c.name));
        for (const c of springs.colliders ?? []) {
            if (!validNode(c.node)) errors.push(`collider ${c.name}: no such node`);
            if (c.shape !== 'sphere' && c.shape !== 'capsule') errors.push(`collider ${c.name}: shape must be sphere or capsule`);
        }
        for (const [i, c] of (springs.chains ?? []).entries()) {
            if (!validNode(c.root)) errors.push(`spring chain ${c.name ?? i}: no root node`);
            if (!(c.period > 0)) errors.push(`spring chain ${c.name ?? i}: period must be above 0`);
            for (const n of c.colliders ?? []) if (!names.has(n)) errors.push(`spring chain ${c.name ?? i}: no collider ${n}`);
        }
    }

    // materials
    let anyToon = false;
    // How each image is read: as color (sRGB) or as data (linear). One image read both ways is decoded wrong for one of them.
    const spaces = new Map<number, Set<string>>();
    const readAs = (info: any, role: string) => {
        const image = textures[info?.index]?.source;
        if (!Number.isInteger(image)) return;
        if (!spaces.has(image)) spaces.set(image, new Set());
        spaces.get(image)!.add(SRGB_ROLES.has(role) ? 'sRGB' : 'linear');
    };
    materials.forEach((m, i) => {
        const label = `material ${m?.name ?? i}`;
        if (!m?.pbrMetallicRoughness) errors.push(`${label} has no pbrMetallicRoughness (the fallback)`);
        for (const role of ['baseColorTexture', 'metallicRoughnessTexture'] as const) readAs(m?.pbrMetallicRoughness?.[role], role);
        for (const role of ['normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) readAs(m?.[role], role);
        const t = m?.extensions?.[MGL_TOON];
        if (!t) return;
        anyToon = true;
        for (const key of ANIME_MAP_KEYS) {
            const info = t[key];
            if (info === undefined || info === null) continue;
            if (!(Number.isInteger(info.index) && info.index >= 0 && info.index < textures.length)) errors.push(`${label}: ${key} points to no texture`);
            else readAs(info, key);
        }
        if (t.draw !== undefined && !(DRAW_LAYERS as readonly string[]).includes(t.draw?.layer)) errors.push(`${label}: draw.layer must be one of ${DRAW_LAYERS.join(', ')}`);
    });
    if (anyToon && !used.includes(MGL_TOON)) errors.push(`${MGL_TOON} is not in extensionsUsed`);
    spaces.forEach((s, image) => {
        if (s.size > 1) warnings.push(`image ${json.images?.[image]?.name ?? image} is read both as color (sRGB) and as data (linear)`);
    });

    // skins and vertex attributes, given the binary chunk
    meshes.forEach((mesh, mi) => {
        for (const prim of mesh?.primitives ?? []) {
            const a = prim.attributes ?? {};
            const label = `mesh ${mesh?.name ?? mi}`;
            if (a.JOINTS_1 !== undefined || a.WEIGHTS_1 !== undefined) errors.push(`${label}: more than 4 bones a vertex`);
            // A normal map is baked against its mesh's tangents. Without them the shading builds a frame
            // from screen derivatives, which follows them only roughly (and hair cards then run their
            // strands up the head), so the file must carry them.
            const needsTangent = !!materials[prim.material]?.normalTexture;
            if (needsTangent && a.TANGENT === undefined) errors.push(`${label}: TANGENT is needed (normal map)`);
            const outlineMode = materials[prim.material]?.extensions?.[MGL_TOON]?.outlineNormals;
            if (outlineMode === 'tangent' && a._OUTLINE !== undefined && a.TANGENT === undefined) warnings.push(`${label}: outline directions in the tangent frame but no TANGENT (the outline goes along NORMAL)`);
            if (!bin) continue;
            if (a.WEIGHTS_0 !== undefined) {
                const w = readAccessor(json, bin, a.WEIGHTS_0);
                if (w) {
                    let bad = 0;
                    for (let i = 0; i < w.values.length; i += w.n) {
                        const s = w.values[i] + w.values[i + 1] + w.values[i + 2] + w.values[i + 3];
                        if (Math.abs(s - 1) > 0.001) bad++;
                    }
                    if (bad) errors.push(`${label}: ${bad} vertices whose weights do not add up to 1`);
                }
            }
            // A baked or tangent-frame outline goes along _OUTLINE's direction, whatever its length; one of
            // no length (the shading takes a squared length under 1e-8 so) goes along the normal.
            if (a._OUTLINE !== undefined && (outlineMode === 'baked' || outlineMode === 'tangent')) {
                const o = readAccessor(json, bin, a._OUTLINE);
                if (o) {
                    let short = 0;
                    for (let i = 0; i < o.values.length; i += o.n) if (Math.hypot(o.values[i], o.values[i + 1], o.values[i + 2]) < 1e-4) short++;
                    if (short) warnings.push(`${label}: ${short} vertices with no outline direction (they go along NORMAL)`);
                }
            }
        }
    });
    return { errors, warnings };
}
