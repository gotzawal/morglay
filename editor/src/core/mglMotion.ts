// A character's motion data between the editor and the character format v1
// (editor/CHARACTERS.md section 4):
// - springs: the editor's groups name bones (patterns, and bones that start
//   chains); the file's chains start at a node and take all under it,
// - colliders: the editor puts a ball's center (or a capsule's ends) in the
//   model's axes at rest; the file in the node's own frame at rest,
// - expressions: the editor moves face bones by offsets in the model's axes
//   at rest; the file's bone binds move a node in its parent's frame at rest
//   (and may turn it, change morphs, colors and layers, which the editor's
//   face does not do yet: they stay in the file as they were).

import { BLINK_SECONDS, boneMatcher, qinv, qmul, rotate, sub, type Quat, type V3 } from './rigMotion';
import { EXPRESSION_PRESETS, matrixRotation, parentsOf, restMatrices, type MglCharacter, type MglExpression, type MglSprings } from './mgl';
import type { MotionDoc, SpringColliderDoc, SpringGroupDoc } from './model';

/** The nodes of a file at rest, in the model's axes (the frame its skeleton hangs in). */
export interface RestSkeleton {
    names: string[];
    parent: number[];
    rot: Quat[];
    pos: V3[];
    byName: Map<string, number>;
}

/**
 * The file's nodes at rest. The model's axes are those of the node the
 * skeleton (the first skin's top joint) hangs under, as the editor's motion
 * reads them; a file without a skin uses the scene's.
 */
export function restSkeleton(json: any): RestSkeleton {
    const nodes: any[] = json.nodes ?? [];
    const parent = parentsOf(json);
    const world = restMatrices(json, parent);
    const joints = new Set<number>(json.skins?.[0]?.joints ?? []);
    const top = [...joints].find((j) => !joints.has(parent[j]));
    const frame = top !== undefined && parent[top] >= 0 ? world[parent[top]] : null;
    const toModel: Quat = frame ? qinv(matrixRotation(frame)) : [0, 0, 0, 1];
    const origin: V3 = frame ? [frame[12], frame[13], frame[14]] : [0, 0, 0];
    const names = nodes.map((n, i) => (typeof n?.name === 'string' && n.name ? n.name : `node_${i}`));
    const byName = new Map<string, number>();
    names.forEach((n, i) => byName.has(n) || byName.set(n, i));
    return {
        names,
        parent,
        rot: world.map((m) => qmul(toModel, matrixRotation(m))),
        pos: world.map((m) => rotate(toModel, sub([m[12], m[13], m[14]], origin))),
        byName,
    };
}

const IDENTITY: Quat = [0, 0, 0, 1];
const parentRot = (s: RestSkeleton, i: number): Quat => (s.parent[i] >= 0 ? s.rot[s.parent[i]] : IDENTITY);
/** A name as a bone pattern (core/rigMotion.ts boneMatcher): spaces and commas become *. */
const asPattern = (name: string) => name.replace(/[\s,]+/g, '*');
const round = (v: V3, digits = 6): V3 => v.map((x) => Math.round(x * 10 ** digits) / 10 ** digits) as V3;
const isIdentity = (q: readonly number[] | undefined) => !q || (Math.abs(q[0]) < 1e-6 && Math.abs(q[1]) < 1e-6 && Math.abs(q[2]) < 1e-6);

// ---------------------------------------------------------------- file to editor

export interface MotionFromFile {
    springs: SpringGroupDoc[];
    colliders: SpringColliderDoc[];
    expressions: Record<string, Record<string, V3>>;
    blink: boolean;
    notes: string[];
}

export function motionFromMgl(json: any, character: MglCharacter | null, springs: MglSprings | null): MotionFromFile {
    const s = restSkeleton(json);
    const notes: string[] = [];
    // ---- colliders: one set each, named as in the file
    const colliders: SpringColliderDoc[] = [];
    for (const c of springs?.colliders ?? []) {
        const name = s.names[c.node];
        if (name === undefined) continue;
        const r = s.rot[c.node];
        colliders.push({
            set: c.name,
            bone: name,
            to: '',
            radius: c.radius,
            offset: round(rotate(r, (c.offset ?? [0, 0, 0]) as V3)),
            tail: c.shape === 'capsule' ? round(rotate(r, (c.tail ?? [0, 0, 0]) as V3)) : [0, 0, 0],
        });
    }
    // ---- chains: those that swing alike and hit the same colliders make one group
    const groups = new Map<string, { g: SpringGroupDoc; roots: string[] }>();
    for (const c of springs?.chains ?? []) {
        const root = s.names[c.root];
        if (root === undefined) continue;
        const hit = (c.colliders ?? []).join(' ');
        const key = JSON.stringify([c.period, c.damping, c.gravity, c.drag, c.maxAngle, c.radius, hit]);
        let entry = groups.get(key);
        if (!entry) {
            entry = { g: { bones: '', chains: '', period: c.period, damping: c.damping, gravity: c.gravity, drag: c.drag, limit: c.maxAngle, radius: c.radius, hit }, roots: [] };
            groups.set(key, entry);
        }
        entry.roots.push(asPattern(root));
    }
    const list = [...groups.values()].map(({ g, roots }) => ({ ...g, chains: roots.join(' ') }));
    if (list.length > 32) notes.push(`${list.length} kinds of spring chains: the editor keeps 32`);
    if (colliders.length > 64) notes.push(`${colliders.length} colliders: the editor keeps 64`);

    // ---- expressions: the bone binds, as offsets in the model's axes
    const expressions: Record<string, Record<string, V3>> = {};
    const ex = character?.expressions;
    const all: [string, MglExpression][] = [...Object.entries(ex?.preset ?? {}), ...Object.entries(ex?.custom ?? {})] as [string, MglExpression][];
    const blinkName = ex?.blink?.expression;
    let turned = 0;
    let others = 0;
    for (const [fileName, e] of all) {
        // The editor blinks with the expression named "blink".
        const name = blinkName && fileName === blinkName ? 'blink' : fileName;
        const offsets: Record<string, V3> = {};
        for (const b of e.boneBinds ?? []) {
            const bone = s.names[b.node];
            if (bone === undefined) continue;
            offsets[bone] = round(rotate(parentRot(s, b.node), (b.translation ?? [0, 0, 0]) as V3));
            if (!isIdentity(b.rotation)) turned++;
        }
        if (Object.keys(offsets).length) expressions[name] = offsets;
        others += (e.morphTargetBinds?.length ?? 0) + (e.materialColorBinds?.length ?? 0) + (e.textureTransformBinds?.length ?? 0) + (e.layerBinds?.length ?? 0);
    }
    if (turned) notes.push(`${turned} bone turns of expressions are not shown by the editor's face (it moves bones only)`);
    if (others) notes.push(`${others} morph, color and layer binds of expressions are kept in the file but not shown yet`);
    return { springs: list.slice(0, 32), colliders: colliders.slice(0, 64), expressions, blink: !!ex?.blink, notes };
}

// ---------------------------------------------------------------- editor to file

export interface MotionToFile {
    springs: MglSprings | null;
    expressions: MglCharacter['expressions'] | undefined;
    notes: string[];
}

/**
 * The file's springs and expressions from the editor's motion. `base`: the
 * expressions the file had, whose binds the editor does not show (morphs,
 * colors, layers, bone turns) are kept; its bone moves are the editor's.
 */
export function mglFromMotion(json: any, motion: Pick<MotionDoc, 'springs' | 'colliders' | 'expressions' | 'blink'> | undefined, base?: MglCharacter['expressions']): MotionToFile {
    const s = restSkeleton(json);
    const notes: string[] = [];
    const children = new Map<number, number[]>();
    s.parent.forEach((p, i) => p >= 0 && (children.get(p) ?? children.set(p, []).get(p)!).push(i));

    // ---- colliders: each its own name (its set's, numbered when the set has more)
    const colliders: NonNullable<MglSprings['colliders']> = [];
    const bySet = new Map<string, string[]>();
    for (const c of motion?.colliders ?? []) {
        const node = s.byName.get(c.bone);
        if (node === undefined) {
            notes.push(`collider on ${c.bone}: no such bone`);
            continue;
        }
        const names = bySet.get(c.set) ?? bySet.set(c.set, []).get(c.set)!;
        const name = names.length ? `${c.set}_${names.length + 1}` : c.set;
        names.push(name);
        const toLocal = qinv(s.rot[node]);
        const to = c.to ? s.byName.get(c.to) : undefined;
        const tail = to !== undefined ? rotate(toLocal, sub(s.pos[to], s.pos[node])) : rotate(toLocal, c.tail as V3);
        const capsule = to !== undefined || Math.hypot(...(c.tail as V3)) > 1e-6;
        colliders.push({ name, node, shape: capsule ? 'capsule' : 'sphere', offset: round(rotate(toLocal, c.offset as V3)), ...(capsule ? { tail: round(tail) } : {}), radius: c.radius });
    }

    // ---- chains: every bone a group swings, from the tops of its runs (a bone in two groups is the first's)
    const chains: MglSprings['chains'] = [];
    const taken = new Set<number>();
    for (const g of motion?.springs ?? []) {
        const named = boneMatcher(g.bones);
        const starts = boneMatcher(g.chains ?? '');
        const members = new Set<number>();
        const add = (i: number) => {
            if (members.has(i)) return;
            members.add(i);
            for (const c of children.get(i) ?? []) add(c);
        };
        s.names.forEach((n, i) => {
            if (g.chains && starts(n)) add(i);
            else if (g.bones && named(n)) members.add(i);
        });
        for (const i of taken) members.delete(i);
        const hit = g.hit.split(/[\s,]+/).filter(Boolean).flatMap((set) => bySet.get(set) ?? []);
        for (const i of members) {
            taken.add(i);
            if (members.has(s.parent[i])) continue;
            chains.push({ name: s.names[i], root: i, period: g.period, damping: g.damping, gravity: g.gravity, drag: g.drag, maxAngle: g.limit, radius: g.radius, ...(hit.length ? { colliders: hit } : {}) });
        }
    }
    const springs: MglSprings | null = chains.length || colliders.length ? { chains, ...(colliders.length ? { colliders } : {}) } : null;

    // ---- expressions: the editor's bone moves over what else the file's expressions did
    const preset: Record<string, MglExpression> = {};
    const custom: Record<string, MglExpression> = {};
    const isPreset = (n: string) => (EXPRESSION_PRESETS as readonly string[]).includes(n);
    const fileBlink = base?.blink?.expression;
    // The file's own: kept without their bone moves (the editor's replace them).
    for (const [list, out] of [[base?.preset, preset], [base?.custom, custom]] as const) {
        for (const [name, e] of Object.entries(list ?? {})) {
            if (!e) continue;
            const { boneBinds, ...rest } = e as MglExpression;
            const turns = (boneBinds ?? []).filter((b) => !isIdentity(b.rotation)).map((b) => ({ node: b.node, rotation: b.rotation }));
            out[name] = { ...rest, ...(turns.length ? { boneBinds: turns } : {}) };
        }
    }
    for (const [editorName, offsets] of Object.entries(motion?.expressions ?? {})) {
        // The editor's blink is the file's blink expression.
        const name = editorName === 'blink' && fileBlink ? fileBlink : editorName;
        const out = isPreset(name) ? preset : custom;
        const binds: NonNullable<MglExpression['boneBinds']> = [];
        for (const [bone, offset] of Object.entries(offsets)) {
            const node = s.byName.get(bone);
            if (node === undefined) {
                notes.push(`expression ${editorName}: no bone ${bone}`);
                continue;
            }
            const turn = out[name]?.boneBinds?.find((b) => b.node === node);
            const translation = round(rotate(qinv(parentRot(s, node)), offset as V3));
            if (turn) turn.translation = translation;
            else binds.push({ node, translation });
        }
        out[name] = { ...(out[name] ?? {}), boneBinds: [...(out[name]?.boneBinds ?? []), ...binds] };
    }
    // What is left with nothing to do is dropped.
    for (const out of [preset, custom]) {
        for (const [name, e] of Object.entries(out)) {
            const n = (e.morphTargetBinds?.length ?? 0) + (e.boneBinds?.length ?? 0) + (e.materialColorBinds?.length ?? 0) + (e.textureTransformBinds?.length ?? 0) + (e.layerBinds?.length ?? 0);
            if (!n) delete out[name];
        }
    }
    const names = new Set([...Object.keys(preset), ...Object.keys(custom)]);
    const blinkName = fileBlink ?? 'blink';
    const expressions: MglCharacter['expressions'] | undefined = names.size
        ? {
              ...(Object.keys(preset).length ? { preset } : {}),
              ...(Object.keys(custom).length ? { custom } : {}),
              ...(base?.default && names.has(base.default) ? { default: base.default } : {}),
              ...((motion?.blink ?? !!base?.blink) && names.has(blinkName) ? { blink: { interval: [2.2, 5.2] as [number, number], duration: BLINK_SECONDS, ...(base?.blink ?? {}), expression: blinkName } } : {}),
          }
        : undefined;
    return { springs, expressions, notes };
}
