import { describe, expect, it } from 'vitest';
import { computeOutlineNormals, computeTangents } from '../../src/core/meshTools';
import { parsePmx } from '../../src/core/pmx';
import { isIrisMaterial, pmxSlot, pmxToGlb } from '../../src/core/pmxToGlb';
import type { PmxMaterial } from '../../src/core/pmx';

/** A tiny PMX 2.0: one quad, one textured material with an edge, two bones, one vertex morph. */
function tinyPmx(): ArrayBuffer {
    const bytes: number[] = [];
    const u8 = (v: number) => bytes.push(v & 255);
    const i8 = (v: number) => u8(v < 0 ? 256 + v : v);
    const u16 = (v: number) => { u8(v); u8(v >> 8); };
    const i32 = (v: number) => { const b = new Uint8Array(new Int32Array([v]).buffer); b.forEach((x) => u8(x)); };
    const f32 = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); b.forEach((x) => u8(x)); };
    const text = (s: string) => { i32(s.length * 2); for (const ch of s) u16(ch.charCodeAt(0)); };
    [0x50, 0x4d, 0x58, 0x20].forEach(u8);
    f32(2);
    u8(8);
    [0, 0, 1, 1, 1, 1, 1, 1].forEach(u8);
    text('テスト'); text('test'); text(''); text('');
    // Four vertices: a 2 x 2 quad facing -Z (MMD's front), v down the image.
    const quad = [[-1, 0, 0, 0, 1], [1, 0, 0, 1, 1], [1, 2, 0, 1, 0], [-1, 2, 0, 0, 0]];
    i32(4);
    quad.forEach(([x, y, z, u, v], i) => {
        f32(x); f32(y); f32(z); f32(0); f32(0); f32(-1); f32(u); f32(v);
        if (i < 2) { u8(0); i8(0); } else { u8(1); i8(0); i8(1); f32(0.25); }
        f32(1);
    });
    i32(6);
    [0, 1, 2, 0, 2, 3].forEach(u8);
    i32(1); text('tex\\hair_D.png');
    i32(1);
    text('髪'); text('hair');
    f32(1); f32(1); f32(1); f32(1);
    f32(0); f32(0); f32(0); f32(5);
    f32(0.5); f32(0.5); f32(0.5);
    u8(0x10 | 0x01);
    f32(0); f32(0); f32(0); f32(1); f32(0.6);
    i8(0); i8(-1); u8(0); u8(1); u8(1);
    text('');
    i32(6);
    i32(2);
    text('センター'); text('center'); f32(0); f32(0); f32(0); i8(-1); i32(0); u16(0x0001); i8(1);
    text('頭'); text('head'); f32(0); f32(10); f32(0); i8(0); i32(0); u16(0); f32(0); f32(1); f32(0);
    i32(1);
    text('まばたき'); text('blink'); u8(2); u8(1); i32(1); u8(2); f32(0); f32(-0.1); f32(0);
    i32(0); i32(0); i32(0);
    return new Uint8Array(bytes).buffer;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function glbJson(glb: Uint8Array): any {
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
}

describe('PMX import', () => {
    it('reads the mesh, skin, materials, bones and vertex morphs', () => {
        const pmx = parsePmx(tinyPmx());
        expect(pmx.positions.length).toBe(12);
        expect(Array.from(pmx.indices)).toEqual([0, 1, 2, 0, 2, 3]);
        expect(pmx.textures).toEqual(['tex\\hair_D.png']);
        expect(pmx.materials[0]).toMatchObject({ name: '髪', edge: true, doubleSided: true, texture: 0, sphere: -1, toon: { shared: 1 }, indexCount: 6 });
        expect(pmx.materials[0].edgeSize).toBeCloseTo(0.6);
        expect(pmx.bones.map((b) => b.name)).toEqual(['センター', '頭']);
        expect(Array.from(pmx.joints.subarray(8, 12))).toEqual([0, 1, 0, 0]);
        expect(pmx.weights[8]).toBeCloseTo(0.25);
        expect(pmx.weights[9]).toBeCloseTo(0.75);
        expect(pmx.morphs[0].offsets).toHaveLength(1);
    });

    it('makes a GLB in meters with Z mirrored, tangents, outline normals and a skin', () => {
        const { glb, slots, report } = pmxToGlb(parsePmx(tinyPmx()), { image: () => ({ bytes: PNG, mimeType: 'image/png' }) });
        const json = glbJson(glb);
        const prim = json.meshes[0].primitives[0];
        expect(Object.keys(prim.attributes).sort()).toEqual(['JOINTS_0', 'NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0', 'WEIGHTS_0', '_OUTLINE_NORMAL']);
        expect(json.accessors[prim.attributes.POSITION].max[1]).toBeCloseTo(0.16);
        // Both bones and one joint over the top bones, the skeleton's root.
        expect(json.skins[0].joints).toHaveLength(3);
        expect(json.nodes[json.skins[0].skeleton].children).toEqual([0]);
        expect(json.nodes[1].translation[1]).toBeCloseTo(0.8);
        expect(json.materials[0].pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
        expect(json.images[0].mimeType).toBe('image/png');
        // MMD's edge size 0.6 scales the hair kind's usual Outline (0.4).
        expect(slots[0]).toMatchObject({ material: '髪', alphaMode: 'opaque', doubleSide: true, anime: { kind: 'hair', outline: 0.24, outlineNormals: 'baked' } });
        expect(report.some((l) => /vertex morphs/.test(l))).toBe(true);
    });

    it('reads a mask in the toon layout and a hair\'s _HN as its two normals, on both hair layers', () => {
        const maps = { HN: new Uint8Array([...PNG, 1]), N: new Uint8Array([...PNG, 2]), P: new Uint8Array([...PNG, 3]) } as Record<string, Uint8Array>;
        const { glb, slots } = pmxToGlb(parsePmx(tinyPmx()), {
            image: () => ({ bytes: PNG, mimeType: 'image/png' }),
            companion: (_path, suffix) => (maps[suffix] ? { bytes: maps[suffix], mimeType: 'image/png' } : null),
        });
        const json = glbJson(glb);
        const mat = json.materials[0];
        // The last byte of the image a texture shows (the maps above end in 1, 2, 3).
        const binAt = 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true) + 8;
        const lastByte = (tex: number) => {
            const view = json.bufferViews[json.images[json.textures[tex].source].bufferView];
            return glb[binAt + (view.byteOffset ?? 0) + view.byteLength - 1];
        };
        // _HN goes before _N (which is not packed at all), the mask to the metallic-roughness slot.
        expect(lastByte(mat.normalTexture.index)).toBe(1);
        expect(lastByte(mat.pbrMetallicRoughness.metallicRoughnessTexture.index)).toBe(3);
        expect(json.images).toHaveLength(3);
        expect(slots[0].anime).toMatchObject({ kind: 'hair', normalLayout: 'split', maskLayout: 'toon' });
        expect(slots[1].anime).toMatchObject({ normalLayout: 'split', maskLayout: 'toon' });
        // Without maps, the layouts stay as the kind has them.
        const bare = pmxToGlb(parsePmx(tinyPmx()), { image: () => ({ bytes: PNG, mimeType: 'image/png' }) });
        expect(bare.slots[0].anime.maskLayout).toBeUndefined();
        expect(bare.slots[0].anime.normalLayout).toBeUndefined();
    });

    it('says which iris maps lost their alpha', () => {
        const pmx = parsePmx(tinyPmx());
        pmx.materials[0].name = '瞳';
        pmx.materials[0].nameEn = 'iris';
        const { slots, report } = pmxToGlb(pmx, { image: () => ({ bytes: PNG, mimeType: 'image/png' }), opaqueIris: () => true });
        // The eye kind's values stand (its tint is neutral and Iris Circle off until set).
        expect(slots[0].anime.kind).toBe('eye');
        expect(slots[0].anime.irisAlphaTint).toBeUndefined();
        expect(report.some((l) => /iris maps without alpha.*瞳/.test(l))).toBe(true);
        // Brows and highlights are not irises.
        expect(isIrisMaterial({ ...pmx.materials[0], name: '眉', nameEn: '' })).toBe(false);
        expect(isIrisMaterial({ ...pmx.materials[0], name: '目HL', nameEn: '' })).toBe(false);
        expect(isIrisMaterial({ ...pmx.materials[0], name: '目', nameEn: '' })).toBe(true);
    });

    it('turns a flat dark see-through material into a multiply overlay', () => {
        const m = { name: '目影', nameEn: '', texture: -1, diffuse: [0, 0, 0, 0.2], edge: false, edgeSize: 0.5, doubleSided: true } as unknown as PmxMaterial;
        expect(pmxSlot(m, '目影')).toMatchObject({ alphaMode: 'multiply', opacity: 1, color: '#cccccc', anime: { kind: 'overlay' } });
        const mask = { ...m, name: '面具', texture: 0, diffuse: [1, 1, 1, 1], edge: true, edgeSize: 0.6 } as PmxMaterial;
        expect(pmxSlot(mask, '面具').anime.kind).toBe('cloth');
        expect(pmxSlot({ ...mask, name: '面' } as PmxMaterial, '面').anime.kind).toBe('face');
        expect(pmxSlot({ ...mask, name: '发' } as PmxMaterial, '发').anime.kind).toBe('hair');
    });

    it('layers the slots as an anime character: eyes and brows through hair, its second layer, decals left out', () => {
        const base = { name: '', nameEn: '', texture: 0, diffuse: [1, 1, 1, 1], edge: true, edgeSize: 0.5, doubleSided: true } as unknown as PmxMaterial;
        const slot = (name: string, tex = '') => pmxSlot({ ...base, name } as PmxMaterial, name, false, tex);
        // The character format's layers (stencil bits 1 character, 2 eye, 4 hair).
        expect(slot('眉')).toMatchObject({ anime: { kind: 'eye', outline: 0 }, pass: { stencil: { ref: 3, compare: 'always', pass: 'replace' } } });
        expect(slot('睫').anime.kind).toBe('eye');
        expect(slot('目').pass?.stencil?.ref).toBe(3);
        expect(slot('目白')).toMatchObject({ anime: { kind: 'face' }, pass: { stencil: { ref: 1 } } });
        const hair = slot('发');
        expect(hair.pass).toMatchObject({ order: 3200, stencil: { ref: 5, read: 2, compare: 'equal' }, outlineStencil: { compare: 'not-equal' } });
        // Its second layer over the eyes is half see-through, so they show through the bangs.
        expect(hair.layers?.[0]).toMatchObject({ suffix: '2', alphaMode: 'blend', opacity: 0.5, pass: { order: 3400, depthCompare: 'less' } });
        expect(slot('Cloth1Alpha')).toMatchObject({ alphaMode: 'blend', pass: { order: 3500, depthWrite: false } });
        // Expression decals MMD keeps hidden until a morph shows them are left out; shown ones stay.
        expect(pmxSlot({ ...base, name: '表情', diffuse: [1, 1, 1, 0] } as PmxMaterial, '表情', false, 'textures\\face_expressions_D.png').drop).toBe(true);
        expect(slot('表情', 'textures\\face_expressions_D.png').drop).toBeUndefined();
        const card = { ...base, name: '面具影', texture: -1, diffuse: [0, 0, 0, 0.2], edge: false } as unknown as PmxMaterial;
        expect(pmxSlot(card, '面具影').pass?.stencil).toMatchObject({ ref: 1, read: 7, compare: 'equal' });
    });
});

describe('mesh tools', () => {
    // A quad in the XY plane facing +Z, its right half's corners split (a UV seam).
    const P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 2, 0, 0.5, 2, 1, 0.5];
    const N = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const UV = [0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0];
    const I = [0, 1, 2, 0, 2, 3, 4, 6, 7, 4, 7, 5];

    it('runs tangents along +U with the bitangent up the image', () => {
        const t = computeTangents(P, N, UV, I);
        expect(t[0]).toBeCloseTo(1);
        expect(t[1]).toBeCloseTo(0);
        expect(t[3]).toBe(1);
    });

    it('gives the vertices at one place one outline normal across a seam', () => {
        const o = computeOutlineNormals(P, I, N);
        expect(Array.from(o.subarray(3, 6))).toEqual(Array.from(o.subarray(12, 15)));
        expect(Array.from(o.subarray(6, 9))).toEqual(Array.from(o.subarray(15, 18)));
        expect(Math.hypot(o[0], o[1], o[2])).toBeCloseTo(1);
    });
});
