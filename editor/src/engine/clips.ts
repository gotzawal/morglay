// Makes the clips of a model's animation sources (core/clipSources.ts) in a
// worker (clips.worker.ts), so the page keeps drawing while a long walk is
// made. Where a worker cannot start or fails, the clips are made on this
// thread.

import { modelWithSources, type ModelWithClips } from '../core/clipSources';
import type { ClipSourceDoc } from '../core/types';
import type { ClipsIn, ClipsOut } from './clips.worker';

interface Job {
    input: ClipsIn;
    resolve: (r: ModelWithClips) => void;
    reject: (e: Error) => void;
}

let worker: Worker | null | undefined;
let next = 1;
const waiting = new Map<number, Job>();

const onPage = (input: ClipsIn) => modelWithSources(input.model, input.sources, new Map(input.files));

function start(): Worker | null {
    if (worker !== undefined) return worker;
    try {
        worker = typeof Worker === 'undefined' ? null : new Worker(new URL('./clips.worker.ts', import.meta.url), { type: 'module', name: 'morglay-clips' });
    } catch (e) {
        console.warn('[clips] no worker: clips are made on the page', e);
        worker = null;
    }
    worker?.addEventListener('message', (e: MessageEvent<ClipsOut>) => {
        const job = waiting.get(e.data.id);
        if (!job) return;
        waiting.delete(e.data.id);
        if ('error' in e.data) job.reject(new Error(e.data.error));
        else job.resolve(e.data);
    });
    // A worker that does not load: what waits on it, and what comes later, is made on the page.
    worker?.addEventListener('error', (e) => {
        console.warn('[clips] the worker failed: clips are made on the page', e.message);
        worker?.terminate();
        worker = null;
        const jobs = [...waiting.values()];
        waiting.clear();
        for (const job of jobs) {
            try {
                job.resolve(onPage(job.input));
            } catch (err: any) {
                job.reject(err instanceof Error ? err : new Error(String(err)));
            }
        }
    });
    return worker;
}

/** The model in `model` with the clips its sources make, whose files `files` holds by asset id (core/clipSources.ts modelWithSources). */
export function makeClips(model: ArrayBuffer, sources: ClipSourceDoc[], files: Map<string, ArrayBuffer>): Promise<ModelWithClips> {
    const input: ClipsIn = { id: next++, model, sources: sources.map((s) => ({ ...s })), files: [...files] };
    const w = start();
    if (!w) return Promise.resolve().then(() => onPage(input));
    return new Promise((resolve, reject) => {
        waiting.set(input.id, { input, resolve, reject });
        // Copied, not handed over: the page keeps them to make the clips itself if the worker fails.
        w.postMessage(input);
    });
}
