import { describe, expect, it } from 'vitest';
import { ANIME_MAP_BUDGET, ANIME_MAP_KEYS, ANIME_MAP_ROLES, animeFaceFront, animeFront, animeKindValue, animeMapsShown, animeRight, animeUp, compactAnime, guessAnimeKind, resolveAnime } from '../../src/core/anime';
import { Anime, Material } from '../../src/core/model';
import { ANIME_DEFINES, ANIME_MAPS, animeSources, shading } from '../../src/engine/animeMaterial';

describe('anime settings', () => {
    it('take what is set, then the kind, then the defaults', () => {
        const cloth = resolveAnime(null);
        expect(cloth.kind).toBe('cloth');
        expect(cloth.outline).toBe(0.45);
        const face = resolveAnime({ kind: 'face', outline: 3 });
        expect(face.outline).toBe(3);
        expect(face.shadeTint).toEqual(animeKindValue('face', 'shadeTint'));
        // Eyes take no cast shadows and have no outline.
        const eye = resolveAnime({ kind: 'eye' });
        expect(eye.shadows).toBeLessThan(cloth.shadows);
        expect(eye.outline).toBe(0);
        // A kind that is not one is cloth.
        expect(resolveAnime({ kind: 'metal' as any }).kind).toBe('cloth');
    });

    it('store only what differs from the kind', () => {
        const stored = compactAnime({ ...resolveAnime({ kind: 'skin' }), specular: 0.9 });
        expect(stored).toEqual({ kind: 'skin', specular: 0.9 });
        // Changing the kind of what was stored brings the new kind's values.
        expect(resolveAnime({ ...stored, kind: 'hair' }).hair).toBe(animeKindValue('hair', 'hair'));
    });

    it('start without maps, in the glTF layouts, with the scene\'s tone mapping', () => {
        const a = resolveAnime({ kind: 'cloth' });
        expect([a.normalLayout, a.maskLayout, a.outlineNormals, a.edge, a.toneCurve, a.highlight]).toEqual(['rgb', 'orm', 'mesh', 0, false, 'ggx']);
        for (const key of ANIME_MAP_KEYS) expect(a[key] ?? null).toBeNull();
    });

    it('parse with the layouts of other conventions', () => {
        const doc = Anime.parse({ kind: 'hair', normalLayout: 'split', maskLayout: 'toon', outlineNormals: 'tangent', hairStrand: 0.5, hairRepeat: [6, 1] });
        expect(doc).toMatchObject({ kind: 'hair', normalLayout: 'split', maskLayout: 'toon', outlineNormals: 'tangent', hairStrand: 0.5, hairRepeat: [6, 1] });
        // A value outside a layout's choices is dropped with the rest kept (the kind's value shows).
        const mended = Material.parse({ type: 'anime', color: '#ffffff', anime: { kind: 'cloth', normalLayout: 'bc5', edge: 0.3 } });
        expect(resolveAnime(mended.anime).normalLayout).toBe('rgb');
    });

    it('give the head\'s axes of a Y-up and of a Z-up mesh', () => {
        expect(animeUp('+y')).toEqual([0, 1, 0]);
        expect(animeUp('+z')).toEqual([0, 0, 1]);
        expect(animeFront('+z')).toEqual([0, 0, 1]);
        expect(animeFront('-y', '+z')).toEqual([0, -1, 0]);
        // A front along the up axis is none: what such meshes face instead.
        expect(animeFront('+y', '+y')).toEqual([0, 0, 1]);
        expect(animeFront('+z', '+z')).toEqual([0, -1, 0]);
        expect(resolveAnime({ kind: 'face' }).up).toBe('+y');
        // The head's right is up × front, in either convention.
        expect(animeRight('+z', '+y')).toEqual([1, 0, 0]);
        expect(animeRight('-y', '+z')).toEqual([1, 0, 0]);
    });

    it('lean the face\'s front down by its tilt', () => {
        const f = animeFaceFront('-y', '+z', 20);
        expect(f[0]).toBeCloseTo(0, 6);
        expect(f[1]).toBeCloseTo(-Math.cos((20 * Math.PI) / 180), 6);
        expect(f[2]).toBeCloseTo(-Math.sin((20 * Math.PI) / 180), 6);
        expect(animeFaceFront('+z', '+y', 0)).toEqual([0, 0, 1]);
        const g = animeFaceFront('+z', '+y', 30);
        expect(Math.hypot(...g)).toBeCloseTo(1, 9);
        expect(g[1]).toBeCloseTo(-0.5, 9);
    });

    it('guess a kind from the names model files use', () => {
        expect(guessAnimeKind('iris_left')).toBe('eye');
        expect(guessAnimeKind('brow_R')).toBe('face');
        expect(guessAnimeKind('face')).toBe('face');
        expect(guessAnimeKind('hair_back')).toBe('hair');
        expect(guessAnimeKind('body')).toBe('skin');
        expect(guessAnimeKind('cloth_coat')).toBe('cloth');
        expect(guessAnimeKind('Footwear')).toBe('cloth');
        // CJK names: the body and face characters alone, and clothes whose names hold them.
        expect([guessAnimeKind('目'), guessAnimeKind('口'), guessAnimeKind('手'), guessAnimeKind('髪')]).toEqual(['eye', 'face', 'skin', 'hair']);
        for (const name of ['縫い目', '袖口', '手袋', '足袋', '体操服', '仮面', '髪飾り']) expect(guessAnimeKind(name), name).toBe('cloth');
    });
});

describe('anime maps', () => {
    const all = Object.fromEntries(ANIME_MAP_KEYS.map((k) => [k, `asset_${k}`]));

    it('have a role and a shader slot each', () => {
        expect(ANIME_MAPS.map((m) => m.key).sort()).toEqual([...ANIME_MAP_KEYS].sort());
        for (const m of ANIME_MAPS) {
            expect(m.role).toBe(ANIME_MAP_ROLES[m.key]);
            expect(ANIME_DEFINES).toContain(m.define);
        }
        expect(new Set(ANIME_MAPS.map((m) => m.slot)).size).toBe(ANIME_MAPS.length);
    });

    it('stay within what one pass can sample, the least needed left out', () => {
        const shown = animeMapsShown(all);
        const surface = [...shown].filter((k) => k !== 'outlineMap');
        expect(surface).toHaveLength(ANIME_MAP_BUDGET);
        // The outline pass has room of its own.
        expect(shown.has('outlineMap')).toBe(true);
        expect(shown.has('rampMap')).toBe(true);
        expect(shown.has('matcapMap')).toBe(false);
        // Fewer than the budget: all of them.
        expect([...animeMapsShown({ rampMap: 'a', matcapMap: 'b' })].sort()).toEqual(['matcapMap', 'rampMap']);
        expect(animeMapsShown(null).size).toBe(0);
    });
});

describe('anime shader sources', () => {
    const { surface, outline } = animeSources();

    it("are the editor's own cel shading when no local shading pack is given", () => {
        expect(shading.name).toBe('Morglay cel shading');
        // The model's own maps keep the editor's define names (engine/materials.ts ANIME_PBR_MAPS).
        for (const d of ['ANIME_NORMALMAP', 'ANIME_MASKMAP']) expect(ANIME_DEFINES).toContain(d);
    });
    /** Lines of the source outside every #if block. */
    const unconditional = (src: string) => {
        const out: string[] = [];
        let depth = 0;
        for (const line of src.split('\n')) {
            const t = line.trim();
            if (t.startsWith('#if')) depth++;
            else if (t.startsWith('#endif')) depth--;
            else if (depth === 0) out.push(t);
        }
        expect(depth).toBe(0);
        return out;
    };

    it('declare a map only while the material shows it', () => {
        const always = unconditional(surface).filter((l) => /^@group\(1\) @binding\(auto\) var \w+: texture_2d<f32>;$/.test(l));
        // Only the base color: the model's normal, mask and emission maps are declared while it has them.
        expect(always).toHaveLength(1);
        for (const m of ANIME_MAPS) {
            const src = m.key === 'outlineMap' ? outline : surface;
            expect(src).toContain(`#if ${m.define}\n@group(1) @binding(auto) var ${m.slot}: texture_2d<f32>;\n#endif`);
        }
    });

    it('use no define the material does not set', () => {
        const engine = /^(USE_|ANIME_EMISSIVE_ENCODED$)/;
        for (const src of [surface, outline]) {
            const used = new Set<string>();
            for (const line of src.split('\n')) {
                const t = line.trim();
                if (!t.startsWith('#if')) continue;
                for (const name of t.slice(3).match(/[A-Z][A-Z0-9_]+/g) ?? []) used.add(name);
            }
            for (const name of used) if (!engine.test(name)) expect(ANIME_DEFINES).toContain(name);
        }
    });

    it('read the model\'s outline normals in the hull only', () => {
        expect(outline).toContain('inputData.outlineNormal');
        expect(surface).not.toContain('outlineNormal');
    });
});
