import { describe, expect, it } from 'vitest';
import { MGL_CHARACTER, MGL_SPRINGS, MGL_TOON, readAccessor, readMgl } from '../../src/core/mgl';
import { mglExportInput, mglImportPlan } from '../../src/core/mglEditor';
import { mglFromMotion, motionFromMgl, restSkeleton } from '../../src/core/mglMotion';
import { mglImage, mglMaterialsByName, writeMgl, type MglImage } from '../../src/core/mglWrite';
import type { MotionDoc } from '../../src/core/model';

// A small rigged model with a "face" material, and full license data.
import { META, model } from './fixtures/mglModel';

const PNG: MglImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mimeType: 'image/png', name: 'shadow' };

describe('writing a character file', () => {
    it('adds the extensions, the textures and the outline, and passes its checks', () => {
        const out = writeMgl({
            glb: model(),
            materials: new Map([['face', { anime: { kind: 'face', faceMap: PNG, faceGlowShift: 0.05, shadeBrightness: 0.65 } as any, draw: { layer: 'body' } }]]),
            character: { meta: META, face: { forwardTilt: 10 } },
        });
        expect(out.report.errors).toEqual([]);
        const file = readMgl(out.glb);
        expect(file.json.extensionsUsed).toEqual(expect.arrayContaining([MGL_CHARACTER, MGL_TOON]));
        expect(file.json.extensionsUsed).not.toContain(MGL_SPRINGS);
        // The humanoid bones, guessed from the names.
        expect(file.character!.humanoid.bones.leftLowerArm.node).toBe(5);
        expect(file.character!.humanoid.bones.head.node).toBe(3);
        // Stored compact: what equals the face kind's value (shade brightness 0.65) is left out.
        const face = mglMaterialsByName(file.json).materials.get('face')!;
        expect(face.anime.shadeBrightness).toBeUndefined();
        expect(face.anime.faceGlowShift).toBe(0.05);
        expect(face.draw).toEqual({ layer: 'body' });
        const img = mglImage(file.json, file.bin, face.anime.faceMap!);
        expect(Array.from(img!.bytes)).toEqual(Array.from(PNG.bytes));
        expect(file.json.samplers[file.json.textures[face.anime.faceMap!].sampler].wrapS).toBe(33071);
        // The outline: smoothed normals (the quad is flat: +Z), w a reserved 1.
        const o = readAccessor(file.json, file.bin, file.json.meshes[0].primitives[0].attributes._OUTLINE)!;
        expect(o.n).toBe(4);
        expect(Array.from(o.values.slice(0, 4))).toEqual([0, 0, 1, 1]);
        expect(out.notes.join('\n')).toMatch(/humanoid bones found by their names: 1\d/);
    });

    it("puts a slot's color texture in place of the file's, or takes it away", () => {
        const COLOR: MglImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]), mimeType: 'image/png', name: 'skin' };
        const out = writeMgl({ glb: model(), baseColor: new Map([['face', COLOR]]), character: { meta: META } });
        const file = readMgl(out.glb);
        const info = file.json.materials.find((m: any) => m.name === 'face').pbrMetallicRoughness.baseColorTexture;
        expect(Array.from(mglImage(file.json, file.bin, info.index)!.bytes)).toEqual(Array.from(COLOR.bytes));
        // A color texture repeats over the UVs.
        expect(file.json.samplers[file.json.textures[info.index].sampler].wrapS).toBe(10497);
        const gone = readMgl(writeMgl({ glb: out.glb, baseColor: new Map([['face', null]]), character: { meta: META } }).glb);
        expect(gone.json.materials.find((m: any) => m.name === 'face').pbrMetallicRoughness.baseColorTexture).toBeUndefined();
        expect(writeMgl({ glb: model(), baseColor: new Map([['nose', COLOR]]), character: { meta: META } }).notes.join('\n')).toMatch(/no material named nose/);
    });

    it("takes the slots' color textures along from the editor", () => {
        const COLOR: MglImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]), mimeType: 'image/png', name: 'skin' };
        const doc = (map: string | null) => ({ asset: 'a_model', materials: { face: { map } } }) as any;
        expect(mglExportInput({ glb: model(), name: 'Test', model: doc('a_color'), images: new Map([['a_color', COLOR]]) }).input.baseColor?.get('face')).toBe(COLOR);
        expect(mglExportInput({ glb: model(), name: 'Test', model: doc(null), images: new Map() }).input.baseColor?.get('face')).toBeNull();
        expect(mglExportInput({ glb: model(), name: 'Test', model: doc('a_gone'), images: new Map() }).notes.join('\n')).toMatch(/face: its color texture is missing/);
        // A slot that leaves the file's texture as it is adds nothing.
        expect(mglExportInput({ glb: model(), name: 'Test', model: { asset: 'a_model', materials: { face: { opacity: 1 } } } as any, images: new Map() }).input.baseColor).toBeUndefined();
    });

    it('writes an overlay as black at an alpha for plain viewers and reads it back as its multiply', () => {
        // A shadow card: a grey of 0.8 as the screen shows it, multiplied at full opacity.
        const card = { face: { shading: 'anime', anime: { kind: 'overlay' }, alphaMode: 'multiply', opacity: 1, color: '#cccccc' } };
        const { input } = mglExportInput({ glb: model(), name: 'Test', model: { asset: 'a_model', materials: card } as any, images: new Map() });
        const out = writeMgl({ ...input, character: { ...input.character, meta: META } });
        const file = readMgl(out.glb);
        const pbr = file.json.materials[0].pbrMetallicRoughness;
        // Under × (1 − alpha) in linear light darkens as much as × 0.8 on the screen.
        expect(pbr.baseColorFactor.slice(0, 3)).toEqual([0, 0, 0]);
        expect(1 - pbr.baseColorFactor[3]).toBeCloseTo(Math.pow((0.8 + 0.055) / 1.055, 2.4), 6);
        const plan = mglImportPlan(out.glb)!;
        expect(plan.slots.face).toMatchObject({ alphaMode: 'multiply', color: '#cccccc', opacity: 1 });
    });

    it('fails its checks without a license', () => {
        const out = writeMgl({ glb: model(), character: { meta: { ...META, authors: [], licenseUrl: '' } } });
        expect(out.report.errors.join('\n')).toMatch(/meta.authors is missing/);
        expect(out.report.errors.join('\n')).toMatch(/meta.licenseUrl is missing/);
    });
});

describe('springs and expressions between the editor and the file', () => {
    const motion: Pick<MotionDoc, 'springs' | 'colliders' | 'expressions' | 'blink'> = {
        springs: [{ bones: '', chains: 'hair1', period: 0.7, damping: 0.4, gravity: 0.2, drag: 0.3, limit: 40, radius: 0.012, hit: 'head' }],
        colliders: [{ set: 'head', bone: 'Head', to: '', radius: 0.08, offset: [0, 0.07, 0.01], tail: [0, 0, 0] }],
        expressions: { happy: { Jaw: [0, -0.004, 0.002] }, blink: { Jaw: [0.001, 0, 0] } },
        blink: true,
    };

    it('goes into the file in the nodes\' own frames and comes back the same', () => {
        const json = readMgl(model()).json;
        const file = mglFromMotion(json, motion);
        expect(file.notes).toEqual([]);
        // One chain from hair1 (hair2 under it goes along), hitting the head.
        expect(file.springs!.chains).toEqual([{ name: 'hair1', root: 17, period: 0.7, damping: 0.4, gravity: 0.2, drag: 0.3, maxAngle: 40, radius: 0.012, colliders: ['head'] }]);
        // The head is turned 90° about Y at rest: the offset in its own frame is turned back.
        const c = file.springs!.colliders![0];
        expect(c.shape).toBe('sphere');
        expect(c.offset![0]).toBeCloseTo(-0.01, 6);
        expect(c.offset![1]).toBeCloseTo(0.07, 6);
        expect(c.offset![2]).toBeCloseTo(0, 6);
        // The jaw hangs under the turned head: its move is in the head's frame.
        const happy = file.expressions!.preset!.happy!.boneBinds![0];
        expect(happy.node).toBe(16);
        expect(happy.translation![0]).toBeCloseTo(-0.002, 6);
        expect(happy.translation![2]).toBeCloseTo(0, 6);
        expect(file.expressions!.blink).toMatchObject({ expression: 'blink', interval: [2.2, 5.2] });

        const back = motionFromMgl(json, { specVersion: '1.0-draft', meta: META, humanoid: { bones: {} }, expressions: file.expressions }, file.springs);
        expect(back.springs[0]).toMatchObject({ chains: 'hair1', period: 0.7, limit: 40, hit: 'head' });
        expect(back.colliders[0].bone).toBe('Head');
        back.colliders[0].offset.forEach((v, i) => expect(v).toBeCloseTo(motion.colliders[0].offset[i], 6));
        back.expressions.happy.Jaw.forEach((v, i) => expect(v).toBeCloseTo(motion.expressions.happy.Jaw[i], 6));
        expect(back.blink).toBe(true);
    });

    it('keeps what the editor does not show of the file\'s expressions', () => {
        const json = readMgl(model()).json;
        const base = { preset: { happy: { morphTargetBinds: [{ node: 19, index: 0, weight: 1 }], boneBinds: [{ node: 16, translation: [0, 1, 0] as [number, number, number] }] } } };
        const file = mglFromMotion(json, { ...motion, expressions: { happy: { Jaw: [0, 0.001, 0] } } }, base);
        const happy = file.expressions!.preset!.happy!;
        expect(happy.morphTargetBinds).toEqual(base.preset.happy.morphTargetBinds);
        expect(happy.boneBinds).toHaveLength(1);
        expect(happy.boneBinds![0].translation![1]).toBeCloseTo(0.001, 6);
    });

    it('reads the model\'s axes from the node its skeleton hangs under', () => {
        const json = readMgl(model()).json;
        const s = restSkeleton(json);
        expect(s.pos[3][1]).toBeCloseTo(1.6, 6);
        expect(s.byName.get('hair2')).toBe(18);
    });
});
