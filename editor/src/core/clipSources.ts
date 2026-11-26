// The clips a model gets from its animation's sources (AnimationDoc.sources)
// instead of from its file: a walk along a path asset, made for the model's
// own body by the motion formulas (motionGen/pathWalk.ts), or a clip of a
// clip file retargeted onto its bones (clipImport.ts). The editor and Play
// load the model's GLB with these clips added, made in memory when it
// loads (engine/sync.ts); the model asset and the source files stay as
// they are, and nothing is stored.

import { appendAnimations, retargetClips } from './clipImport';
import { walkClip, walkerOf, type Walker } from './motionGen/pathWalk';
import { parsePath } from './motionPath';
import { readGlbClips, type Clip } from './retarget';
import type { AssetMeta, ClipSourceDoc } from './types';

export interface ModelWithClips {
    /** The model's GLB with the clips added (a new array: the model's bytes are not changed); null when no source made a clip. */
    glb: Uint8Array | null;
    /** The names of the clips added, one for each source that made one, in the sources' order. */
    clips: string[];
    /** A line for each source that made no clip, saying why (a missing file, a bad path, a model without legs). */
    problems: string[];
    /** How each clip was made, for the log. */
    report: string[];
}

/** The asset ids the sources read. */
export function sourceAssetIds(sources: readonly ClipSourceDoc[]): string[] {
    return [...new Set(sources.flatMap((s) => (s.walk ? [s.walk] : s.clip ? [s.clip] : [])))];
}

/**
 * What the model with its sources' clips depends on: the model, each source and the files they name,
 * each file by its size and fingerprint (a file replaced under the same id makes another key). Empty
 * without sources.
 */
export function sourcesKey(modelAsset: string, sources: readonly ClipSourceDoc[] | undefined, assets: readonly AssetMeta[]): string {
    if (!sources?.length) return '';
    const version = (id: string | undefined) => {
        const a = id ? assets.find((x) => x.id === id) : undefined;
        return a ? `${a.id}:${a.size}:${a.hash ?? ''}` : id ? `${id}:missing` : '';
    };
    return JSON.stringify([version(modelAsset), sources.map((s) => [s.name, s.walk ? version(s.walk) : '', s.clip ? version(s.clip) : '', s.take ?? ''])]);
}

/**
 * The model in `modelGlb` with the clips its sources make: a walk along each path (a key every 1/`fps`
 * second), the clip of each clip file retargeted onto its bones. `files` holds the bytes of the assets the
 * sources name, by id. Each clip is named as its source, made unique against the model's own clips and
 * the ones before it. A source that cannot be made is left out and said in `problems`; throws only when
 * the model is not a GLB.
 */
export function modelWithSources(modelGlb: ArrayBuffer, sources: readonly ClipSourceDoc[], files: ReadonlyMap<string, ArrayBuffer>, fps = 60): ModelWithClips {
    const model = readGlbClips(modelGlb);
    if (!model) throw new Error('the model is not a GLB');
    const taken = new Set(model.clips.map((c) => c.name));
    const clips: Clip[] = [];
    const problems: string[] = [];
    const report: string[] = [];
    let walker: Walker | null = null;
    for (const source of sources) {
        const base = source.name.trim() || (source.walk ? 'Walk' : source.take || 'Clip');
        let name = base;
        for (let k = 2; taken.has(name); k++) name = `${base} (${k})`;
        try {
            let clip: Clip;
            if (source.walk) {
                const bytes = files.get(source.walk);
                if (!bytes) throw new Error('its path file is missing');
                const path = parsePath(new TextDecoder().decode(bytes));
                walker ??= walkerOf(modelGlb, model);
                const walk = walkClip(walker, path, name, fps);
                clip = walk.clip;
                report.push(`${name}: a walk of ${path.length.toFixed(1)} m in ${walk.seconds.toFixed(1)} s`);
            } else if (source.clip) {
                const bytes = files.get(source.clip);
                if (!bytes) throw new Error('its clip file is missing');
                const src = readGlbClips(bytes);
                if (!src?.clips.length) throw new Error('its clip file has no animation');
                const take = source.take ? src.clips.find((c) => c.name === source.take) : src.clips[0];
                if (!take) throw new Error(`its clip file has no clip "${source.take}" (it has ${src.clips.map((c) => `"${c.name}"`).join(', ')})`);
                const made = retargetClips(model, src, [take]);
                clip = made.clips[0];
                report.push(`${name}: "${take.name}" retargeted, ${made.report.join('; ')}`);
            } else continue;
            taken.add(name);
            clips.push({ ...clip, name });
        } catch (e: any) {
            problems.push(`${base}: ${e?.message || e}`);
        }
    }
    return { glb: clips.length ? appendAnimations(new Uint8Array(modelGlb), clips) : null, clips: clips.map((c) => c.name), problems, report };
}
