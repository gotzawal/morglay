import { describe, expect, it } from 'vitest';
import { addClipsToModel, appendAnimations } from '../../src/core/clipImport';
import { readGlbClips, type Quat } from '../../src/core/retarget';

/** A GLB of nodes only (a skeleton: [name, parent, translation]), no binary chunk. */
function skeletonGlb(bones: [string, number, [number, number, number]][]): Uint8Array {
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

// The same little body twice: a Mixamo-named clip skeleton and a Biped-named model, both standing in a T.
const mixamo = skeletonGlb([
    ['mixamorig:Hips', -1, [0, 1, 0]], ['mixamorig:Spine', 0, [0, 0.1, 0]], ['mixamorig:Spine1', 1, [0, 0.1, 0]], ['mixamorig:Spine2', 2, [0, 0.1, 0]],
    ['mixamorig:Neck', 3, [0, 0.2, 0]], ['mixamorig:Head', 4, [0, 0.1, 0]],
    ['mixamorig:LeftShoulder', 3, [0.05, 0.15, 0]], ['mixamorig:LeftArm', 6, [0.1, 0, 0]], ['mixamorig:LeftForeArm', 7, [0.25, 0, 0]], ['mixamorig:LeftHand', 8, [0.25, 0, 0]],
    ['mixamorig:LeftUpLeg', 0, [0.1, -0.05, 0]], ['mixamorig:LeftLeg', 10, [0, -0.45, 0]], ['mixamorig:LeftFoot', 11, [0, -0.45, 0]], ['mixamorig:LeftToeBase', 12, [0, -0.05, 0.1]],
]);
const biped = skeletonGlb([
    ['Bip001', -1, [0, 0, 0]], ['Bip001 Pelvis', 0, [0, 0.9, 0]], ['Bip001 Spine', 1, [0, 0.1, 0]], ['Bip001 Spine1', 2, [0, 0.1, 0]], ['Bip001 Spine2', 3, [0, 0.1, 0]],
    ['Bip001 Neck', 4, [0, 0.2, 0]], ['Bip001 Head', 5, [0, 0.1, 0]],
    ['Bip001 L Clavicle', 5, [0.05, 0, 0]], ['Bip001 L UpperArm', 7, [0.1, 0, 0]], ['Bip001 L Forearm', 8, [0.22, 0, 0]], ['Bip001 L Hand', 9, [0.22, 0, 0]],
    ['Bip001 L Thigh', 1, [0.1, -0.05, 0]], ['Bip001 L Calf', 11, [0, -0.4, 0]], ['Bip001 L Foot', 12, [0, -0.4, 0]], ['Bip001 L Toe0', 13, [0, -0.04, 0.08]],
]);
const s = Math.SQRT1_2;
const clipGlb = appendAnimations(mixamo, [{
    name: 'Wave',
    tracks: [
        // The left arm from straight out to straight up (a quarter turn about +Z).
        { bone: 7, path: 'rotation', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, 0, 0, s, s]) },
        { bone: 0, path: 'translation', times: new Float32Array([0, 1]), values: new Float32Array([0, 1, 0, 0, 1, 0.5]) },
    ],
}]);

describe('motion onto a model', () => {
    it('writes animations a GLB reader reads back', () => {
        const r = readGlbClips(buf(clipGlb))!;
        expect(r.clips.map((c) => c.name)).toEqual(['Wave']);
        expect(Array.from(r.clips[0].tracks[0].values)).toEqual(Array.from(new Float32Array([0, 0, 0, 1, 0, 0, s, s])));
    });

    it('retargets a Mixamo clip onto a Biped model and keeps the name unique', () => {
        const first = addClipsToModel(buf(biped), buf(clipGlb), 'wave');
        expect(first.names).toEqual(['Wave']);
        expect(first.report[0]).toMatch(/by humanoid role/);
        const again = addClipsToModel(buf(first.glb), buf(clipGlb), 'wave');
        expect(again.names).toEqual(['Wave (2)']);
        const model = readGlbClips(buf(again.glb))!;
        expect(model.clips.map((c) => c.name)).toEqual(['Wave', 'Wave (2)']);
        // The model's upper arm turns up as the source's did.
        const arm = model.clips[0].tracks.find((t) => t.bone === 8 && t.path === 'rotation')!;
        const end = Array.from(arm.values.subarray(4, 8)) as Quat;
        expect(end[2]).toBeCloseTo(s, 5);
        expect(end[3]).toBeCloseTo(s, 5);
        // The hips move forward by the source's 0.5 m times the legs' ratio (0.8 / 0.9).
        const move = model.clips[0].tracks.find((t) => t.path === 'translation')!;
        expect(model.skeleton[move.bone].name).toBe('Bip001 Pelvis');
        expect(move.values[5]).toBeCloseTo(0.5 * (0.8 / 0.9), 4);
    });

    it('refuses a motion that shares no bones with the model', () => {
        const other = skeletonGlb([['root', -1, [0, 0, 0]], ['tail', 0, [0, 0, -1]]]);
        expect(() => addClipsToModel(buf(other), buf(clipGlb))).toThrow(/share only/);
    });
});
