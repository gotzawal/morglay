// VRM 1.0 (VRMC_vrm, VRMC_springBone, VRMC_materials_mtoon) and the character format
// v1 (editor/CHARACTERS.md, section 4):
// - reading a VRM as the format's character data (license, humanoid bones,
//   expressions, look-at, springs, toon materials),
// - writing the format's data as VRM beside it, so VRM viewers and ours read one file.
// The license data, bones and expressions are the same model on both sides. The
// toon material and the springs are converted approximately: MToon has no face
// shadow map, hair highlights or eye effects, and VRM's springs are set by forces,
// ours by how the swing looks.

import { CEL_SHADING, guessAnimeKind, resolveAnime } from './anime';
import { EXPRESSION_PRESETS, MGL_CHARACTER, MGL_SPEC_VERSION, MGL_SPRINGS, MGL_TOON, parentsOf, restMatrices, type MglCharacter, type MglExpression, type MglMeta, type MglSprings, type TextureInfo } from './mgl';
import { materialOfJson, type AnimeWith, type MglMaterialExt } from './mglMaterial';

export const VRMC_VRM = 'VRMC_vrm';
export const VRMC_SPRING = 'VRMC_springBone';
export const VRMC_MTOON = 'VRMC_materials_mtoon';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const v3 = (v: unknown, d: [number, number, number]): [number, number, number] => (Array.isArray(v) && v.length >= 3 ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : d);

// ---------------------------------------------------------------- springs: VRM's forces and our swing

/** A VRM joint's stiffness as our period (seconds of one swing), and back: stiffer swings faster. */
export const periodOfStiffness = (s: number) => clamp(1 / (0.6 + 0.8 * Math.max(0, s)), 0.05, 5);
export const stiffnessOfPeriod = (t: number) => Math.max(0, (1 / Math.max(t, 0.05) - 0.6) / 0.8);
/** VRM's drag force (0..1) as our damping ratio, and back. */
export const dampingOfDrag = (d: number) => clamp(0.25 + 0.5 * d, 0, 1);
export const dragOfDamping = (d: number) => clamp((d - 0.25) / 0.5, 0, 1);
/** VRM's gravity power as our sag, and back. */
export const gravityOfPower = (g: number) => clamp(g * 0.2, 0, 2);
export const powerOfGravity = (g: number) => Math.max(0, g / 0.2);

// ---------------------------------------------------------------- reading a VRM

export interface FromVrm {
    character: MglCharacter;
    springs: MglSprings | null;
    /** The format's materials by material index (textures as the file names them). */
    materials: Map<number, MglMaterialExt<TextureInfo>>;
    notes: string[];
}

export const isVrm = (json: any) => !!json?.extensions?.[VRMC_VRM];

const META_DEFAULTS: Pick<MglMeta, 'avatarPermission' | 'commercialUsage' | 'creditNotation' | 'modification'> = {
    avatarPermission: 'onlyAuthor',
    commercialUsage: 'personalNonProfit',
    creditNotation: 'required',
    modification: 'prohibited',
};

/** The format's character data of a VRM 1.0 file; null when it is not one (VRM 0.x is not read). */
export function vrmToMgl(json: any): FromVrm | null {
    const vrm = json?.extensions?.[VRMC_VRM];
    if (!vrm) return null;
    const notes: string[] = [];
    if (!/^1\./.test(String(vrm.specVersion ?? ''))) notes.push(`VRMC_vrm ${vrm.specVersion ?? '(no version)'}: read as 1.0`);

    // ---- license data: the same fields; ours come back from extras
    const m = vrm.meta ?? {};
    const ours = m.extras?.MGL ?? {};
    const meta: MglMeta = {
        name: String(m.name ?? ''),
        ...(m.version ? { version: String(m.version) } : {}),
        authors: Array.isArray(m.authors) ? m.authors.map(String) : [],
        ...(m.copyrightInformation ? { copyrightInformation: String(m.copyrightInformation) } : {}),
        ...(m.contactInformation ? { contactInformation: String(m.contactInformation) } : {}),
        ...(Array.isArray(m.references) ? { references: m.references.map(String) } : {}),
        ...(Number.isInteger(m.thumbnailImage) ? { thumbnailImage: m.thumbnailImage } : {}),
        licenseUrl: String(m.licenseUrl ?? ''),
        avatarPermission: m.avatarPermission ?? META_DEFAULTS.avatarPermission,
        commercialUsage: m.commercialUsage ?? META_DEFAULTS.commercialUsage,
        allowExcessivelyViolentUsage: !!m.allowExcessivelyViolentUsage,
        allowExcessivelySexualUsage: !!m.allowExcessivelySexualUsage,
        allowPoliticalOrReligiousUsage: !!m.allowPoliticalOrReligiousUsage,
        allowAntisocialOrHateUsage: !!m.allowAntisocialOrHateUsage,
        creditNotation: m.creditNotation ?? META_DEFAULTS.creditNotation,
        allowRedistribution: !!m.allowRedistribution,
        modification: m.modification ?? META_DEFAULTS.modification,
        ...(m.otherLicenseUrl ? { otherLicenseUrl: String(m.otherLicenseUrl) } : {}),
        ...(ours.derivative ? { derivative: ours.derivative } : {}),
        ...(typeof ours.partExtraction === 'boolean' ? { partExtraction: ours.partExtraction } : {}),
        ...(ours.sourceTerms ? { sourceTerms: String(ours.sourceTerms) } : {}),
    };

    // ---- bones, expressions, look-at
    const bones: Record<string, { node: number }> = {};
    for (const [role, b] of Object.entries<any>(vrm.humanoid?.humanBones ?? {})) if (Number.isInteger(b?.node)) bones[role] = { node: b.node };
    const copyExpr = (list: Record<string, any> | undefined) => {
        const out: Record<string, MglExpression> = {};
        for (const [name, e] of Object.entries(list ?? {})) {
            if (!e || typeof e !== 'object') continue;
            const { morphTargetBinds, materialColorBinds, textureTransformBinds, isBinary, overrideBlink, overrideLookAt, overrideMouth } = e;
            out[name] = JSON.parse(JSON.stringify({ morphTargetBinds, materialColorBinds, textureTransformBinds, isBinary, overrideBlink, overrideLookAt, overrideMouth }));
        }
        return out;
    };
    const preset = copyExpr(vrm.expressions?.preset);
    for (const name of Object.keys(preset)) if (!(EXPRESSION_PRESETS as readonly string[]).includes(name)) delete preset[name];
    const custom = copyExpr(vrm.expressions?.custom);
    const expressions: MglCharacter['expressions'] =
        Object.keys(preset).length || Object.keys(custom).length
            ? { ...(Object.keys(preset).length ? { preset } : {}), ...(Object.keys(custom).length ? { custom } : {}), ...(preset.blink ? { blink: { expression: 'blink' } } : {}) }
            : undefined;
    const la = vrm.lookAt;
    const lookAt: MglCharacter['lookAt'] = la
        ? {
              type: la.type === 'expression' ? 'expression' : 'bone',
              ...(Array.isArray(la.offsetFromHeadBone) ? { offsetFromHeadBone: v3(la.offsetFromHeadBone, [0, 0.06, 0]) } : {}),
              yaw: { inner: num(la.rangeMapHorizontalInner?.outputScale, 10), outer: num(la.rangeMapHorizontalOuter?.outputScale, 10) },
              pitch: { up: num(la.rangeMapVerticalUp?.outputScale, 10), down: num(la.rangeMapVerticalDown?.outputScale, 10) },
          }
        : undefined;
    const character: MglCharacter = {
        specVersion: MGL_SPEC_VERSION,
        meta,
        humanoid: { bones },
        ...(expressions ? { expressions } : {}),
        ...(lookAt ? { lookAt } : {}),
    };

    // ---- springs: each VRM spring's top joints start chains with its first joint's forces
    const sb = json.extensions?.[VRMC_SPRING];
    let springs: MglSprings | null = null;
    if (sb) {
        const colliders: NonNullable<MglSprings['colliders']> = [];
        (sb.colliders ?? []).forEach((c: any, i: number) => {
            if (!Number.isInteger(c?.node)) return;
            const sphere = c.shape?.sphere;
            const capsule = c.shape?.capsule;
            const s = capsule ?? sphere;
            if (!s) return;
            colliders.push({ name: `collider_${i}`, node: c.node, shape: capsule ? 'capsule' : 'sphere', offset: v3(s.offset, [0, 0, 0]), ...(capsule ? { tail: v3(capsule.tail, [0, 0, 0]) } : {}), radius: num(s.radius, 0) });
        });
        const named = new Set(colliders.map((c) => c.name));
        const groupNames = (sb.colliderGroups ?? []).map((g: any) => (g?.colliders ?? []).map((i: number) => `collider_${i}`).filter((n: string) => named.has(n)));
        const parent = parentsOf(json);
        const chains: MglSprings['chains'] = [];
        for (const [si, s] of (sb.springs ?? []).entries()) {
            const joints: any[] = (s?.joints ?? []).filter((j: any) => Number.isInteger(j?.node));
            const nodes = new Set(joints.map((j) => j.node));
            const hit = [...new Set((s.colliderGroups ?? []).flatMap((g: number) => groupNames[g] ?? []))] as string[];
            for (const j of joints) {
                if (nodes.has(parent[j.node])) continue;
                chains.push({
                    name: s.name ? String(s.name) : `spring_${si}`,
                    root: j.node,
                    period: periodOfStiffness(num(j.stiffness, 1)),
                    damping: dampingOfDrag(num(j.dragForce, 0.5)),
                    gravity: gravityOfPower(num(j.gravityPower, 0)),
                    drag: 0.3,
                    maxAngle: 90,
                    radius: num(j.hitRadius, 0.01),
                    ...(hit.length ? { colliders: hit } : {}),
                });
            }
        }
        if (chains.length || colliders.length) springs = { chains, ...(colliders.length ? { colliders } : {}) };
        notes.push(`${chains.length} spring chain(s): VRM's stiffness, drag and gravity turned into swing period, damping and sag (approximate)`);
    }

    // ---- materials: MToon as the format's material (approximate: its shade is a color, ours is made from the base color)
    const materials = new Map<number, MglMaterialExt<TextureInfo>>();
    const skipped = new Set<string>();
    (json.materials ?? []).forEach((mat: any, i: number) => {
        const mt = mat?.extensions?.[VRMC_MTOON];
        if (!mt) return;
        const kind = guessAnimeKind(mat.name ?? '');
        const tex = (t: any): TextureInfo | null => (Number.isInteger(t?.index) ? { index: t.index, ...(t.texCoord ? { texCoord: t.texCoord } : {}) } : null);
        // MToon's shade is shadeColorFactor times its shade texture, without the base color factor;
        // the format makes its shade from the base color, factor and all. Where the shade texture is
        // the base color's (or there is none), the factor comes out of the shade here.
        const baseFactor = v3(mat.pbrMetallicRoughness?.baseColorFactor, [1, 1, 1]);
        const shadeOnBase = !tex(mt.shadeMultiplyTexture) || mt.shadeMultiplyTexture.index === mat.pbrMetallicRoughness?.baseColorTexture?.index;
        const shade = v3(mt.shadeColorFactor, [1, 1, 1]).map((c, j) => (shadeOnBase ? c / Math.max(baseFactor[j], 1e-3) : c));
        const y = Math.max(luminance(shade), 1e-3);
        const outlineMode = mt.outlineWidthMode ?? 'none';
        const anime: AnimeWith<TextureInfo> = {
            kind,
            // The shade: the base color at the shade color's brightness, and Shade Light Tint in the
            // shade color's hue (the shade takes half of the tint).
            shadeSaturation: 1,
            shadeBrightness: clamp(y / (shadeDepth(kind) * DARKNESS), 0, 2),
            shadeTint: shade.map((c) => Math.max(2 * (c / y) - 1, 0)) as [number, number, number],
            step: clamp(0.5 - num(mt.shadingShiftFactor, 0) * 0.5, 0, 1),
            feather: clamp((1 - clamp(num(mt.shadingToonyFactor, 0.9), 0, 1)) * 0.5, 0, 0.5),
            highlight: 'none',
            edge: 0,
            saturateLit: false,
            toneCurve: false,
            outline: outlineMode === 'none' ? 0 : clamp(num(mt.outlineWidthFactor, 0) * (outlineMode === 'screenCoordinates' ? OUTLINE_PER_SCREEN : OUTLINE_PER_METER), 0, 5),
            // MToon's line is its outline color (lit: times the lit surface, base color and all); the
            // format's is the base color at lineShare of Outline Brightness. Its hue is not kept.
            outlineBrightness: clamp(luminance(v3(mt.outlineColorFactor, [0, 0, 0])) / CEL_SHADING.lineShare, 0, 2),
            outlineSaturation: 1,
            outlineLit: num(mt.outlineLightingMixFactor, 1) > 0.5,
            ...(kind === 'eye' && tex(mt.matcapTexture) ? { matcapMap: tex(mt.matcapTexture), matcap: Math.max(...v3(mt.matcapFactor, [1, 1, 1])), matcapColor: [0, 0, 0] as [number, number, number] } : {}),
            // MToon has no hair highlights.
            ...(kind === 'hair' ? { hair: 0 } : {}),
        };
        if (!shadeOnBase) skipped.add('shadeMultiplyTexture (a texture of its own; the format shades the base color)');
        for (const k of ['shadingShiftTexture', 'rimMultiplyTexture', 'outlineWidthMultiplyTexture', 'uvAnimationMaskTexture']) if (mt[k]) skipped.add(k);
        if (luminance(v3(mt.parametricRimColorFactor, [0, 0, 0])) > 0) skipped.add('parametricRim (the rim comes from the scene\'s character lights)');
        if (kind !== 'eye' && mt.matcapTexture) skipped.add('matcapTexture (matcaps are for eyes)');
        materials.set(i, { anime, draw: { layer: mat.alphaMode === 'BLEND' ? 'transparent' : 'body' } });
    });
    if (skipped.size) notes.push(`MToon parts the format's material does not take, left out: ${[...skipped].join(', ')}`);
    if (materials.size) notes.push(`${materials.size} MToon material(s) as the format's material (approximate; kinds guessed from their names: check them)`);
    return { character, springs, materials, notes };
}

/** The shade darkness the format's material starts from (core/model.ts Anime). */
const DARKNESS = resolveAnime(null).shadeDarkness;
/** How much deeper the cel shading draws the form shadow than its shade settings give, cloth's a tenth lighter. */
const shadeDepth = (kind: string) => CEL_SHADING.formShade * (kind === 'cloth' ? CEL_SHADING.clothShade : 1);
/**
 * Outline widths, made to agree at one view: a 1.6 m character seen whole through a 20° field of
 * view, from 4.54 m. The format's width w draws w × lineWidth × d^(1 − lineThinning) meters wide at
 * a distance d (it thins slower than perspective), which is VRM's worldCoordinates (meters): about
 * 548 per meter. On the screen that is w × lineWidth × P11 / d^lineThinning in clip space, which
 * spans 2 over the screen's height; VRM's screenCoordinates is a share of that height (as UniVRM
 * draws it; three-vrm draws it half as wide): about 877 per share.
 */
const FIT_HALF_FOV = (10 * Math.PI) / 180;
const FIT_DISTANCE = 0.8 / Math.tan(FIT_HALF_FOV);
const OUTLINE_PER_METER = 1 / (CEL_SHADING.lineWidth * FIT_DISTANCE ** (1 - CEL_SHADING.lineThinning));
const OUTLINE_PER_SCREEN = (2 * Math.tan(FIT_HALF_FOV) * FIT_DISTANCE ** CEL_SHADING.lineThinning) / CEL_SHADING.lineWidth;
const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------- writing VRM beside the format

/** Linear chains of a chain's nodes (VRM springs are lists of joints): down the first child, other children start their own. */
function jointPaths(root: number, children: Map<number, number[]>): number[][] {
    const paths: number[][] = [];
    const walk = (start: number) => {
        const path = [start];
        let at = start;
        for (;;) {
            const kids = children.get(at) ?? [];
            if (!kids.length) break;
            for (const k of kids.slice(1)) walk(k);
            at = kids[0];
            path.push(at);
        }
        paths.push(path);
    };
    walk(root);
    return paths;
}

/**
 * Adds VRM 1.0 to a character file's JSON (one with MGL_character): the same
 * license data, bones, expressions and look-at, springs as VRM springs, and
 * an MToon material beside every toon material. Returns what was approximate
 * or left out.
 */
export function mglToVrm(json: any): string[] {
    const notes: string[] = [];
    const ch: MglCharacter | undefined = json.extensions?.[MGL_CHARACTER];
    if (!ch) throw new Error('not a character file');
    const m = ch.meta;
    const extras: Record<string, unknown> = {};
    if (m.derivative) extras.derivative = m.derivative;
    if (m.partExtraction !== undefined) extras.partExtraction = m.partExtraction;
    if (m.sourceTerms) extras.sourceTerms = m.sourceTerms;
    const meta: Record<string, unknown> = {
        name: m.name,
        ...(m.version ? { version: m.version } : {}),
        authors: m.authors,
        ...(m.copyrightInformation ? { copyrightInformation: m.copyrightInformation } : {}),
        ...(m.contactInformation ? { contactInformation: m.contactInformation } : {}),
        ...(m.references ? { references: m.references } : {}),
        ...(m.thumbnailImage !== undefined ? { thumbnailImage: m.thumbnailImage } : {}),
        licenseUrl: m.licenseUrl,
        avatarPermission: m.avatarPermission,
        allowExcessivelyViolentUsage: m.allowExcessivelyViolentUsage,
        allowExcessivelySexualUsage: m.allowExcessivelySexualUsage,
        commercialUsage: m.commercialUsage,
        allowPoliticalOrReligiousUsage: m.allowPoliticalOrReligiousUsage,
        allowAntisocialOrHateUsage: m.allowAntisocialOrHateUsage,
        creditNotation: m.creditNotation,
        allowRedistribution: m.allowRedistribution,
        modification: m.modification,
        ...(m.otherLicenseUrl ? { otherLicenseUrl: m.otherLicenseUrl } : {}),
        ...(Object.keys(extras).length ? { extras: { MGL: extras } } : {}),
    };
    // ---- expressions without what VRM does not have
    let dropped = 0;
    const strip = (list: Record<string, MglExpression> | undefined) => {
        if (!list) return undefined;
        const out: Record<string, unknown> = {};
        for (const [name, e] of Object.entries(list)) {
            if (!e) continue;
            const { boneBinds, layerBinds, ...rest } = e;
            dropped += (boneBinds?.length ?? 0) + (layerBinds?.length ?? 0);
            out[name] = rest;
        }
        return out;
    };
    const preset = strip(ch.expressions?.preset as Record<string, MglExpression> | undefined);
    const custom = strip(ch.expressions?.custom);
    if (dropped) notes.push(`${dropped} bone and layer binds of expressions are not in VRM (left in MGL_character only)`);
    const la = ch.lookAt;
    const range = (v: number) => ({ inputMaxValue: 90, outputScale: v });
    json.extensions[VRMC_VRM] = {
        specVersion: '1.0',
        meta,
        humanoid: { humanBones: ch.humanoid.bones },
        ...(preset || custom ? { expressions: { ...(preset ? { preset } : {}), ...(custom ? { custom } : {}) } } : {}),
        ...(la
            ? {
                  lookAt: {
                      type: la.type,
                      ...(la.offsetFromHeadBone ? { offsetFromHeadBone: la.offsetFromHeadBone } : {}),
                      rangeMapHorizontalInner: range(la.yaw?.inner ?? 10),
                      rangeMapHorizontalOuter: range(la.yaw?.outer ?? 10),
                      rangeMapVerticalDown: range(la.pitch?.down ?? 10),
                      rangeMapVerticalUp: range(la.pitch?.up ?? 10),
                  },
              }
            : {}),
    };
    if (!m.authors?.length || !m.licenseUrl) notes.push('VRM needs authors and a license URL in the license data');

    // ---- springs
    const s: MglSprings | undefined = json.extensions?.[MGL_SPRINGS];
    const used = new Set<string>(json.extensionsUsed ?? []);
    if (s?.chains?.length) {
        const parent = parentsOf(json);
        const children = new Map<number, number[]>();
        parent.forEach((p, i) => p >= 0 && (children.get(p) ?? children.set(p, []).get(p)!).push(i));
        const colliders = (s.colliders ?? []).map((c) => ({
            node: c.node,
            shape: c.shape === 'capsule' ? { capsule: { offset: c.offset ?? [0, 0, 0], radius: c.radius, tail: c.tail ?? [0, 0, 0] } } : { sphere: { offset: c.offset ?? [0, 0, 0], radius: c.radius } },
        }));
        const colliderIndex = new Map((s.colliders ?? []).map((c, i) => [c.name, i]));
        const groups: { name: string; colliders: number[] }[] = [];
        const groupOf = new Map<string, number>();
        const springs: unknown[] = [];
        for (const c of s.chains) {
            const list = (c.colliders ?? []).map((n) => colliderIndex.get(n)).filter((i): i is number => i !== undefined);
            const key = list.join(',');
            let g = groupOf.get(key);
            if (list.length && g === undefined) groupOf.set(key, (g = groups.push({ name: (c.colliders ?? []).join('+'), colliders: list }) - 1));
            for (const path of jointPaths(c.root, children)) {
                springs.push({
                    name: c.name ?? `chain_${c.root}`,
                    joints: path.map((node) => ({ node, hitRadius: c.radius, stiffness: stiffnessOfPeriod(c.period), gravityPower: powerOfGravity(c.gravity), gravityDir: [0, -1, 0], dragForce: dragOfDamping(c.damping) })),
                    ...(g !== undefined ? { colliderGroups: [g] } : {}),
                });
            }
        }
        json.extensions[VRMC_SPRING] = { specVersion: '1.0', ...(colliders.length ? { colliders } : {}), ...(groups.length ? { colliderGroups: groups } : {}), springs };
        used.add(VRMC_SPRING);
        notes.push(`${springs.length} VRM spring(s) from ${s.chains.length} chain(s): period, damping and sag as stiffness, drag and gravity (approximate); VRM has no turn limit`);
    }

    // ---- materials: MToon beside each of the format's materials (approximate)
    let mtoons = 0;
    const layered = new Set<string>();
    for (const mat of json.materials ?? []) {
        const ext = mat?.extensions?.[MGL_TOON];
        if (!ext) continue;
        const { anime, draw } = materialOfJson<TextureInfo>(ext);
        const t = resolveAnime(anime as any);
        const base = mat.pbrMetallicRoughness ?? {};
        const baseFactor = ((base.baseColorFactor ?? [1, 1, 1]) as number[]).slice(0, 3);
        // The shade: the base color times the shade's brightness and half of Shade Light Tint, as the
        // shading draws it. MToon multiplies its shade by the shade texture alone, so the base color's
        // factor goes into the shade color here; Shade Saturation has no place in it.
        const k = t.shadeBrightness * shadeDepth(t.kind) * t.shadeDarkness;
        const outlined = t.outline > 0 && t.kind !== 'eye' && t.kind !== 'overlay';
        const matcap = t.kind === 'eye' && anime.matcapMap ? (anime.matcapMap as TextureInfo) : null;
        mat.extensions[VRMC_MTOON] = {
            specVersion: '1.0',
            transparentWithZWrite: draw.layer === 'hairOver',
            renderQueueOffsetNumber: 0,
            shadeColorFactor: t.shadeTint.map((c, j) => clamp(k * (0.5 + 0.5 * c) * baseFactor[j], 0, 1)),
            ...(base.baseColorTexture ? { shadeMultiplyTexture: { index: base.baseColorTexture.index } } : {}),
            // MToon's edge lies where N·L = −shift; the format's where N·L = 2·step − 1 − Shade Bias.
            shadingShiftFactor: clamp((0.5 - t.step) * 2 + t.shadeBias, -1, 1),
            shadingToonyFactor: clamp(1 - 2 * t.feather, 0, 1),
            giEqualizationFactor: 0.9,
            ...(matcap ? { matcapFactor: [t.matcap, t.matcap, t.matcap], matcapTexture: { index: matcap.index } } : {}),
            parametricRimColorFactor: [0, 0, 0],
            rimLightingMixFactor: 1,
            ...(outlined
                ? {
                      // In meters: across 1 to 8 m a world line stays within 0.69 to 1.15 times the format's
                      // (which thins slower than perspective), where a screen one runs 3.1 to 0.65 times;
                      // and viewers draw world lines alike (three-vrm draws screen ones half as wide).
                      outlineWidthMode: 'worldCoordinates',
                      outlineWidthFactor: t.outline / OUTLINE_PER_METER,
                      // Lit, MToon multiplies the line by the lit surface, which brings the base color
                      // itself; unlit, the base color factor stands in for it (MToon's line has no texture).
                      outlineColorFactor: (t.outlineLit ? [1, 1, 1] : ((base.baseColorFactor ?? [1, 1, 1]) as number[]).slice(0, 3)).map((c) => clamp(c * t.outlineBrightness * CEL_SHADING.lineShare, 0, 1)),
                      outlineLightingMixFactor: t.outlineLit ? 1 : 0,
                  }
                : { outlineWidthMode: 'none' }),
        };
        if (draw.layer !== 'body' && draw.layer !== 'transparent') layered.add(draw.layer);
        mtoons++;
    }
    if (mtoons) {
        used.add(VRMC_MTOON);
        notes.push(`${mtoons} MToon material(s) beside the format's materials (ramps, color tables, shade saturation, face shadow maps, hair highlights and eye effects are not in MToon)`);
    }
    if (layered.size) notes.push(`draw layers ${[...layered].join(', ')} (eyes through hair, overlays) are not in VRM: VRM viewers draw those materials plainly`);

    // ---- VRM's rest pose is a T-pose: say how far the arms hang
    const bones = ch.humanoid.bones;
    if (bones.leftUpperArm && bones.leftLowerArm) {
        const world = restMatrices(json);
        const a = world[bones.leftUpperArm.node];
        const b = world[bones.leftLowerArm.node];
        const d = [b[12] - a[12], b[13] - a[13], b[14] - a[14]];
        const below = (Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
        if (below > 15) notes.push(`the arms hang ${below.toFixed(0)}° below level at rest: VRM expects a T-pose (VRM animations will look off)`);
    }
    json.extensionsUsed = [...new Set([...used, VRMC_VRM])];
    return notes;
}
