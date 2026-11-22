import { describe, expect, it } from 'vitest';
import { CEL_SHADING, resolveAnime } from '../../src/core/anime';
import { MGL_CHARACTER, MGL_SPRINGS, MGL_TOON, readMgl } from '../../src/core/mgl';
import { mglImportPlan } from '../../src/core/mglEditor';
import { joinGlb, writeMgl } from '../../src/core/mglWrite';
import { dampingOfDrag, dragOfDamping, gravityOfPower, mglToVrm, periodOfStiffness, powerOfGravity, stiffnessOfPeriod, vrmToMgl, VRMC_MTOON, VRMC_SPRING, VRMC_VRM } from '../../src/core/vrm';
import { META, model } from './fixtures/mglModel';

/** The test model written as a character file with a face material and a hair chain. */
function character() {
    const out = writeMgl({
        glb: model(),
        materials: new Map([['face', { anime: { kind: 'face', step: 0.4, feather: 0.1, shadeBrightness: 0.6, shadeTint: [1.1, 0.9, 0.9], outline: 0.5, outlineBrightness: 0.5 } as any, draw: { layer: 'body' } }]]),
        character: { meta: { ...META, sourceTerms: 'no redistribution', partExtraction: false }, lookAt: { type: 'bone', yaw: { inner: 12, outer: 14 }, pitch: { up: 8, down: 10 } } },
        springs: { chains: [{ name: 'hair', root: 17, period: 0.7, damping: 0.4, gravity: 0.2, drag: 0.3, maxAngle: 40, radius: 0.012, colliders: ['head'] }], colliders: [{ name: 'head', node: 3, shape: 'sphere', offset: [0, 0.07, 0], radius: 0.08 }] },
    });
    expect(out.report.errors).toEqual([]);
    return readMgl(out.glb);
}

describe('VRM 1.0 and the character format', () => {
    it('turns forces into swings and back', () => {
        for (const s of [0, 0.5, 1, 2, 4]) expect(stiffnessOfPeriod(periodOfStiffness(s))).toBeCloseTo(s, 6);
        for (const d of [0, 0.4, 1]) expect(dragOfDamping(dampingOfDrag(d))).toBeCloseTo(d, 6);
        for (const g of [0, 0.5, 2]) expect(powerOfGravity(gravityOfPower(g))).toBeCloseTo(g, 6);
        // Stiffer swings faster.
        expect(periodOfStiffness(2)).toBeLessThan(periodOfStiffness(0.5));
    });

    it('writes VRM beside the format: the same license, bones and look-at, springs as joints, MToon beside each material', () => {
        const file = character();
        const notes = mglToVrm(file.json);
        const vrm = file.json.extensions[VRMC_VRM];
        expect(file.json.extensionsUsed).toEqual(expect.arrayContaining([VRMC_VRM, VRMC_MTOON, VRMC_SPRING, MGL_CHARACTER, MGL_TOON, MGL_SPRINGS]));
        expect(vrm.meta).toMatchObject({ name: 'Test', authors: ['someone'], allowRedistribution: false, extras: { MGL: { sourceTerms: 'no redistribution', partExtraction: false } } });
        expect(vrm.humanoid.humanBones.leftLowerArm).toEqual({ node: 5 });
        expect(vrm.lookAt.rangeMapHorizontalOuter).toEqual({ inputMaxValue: 90, outputScale: 14 });
        // hair1 -> hair2: one spring of two joints, hitting the head's group.
        const spring = file.json.extensions[VRMC_SPRING];
        expect(spring.springs).toHaveLength(1);
        expect(spring.springs[0].joints.map((j: any) => j.node)).toEqual([17, 18]);
        expect(spring.springs[0].joints[0].stiffness).toBeCloseTo(stiffnessOfPeriod(0.7), 6);
        expect(spring.colliderGroups[spring.springs[0].colliderGroups[0]].colliders).toEqual([0]);
        expect(spring.colliders[0]).toEqual({ node: 3, shape: { sphere: { offset: [0, 0.07, 0], radius: 0.08 } } });
        const mt = file.json.materials[0].extensions[VRMC_MTOON];
        expect(mt.shadingShiftFactor).toBeCloseTo(0.2, 6);
        expect(mt.shadingToonyFactor).toBeCloseTo(0.8, 6);
        expect(mt.outlineWidthMode).toBe('worldCoordinates');
        // A lit line: MToon multiplies its color by the lit surface, so it holds only the format's share of Outline Brightness.
        for (const c of mt.outlineColorFactor) expect(c).toBeCloseTo(0.5 * CEL_SHADING.lineShare, 6);
        expect(notes.join('\n')).toMatch(/MToon material/);
    });

    it('writes the shade with the base color factor and the edge with Shade Bias, and reads the drawn shade back', () => {
        const out = writeMgl({
            glb: model(),
            materials: new Map([['face', { anime: { kind: 'face', step: 0.4, shadeBias: 0.2, shadeBrightness: 0.6, shadeTint: [1.1, 0.9, 0.9] } as any, draw: { layer: 'body' } }]]),
            character: { meta: META },
        });
        const file = readMgl(out.glb);
        file.json.materials[0].pbrMetallicRoughness.baseColorFactor = [0.5, 0.8, 1, 1];
        mglToVrm(file.json);
        const mt = file.json.materials[0].extensions[VRMC_MTOON];
        const t = resolveAnime({ kind: 'face' });
        const k = 0.6 * CEL_SHADING.formShade * t.shadeDarkness;
        // MToon's shade leaves the base color factor out, so it is in the shade color.
        expect(mt.shadeColorFactor[0]).toBeCloseTo(k * (0.5 + 0.5 * 1.1) * 0.5, 6);
        expect(mt.shadeColorFactor[1]).toBeCloseTo(k * (0.5 + 0.5 * 0.9) * 0.8, 6);
        // MToon's edge lies where N·L = −shift, the format's where N·L = 2·step − 1 − Shade Bias.
        expect(mt.shadingShiftFactor).toBeCloseTo(1 - 2 * 0.4 + 0.2, 6);
        // A VRM viewer's file read back: the same edge, and the same drawn shade (brightness × half tint).
        const json = JSON.parse(JSON.stringify(file.json));
        delete json.extensions[MGL_CHARACTER];
        for (const m of json.materials) delete m.extensions[MGL_TOON];
        const back = resolveAnime(vrmToMgl(json)!.materials.get(0)!.anime as any);
        expect(2 * back.step - 1 - back.shadeBias).toBeCloseTo(2 * 0.4 - 1 - 0.2, 6);
        [1.1, 0.9, 0.9].forEach((c, j) => expect(back.shadeBrightness * (0.5 + 0.5 * back.shadeTint[j])).toBeCloseTo(0.6 * (0.5 + 0.5 * c), 5));
    });

    it('reads a world outline as the width the shading draws as wide at the matched view', () => {
        const file = character();
        mglToVrm(file.json);
        const json = JSON.parse(JSON.stringify(file.json));
        for (const m of json.materials) delete m.extensions[MGL_TOON];
        Object.assign(json.materials[0].extensions[VRMC_MTOON], { outlineWidthMode: 'worldCoordinates', outlineWidthFactor: 0.002 });
        const face = resolveAnime(vrmToMgl(json)!.materials.get(0)!.anime as any);
        // A 1.6 m character seen whole through 20°: 4.54 m away, where width w draws w × lineWidth × d^(1 − lineThinning) meters.
        const d = 0.8 / Math.tan((10 * Math.PI) / 180);
        expect(face.outline * CEL_SHADING.lineWidth * d ** (1 - CEL_SHADING.lineThinning)).toBeCloseTo(0.002, 6);
        expect(face.outlineBrightness).toBeCloseTo(0.5, 6);
    });

    it("reads a VRM back as the format's data", () => {
        const file = character();
        mglToVrm(file.json);
        // A VRM viewer's file: only VRM left.
        const json = JSON.parse(JSON.stringify(file.json));
        delete json.extensions[MGL_CHARACTER];
        delete json.extensions[MGL_SPRINGS];
        for (const m of json.materials) delete m.extensions[MGL_TOON];
        const back = vrmToMgl(json)!;
        expect(back.character.meta).toMatchObject({ name: 'Test', licenseUrl: META.licenseUrl, sourceTerms: 'no redistribution' });
        expect(back.character.humanoid.bones.head).toEqual({ node: 3 });
        expect(back.character.lookAt?.yaw).toEqual({ inner: 12, outer: 14 });
        expect(back.springs!.chains[0]).toMatchObject({ root: 17, radius: 0.012, colliders: ['collider_0'] });
        expect(back.springs!.chains[0].period).toBeCloseTo(0.7, 6);
        const face = resolveAnime(back.materials.get(0)!.anime as any);
        expect(face.kind).toBe('face');
        expect(face.step).toBeCloseTo(0.4, 6);
        expect(face.feather).toBeCloseTo(0.1, 6);
        expect(face.highlight).toBe('none');
        expect(face.outline).toBeCloseTo(0.5, 6);

        // The editor imports it as a character: cel-shaded slots, springs and license data.
        const plan = mglImportPlan(joinGlb(json, file.bin))!;
        expect(Object.keys(plan.slots)).toEqual(['face']);
        expect(plan.slots.face.shading).toBe('anime');
        expect(plan.motion!.springs[0].chains).toBe('hair1');
        expect(plan.character!.sourceTerms).toBe('no redistribution');
        expect(plan.notes[0]).toMatch(/VRM 1.0/);
    });
});
