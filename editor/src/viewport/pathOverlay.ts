// The paths the models of the scene walk (their animation's walk sources,
// core/clipSources.ts), drawn on the floor under them as thin orange
// ribbons: a view aid of the editor, made from the path assets, never part
// of the scene or a game, and hidden while playing.

import { Color, GeometryBase, MeshRenderer, Object3D, UnLitMaterial, VertexAttributeName } from '@orillusion/core';
import { getAssetBlob } from '../core/assets';
import { parsePath } from '../core/motionPath';
import { pathRibbon } from '../core/motionGen/pathWalk';
import type { Store } from '../core/store';
import type { Runtime } from '../engine/runtime';
import type { SceneSync } from '../engine/sync';

interface Drawn {
    /** What it was drawn from: the path assets and their versions. */
    key: string;
    /** The object of the node it is drawn under. */
    under: Object3D;
    obj: Object3D;
}

export class PathOverlay {
    private drawn = new Map<string, Drawn>();
    private timer = 0;
    private version = 0;

    constructor(private runtime: Runtime, private store: Store, private sync: SceneSync) {
        const later = () => {
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => void this.update(), 100);
        };
        store.on('change', (hint) => !hint?.transform && later());
        store.on('load', later);
        store.on('playing', later);
        // A node's object made again (a model reloaded, Play stopped) takes the ribbon under it along.
        sync.on('model', later);
        later();
    }

    private async update() {
        const version = ++this.version;
        const doc = this.store.doc;
        const want = new Map<string, { key: string; walks: string[] }>();
        if (!this.store.playing) {
            for (const n of doc.nodes) {
                const walks = [...new Set((n.animation?.sources ?? []).map((s) => s.walk).filter((x): x is string => !!x))];
                if (!n.model || !walks.length) continue;
                const key = walks.map((id) => {
                    const a = doc.assets.find((x) => x.id === id);
                    return a ? `${a.id}:${a.size}:${a.hash ?? ''}` : '';
                }).join('|');
                want.set(n.id, { key, walks });
            }
        }
        for (const [id, d] of Array.from(this.drawn)) {
            const entry = this.sync.entries.get(id);
            const w = want.get(id);
            if (w && entry && d.key === w.key && d.under === entry.obj && d.obj.transform.parent) {
                this.show(d, entry.visible);
                continue;
            }
            this.drop(id, d);
        }
        for (const [id, w] of want) {
            if (this.drawn.has(id)) continue;
            const obj = new Object3D();
            obj.name = 'Walk Path';
            for (const walk of w.walks) {
                const blob = await getAssetBlob(walk);
                if (version !== this.version) {
                    obj.destroy();
                    return;
                }
                try {
                    if (blob) this.ribbon(obj, parsePath(await blob.text()));
                } catch (e) {
                    console.warn('[editor] the path could not be drawn', e);
                }
            }
            const entry = this.sync.entries.get(id);
            if (version !== this.version || !entry) {
                obj.destroy();
                if (version !== this.version) return;
                continue;
            }
            entry.obj.addChild(obj);
            const d: Drawn = { key: w.key, under: entry.obj, obj };
            this.drawn.set(id, d);
            this.show(d, entry.visible);
        }
    }

    private ribbon(parent: Object3D, path: ReturnType<typeof parsePath>) {
        const { positions, indices } = pathRibbon(path, 0.04, 0.006);
        const normals = new Float32Array(positions.length);
        for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
        const uv = new Float32Array((positions.length / 3) * 2);
        const geo = new GeometryBase();
        geo.setIndices(positions.length / 3 > 65535 ? indices : new Uint16Array(indices));
        geo.setAttribute(VertexAttributeName.position, positions);
        geo.setAttribute(VertexAttributeName.normal, normals);
        geo.setAttribute(VertexAttributeName.uv, uv);
        geo.setAttribute(VertexAttributeName.TEXCOORD_1, uv);
        geo.addSubGeometry({ indexStart: 0, indexCount: indices.length, vertexStart: 0, vertexCount: 0, firstStart: 0, index: 0, topology: 0 });
        const mat = new UnLitMaterial(this.runtime.engine.context3D);
        mat.baseColor = new Color(1, 0.45, 0.1, 1);
        mat.doubleSide = true;
        const obj = new Object3D();
        const mr = obj.addComponent(MeshRenderer);
        mr.geometry = geo;
        mr.material = mat;
        mr.castShadow = false;
        mr.receiveShadow = false;
        mr.castGI = false;
        parent.addChild(obj);
    }

    private show(d: Drawn, visible: boolean) {
        d.obj.traverse((o: Object3D) => {
            const mr = o.getComponent(MeshRenderer);
            if (mr) mr.enable = visible;
        });
    }

    private drop(id: string, d: Drawn) {
        this.drawn.delete(id);
        // An object destroyed with the node's is gone already.
        if (!d.obj.transform.parent) return;
        d.obj.removeFromParent();
        d.obj.destroy();
    }
}
