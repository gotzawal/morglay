// A small rigged model for the character format's tests: a Mixamo-named
// skeleton (its head turned 90° about Y at rest, to test frames), hair under
// the head, and one quad whose material is named "face".

import type { MglMeta } from '../../../src/core/mgl';
import { joinGlb } from '../../../src/core/mglWrite';

export const META: MglMeta = {
    name: 'Test', authors: ['someone'], licenseUrl: 'https://example.com/license', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit',
    allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false,
    creditNotation: 'required', allowRedistribution: false, modification: 'prohibited',
};

export function model(): Uint8Array {
    const bones: [string, number, [number, number, number]][] = [
        ['Hips', -1, [0, 1, 0]], ['Spine', 0, [0, 0.1, 0]], ['Neck', 1, [0, 0.4, 0]], ['Head', 2, [0, 0.1, 0]],
        ['LeftArm', 1, [0.2, 0.3, 0]], ['LeftForeArm', 4, [0.25, 0, 0]], ['LeftHand', 5, [0.25, 0, 0]],
        ['RightArm', 1, [-0.2, 0.3, 0]], ['RightForeArm', 7, [-0.25, 0, 0]], ['RightHand', 8, [-0.25, 0, 0]],
        ['LeftUpLeg', 0, [0.1, -0.05, 0]], ['LeftLeg', 10, [0, -0.45, 0]], ['LeftFoot', 11, [0, -0.45, 0]],
        ['RightUpLeg', 0, [-0.1, -0.05, 0]], ['RightLeg', 13, [0, -0.45, 0]], ['RightFoot', 14, [0, -0.45, 0]],
        ['Jaw', 3, [0, 0.02, 0.05]], ['hair1', 3, [0, 0.1, -0.05]], ['hair2', 17, [0, -0.1, 0]],
    ];
    const s = Math.SQRT1_2;
    const nodes: any[] = bones.map(([name, , t], i) => ({ name, translation: t, ...(i === 3 ? { rotation: [0, s, 0, s] } : {}) }));
    bones.forEach(([, p], i) => p >= 0 && (nodes[p].children ??= []).push(i));
    nodes.push({ name: 'Body', mesh: 0, skin: 0 });
    const P = new Float32Array([-0.1, 1.5, 0.1, 0.1, 1.5, 0.1, 0.1, 1.7, 0.1, -0.1, 1.7, 0.1]);
    const N = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const I = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const bin = new Uint8Array(P.byteLength + N.byteLength + I.byteLength);
    bin.set(new Uint8Array(P.buffer), 0);
    bin.set(new Uint8Array(N.buffer), P.byteLength);
    bin.set(new Uint8Array(I.buffer), P.byteLength + N.byteLength);
    const json = {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0, bones.length] }],
        nodes,
        skins: [{ joints: bones.map((_, i) => i) }],
        meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
        materials: [{ name: 'face', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
        buffers: [{ byteLength: bin.byteLength }],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: P.byteLength },
            { buffer: 0, byteOffset: P.byteLength, byteLength: N.byteLength },
            { buffer: 0, byteOffset: P.byteLength + N.byteLength, byteLength: I.byteLength },
        ],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.1, 1.5, 0.1], max: [0.1, 1.7, 0.1] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
    };
    return joinGlb(json, bin);
}
