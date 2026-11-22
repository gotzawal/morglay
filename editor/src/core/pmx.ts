// Reads a PMX 2.0 / 2.1 model (MikuMikuDance's format): the mesh, its skin,
// materials, textures, bones and vertex morphs, as the file has them (MMD's
// units and axes; core/pmxToGlb.ts turns them into a glTF model). Display
// frames, rigid bodies, joints and soft bodies are not read: the converter
// does not use them.

export interface PmxMaterial {
    name: string;
    nameEn: string;
    /** Diffuse color and alpha (multiplies the texture). */
    diffuse: [number, number, number, number];
    specular: [number, number, number];
    specularPower: number;
    ambient: [number, number, number];
    doubleSided: boolean;
    castShadow: boolean;
    receiveShadow: boolean;
    /** Draws MMD's edge (outline). */
    edge: boolean;
    edgeColor: [number, number, number, number];
    edgeSize: number;
    /** Index into textures, or -1. */
    texture: number;
    sphere: number;
    sphereMode: 'none' | 'multiply' | 'add' | 'subtexture';
    /** A toon texture: one of MMD's ten shared ones (0-9), or an index into textures; null for none. */
    toon: { shared: number } | { texture: number } | null;
    memo: string;
    /** How many indices (three a triangle) of the face list are this material's, in order. */
    indexCount: number;
}

export interface PmxBone {
    name: string;
    nameEn: string;
    position: [number, number, number];
    parent: number;
    layer: number;
    flags: number;
}

export interface PmxMorph {
    name: string;
    nameEn: string;
    panel: number;
    /** Vertex morphs only: vertex index and offset. */
    offsets: { vertex: number; offset: [number, number, number] }[];
}

export interface PmxModel {
    version: number;
    name: string;
    nameEn: string;
    comment: string;
    /** Per vertex: x y z. */
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** Up to four bones per vertex and their weights (SDEF is read as BDEF2, its curve dropped). */
    joints: Uint16Array;
    weights: Float32Array;
    /** MMD's per-vertex edge (outline) width scale. */
    edgeScale: Float32Array;
    indices: Uint32Array;
    textures: string[];
    materials: PmxMaterial[];
    bones: PmxBone[];
    morphs: PmxMorph[];
    /** How many SDEF vertices were read as BDEF2. */
    sdef: number;
}

export function isPmx(buffer: ArrayBuffer): boolean {
    const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    return b.length === 4 && b[0] === 0x50 && b[1] === 0x4d && b[2] === 0x58 && b[3] === 0x20;
}

export function parsePmx(buffer: ArrayBuffer): PmxModel {
    if (!isPmx(buffer)) throw new Error('Not a PMX file');
    const view = new DataView(buffer);
    let p = 4;
    const version = view.getFloat32(p, true);
    p += 4;
    const globalsCount = view.getUint8(p++);
    const globals: number[] = [];
    for (let i = 0; i < globalsCount; i++) globals.push(view.getUint8(p++));
    const [encoding, additionalUV, vertexSize, textureSize, materialSize, boneSize, morphSize] = globals;
    const decoder = new TextDecoder(encoding === 0 ? 'utf-16le' : 'utf-8');

    const f32 = () => { const v = view.getFloat32(p, true); p += 4; return v; };
    const i32 = () => { const v = view.getInt32(p, true); p += 4; return v; };
    const u8 = () => view.getUint8(p++);
    const u16 = () => { const v = view.getUint16(p, true); p += 2; return v; };
    const vec = (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push(f32()); return out; };
    const text = () => {
        const n = i32();
        if (n < 0 || p + n > buffer.byteLength) throw new Error('PMX text out of range');
        const s = decoder.decode(new Uint8Array(buffer, p, n));
        p += n;
        return s;
    };
    // Indices: vertex indices are unsigned, the others signed (-1 for none).
    const vertexIndex = () => {
        if (vertexSize === 1) return u8();
        if (vertexSize === 2) return u16();
        return i32();
    };
    const index = (size: number) => {
        if (size === 1) { const v = view.getInt8(p); p += 1; return v; }
        if (size === 2) { const v = view.getInt16(p, true); p += 2; return v; }
        return i32();
    };

    const name = text();
    const nameEn = text();
    const comment = text();
    text(); // comment (English)

    // ---- vertices
    const count = i32();
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const joints = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    const edgeScale = new Float32Array(count);
    let sdef = 0;
    for (let v = 0; v < count; v++) {
        positions[v * 3] = f32(); positions[v * 3 + 1] = f32(); positions[v * 3 + 2] = f32();
        normals[v * 3] = f32(); normals[v * 3 + 1] = f32(); normals[v * 3 + 2] = f32();
        uvs[v * 2] = f32(); uvs[v * 2 + 1] = f32();
        p += additionalUV * 16;
        const type = u8();
        const set = (k: number, bone: number, w: number) => {
            joints[v * 4 + k] = bone >= 0 ? bone : 0;
            weights[v * 4 + k] = bone >= 0 ? w : 0;
        };
        if (type === 0) {
            set(0, index(boneSize), 1);
        } else if (type === 1 || type === 3) {
            const b0 = index(boneSize), b1 = index(boneSize), w = f32();
            set(0, b0, w);
            set(1, b1, 1 - w);
            if (type === 3) {
                p += 36; // C, R0, R1
                sdef++;
            }
        } else if (type === 2 || type === 4) {
            const b = [index(boneSize), index(boneSize), index(boneSize), index(boneSize)];
            const w = vec(4);
            for (let k = 0; k < 4; k++) set(k, b[k], w[k]);
        } else {
            throw new Error(`PMX vertex ${v}: unknown weight type ${type}`);
        }
        // Weights sum to one (BDEF4 files do not always).
        const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
        if (sum > 0) for (let k = 0; k < 4; k++) weights[v * 4 + k] /= sum;
        else weights[v * 4] = 1;
        edgeScale[v] = f32();
    }

    // ---- faces
    const indexCount = i32();
    const indices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) indices[i] = vertexIndex();

    // ---- textures
    const textures: string[] = [];
    for (let i = 0, n = i32(); i < n; i++) textures.push(text());

    // ---- materials
    const materials: PmxMaterial[] = [];
    for (let i = 0, n = i32(); i < n; i++) {
        const mName = text();
        const mNameEn = text();
        const diffuse = vec(4) as PmxMaterial['diffuse'];
        const specular = vec(3) as PmxMaterial['specular'];
        const specularPower = f32();
        const ambient = vec(3) as PmxMaterial['ambient'];
        const flags = u8();
        const edgeColor = vec(4) as PmxMaterial['edgeColor'];
        const edgeSize = f32();
        const texture = index(textureSize);
        const sphere = index(textureSize);
        const sphereMode = (['none', 'multiply', 'add', 'subtexture'] as const)[u8()] ?? 'none';
        const sharedToon = u8();
        const toonValue = sharedToon === 1 ? u8() : index(textureSize);
        const toon = sharedToon === 1 ? { shared: toonValue } : toonValue >= 0 ? { texture: toonValue } : null;
        const memo = text();
        materials.push({
            name: mName, nameEn: mNameEn, diffuse, specular, specularPower, ambient,
            doubleSided: !!(flags & 0x01), castShadow: !!(flags & 0x04), receiveShadow: !!(flags & 0x08), edge: !!(flags & 0x10),
            edgeColor, edgeSize, texture, sphere, sphereMode, toon, memo, indexCount: i32(),
        });
    }

    // ---- bones
    const bones: PmxBone[] = [];
    for (let i = 0, n = i32(); i < n; i++) {
        const bName = text();
        const bNameEn = text();
        const position = vec(3) as PmxBone['position'];
        const parent = index(boneSize);
        const layer = i32();
        const flags = u16();
        if (flags & 0x0001) index(boneSize); else p += 12; // tail
        if (flags & 0x0300) { index(boneSize); f32(); } // inherited rotation or move
        if (flags & 0x0400) p += 12; // fixed axis
        if (flags & 0x0800) p += 24; // local axes
        if (flags & 0x2000) p += 4; // external parent
        if (flags & 0x0020) {
            index(boneSize); i32(); f32();
            for (let k = 0, links = i32(); k < links; k++) {
                index(boneSize);
                if (u8()) p += 24;
            }
        }
        bones.push({ name: bName, nameEn: bNameEn, position, parent, layer, flags });
    }

    // ---- morphs (vertex offsets kept, the other kinds skipped)
    const morphs: PmxMorph[] = [];
    for (let i = 0, n = i32(); i < n; i++) {
        const mName = text();
        const mNameEn = text();
        const panel = u8();
        const type = u8();
        const items = i32();
        const offsets: PmxMorph['offsets'] = [];
        for (let k = 0; k < items; k++) {
            if (type === 0 || type === 9) { index(morphSize); f32(); }
            else if (type === 1) { const vertex = vertexIndex(); offsets.push({ vertex, offset: vec(3) as [number, number, number] }); }
            else if (type === 2) { index(boneSize); p += 28; }
            else if (type >= 3 && type <= 7) { vertexIndex(); p += 16; }
            else if (type === 8) { index(materialSize); p += 1 + 16 + 12 + 4 + 12 + 16 + 4 + 16 + 16 + 16; }
            else if (type === 10) { index(globals[7]); p += 1 + 24; }
            else throw new Error(`PMX morph ${mName}: unknown type ${type}`);
        }
        if (type === 1) morphs.push({ name: mName, nameEn: mNameEn, panel, offsets });
    }

    return { version, name, nameEn, comment, positions, normals, uvs, joints, weights, edgeScale, indices, textures, materials, bones, morphs, sdef };
}
