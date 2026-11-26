// A motion put onto a model: the clips of a clip GLB (a skeleton and its
// animations, no meshes: Mixamo "Without Skin" converted from FBX to GLB, a
// game's clip, an earlier export) retargeted onto the model's bones, and
// GLBs with clips added (the model the editor shows with its animation's
// clips, core/clipSources.ts; a converted PMX with the motions dropped with it).

import { humanoidPairs, mmdFromBiped, readGlbClips, retargetClip, retargetHumanoid, type Clip, type Helper } from './retarget';

export interface ClipsOntoModel {
    /** The model's GLB with the new clips added. */
    glb: Uint8Array;
    /** The names the new clips got (made unique against the model's own). */
    names: string[];
    /** How the bones were paired, for the log. */
    report: string[];
}

/** A GLB's skeleton and clips, as readGlbClips reads them. */
export type GlbClips = NonNullable<ReturnType<typeof readGlbClips>>;

/**
 * Clips of `src` (all of them, or those given) retargeted onto the skeleton of `model`, by
 * the method in retarget.ts: humanoid roles, one reference posture, turns from it, the hips'
 * move scaled, and the model's own clips for still joints and helper bones. A Biped clip on
 * an MMD model goes by the MMD table instead (its D and twist bones). The clips keep their
 * names. Throws when the two have too few bones in common.
 */
export function retargetClips(model: GlbClips, src: GlbClips, clips: Clip[] = src.clips): { clips: Clip[]; report: string[] } {
    const mmd = mmdFromBiped(model.skeleton, src.skeleton);
    const human = humanoidPairs(model.skeleton, src.skeleton);
    const byTable = mmd.pairs.length > human.pairs.length;
    const count = byTable ? mmd.pairs.length : human.pairs.length;
    if (count < 6) throw new Error(`the motion and the model share only ${count} humanoid bones`);
    let held: string[] = [];
    let helpers: Helper[] = [];
    const out: Clip[] = clips.map((clip) => {
        if (byTable) return { ...retargetClip(src.skeleton, clip, model.skeleton, mmd.pairs, { root: mmd.root, legs: mmd.legs }), name: clip.name };
        const r = retargetHumanoid(model, src.skeleton, clip, human);
        held = r.held;
        helpers = r.helpers;
        return { ...r.clip, name: clip.name };
    });
    const unmatched = byTable ? mmd.unmatched : human.unmatched;
    const kinds = (k: Helper['kind']) => helpers.filter((h) => h.kind === k).map((h) => h.name);
    const report = [
        `${count} bones paired ${byTable ? 'by the MMD-Biped table' : 'by humanoid role'}`,
        ...(unmatched.length ? [`not paired: ${unmatched.slice(0, 12).join(', ')}${unmatched.length > 12 ? '…' : ''}`] : []),
        ...(held.length ? [`kept still as in the model's own clips: ${held.join(', ')}`] : []),
        ...(kinds('share').length ? [`twist bones by their share of the joints' twist: ${kinds('share').join(', ')}`] : []),
        ...(kinds('fitted').length ? [`helper bones fitted to the model's clips: ${kinds('fitted').join(', ')}`] : []),
        ...((byTable ? mmd.root : human.root) ? [] : ['no hips on one side: the clip does not move the body']),
    ];
    return { clips: out, report };
}

/**
 * Retargets every clip of `clipGlb` onto the skeleton of `modelGlb` (retargetClips) and adds
 * them to a copy of it, their names made unique against the model's own. Throws when the
 * motion has no clips or the two have too few bones in common.
 */
export function addClipsToModel(modelGlb: ArrayBuffer, clipGlb: ArrayBuffer, fallbackName = 'clip'): ClipsOntoModel {
    const model = readGlbClips(modelGlb);
    const src = readGlbClips(clipGlb);
    if (!model) throw new Error('the model is not a GLB');
    if (!src || !src.clips.length) throw new Error('the motion file has no animation');
    const made = retargetClips(model, src);
    const taken = new Set(model.clips.map((c) => c.name));
    const names: string[] = [];
    const clips = made.clips.map((clip, i) => {
        const base = clip.name || (src.clips.length > 1 ? `${fallbackName}_${i}` : fallbackName);
        let name = base;
        for (let k = 2; taken.has(name); k++) name = `${base} (${k})`;
        taken.add(name);
        names.push(name);
        return { ...clip, name };
    });
    return { glb: appendAnimations(new Uint8Array(modelGlb), clips), names, report: made.report };
}

/** A GLB with animations added: their data after the binary chunk's, as float accessors. */
export function appendAnimations(glb: Uint8Array, clips: Clip[]): Uint8Array {
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
    const jsonLength = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder('utf-8').decode(glb.subarray(20, 20 + jsonLength)));
    const binAt = 20 + jsonLength;
    const hasBin = binAt + 8 <= glb.byteLength && dv.getUint32(binAt + 4, true) === 0x004e4942;
    const oldBin = hasBin ? glb.subarray(binAt + 8, binAt + 8 + dv.getUint32(binAt, true)) : new Uint8Array(0);
    if (json.buffers?.[0]?.uri !== undefined) throw new Error('the model keeps its data in another file');

    const parts: Uint8Array[] = [oldBin];
    let length = oldBin.byteLength;
    const align = () => {
        const pad = (4 - (length % 4)) % 4;
        if (pad) { parts.push(new Uint8Array(pad)); length += pad; }
    };
    json.bufferViews ??= [];
    json.accessors ??= [];
    const accessor = (data: Float32Array, type: 'SCALAR' | 'VEC3' | 'VEC4', bounds = false) => {
        align();
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength });
        parts.push(bytes);
        length += bytes.byteLength;
        const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
        const acc: Record<string, unknown> = { bufferView: json.bufferViews.length - 1, componentType: 5126, count: data.length / size, type };
        if (bounds) {
            let lo = Infinity, hi = -Infinity;
            for (const v of data) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
            acc.min = [lo];
            acc.max = [hi];
        }
        json.accessors.push(acc);
        return json.accessors.length - 1;
    };
    json.animations ??= [];
    for (const clip of clips) {
        const inputs = new Map<Float32Array, number>();
        const anim = { name: clip.name, samplers: [] as unknown[], channels: [] as unknown[] };
        for (const tr of clip.tracks) {
            if (!tr.times.length) continue;
            let input = inputs.get(tr.times);
            if (input === undefined) inputs.set(tr.times, (input = accessor(tr.times, 'SCALAR', true)));
            const output = accessor(tr.values, tr.path === 'rotation' ? 'VEC4' : 'VEC3');
            anim.samplers.push({ input, output, interpolation: 'LINEAR' });
            anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: tr.bone, path: tr.path } });
        }
        if (anim.channels.length) json.animations.push(anim);
    }
    align();
    json.buffers ??= [];
    if (!json.buffers.length) json.buffers.push({ byteLength: 0 });
    json.buffers[0].byteLength = length;

    let text = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (text.byteLength % 4)) % 4;
    if (jsonPad) {
        const t = new Uint8Array(text.byteLength + jsonPad).fill(0x20);
        t.set(text);
        text = t;
    }
    const total = 12 + 8 + text.byteLength + 8 + length;
    const out = new Uint8Array(total);
    const o = new DataView(out.buffer);
    o.setUint32(0, 0x46546c67, true);
    o.setUint32(4, 2, true);
    o.setUint32(8, total, true);
    o.setUint32(12, text.byteLength, true);
    o.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    let at = 20 + text.byteLength;
    o.setUint32(at, length, true);
    o.setUint32(at + 4, 0x004e4942, true);
    at += 8;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
}
