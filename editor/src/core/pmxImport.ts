// A PMX file dropped with its textures, made into a GLB (core/pmxToGlb.ts):
// the textures it names are found among the files by name (MMD writes
// paths relative to the model, often in subfolders), images that are not
// PNG or JPEG are drawn into PNGs, and the maps that go with a
// color texture named _D (its _N, _P and _E, a hair's _HN, and an _M in
// place of a missing _P when it is packed as a toon mask) are taken along.
// Eye maps that lost their alpha are reported (core/pmxMaps.ts). Clip
// GLBs dropped with it (a Biped body's motions) are retargeted onto its
// bones and go into the same GLB (core/retarget.ts).

import { fileByPath } from './modelPackage';
import { isPmx, parsePmx } from './pmx';
import { isOpaqueIris, isToonMask } from './pmxMaps';
import { isIrisMaterial, pmxSkeleton, pmxToGlb, type PmxImage, type PmxSlot } from './pmxToGlb';
import { humanoidPairs, mmdFromBiped, readGlbClips, retargetClip, retargetHumanoid, type Clip } from './retarget';

export interface ConvertedPmx {
    glb: Uint8Array;
    slots: PmxSlot[];
    report: string[];
    /** The model's name and its comment (where MMD models keep their credits and terms of use). */
    name: string;
    comment: string;
}

/** A GLB that holds clips and no mesh (a motion for a model, not a model). */
export async function isClipGlb(file: File): Promise<boolean> {
    if (!/\.glb$/i.test(file.name)) return false;
    try {
        const r = readGlbClips(await file.arrayBuffer());
        return !!r && r.meshes === 0 && r.clips.length > 0;
    } catch {
        return false;
    }
}

const baseName = (path: string) => path.split(/[\\/]/).pop()!.toLowerCase();

/**
 * The file among `files` a path of the model names, by its name. Of several files of that
 * name (folders of a package), the one in the folder the path gives.
 */
export function fileForPath(files: readonly File[], path: string): File | undefined {
    return fileByPath(files, path);
}

/** The map named <stem>_<suffix> that goes with a color texture: its extension first, else PNG or JPEG, any case. */
function companionFile(files: readonly File[], stem: string, ext: string, suffix: string): File | undefined {
    const exact = `${stem}_${suffix}${ext}`.toLowerCase();
    const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_${suffix}\\.(png|jpe?g)$`, 'i');
    return files.find((x) => x.name.toLowerCase() === exact) ?? files.find((x) => pattern.test(x.name));
}

async function asImage(file: File): Promise<PmxImage | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, mimeType: 'image/png' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, mimeType: 'image/jpeg' };
    // BMP, GIF, WebP and what else the browser decodes: drawn into a PNG.
    try {
        const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        bitmap.close();
        const png = await canvas.convertToBlob({ type: 'image/png' });
        return { bytes: new Uint8Array(await png.arrayBuffer()), mimeType: 'image/png' };
    } catch {
        return null;
    }
}

/** Converts a PMX file with the files dropped with it. */
export async function convertPmx(file: File, files: readonly File[], scale?: number): Promise<ConvertedPmx> {
    const buffer = await file.arrayBuffer();
    if (!isPmx(buffer)) throw new Error(`${file.name} is not a PMX file`);
    const pmx = parsePmx(buffer);
    const images = new Map<string, PmxImage | null>();
    const companions = new Map<string, PmxImage | null>();
    const undecodable: string[] = [];
    const mapNotes: string[] = [];
    for (const path of pmx.textures) {
        const f = fileForPath(files, path);
        const img = f ? await asImage(f) : null;
        if (f && !img) undecodable.push(f.name);
        images.set(path, img);
        // _D: look for the maps that go with it.
        const m = /^(.*)_D(\.[^.]+)$/i.exec(baseName(path));
        if (!m) continue;
        for (const suffix of ['N', 'P', 'E', 'HN'] as const) {
            const g = companionFile(files, m[1], m[2], suffix);
            companions.set(`${path}#${suffix}`, g ? await asImage(g) : null);
        }
        // No _P: some packages name the mask _M; taken when it is packed as one.
        if (!companions.get(`${path}#P`)) {
            const g = companionFile(files, m[1], m[2], 'M');
            const mask = g ? await asImage(g) : null;
            if (g && mask && (await isToonMask(mask.bytes))) {
                companions.set(`${path}#P`, mask);
                mapNotes.push(`${g.name} taken as the mask of ${f?.name ?? baseName(path)}`);
            }
        }
    }
    // Iris maps without alpha (MMD edits often drop it): Iris Alpha Tint would cover the whole iris.
    const opaqueIris = new Set<string>();
    for (const mat of pmx.materials) {
        const path = mat.texture >= 0 ? pmx.textures[mat.texture] : undefined;
        if (path === undefined || opaqueIris.has(path) || !isIrisMaterial(mat, path)) continue;
        const img = images.get(path);
        if (img && (await isOpaqueIris(img.bytes))) opaqueIris.add(path);
    }
    // Clips dropped with it, made for a Biped body (Bip001): moved onto the model's bones.
    const animations: Clip[] = [];
    const notes: string[] = [];
    const skeleton = pmxSkeleton(pmx, scale ?? 0.08);
    for (const f of files) {
        if (f === file || !(await isClipGlb(f))) continue;
        const src = readGlbClips(await f.arrayBuffer())!;
        // A Biped clip by the MMD table, any other humanoid (Mixamo, VRoid...) by its humanoid bones.
        // (retarget.ts; the converted model has no clips of its own to teach helpers.)
        const table = mmdFromBiped(skeleton, src.skeleton);
        const human = table.pairs.length < 6 ? humanoidPairs(skeleton, src.skeleton) : null;
        const map = human ?? table;
        if (map.pairs.length < 6) {
            notes.push(`${f.name}: no humanoid bones found in it, not retargeted`);
            continue;
        }
        for (const clip of src.clips) {
            animations.push(human ? retargetHumanoid({ skeleton, clips: [] }, src.skeleton, clip, human).clip : retargetClip(src.skeleton, clip, skeleton, table.pairs, { root: table.root, legs: table.legs }));
        }
        notes.push(`${f.name}: ${src.clips.length} clip(s) retargeted onto ${map.pairs.length} bones${map.unmatched.length ? ` (no match: ${map.unmatched.slice(0, 8).join(', ')}${map.unmatched.length > 8 ? '…' : ''})` : ''}`);
    }
    const out = pmxToGlb(pmx, {
        scale,
        image: (path) => images.get(path) ?? null,
        companion: (path, suffix) => companions.get(`${path}#${suffix}`) ?? null,
        opaqueIris: (path) => opaqueIris.has(path),
        animations,
    });
    if (undecodable.length) out.report.push(`images the browser cannot read (TGA, DDS): ${undecodable.join(', ')}`);
    out.report.push(...mapNotes);
    out.report.push(...notes);
    return { ...out, name: pmx.name || pmx.nameEn, comment: (pmx.comment ?? '').trim() };
}
