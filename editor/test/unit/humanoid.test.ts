import { describe, expect, it } from 'vitest';
import { guessHumanoid, type HumanoidNode } from '../../src/core/humanoid';

/** A skeleton from [name, parent name] pairs, parents first. */
function tree(pairs: [string, string | null][]): HumanoidNode[] {
    const index = new Map<string, number>();
    return pairs.map(([name, parent], i) => {
        index.set(name, i);
        return { name, parent: parent === null ? -1 : index.get(parent)! };
    });
}
const named = (nodes: HumanoidNode[], bones: Record<string, number>) => Object.fromEntries(Object.entries(bones).map(([role, i]) => [role, nodes[i].name]));

const limbs = (side: 'L' | 'R', fmt: (part: string) => string, parents: { arm: string; leg: string }): [string, string | null][] => [
    [fmt(`${side} Clavicle`), parents.arm],
    [fmt(`${side} UpperArm`), fmt(`${side} Clavicle`)],
    [fmt(`${side} Forearm`), fmt(`${side} UpperArm`)],
    [fmt(`${side} Hand`), fmt(`${side} Forearm`)],
    [fmt(`${side} Thigh`), parents.leg],
    [fmt(`${side} Calf`), fmt(`${side} Thigh`)],
    [fmt(`${side} Foot`), fmt(`${side} Calf`)],
];

describe('guessing the humanoid bones', () => {
    it('reads MikuMikuDance names, taking the D bones the skin follows', () => {
        const nodes = tree([
            ['全ての親', null], ['センター', '全ての親'], ['グルーブ', 'センター'], ['腰', 'グルーブ'],
            ['上半身', '腰'], ['上半身２', '上半身'], ['首', '上半身２'], ['頭', '首'], ['左目', '頭'], ['右目', '頭'],
            ['左肩', '上半身２'], ['左腕', '左肩'], ['左腕捩', '左腕'], ['左ひじ', '左腕'], ['左手首', '左ひじ'], ['左親指１', '左手首'], ['左親指２', '左親指１'], ['左人指１', '左手首'],
            ['右肩', '上半身２'], ['右腕', '右肩'], ['右ひじ', '右腕'], ['右手首', '右ひじ'],
            ['下半身', '腰'], ['左足', '下半身'], ['左ひざ', '左足'], ['左足首', '左ひざ'], ['右足', '下半身'], ['右ひざ', '右足'], ['右足首', '右ひざ'],
            ['左足Ｄ', '下半身'], ['左ひざＤ', '左足Ｄ'], ['左足首Ｄ', '左ひざＤ'], ['左足先EX', '左足首Ｄ'],
            ['右足Ｄ', '下半身'], ['右ひざＤ', '右足Ｄ'], ['右足首Ｄ', '右ひざＤ'],
            ['左足ＩＫ', '全ての親'],
        ]);
        const g = guessHumanoid(nodes);
        expect(g.missing).toEqual([]);
        expect(named(nodes, g.bones)).toMatchObject({
            hips: '腰', spine: '上半身', chest: '上半身２', neck: '首', head: '頭', leftEye: '左目',
            leftShoulder: '左肩', leftUpperArm: '左腕', leftLowerArm: '左ひじ', leftHand: '左手首',
            leftThumbProximal: '左親指１', leftThumbDistal: '左親指２', leftIndexProximal: '左人指１',
            leftUpperLeg: '左足Ｄ', leftLowerLeg: '左ひざＤ', leftFoot: '左足首Ｄ', leftToes: '左足先EX', rightUpperLeg: '右足Ｄ',
        });
    });

    it('reads 3ds Max Biped names, legs under the spine and fingers by number', () => {
        const b = (p: string) => `Bip001 ${p}`;
        const nodes = tree([
            ['Bip001', null], [b('Pelvis'), 'Bip001'], [b('Spine'), b('Pelvis')], [b('Spine1'), b('Spine')], [b('Neck'), b('Spine1')], [b('Head'), b('Neck')], [b('HeadNub'), b('Head')],
            ...limbs('L', b, { arm: b('Neck'), leg: b('Spine') }), ...limbs('R', b, { arm: b('Neck'), leg: b('Spine') }),
            [b('L Toe0'), b('L Foot')], [b('L ForeTwist'), b('L Forearm')], [b('L Finger0'), b('L Hand')], [b('L Finger01'), b('L Finger0')], [b('L Finger1'), b('L Hand')],
        ]);
        const g = guessHumanoid(nodes);
        expect(g.missing).toEqual([]);
        expect(named(nodes, g.bones)).toMatchObject({
            hips: b('Pelvis'), spine: b('Spine'), chest: b('Spine1'), neck: b('Neck'), head: b('Head'),
            leftShoulder: b('L Clavicle'), leftUpperArm: b('L UpperArm'), leftLowerArm: b('L Forearm'), leftHand: b('L Hand'),
            leftUpperLeg: b('L Thigh'), leftLowerLeg: b('L Calf'), leftFoot: b('L Foot'), leftToes: b('L Toe0'),
            leftThumbMetacarpal: b('L Finger0'), leftThumbProximal: b('L Finger01'), leftIndexProximal: b('L Finger1'),
        });
    });

    it('reads Mixamo and VRoid names', () => {
        const m = (p: string) => `mixamorig:${p}`;
        const mixamo = tree([
            [m('Hips'), null], [m('Spine'), m('Hips')], [m('Spine1'), m('Spine')], [m('Spine2'), m('Spine1')], [m('Neck'), m('Spine2')], [m('Head'), m('Neck')], [m('HeadTop_End'), m('Head')],
            ...(['Left', 'Right'] as const).flatMap((s): [string, string][] => [
                [m(`${s}Shoulder`), m('Spine2')], [m(`${s}Arm`), m(`${s}Shoulder`)], [m(`${s}ForeArm`), m(`${s}Arm`)], [m(`${s}Hand`), m(`${s}ForeArm`)],
                [m(`${s}UpLeg`), m('Hips')], [m(`${s}Leg`), m(`${s}UpLeg`)], [m(`${s}Foot`), m(`${s}Leg`)], [m(`${s}ToeBase`), m(`${s}Foot`)],
            ]),
            [m('LeftHandThumb1'), m('LeftHand')],
        ]);
        const g = guessHumanoid(mixamo);
        expect(g.missing).toEqual([]);
        expect(named(mixamo, g.bones)).toMatchObject({
            spine: m('Spine'), chest: m('Spine1'), upperChest: m('Spine2'), leftUpperArm: m('LeftArm'), leftLowerArm: m('LeftForeArm'),
            leftUpperLeg: m('LeftUpLeg'), leftLowerLeg: m('LeftLeg'), leftToes: m('LeftToeBase'), leftThumbMetacarpal: m('LeftHandThumb1'),
        });

        const j = (p: string) => `J_Bip_${p}`;
        const vroid = tree([
            [j('C_Hips'), null], [j('C_Spine'), j('C_Hips')], [j('C_Chest'), j('C_Spine')], [j('C_UpperChest'), j('C_Chest')], [j('C_Neck'), j('C_UpperChest')], [j('C_Head'), j('C_Neck')],
            ['J_Adj_L_FaceEye', j('C_Head')],
            ...(['L', 'R'] as const).flatMap((s): [string, string][] => [
                [j(`${s}_Shoulder`), j('C_UpperChest')], [j(`${s}_UpperArm`), j(`${s}_Shoulder`)], [j(`${s}_LowerArm`), j(`${s}_UpperArm`)], [j(`${s}_Hand`), j(`${s}_LowerArm`)],
                [j(`${s}_UpperLeg`), j('C_Hips')], [j(`${s}_LowerLeg`), j(`${s}_UpperLeg`)], [j(`${s}_Foot`), j(`${s}_LowerLeg`)], [j(`${s}_ToeBase`), j(`${s}_Foot`)],
            ]),
        ]);
        const v = guessHumanoid(vroid);
        expect(v.missing).toEqual([]);
        expect(named(vroid, v.bones)).toMatchObject({ chest: j('C_Chest'), upperChest: j('C_UpperChest'), leftEye: 'J_Adj_L_FaceEye', rightUpperLeg: j('R_UpperLeg') });
    });

    it('does not give a role to a bone outside the bone it hangs from', () => {
        // A "hand" under the head is not the arm's hand.
        const nodes = tree([['Hips', null], ['Spine', 'Hips'], ['Head', 'Spine'], ['L_UpperArm', 'Spine'], ['L_LowerArm', 'L_UpperArm'], ['L_Hand', 'Head']]);
        const g = guessHumanoid(nodes);
        expect(g.bones.leftHand).toBeUndefined();
        expect(g.missing).toContain('leftHand');
    });
});
