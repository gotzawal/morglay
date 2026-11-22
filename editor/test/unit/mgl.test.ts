import { describe, expect, it } from 'vitest';
import { checkMgl, humanoidParents, MGL_CHARACTER, MGL_SPRINGS, MGL_TOON, readAccessor, readMgl } from '../../src/core/mgl';
import { layerOfPass, layerPass, mapAnimeMaps, materialJson, materialOfJson, passIsLayer } from '../../src/core/mglMaterial';
import type { SlotPassDoc } from '../../src/core/model';

describe("the format's material", () => {
    // The pass states a layered character's slots use (eyes through hair, shadows on skin and eyes).
    // Stencil bits: 1 a character, 2 an eye, 4 hair.
    const BODY = { ref: 1, read: 7, write: 7, compare: 'always', pass: 'replace' } as const;
    const EYE = { ref: 3, read: 7, write: 7, compare: 'always', pass: 'replace' } as const;
    const HAIR = { ref: 5, read: 2, write: 5, compare: 'equal', pass: 'replace' } as const;
    const NOT_EYE = { ref: 2, read: 2, write: 0, compare: 'not-equal', pass: 'keep' } as const;
    const on = (ref: number, read: number) => ({ ref, read, write: 0, compare: 'equal', pass: 'keep' }) as const;
    const slots: [string, { pass?: SlotPassDoc; alphaMode?: 'multiply'; kind?: 'overlay' }, string][] = [
        ['body', { pass: { stencil: BODY } }, 'body'],
        ['eye', { pass: { stencil: EYE } }, 'eye'],
        ['hair', { pass: { order: 3200, stencil: HAIR, outlineDepthCompare: 'less', outlineStencil: NOT_EYE } }, 'hair'],
        ['mask over hair', { pass: { order: 3210, stencil: BODY } }, 'afterHair'],
        ['hair over eyes', { pass: { order: 3400, depthCompare: 'less', depthWrite: true, outlineDepthCompare: 'less', outlineStencil: NOT_EYE } }, 'hairOver'],
        ['see-through', { pass: { order: 3500, depthWrite: false } }, 'transparent'],
        ['shadow on skin and hair', { alphaMode: 'multiply', kind: 'overlay', pass: { order: 3300, depthWrite: false, depthBias: -1, depthBiasSlope: -1, stencil: on(1, 3) } }, 'overlay'],
        ['shadow on eyes', { alphaMode: 'multiply', kind: 'overlay', pass: { order: 3300, depthWrite: false, depthBias: -1, depthBiasSlope: -1, stencil: on(3, 3) } }, 'overlay'],
        ['shadow on skin only', { alphaMode: 'multiply', kind: 'overlay', pass: { order: 3310, depthWrite: false, depthBias: -5, depthBiasSlope: -1, stencil: on(1, 7) } }, 'overlay'],
    ];

    it('draws cards that darken only the body after the other overlays', () => {
        expect(layerPass({ layer: 'overlay', target: ['body'] }).order).toBeGreaterThan(layerPass({ layer: 'overlay' }).order!);
        expect(layerPass({ layer: 'overlay', target: ['eye'] }).order).toBe(layerPass({ layer: 'overlay' }).order);
        // Their order among themselves is still free: a card moved by hand stays the same layer.
        expect(passIsLayer({ ...layerPass({ layer: 'overlay' }), order: 3350 }, { layer: 'overlay' })).toBe(true);
    });

    it('reads each pass state as a layer and gives the same pass state back', () => {
        for (const [what, s, layer] of slots) {
            const draw = layerOfPass({ pass: s.pass, alphaMode: s.alphaMode, anime: s.kind ? { kind: s.kind } : undefined } as any);
            expect(draw.layer, what).toBe(layer);
            expect(passIsLayer(s.pass, draw), what).toBe(true);
            // An overlay's order among overlays is free (they multiply): the rest is exact.
            const back = layerPass(draw);
            expect({ ...back, order: s.pass?.order }, what).toEqual({ ...s.pass, order: s.pass?.order });
        }
    });

    it('stores what differs from the kind, maps as textures, and the layer', () => {
        const json = materialJson({ anime: { kind: 'hair', hair: 1, hairShift: 0.46, rampMap: { index: 3 }, outline: 0.4 } as any, draw: { layer: 'hair' } });
        // An outline of 0.4 is what the hair kind gives (left out); hair 1 is not its 0.9.
        expect(json).toEqual({ kind: 'hair', hair: 1, hairShift: 0.46, rampMap: { index: 3 }, draw: { layer: 'hair' } });
        const back = materialOfJson<{ index: number }>(json);
        expect(back.draw).toEqual({ layer: 'hair' });
        expect(mapAnimeMaps(back.anime, (t) => `asset-${t.index}`).rampMap).toBe('asset-3');
        // A body material says no layer; an overlay keeps its marks and offset.
        expect(materialJson({ anime: { kind: 'cloth' }, draw: { layer: 'body' } })).toEqual({ kind: 'cloth' });
        expect(materialJson({ anime: { kind: 'overlay' }, draw: { layer: 'overlay', target: ['body'], depthBias: -5 } }).draw).toEqual({ layer: 'overlay', target: ['body'], depthBias: -5 });
    });
});

/** A small valid character: the fifteen humanoid bones, one mesh with two morph targets, a face material. */
function character(): any {
    const n = (name: string, t: number[], children: number[] = []) => ({ name, translation: t, ...(children.length ? { children } : {}) });
    const nodes = [
        n('hips', [0, 0.9, 0], [1, 9, 12]),
        n('spine', [0, 0.1, 0], [2, 3, 6]),
        n('head', [0, 0.5, 0]),
        n('l_upper_arm', [0.15, 0.35, 0], [4]), n('l_lower_arm', [0.25, 0, 0], [5]), n('l_hand', [0.25, 0, 0]),
        n('r_upper_arm', [-0.15, 0.35, 0], [7]), n('r_lower_arm', [-0.25, 0, 0], [8]), n('r_hand', [-0.25, 0, 0]),
        n('l_upper_leg', [0.1, -0.05, 0], [10]), n('l_lower_leg', [0, -0.4, 0], [11]), n('l_foot', [0, -0.4, 0]),
        n('r_upper_leg', [-0.1, -0.05, 0], [13]), n('r_lower_leg', [0, -0.4, 0], [14]), n('r_foot', [0, -0.4, 0]),
        { name: 'face', mesh: 0 },
    ];
    const roles = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
    return {
        asset: { version: '2.0' },
        extensionsUsed: [MGL_CHARACTER, MGL_TOON, MGL_SPRINGS],
        nodes,
        scenes: [{ nodes: [0, 15] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2 }, material: 0, targets: [{ POSITION: 3 }, { POSITION: 3 }] }] }],
        materials: [{ name: 'face', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] }, extensions: { [MGL_TOON]: { kind: 'face', faceMap: { index: 0 } } } }],
        textures: [{ source: 0 }],
        images: [{ uri: 'library:face-shadow/standard' }],
        extensions: {
            [MGL_CHARACTER]: {
                specVersion: '1.0-draft',
                meta: {
                    name: 'Test', authors: ['me'], licenseUrl: 'https://example.com/license', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit',
                    allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false,
                    creditNotation: 'required', allowRedistribution: false, modification: 'prohibited',
                },
                humanoid: { bones: Object.fromEntries(roles.map((r, i) => [r, { node: i }])) },
                expressions: {
                    preset: { blink: { morphTargetBinds: [{ node: 15, index: 1, weight: 1 }] }, neutral: {} },
                    default: 'neutral',
                    blink: { expression: 'blink', interval: [2, 5], duration: 0.15 },
                },
            },
            [MGL_SPRINGS]: { chains: [{ root: 2, period: 0.8, damping: 0.5, gravity: 0.1, drag: 0.2, maxAngle: 40, radius: 0.01, colliders: ['head'] }], colliders: [{ name: 'head', node: 2, shape: 'sphere', radius: 0.08 }] },
        },
    };
}

describe('the format checks', () => {
    it('passes a small valid character', () => {
        const r = checkMgl(character());
        expect(r.errors).toEqual([]);
        expect(r.warnings).toEqual([]);
    });

    it('catches what breaks the format', () => {
        const json = character();
        delete json.extensions[MGL_CHARACTER].humanoid.bones.leftHand;
        json.extensions[MGL_CHARACTER].humanoid.bones.rightLowerArm = { node: 3 }; // under the wrong arm, and doubled
        json.extensionsRequired = [MGL_TOON];
        json.materials[0].extensions[MGL_TOON].faceMap = { index: 4 };
        json.materials[0].extensions[MGL_TOON].draw = { layer: 'behind' };
        delete json.materials[0].pbrMetallicRoughness;
        json.extensions[MGL_CHARACTER].expressions.preset.blink.morphTargetBinds[0].index = 2;
        json.extensions[MGL_CHARACTER].expressions.preset.smirk = {};
        json.extensions[MGL_SPRINGS].chains[0].colliders = ['nose'];
        // A normal map reads the tangents; the outline alone does not.
        json.materials[0].normalTexture = { index: 0 };
        json.meshes[0].primitives[0].attributes.TANGENT = undefined;
        const r = checkMgl(json).errors.join('\n');
        expect(r).toMatch(/humanoid.leftHand is missing/);
        expect(r).toMatch(/humanoid.rightLowerArm is not under rightUpperArm/);
        expect(r).toMatch(/same node/);
        expect(r).toMatch(/must not be in extensionsRequired/);
        expect(r).toMatch(/faceMap points to no texture/);
        expect(r).toMatch(/draw.layer must be one of/);
        expect(r).toMatch(/no pbrMetallicRoughness/);
        expect(r).toMatch(/morph target 2 does not exist/);
        expect(r).toMatch(/smirk is not a preset name/);
        expect(r).toMatch(/no collider nose/);
        expect(r).toMatch(/TANGENT is needed/);
    });

    it('asks for tangents only where a normal map reads them', () => {
        const json = character();
        json.meshes[0].primitives[0].attributes.TANGENT = undefined;
        // An outlined face without a normal map, and hair (its strands then run up the head), need none.
        expect(checkMgl(json).errors.join('\n')).not.toMatch(/TANGENT/);
        json.materials[0].extensions[MGL_TOON] = { kind: 'hair' };
        expect(checkMgl(json).errors.join('\n')).not.toMatch(/TANGENT/);
        json.materials[0].normalTexture = { index: 0 };
        expect(checkMgl(json).errors.join('\n')).toMatch(/TANGENT is needed/);
    });

    it('warns about an image read two ways and about outline directions a baked outline cannot go by', () => {
        const json = character();
        // The face's shadow map is also its base color: one image, read as sRGB and as linear.
        json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
        // Three outline directions: one whole, one of no length, one short (still a direction).
        const dirs = new Float32Array([0, 0, 1, 1, 0, 0, 0, 1, 0.05, 0, 0, 1]);
        json.buffers = [{ byteLength: dirs.byteLength }];
        json.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: dirs.byteLength }];
        json.accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC4' }];
        json.meshes[0].primitives[0].attributes._OUTLINE = 0;
        const bin = new Uint8Array(dirs.buffer);
        // Along the mesh's normals the attribute is not read.
        expect(checkMgl(json, bin).warnings.join('\n')).not.toMatch(/outline direction/);
        json.materials[0].extensions[MGL_TOON].outlineNormals = 'baked';
        const r = checkMgl(json, bin);
        expect(r.errors).toEqual([]);
        expect(r.warnings.join('\n')).toMatch(/1 vertices with no outline direction \(they go along NORMAL\)/);
        expect(r.warnings.join('\n')).toMatch(/read both as color \(sRGB\) and as data \(linear\)/);
        // In the tangent frame too, and without TANGENT the whole outline goes along the normal.
        json.materials[0].extensions[MGL_TOON].outlineNormals = 'tangent';
        const t = checkMgl(json, bin).warnings.join('\n');
        expect(t).toMatch(/1 vertices with no outline direction/);
        expect(t).not.toMatch(/no TANGENT/);
        json.meshes[0].primitives[0].attributes.TANGENT = undefined;
        expect(checkMgl(json, bin).warnings.join('\n')).toMatch(/in the tangent frame but no TANGENT/);
    });

    it('knows which bone a humanoid bone hangs under', () => {
        expect(humanoidParents('leftLowerArm')).toEqual(['leftUpperArm']);
        expect(humanoidParents('rightIndexIntermediate')).toEqual(['rightIndexProximal']);
        expect(humanoidParents('leftThumbMetacarpal')).toEqual(['leftHand']);
        expect(humanoidParents('head')[0]).toBe('neck');
    });

    it('reads the extensions out of a GLB and normalized accessors', () => {
        const json = character();
        // One accessor of two normalized shorts x 4 (an outline attribute) in the binary chunk.
        const shorts = new Int16Array([32767, 0, 0, 32767, 0, -32767, 0, 16384]);
        json.buffers = [{ byteLength: 16 }];
        json.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 16 }];
        json.accessors = [{ bufferView: 0, componentType: 5122, normalized: true, count: 2, type: 'VEC4' }];
        const text = new TextEncoder().encode(JSON.stringify(json));
        const jpad = (4 - (text.length % 4)) % 4;
        const glb = new Uint8Array(12 + 8 + text.length + jpad + 8 + 16);
        const dv = new DataView(glb.buffer);
        dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
        dv.setUint32(12, text.length + jpad, true); dv.setUint32(16, 0x4e4f534a, true);
        glb.set(text, 20); glb.fill(0x20, 20 + text.length, 20 + text.length + jpad);
        const at = 20 + text.length + jpad;
        dv.setUint32(at, 16, true); dv.setUint32(at + 4, 0x004e4942, true);
        glb.set(new Uint8Array(shorts.buffer), at + 8);
        const f = readMgl(glb);
        expect(f.character?.meta.name).toBe('Test');
        expect(f.springs?.chains).toHaveLength(1);
        expect(f.materials.get(0)?.anime.kind).toBe('face');
        expect(f.materials.get(0)?.draw.layer).toBe('body');
        const acc = readAccessor(f.json, f.bin, 0)!;
        expect(acc.n).toBe(4);
        expect(acc.values[0]).toBeCloseTo(1);
        expect(acc.values[5]).toBeCloseTo(-1);
        expect(acc.values[7]).toBeCloseTo(0.5, 3);
    });
});
