// Makes the clips of a model's animation sources off the main thread
// (engine/clips.ts sends the model's GLB, its sources and their files, and
// gets the GLB with the clips added back), so a long walk does not stall
// the editor or a game while it loads.

/// <reference lib="webworker" />
import { modelWithSources, type ModelWithClips } from '../core/clipSources';
import type { ClipSourceDoc } from '../core/types';

export interface ClipsIn {
    id: number;
    model: ArrayBuffer;
    sources: ClipSourceDoc[];
    files: [string, ArrayBuffer][];
}

export type ClipsOut = ({ id: number } & ModelWithClips) | { id: number; error: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<ClipsIn>) => {
    const { id, model, sources, files } = e.data;
    try {
        const made = modelWithSources(model, sources, new Map(files));
        self.postMessage({ id, ...made } satisfies ClipsOut, made.glb ? [made.glb.buffer] : []);
    } catch (err: any) {
        self.postMessage({ id, error: String(err?.message || err) } satisfies ClipsOut);
    }
};
