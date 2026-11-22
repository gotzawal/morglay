// Which nodes of a skeleton are the humanoid bones (VRM 1.0's names, the
// character format's MGL_character.humanoid), guessed from the bones' names:
// MikuMikuDance's Japanese names, 3ds Max Biped ("Bip001 L UpperArm"), VRoid
// ("J_Bip_L_UpperArm"), Mixamo ("mixamorig:LeftForeArm"), Unreal ("upperarm_l"),
// Blender ("DEF-upper_arm.L") and plain English ones. A bone takes a role only
// under the bone the role hangs from (core/mgl.ts humanoidParents).

import { HUMANOID_BONES, humanoidParents } from './mgl';

export interface HumanoidNode {
    name: string;
    /** The parent's index, -1 for none. */
    parent: number;
}

export interface HumanoidGuess {
    /** Node index by humanoid bone. */
    bones: Record<string, number>;
    /** The fifteen every model has that were not found. */
    missing: string[];
}

type Side = 'left' | 'right' | '';
interface Candidate {
    node: number;
    role: string;
    /** Lower is better, among the bones that could take a role. */
    rank: number;
}

const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const SEGMENTS = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], other: ['Proximal', 'Intermediate', 'Distal'] } as const;
const fingerRole = (side: Side, finger: number, segment: number) => {
    const f = FINGER_NAMES[finger];
    const seg = (f === 'Thumb' ? SEGMENTS.Thumb : SEGMENTS.other)[segment];
    return side && f && seg ? `${side}${f}${seg}` : null;
};

// ---------------------------------------------------------------- MMD's names

/** Roles of MMD's standard bone names (after NFKC: full-width digits are ASCII); D bones (the ones the skin follows) first. */
const MMD: [RegExp, string, number][] = [
    [/^腰$/, 'hips', 0],
    [/^グルーブ$/, 'hips', 1],
    [/^センター$/, 'hips', 2],
    [/^上半身$/, 'spine', 0],
    [/^上半身2$/, 'chest', 0],
    [/^上半身3$/, 'upperChest', 0],
    [/^(首|颈)$/, 'neck', 0],
    [/^(頭|头)$/, 'head', 0],
    [/^([左右])肩$/, 'Shoulder', 0],
    [/^([左右])腕$/, 'UpperArm', 0],
    [/^([左右])ひじ$/, 'LowerArm', 0],
    [/^([左右])手首$/, 'Hand', 0],
    [/^([左右])足D$/, 'UpperLeg', 0],
    [/^([左右])足$/, 'UpperLeg', 1],
    [/^([左右])ひざD$/, 'LowerLeg', 0],
    [/^([左右])ひざ$/, 'LowerLeg', 1],
    [/^([左右])足首D$/, 'Foot', 0],
    [/^([左右])足首$/, 'Foot', 1],
    [/^([左右])足先EX$/, 'Toes', 0],
    [/^([左右])つま先$/, 'Toes', 1],
    [/^([左右])目$/, 'Eye', 0],
];
const MMD_FINGERS: [RegExp, number][] = [
    [/^([左右])親指([0-2])$/, 0],
    [/^([左右])人指([1-3])$/, 1],
    [/^([左右])中指([1-3])$/, 2],
    [/^([左右])薬指([1-3])$/, 3],
    [/^([左右])小指([1-3])$/, 4],
];
const mmdSide = (c: string): Side => (c === '左' ? 'left' : c === '右' ? 'right' : '');

// ------------------------------------------------------------- other rigs' names

/** Name words that carry no role: rig prefixes. */
const PREFIX = new Set(['bip001', 'bip01', 'bip', 'mixamorig', 'j', 'c', 'def', 'org', 'armature', 'b', 'bone', 'jnt', 'joint']);
/** Bones that are never the humanoid's (helpers, twists, ends). */
const SKIP = /twist|roll|nub|end|tip|ik|pole|target|ctrl|helper|null|dummy|corrective|share|cancel/;

/** A name as words, its side apart: "Bip001 L UpperArm" is left, ["upper", "arm"]. */
function words(name: string): { side: Side; key: string } {
    const parts = name
        .normalize('NFKC')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[\s_\-.:|/\\]+/)
        .filter(Boolean);
    let side: Side = '';
    const rest: string[] = [];
    for (const p of parts) {
        if (p === 'l' || p === 'left') side ||= 'left';
        else if (p === 'r' || p === 'right') side ||= 'right';
        else if (!PREFIX.has(p)) rest.push(p);
    }
    return { side, key: rest.join('') };
}

const GENERIC: [RegExp, string, number][] = [
    [/^(hips?|pelvis)$/, 'hips', 0],
    [/^chest$/, 'chest', 0],
    [/^upperchest$/, 'upperChest', 0],
    [/^neck0?1?$/, 'neck', 0],
    [/^head$/, 'head', 0],
    [/^jaw$/, 'jaw', 0],
    [/^(shoulder|clavicle|collar(bone)?)$/, 'Shoulder', 0],
    [/^(upperarm|uparm)$/, 'UpperArm', 0],
    [/^arm$/, 'UpperArm', 1],
    [/^(lowerarm|forearm|lowarm)$/, 'LowerArm', 0],
    [/^elbow$/, 'LowerArm', 1],
    [/^hand$/, 'Hand', 0],
    [/^wrist$/, 'Hand', 1],
    [/^(upperleg|upleg|thigh)$/, 'UpperLeg', 0],
    [/^(lowerleg|calf|shin)$/, 'LowerLeg', 0],
    [/^(leg|knee)$/, 'LowerLeg', 1],
    [/^foot$/, 'Foot', 0],
    [/^ankle$/, 'Foot', 1],
    [/^(toes?|toebase|toe0|ball)$/, 'Toes', 0],
    // VRoid's eyes: "J_Adj_L_FaceEye".
    [/^(adj)?(face)?eye$/, 'Eye', 0],
];
const FINGER_WORDS: Record<string, number> = { thumb: 0, index: 1, middle: 2, ring: 3, little: 4, pinky: 4 };

/** The roles a bone could take, by its name ('spine#n' marks the n-th bone of a spine by its name). */
function candidates(name: string): { role: string; rank: number }[] {
    const n = name.normalize('NFKC').trim();
    // MikuMikuDance
    for (const [re, role, rank] of MMD) {
        const m = re.exec(n);
        if (!m) continue;
        const side = m[1] ? mmdSide(m[1]) : '';
        return [{ role: side ? side + role : role, rank }];
    }
    for (const [re, finger] of MMD_FINGERS) {
        const m = re.exec(n);
        if (!m) continue;
        // Thumbs count from 0 where the model has the thumb's base (親指0), else from 1.
        const seg = finger === 0 ? Number(m[2]) : Number(m[2]) - 1;
        const role = fingerRole(mmdSide(m[1]), finger, seg);
        return role ? [{ role, rank: 0 }] : [];
    }
    const { side, key } = words(n);
    if (!key || SKIP.test(key)) return [];
    // Spines: "spine", "spine1", "spine_02", "spine.001"
    const spine = /^spine(\d*)$/.exec(key);
    if (spine && !side) return [{ role: `spine#${spine[1] ? Number(spine[1]) : 0}`, rank: 0 }];
    for (const [re, role, rank] of GENERIC) {
        if (!re.test(key)) continue;
        const sided = role[0] === role[0].toUpperCase();
        if (sided && !side) return [];
        if (!sided && side && role !== 'jaw') return [];
        return [{ role: sided ? side + role : role, rank }];
    }
    if (!side) return [];
    // Fingers: "Thumb1", "HandIndex2" (Mixamo), "Index_02" (Unreal), Biped's "Finger0" (thumb), "Finger12" (index, third)
    const named = /^(?:hand)?(thumb|index|middle|ring|little|pinky)0?(\d)$/.exec(key);
    if (named) {
        const finger = FINGER_WORDS[named[1]];
        const role = fingerRole(side, finger, Number(named[2]) - 1);
        return role ? [{ role, rank: 0 }] : [];
    }
    const biped = /^finger([0-4])([0-2])?$/.exec(key);
    if (biped) {
        const role = fingerRole(side, Number(biped[1]), biped[2] === undefined ? 0 : Number(biped[2]));
        return role ? [{ role, rank: 0 }] : [];
    }
    return [];
}

/** The order roles are settled in: every role after the ones it hangs from. */
const ORDER = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw', 'leftEye', 'rightEye',
    'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
    ...(['left', 'right'] as const).flatMap((s) => FINGER_NAMES.flatMap((f) => (f === 'Thumb' ? SEGMENTS.Thumb : SEGMENTS.other).map((g) => `${s}${f}${g}`))),
    'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes',
];

/** Guesses the humanoid bones of a skeleton from its bones' names and how they hang. */
export function guessHumanoid(nodes: readonly HumanoidNode[]): HumanoidGuess {
    const depth = (i: number) => {
        let d = 0;
        for (let p = nodes[i]?.parent ?? -1; p >= 0 && d < nodes.length; p = nodes[p].parent) d++;
        return d;
    };
    const isAncestor = (a: number, b: number) => {
        for (let p = nodes[b]?.parent ?? -1, guard = 0; p >= 0 && guard < nodes.length; p = nodes[p].parent, guard++) if (p === a) return true;
        return false;
    };
    const byRole = new Map<string, Candidate[]>();
    const spines: { node: number; order: number }[] = [];
    nodes.forEach((n, node) => {
        for (const c of candidates(n.name)) {
            if (c.role.startsWith('spine#')) spines.push({ node, order: Number(c.role.slice(6)) });
            else (byRole.get(c.role) ?? byRole.set(c.role, []).get(c.role)!).push({ node, role: c.role, rank: c.rank });
        }
    });
    // Spines by name: the first is the spine, then the chest and the upper chest (where no bone is named so).
    spines.sort((a, b) => depth(a.node) - depth(b.node) || a.order - b.order);
    const chain = ['spine', ...(byRole.has('chest') ? [] : ['chest']), ...(byRole.has('upperChest') || byRole.has('chest') ? [] : ['upperChest'])];
    spines.slice(0, chain.length).forEach((s, i) => (byRole.get(chain[i]) ?? byRole.set(chain[i], []).get(chain[i])!).push({ node: s.node, role: chain[i], rank: 1 }));

    const bones: Record<string, number> = {};
    const used = new Set<number>();
    for (const role of ORDER) {
        const list = (byRole.get(role) ?? []).filter((c) => !used.has(c.node)).sort((a, b) => a.rank - b.rank || depth(a.node) - depth(b.node));
        const up = humanoidParents(role).find((p) => bones[p] !== undefined);
        const pick = list.find((c) => (up === undefined ? true : isAncestor(bones[up], c.node)));
        if (!pick) continue;
        bones[role] = pick.node;
        used.add(pick.node);
    }
    // Every bone the order missed (none should be): kept out.
    const missing = HUMANOID_BONES.slice(0, 15).filter((b) => bones[b] === undefined);
    return { bones, missing };
}
