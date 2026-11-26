import { describe, expect, it } from 'vitest';
import { appendAnimations } from '../../src/core/clipImport';
import { modelWithSources, sourcesKey } from '../../src/core/clipSources';
import { defaults } from '../../src/core/schema';
import { Animation } from '../../src/core/model';
import { parsePath } from '../../src/core/motionPath';
import { dropRefs, refs } from '../../src/core/refs';
import { readGlbClips, type Quat, type Vec3 } from '../../src/core/retarget';
import { sanitize } from '../../src/core/store';
import type { AssetMeta } from '../../src/core/types';

/** A GLB of nodes only (a skeleton: [name, parent, translation]), no binary chunk. */
function skeletonGlb(bones: [string, number, Vec3][]): Uint8Array {
    const nodes = bones.map(([name, , translation]) => ({ name, translation, children: [] as number[] }));
    bones.forEach(([, parent], i) => parent >= 0 && nodes[parent].children.push(i));
    for (const n of nodes) if (!n.children.length) delete (n as { children?: number[] }).children;
    let text = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes }));
    const pad = (4 - (text.byteLength % 4)) % 4;
    const t = new Uint8Array(text.byteLength + pad).fill(0x20);
    t.set(text);
    text = t;
    const out = new Uint8Array(20 + text.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, out.byteLength, true);
    dv.setUint32(12, text.byteLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    return out;
}
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const bytesOf = (o: unknown) => buf(new TextEncoder().encode(JSON.stringify(o)));

// A plain humanoid standing with its arms out level, facing +Z, its left at +X (as motionGen.test.ts builds it).
const human = skeletonGlb([
    ['hips', -1, [0, 0.95, 0]], ['spine', 0, [0, 0.12, 0]], ['chest', 1, [0, 0.14, 0]], ['neck', 2, [0, 0.2, 0]], ['head', 3, [0, 0.1, 0]],
    ['leftShoulder', 2, [0.04, 0.16, 0]], ['leftUpperArm', 5, [0.12, 0, 0]], ['leftLowerArm', 6, [0.27, 0, 0]], ['leftHand', 7, [0.25, 0, 0]],
    ['rightShoulder', 2, [-0.04, 0.16, 0]], ['rightUpperArm', 9, [-0.12, 0, 0]], ['rightLowerArm', 10, [-0.27, 0, 0]], ['rightHand', 11, [-0.25, 0, 0]],
    ['leftUpperLeg', 0, [0.09, -0.05, 0]], ['leftLowerLeg', 13, [0, -0.42, 0]], ['leftFoot', 14, [0, -0.41, 0]], ['leftToes', 15, [0, -0.05, 0.12]],
    ['rightUpperLeg', 0, [-0.09, -0.05, 0]], ['rightLowerLeg', 17, [0, -0.42, 0]], ['rightFoot', 18, [0, -0.41, 0]], ['rightToes', 19, [0, -0.05, 0.12]],
]);

// A motion of the same body with Mixamo's names: the left arm from out level to straight up.
const s = Math.SQRT1_2;
const wave = appendAnimations(skeletonGlb([
    ['mixamorig:Hips', -1, [0, 0.95, 0]], ['mixamorig:Spine', 0, [0, 0.12, 0]], ['mixamorig:Spine1', 1, [0, 0.14, 0]], ['mixamorig:Neck', 2, [0, 0.2, 0]], ['mixamorig:Head', 3, [0, 0.1, 0]],
    ['mixamorig:LeftShoulder', 2, [0.04, 0.16, 0]], ['mixamorig:LeftArm', 5, [0.12, 0, 0]], ['mixamorig:LeftForeArm', 6, [0.27, 0, 0]], ['mixamorig:LeftHand', 7, [0.25, 0, 0]],
    ['mixamorig:LeftUpLeg', 0, [0.09, -0.05, 0]], ['mixamorig:LeftLeg', 9, [0, -0.42, 0]], ['mixamorig:LeftFoot', 10, [0, -0.41, 0]], ['mixamorig:LeftToeBase', 11, [0, -0.05, 0.12]],
]), [
    { name: 'Idle', tracks: [{ bone: 6, path: 'rotation', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]) }] },
    { name: 'Wave', tracks: [{ bone: 6, path: 'rotation', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, 0, 0, s, s]) }] },
]);

// Stands half a second, eases off to 1.2 m/s, brakes into a stop 3 m ahead and stands there: 6 s.
const ahead = {
    format: 'morglay-path', version: 1, closed: false,
    points: [{ at: [0, 0], out: [0, 1] }, { at: [0, 3], in: [0, 2] }],
    timing: { keys: [{ t: 0, s: 0 }, { t: 0.5, s: 0, out: [0.6, 0] }, { t: 2, s: 0.9, in: [-0.4, -0.48], out: [0.4, 0.48] }, { t: 3.5, s: 2.6, in: [-0.4, -0.48], out: [0.3, 0.36] }, { t: 4.5, s: 3, in: [-0.5, 0] }, { t: 6, s: 3 }] },
};

describe('clips made from sources', () => {
    const files = new Map([['p', bytesOf(ahead)], ['w', buf(wave)]]);

    it('makes a walk as long as its timing, on the model\'s own bones, and leaves the model\'s file as it was', () => {
        const model = buf(human);
        const before = new Uint8Array(model).slice();
        const made = modelWithSources(model, [{ name: 'Ahead', walk: 'p' }], files);
        expect(made.problems).toEqual([]);
        expect(made.clips).toEqual(['Ahead']);
        expect(new Uint8Array(model)).toEqual(before);
        const out = readGlbClips(buf(made.glb!))!;
        expect(out.skeleton.map((b) => b.name)).toEqual(readGlbClips(model)!.skeleton.map((b) => b.name));
        const clip = out.clips.find((c) => c.name === 'Ahead')!;
        const end = Math.max(...clip.tracks.map((t) => t.times[t.times.length - 1]));
        expect(Math.abs(end - parsePath(ahead).duration)).toBeLessThanOrEqual(1 / 60 + 1e-6);
        // The hips go 3 m ahead (+Z, the body's forward) over the walk, and stand still at both ends.
        const hips = clip.tracks.find((t) => t.path === 'translation')!;
        expect(out.skeleton[hips.bone].name).toBe('hips');
        const n = hips.values.length / 3;
        expect(hips.values[2]).toBeCloseTo(0, 2);
        expect(hips.values[3 * n - 1]).toBeGreaterThan(2.8);
        expect(hips.values[3 * n - 1]).toBeLessThan(3.2);
        expect(Math.abs(hips.values[3 * n - 3])).toBeLessThan(0.1);
    });

    it('retargets the clip a clip file names onto the model, under the source\'s name', () => {
        const made = modelWithSources(buf(human), [{ name: 'Hello', clip: 'w', take: 'Wave' }], files);
        expect(made.problems).toEqual([]);
        expect(made.clips).toEqual(['Hello']);
        const out = readGlbClips(buf(made.glb!))!;
        const arm = out.clips[0].tracks.find((t) => out.skeleton[t.bone].name === 'leftUpperArm' && t.path === 'rotation')!;
        const end = Array.from(arm.values.subarray(arm.values.length - 4)) as Quat;
        expect(end[2]).toBeCloseTo(s, 4);
        expect(end[3]).toBeCloseTo(s, 4);
        // Without a take it takes the file's first clip.
        const first = modelWithSources(buf(human), [{ name: 'Rest', clip: 'w' }], files);
        expect(first.report[0]).toMatch(/"Idle"/);
    });

    it('says what it could not make and makes the rest, its names kept apart from the model\'s own', () => {
        const withWalk = appendAnimations(human, [{ name: 'Walk', tracks: [{ bone: 0, path: 'translation', times: new Float32Array([0, 1]), values: new Float32Array([0, 0.95, 0, 0, 0.95, 0]) }] }]);
        const made = modelWithSources(buf(withWalk), [
            { name: 'Walk', walk: 'p' },
            { name: 'Lost', walk: 'gone' },
            { name: 'Bad', walk: 'bad' },
            { name: 'Nope', clip: 'w', take: 'Dance' },
        ], new Map([...files, ['bad', bytesOf({ ...ahead, timing: { keys: [{ t: 0, s: 2 }, { t: 1, s: 1 }] } })]]));
        expect(made.clips).toEqual(['Walk (2)']);
        expect(made.problems).toHaveLength(3);
        expect(made.problems[0]).toMatch(/^Lost: .*missing/);
        expect(made.problems[1]).toMatch(/^Bad: .*goes back/);
        expect(made.problems[2]).toMatch(/^Nope: .*no clip "Dance"/);
        expect(readGlbClips(buf(made.glb!))!.clips.map((c) => c.name)).toEqual(['Walk', 'Walk (2)']);
        // Nothing made: no new file.
        expect(modelWithSources(buf(human), [{ name: 'Lost', walk: 'gone' }], files).glb).toBeNull();
    });

    it('is made again when a file it reads is another', () => {
        const assets: AssetMeta[] = [
            { id: 'm', name: 'body.glb', kind: 'model', mime: 'model/gltf-binary', size: 10 },
            { id: 'p', name: 'ahead.path.json', kind: 'data', mime: 'application/json', size: 20 },
        ];
        const key = sourcesKey('m', [{ name: 'Ahead', walk: 'p' }], assets);
        expect(sourcesKey('m', [], assets)).toBe('');
        expect(sourcesKey('m', [{ name: 'Ahead', walk: 'p' }], assets)).toBe(key);
        expect(sourcesKey('m', [{ name: 'Ahead', walk: 'p' }], [assets[0], { ...assets[1], size: 21 }])).not.toBe(key);
        expect(sourcesKey('m', [{ name: 'Other', walk: 'p' }], assets)).not.toBe(key);
    });
});

describe('animation sources in the document', () => {
    it('are repaired: each a walk or a clip file, a name of its own, nothing else', () => {
        const a = Animation.parse({
            clip: 'Walk Path',
            sources: [{ name: 'Walk Path', walk: 'a_path' }, { name: 'Walk Path', walk: 'a_path2' }, { name: '', clip: 'a_clip', take: 'Wave', walk: '' }, { name: 'empty' }, 'junk', { name: 'x', walk: 7 }],
        });
        expect(a.sources).toEqual([{ name: 'Walk Path', walk: 'a_path' }, { name: 'Walk Path (2)', walk: 'a_path2' }, { name: 'Wave', clip: 'a_clip', take: 'Wave' }]);
        expect(defaults(Animation).sources).toEqual([]);
    });

    it('name the assets a scene file and a game carry, and let go of one that is removed', () => {
        const doc = sanitize({
            assets: [
                { id: 'a_model', name: 'body.vrm', kind: 'model', mime: 'model/gltf-binary', size: 1 },
                { id: 'a_path', name: 'loop.path.json', kind: 'data', mime: 'application/json', size: 1 },
                { id: 'a_clip', name: 'wave.glb', kind: 'clip', mime: 'model/gltf-binary', size: 1 },
            ],
            nodes: [{ id: 'n_1', name: 'Body', model: { asset: 'a_model' }, animation: { clip: 'Loop', sources: [{ name: 'Loop', walk: 'a_path' }, { name: 'Wave', clip: 'a_clip', take: 'Wave' }] } }],
        });
        const ids = refs(doc).filter((r) => r.kind === 'asset').map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining(['a_model', 'a_path', 'a_clip']));
        dropRefs(doc, 'asset', 'a_path');
        expect(doc.nodes[0].animation!.sources).toEqual([{ name: 'Wave', clip: 'a_clip', take: 'Wave' }]);
        // The clip it played goes back to the first.
        expect(doc.nodes[0].animation!.clip).toBe('');
        expect(refs(doc).some((r) => r.id === 'a_path')).toBe(false);
    });
});
