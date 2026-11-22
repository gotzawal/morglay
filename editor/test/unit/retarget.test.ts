import { describe, expect, it } from 'vitest';
import { driveHelpers, humanoidPairs, mmdFromBiped, readGlbClips, retargetHumanoid, retargetPose, stillBones, retargetClip, rotate, type Quat, type SkeletonBone, type Vec3 } from '../../src/core/retarget';
import { pmxToGlb } from '../../src/core/pmxToGlb';
import type { PmxModel } from '../../src/core/pmx';

const s = Math.SQRT1_2;
const Z90: Quat = [0, 0, s, s];
const I: Quat = [0, 0, 0, 1];

// Source: an arm resting straight up, its frame turned (as a Biped's bones are).
const source: SkeletonBone[] = [
    { name: 'root', parent: -1, translation: [0, 0, 0], rotation: I },
    { name: 'arm', parent: 0, translation: [0, 1, 0], rotation: Z90 },
    { name: 'hand', parent: 1, translation: [1, 0, 0], rotation: I },
];
// Target: the same arm resting down and out (an A pose), its bones not turned.
const target: SkeletonBone[] = [
    { name: 'root', parent: -1, translation: [0, 0, 0], rotation: I },
    { name: 'arm', parent: 0, translation: [0, 1, 0], rotation: I },
    { name: 'hand', parent: 1, translation: [s, -s, 0], rotation: I },
];
const clip = {
    name: 'raise',
    tracks: [
        // From rest (up) to pointing along +X.
        { bone: 1, path: 'rotation' as const, times: new Float32Array([0, 1]), values: new Float32Array([...Z90, ...I]) },
        { bone: 0, path: 'translation' as const, times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 0, 0, 2]) },
    ],
};

/** Where the target arm points at key k of a retargeted clip. */
function armDirection(out: ReturnType<typeof retargetClip>, k: number): Vec3 {
    const tr = out.tracks.find((t) => t.bone === 1 && t.path === 'rotation')!;
    const q = Array.from(tr.values.subarray(k * 4, k * 4 + 4)) as Quat;
    return rotate(q, target[2].translation);
}

describe('retargeting', () => {
    it('points the target bone where the source bone points, whatever each rests at', () => {
        const out = retargetClip(source, clip, target, [{ target: 1, source: 1, aim: { target: 2, source: 2 } }], { root: { target: 0, source: 0 } });
        const d0 = armDirection(out, 0);
        const d1 = armDirection(out, 1);
        expect(d0[0]).toBeCloseTo(0, 5);
        expect(d0[1]).toBeCloseTo(1, 5);
        expect(d1[0]).toBeCloseTo(1, 5);
        expect(d1[1]).toBeCloseTo(0, 5);
        const move = out.tracks.find((t) => t.path === 'translation')!;
        expect(Array.from(move.values.subarray(3, 6))).toEqual([0, 0, 2]);
    });

    it('turns a bone without an aim from its rest as the source turns', () => {
        const out = retargetClip(source, clip, target, [{ target: 1, source: 1 }]);
        // No lining up: at rest the arm keeps its own rest (down and out), then turns a quarter.
        const d0 = armDirection(out, 0);
        const d1 = armDirection(out, 1);
        expect(d0[0]).toBeCloseTo(s, 5);
        expect(d0[1]).toBeCloseTo(-s, 5);
        expect(d1[0]).toBeCloseTo(-s, 5);
        expect(d1[1]).toBeCloseTo(-s, 5);
    });

    it('pairs MMD bones with Biped ones by name, full-width digits and D bones too', () => {
        const mmd = (names: string[]): SkeletonBone[] => names.map((name, i) => ({ name, parent: i ? 0 : -1, translation: [0, i * 0.1, 0], rotation: I }));
        const t = mmd(['センター', '下半身', '左足', '左足D', '左足首', '左腕', '左ひじ', '左親指０', '左親指１']);
        const src = mmd(['Bip001', 'Bip001_Pelvis', 'Bip001_L_Thigh', 'Bip001_L_Foot', 'Bip001 L UpperArm', 'Bip001_L_Forearm', 'Bip001_L_Finger0', 'Bip001_L_Finger01']);
        const map = mmdFromBiped(t, src);
        const pairOf = (n: string) => map.pairs.find((p) => t[p.target].name === n);
        expect(src[pairOf('左足D')!.source].name).toBe('Bip001_L_Thigh');
        expect(src[pairOf('左腕')!.source].name).toBe('Bip001 L UpperArm');
        expect(t[pairOf('左腕')!.aim!.target].name).toBe('左ひじ');
        expect(src[pairOf('左親指０')!.source].name).toBe('Bip001_L_Finger0');
        expect(map.root).toEqual({ target: 0, source: 1 });
        expect(map.legs).toEqual({ target: [2, 4], source: [2, 3] });
    });

    it('lowers the root so the ground bones come as low as at rest', () => {
        // The hand rests at y 1 - √½; the clip has it at 2 (up) then 1 (along +X): lowered by the difference.
        const out = retargetClip(source, clip, target, [{ target: 1, source: 1, aim: { target: 2, source: 2 } }], { root: { target: 0, source: 0 }, ground: [2] });
        const move = out.tracks.find((t) => t.path === 'translation')!;
        expect(move.values[1]).toBeCloseTo(-s, 5);
        expect(move.values[4]).toBeCloseTo(-s, 5);
        expect(move.values[5]).toBeCloseTo(2, 5);
    });

    it('finds the bones a model\'s own clips never bend', () => {
        const bones: SkeletonBone[] = [
            { name: 'foot', parent: -1, translation: [0, 0, 0], rotation: I },
            { name: 'toe', parent: 0, translation: [0, 0, 0.1], rotation: I },
        ];
        const bend = (deg: number): Quat => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];
        const own = [{ name: 'walk', tracks: [
            { bone: 0, path: 'rotation' as const, times: new Float32Array([0, 1]), values: new Float32Array([...I, ...bend(30)]) },
            { bone: 1, path: 'rotation' as const, times: new Float32Array([0, 1]), values: new Float32Array([...I, ...bend(0.3)]) },
        ] }];
        expect([...stillBones(bones, own)]).toEqual([1]);
        expect(stillBones(bones, []).size).toBe(0);
    });

    it('moves a helper bone as the model\'s own clips move it for the same bend', () => {
        // A knee and a corrective bone under it that turns half as far and slides 1 mm a degree.
        const bones: SkeletonBone[] = [
            { name: 'thigh', parent: -1, translation: [0, 1, 0], rotation: I },
            { name: 'knee', parent: 0, translation: [0, -0.5, 0], rotation: I },
            { name: 'knee_ty', parent: 1, translation: [0, 0, 0.05], rotation: I },
            { name: 'foot', parent: 1, translation: [0, -0.5, 0], rotation: I },
        ];
        const bend = (deg: number): Quat => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];
        const angles = [0, 10, 20, 30, 40, 50, 60];
        const times = new Float32Array(angles.map((_, i) => i));
        const own = [{ name: 'walk', tracks: [
            { bone: 1, path: 'rotation' as const, times, values: new Float32Array(angles.flatMap((a) => bend(a))) },
            { bone: 2, path: 'rotation' as const, times, values: new Float32Array(angles.flatMap((a) => bend(a / 2))) },
            { bone: 2, path: 'translation' as const, times, values: new Float32Array(angles.flatMap((a) => [0, 0, 0.05 + a * 0.001])) },
        ] }];
        const clip = { name: 'other', tracks: [{ bone: 1, path: 'rotation' as const, times: new Float32Array([0, 1]), values: new Float32Array([...bend(25), ...bend(65)]) }] };
        const { clip: out, helpers } = driveHelpers(bones, own, clip, new Set([0, 1, 3]));
        expect(helpers).toEqual([{ name: 'knee_ty', kind: 'fitted' }]);
        const rot = out.tracks.find((t) => t.bone === 2 && t.path === 'rotation')!;
        const angleOf = (k: number) => (2 * Math.acos(Math.min(1, Math.abs(rot.values[k * 4 + 3]))) * 180) / Math.PI;
        expect(angleOf(0)).toBeCloseTo(12.5, 1);
        expect(angleOf(1)).toBeCloseTo(32.5, 1);
        const move = out.tracks.find((t) => t.bone === 2 && t.path === 'translation')!;
        expect(move.values[2]).toBeCloseTo(0.075, 4);
    });

    it('pairs a Mixamo skeleton with a Biped one by their humanoid bones', () => {
        const tree = (list: [string, number][]): SkeletonBone[] => list.map(([name, parent], i) => ({ name, parent, translation: [0, i ? 0.1 : 1, 0], rotation: I }));
        const mixamo = tree([
            ['mixamorig:Hips', -1], ['mixamorig:Spine', 0], ['mixamorig:Spine1', 1], ['mixamorig:Spine2', 2], ['mixamorig:Neck', 3], ['mixamorig:Head', 4],
            ['mixamorig:LeftShoulder', 3], ['mixamorig:LeftArm', 6], ['mixamorig:LeftForeArm', 7], ['mixamorig:LeftHand', 8],
            ['mixamorig:LeftUpLeg', 0], ['mixamorig:LeftLeg', 10], ['mixamorig:LeftFoot', 11], ['mixamorig:LeftToeBase', 12],
        ]);
        const biped = tree([
            ['Bip001', -1], ['Bip001 Pelvis', 0], ['Bip001 Spine', 1], ['Bip001 Spine1', 2], ['Bip001 Spine2', 3], ['Bip001 Neck', 4], ['Bip001 Head', 5],
            ['Bip001 L Clavicle', 5], ['Bip001 L UpperArm', 7], ['Bip001 L Forearm', 8], ['Bip001 L Hand', 9],
            ['Bip001 L Thigh', 1], ['Bip001 L Calf', 11], ['Bip001 L Foot', 12], ['Bip001 L Toe0', 13],
        ]);
        const map = humanoidPairs(biped, mixamo);
        const pairOf = (n: string) => map.pairs.find((p) => biped[p.target].name === n);
        expect(mixamo[pairOf('Bip001 L UpperArm')!.source].name).toBe('mixamorig:LeftArm');
        expect(pairOf('Bip001 L UpperArm')!.aim).toBeUndefined();
        expect(mixamo[pairOf('Bip001 L Toe0')!.source].name).toBe('mixamorig:LeftToeBase');
        expect(map.root).toEqual({ target: 1, source: 0 });
        expect(map.legs).toEqual({ target: [11, 13], source: [10, 12] });
        expect(map.ground).toEqual([13, 14]);
    });

    // An A-posed body: arms hang 45° out and down, legs a little apart, the foot runs forward and down.
    const body = (armDown: number): SkeletonBone[] => {
        const c = Math.cos(armDown), d = Math.sin(armDown);
        return [
            { name: 'hips', parent: -1, translation: [0, 1, 0], rotation: I },
            { name: 'spine', parent: 0, translation: [0, 0.2, 0], rotation: I },
            { name: 'chest', parent: 1, translation: [0, 0.2, 0], rotation: I },
            { name: 'neck', parent: 2, translation: [0, 0.2, 0], rotation: I },
            { name: 'head', parent: 3, translation: [0, 0.1, 0], rotation: I },
            { name: 'leftShoulder', parent: 2, translation: [0.05, 0.15, 0], rotation: I },
            { name: 'leftUpperArm', parent: 5, translation: [0.1, 0, 0], rotation: I },
            { name: 'leftLowerArm', parent: 6, translation: [0.25 * c, -0.25 * d, 0], rotation: I },
            { name: 'leftHand', parent: 7, translation: [0.25 * c, -0.25 * d, 0], rotation: I },
            { name: 'leftUpperLeg', parent: 0, translation: [0.1, -0.05, 0], rotation: I },
            { name: 'leftLowerLeg', parent: 9, translation: [0.03, -0.45, 0], rotation: I },
            { name: 'leftFoot', parent: 10, translation: [0, -0.45, 0], rotation: I },
            { name: 'leftToes', parent: 11, translation: [0, -0.05, 0.1], rotation: I },
            { name: 'rightUpperLeg', parent: 0, translation: [-0.1, -0.05, 0], rotation: I },
        ];
    };
    const roles = (b: SkeletonBone[]) => Object.fromEntries(b.map((x, i) => [x.name, i]));

    it('puts a body in the reference pose: arms out level, legs straight down, the rest as built', () => {
        const a = body(Math.PI / 4);
        const ref = retargetPose(a, roles(a));
        // The upper arm now points its forearm along +X (left is +X: the left thigh sits at +X).
        expect(rotate(ref[6], a[7].translation)[1]).toBeCloseTo(0, 6);
        expect(rotate(ref[6], a[7].translation)[0]).toBeGreaterThan(0);
        // The thigh points straight down; the shoulder and the foot keep their rest.
        const knee = rotate(ref[9], a[10].translation);
        expect(knee[0]).toBeCloseTo(0, 6);
        expect(ref[5]).toEqual(I);
        expect(ref[11]).toEqual(I);
    });

    it('moves a clip between an A-posed and a T-posed body by their reference pose', () => {
        const a = body(Math.PI / 4), t = body(0);
        const s = Math.SQRT1_2;
        // The T body drops its arm straight down (a quarter turn about -Z at the upper arm).
        const drop = { name: 'drop', tracks: [{ bone: 6, path: 'rotation' as const, times: new Float32Array([0, 1]), values: new Float32Array([...I, 0, 0, -s, s]) }] };
        const out = retargetHumanoid({ skeleton: a, clips: [] }, t, drop).clip;
        const arm = out.tracks.find((x) => x.bone === 6 && x.path === 'rotation')!;
        // Where the T body holds its arm level, so does the A body (the posture, not the rest, carries
        // over); dropped, its forearm points straight down.
        expect(rotate(Array.from(arm.values.subarray(0, 4)) as Quat, a[7].translation)[1]).toBeCloseTo(0, 5);
        const down = rotate(Array.from(arm.values.subarray(4, 8)) as Quat, a[7].translation);
        expect(down[0]).toBeCloseTo(0, 5);
        expect(down[1]).toBeCloseTo(-0.25, 5);
        // And back again, the T body's clip as it was.
        const back = retargetHumanoid({ skeleton: t, clips: [] }, a, out).clip;
        const end = back.tracks.find((x) => x.bone === 6 && x.path === 'rotation')!;
        expect(Math.abs(end.values[4 * 1 + 2])).toBeCloseTo(s, 5);
        expect(Math.abs(end.values[4 * 1 + 3])).toBeCloseTo(s, 5);
    });

    it('writes clips into the PMX GLB, read back the same', () => {
        const pmx: PmxModel = {
            version: 2, name: 'm', nameEn: '', comment: '',
            positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), joints: new Uint16Array(0), weights: new Float32Array(0), edgeScale: new Float32Array(0),
            indices: new Uint32Array(0), textures: [], materials: [],
            bones: [
                { name: 'センター', nameEn: '', position: [0, 10, 0], parent: -1, layer: 0, flags: 0 },
                { name: '頭', nameEn: '', position: [0, 20, 0], parent: 0, layer: 0, flags: 0 },
            ],
            morphs: [], sdef: 0,
        };
        const times = new Float32Array([0, 0.5]);
        const { glb, report } = pmxToGlb(pmx, {
            image: () => null,
            animations: [{ name: 'walk', tracks: [{ bone: 1, path: 'rotation', times, values: new Float32Array([0, 0, 0, 1, 0, s, 0, s]) }, { bone: 0, path: 'translation', times, values: new Float32Array([0, 0.8, 0, 0, 0.9, 0]) }] }],
        });
        expect(report.some((l) => /clip walk: 2 tracks/.test(l))).toBe(true);
        const back = readGlbClips(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer)!;
        expect(back.clips).toHaveLength(1);
        const rot = back.clips[0].tracks.find((t) => t.path === 'rotation')!;
        expect(back.skeleton[rot.bone].name).toBe('頭');
        expect(rot.values[5]).toBeCloseTo(s);
        expect(Array.from(back.clips[0].tracks.find((t) => t.path === 'translation')!.times)).toEqual([0, 0.5]);
    });
});
