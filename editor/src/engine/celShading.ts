// The editor's own cel shading for the anime material (engine/animeMaterial.ts uses it unless a
// local shading pack stands in). It is written for this engine: the lights of the pixel's cluster
// (the first directional one is the key light; every other light adds its own banded light), the
// engine's shadow maps and environment light, and its uniform and output conventions.
//
// What it draws, and how it reads the material's maps and settings, is the editor's character
// format (editor/CHARACTERS.md, section 2): a lit and a shaded color split by a ramp, a face shadow
// map, highlights for each kind of slot (cloth, skin, hair, eye), shadow cards and an outline. The
// format's own features follow its settings as CHARACTERS.md describes them: the hair's strand
// breakup, facing fade and tilt, the eye's tints, the face glow, alpha darkening, and the channels
// of the face mask and the outline map.
//
// How it is built, each part for what it should look like (editor/CEL-SHADING.md, section 2):
// - light and shade as a painter separates them: the form shadow in the shade color, cast shadows
//   deeper; surfaces turned down get less of the key light (the body and the ground keep the sky
//   from them), skin less so as light spreads inside it; a face's own shadow is the face shadow
//   map's, so the face's far side takes no cast shadow from the head itself;
// - cloth's highlights from the key light and from a studio light kept by the camera, so polished
//   parts keep a highlight that moves with the view;
// - hair's highlights as rings across the strands (smooth bands) that show within a window around
//   the head facing the camera;
// - the eye's matcap as the room seen on the cornea (a sphere cap over the iris).
// The constants that weigh the terms were fitted by comparing renders against a reference look.
//
// Published techniques it uses:
// - light and shade split along half-Lambert through a ramp texture (Valve, "Illustrative
//   Rendering in Team Fortress 2", 2007), or a soft step without one;
// - a face shadow map read against the light's angle around the head (thresholds stored as a
//   distance field, as in Green, "Improved Alpha-Tested Magnification for Vector Textures and
//   Special Effects", SIGGRAPH 2007; mirrored for the other side);
// - GGX highlights (Walter et al. 2007) with the height-correlated Smith term (Heitz 2014) and
//   Schlick's Fresnel, or a cut toon spot;
// - hair highlights along the strands from shifted tangents (Kajiya and Kay 1989, Scheuermann
//   2004);
// - the iris set back behind the surface by parallax (Kaneko et al. 2001), and a matcap ("The Lit
//   Sphere", Sloan et al. 2001) read by the cornea's normal;
// - normals from screen derivatives where a mesh has no tangents (Schüler 2013);
// - the outline as an inverted hull pushed out in screen space;
// - with Own Tone Curve, Stephen Hill's fit of the ACES transforms (BakingLab, MIT License; see
//   celFilmic) and display colors;
// - a shade table read as a strip of 2D slices (Selan, "Using Lookup Tables to Accelerate Color
//   Transformations", GPU Gems 2, ch. 24, 2005).
import { Engine3D, GPUCullMode, isSrgbFormat, Material, PassType, RenderShaderPass, Shader, ShaderLib, Vector4 } from '@orillusion/core';
import { CEL_SHADING, type AnimeValues } from '../core/anime';
import type { AnimeHead, AnimeMapSlot, AnimeShading, ShadingDeps } from './animeShadingApi';

/** A number as a WGSL float literal (for the constants the shading shares, core/anime.ts CEL_SHADING). */
const f32 = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** Uniforms after the engine's (vec4 only: the buffer is packed without padding). */
const FIELDS = `
    celShade: vec4<f32>,
    celFill: vec4<f32>,
    celKey: vec4<f32>,
    celBand: vec4<f32>,
    celEdge: vec4<f32>,
    celGloss: vec4<f32>,
    celHair: vec4<f32>,
    celHair2: vec4<f32>,
    celStrand: vec4<f32>,
    celStrandMap: vec4<f32>,
    celStrandMore: vec4<f32>,
    celIris: vec4<f32>,
    celIris2: vec4<f32>,
    celMatcap: vec4<f32>,
    celLine: vec4<f32>,
    celGlow: vec4<f32>,
    celHeadRight: vec4<f32>,
    celHeadUp: vec4<f32>,
    celFaceFront: vec4<f32>,
    celFaceRight: vec4<f32>,`;

/** The cel shading's own maps and the textures they go to. */
const MAPS: AnimeMapSlot[] = [
    { key: 'rampMap', slot: 'celRampMap', role: 'lookup', define: 'CEL_RAMP_MAP' },
    { key: 'faceMap', slot: 'celFaceMap', role: 'lookup', define: 'CEL_FACE_MAP' },
    { key: 'shadeLut', slot: 'celLutMap', role: 'lookup', define: 'CEL_LUT_MAP' },
    { key: 'faceMaskMap', slot: 'celFaceMaskMap', role: 'lookup', define: 'CEL_FACE_MASK_MAP' },
    { key: 'specularMap', slot: 'celSpecMap', role: 'lookup', define: 'CEL_SPEC_MAP' },
    { key: 'hairMap', slot: 'celHairMap', role: 'lookup', define: 'CEL_HAIR_MAP' },
    { key: 'faceGlowMap', slot: 'celGlowMap', role: 'lookup', define: 'CEL_GLOW_MAP' },
    { key: 'matcapMap', slot: 'celMatcapMap', role: 'color', define: 'CEL_MATCAP_MAP' },
    { key: 'overlayMap', slot: 'celOverlayMap', role: 'lookup', define: 'CEL_OVERLAY_MAP' },
    { key: 'outlineMap', slot: 'celLineMap', role: 'lookup', define: 'CEL_LINE_MAP' },
];

/** Every define of the passes. The model's own maps keep the editor's names (engine/materials.ts ANIME_PBR_MAPS). */
const DEFINES = [
    'ANIME_NORMALMAP', 'ANIME_MASKMAP', 'ANIME_EMISSIVEMAP',
    ...MAPS.map((m) => m.define),
    'CEL_CLOTH', 'CEL_SKIN', 'CEL_HAIR', 'CEL_EYE', 'CEL_OVERLAY',
    'CEL_IRIS', 'CEL_GGX', 'CEL_TOON_SPEC', 'CEL_HAIR_LOBES', 'CEL_STRANDS', 'CEL_SATURATE', 'CEL_SHADOWS', 'CEL_TONE',
    'CEL_LINE_LIT', 'CEL_BLEND', 'CEL_A2C', 'CEL_NORMAL_AG', 'CEL_NORMAL_SPLIT', 'CEL_MASK_TOON', 'CEL_LINE_TANGENT',
] as const;

const declare = (m: AnimeMapSlot) => `#if ${m.define}\n@group(1) @binding(auto) var ${m.slot}: texture_2d<f32>;\n#endif`;
const mapDecl = (keys: string[]) => MAPS.filter((m) => keys.includes(m.key)).map(declare).join('\n');

/** What both passes share: helpers for color, the frame of the head, the lights and the banding. */
const COMMON_WGSL = /* wgsl */ `
// The engine's shadow code reads the shaded normal from here.
struct FragData {
    N: vec3<f32>,
};
var<private> fragData: FragData;

const CEL_PI: f32 = 3.14159265;

// Rec. 709 luminance.
fn celLuminance(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// The color pulled away from (s > 1) or toward (s < 1) its own grey.
fn celSaturation(c: vec3<f32>, s: f32) -> vec3<f32> {
    let grey = vec3<f32>(celLuminance(c));
    return max(grey + (c - grey) * s, vec3<f32>(0.0));
}

fn celUnit(v: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
    let len = length(v);
    return select(fallback, v / len, len > 1e-6);
}

// sRGB transfer, both ways (IEC 61966-2-1).
fn celToSrgb(c: vec3<f32>) -> vec3<f32> {
    let x = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3<f32>(0.0031308));
}
fn celFromSrgb(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

// The base map's coordinates.
fn celUV() -> vec2<f32> {
    let o = materialUniform.baseMapOffsetSize;
    return ORI_VertexVarying.fragUV0 * o.zw + o.xy;
}

// The key light: the first directional light of the pixel's cluster, its color and its cast shadow.
struct CelKey {
    dir: vec3<f32>,
    color: vec3<f32>,
    shadow: f32,
    found: bool,
};

// The key light's cast shadow: one filtered lookup (the engine's) in the first cascade that holds
// the point. dx, dy: the world position's screen derivatives, taken where control flow is uniform.
fn celKeyShadow(light: LightData, dx: vec3<f32>, dy: vec3<f32>) -> f32 {
    let index = i32(light.castShadow);
    if (index < 0) {
        return 1.0;
    }
    #if USE_CSM
        if (light.csmShadowMapIndex >= 0.0) {
            let cascades = clamp(i32(light.csmShadowMapNum), 1, csmCount);
            for (var c: i32 = 0; c < cascades; c++) {
                let r = directShadowMapingIndex(light, globalUniform.shadowMatrix[index + c], index + c, light.shadowBias[c], light.normalBias[c], dx, dy);
                if (r.y < 0.5) {
                    return r.x;
                }
            }
            return 1.0;
        }
    #endif
    return directShadowMapingIndex(light, globalUniform.shadowMatrix[index], index, light.shadowBias[0], light.normalBias[0], dx, dy).x;
}

fn celKeyLight(withShadow: bool, dx: vec3<f32>, dy: vec3<f32>) -> CelKey {
    var key = CelKey(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0), 1.0, false);
    let cluster = getCluster();
    let first = i32(max(cluster.start, 0.0));
    let last = first + i32(max(cluster.count, 0.0));
    for (var i = first; i < last; i += 1) {
        let light = getLight(i);
        if (light.lightType == DirectLightType) {
            key.dir = celUnit(-light.direction, vec3<f32>(0.0, 1.0, 0.0));
            // A key light of intensity 2 (the editor's daylight) shows the base color as painted where
            // a surface faces up (surfaces turned down get less of it: celGround).
            key.color = light.lightColor * (light.intensity * 0.5) * materialUniform.celKey.rgb * materialUniform.celKey.w;
            #if CEL_SHADOWS
                if (withShadow) {
                    key.shadow = celKeyShadow(light, dx, dy);
                }
            #endif
            key.found = true;
            break;
        }
    }
    return key;
}

#if CEL_RAMP_MAP
    // The ramp at u (0 the shade side, 1 the lit side): alpha how lit, color the tint along the
    // edge. Read no closer to its ends than their texels' centers, as the shared sampler may repeat
    // and would blend the two ends.
    fn celRamp(u: f32) -> vec4<f32> {
        let half = 0.5 / f32(textureDimensions(celRampMap, 0).x);
        return textureSampleLevel(celRampMap, baseMapSampler, vec2<f32>(clamp(u, half, 1.0 - half), 0.5), 0.0);
    }
#endif

// How lit a point is from where it faces: half-Lambert (0 facing away, 1 facing the light) of the
// cosine moved by the shade bias (the bias is in cosine units), read through the ramp or a soft
// step around the shade edge. Returns tint (rgb) and how lit (a).
fn celBand(facing: f32) -> vec4<f32> {
    let x = clamp(0.5 * (facing + materialUniform.celShade.w) + 0.5, 0.0, 1.0);
    #if CEL_RAMP_MAP
        return celRamp(x);
    #else
        let edge = materialUniform.celBand.x;
        let soft = max(materialUniform.celBand.y, 1e-4);
        return vec4<f32>(1.0, 1.0, 1.0, smoothstep(edge - soft, edge + soft, x));
    #endif
}

// The tint of the light in shade: half of Shade Light Tint. The shade keeps some of the base color's
// own hue, as if half its light came from the tinted sky and half bounced off the surroundings.
// The shade color made from settings takes it (a shade table brings its own hue instead); lit
// outlines take it in the shade either way, as they read no table.
fn celShadeTint() -> vec3<f32> {
    return mix(vec3<f32>(1.0), materialUniform.celFill.rgb, 0.5);
}

// Sky and ground: a surface turned down gets less of the key light, as the body and the ground keep
// the sky from it (the key light stands for all the light here, the sky's included): up to 45% less
// facing straight down. Skin loses less (30%): light spreads inside it, so its shading stays softer.
fn celGround(N: vec3<f32>) -> f32 {
    var occlude = 0.45;
    #if CEL_SKIN
        occlude = 0.3;
    #endif
    return 1.0 - occlude * (0.5 - 0.5 * N.y);
}

// The color in shade, made from the base color: through the shade table (which brings its own
// color), or by saturation and brightness, under the shade's tint.
fn celShadeColor(base: vec3<f32>) -> vec3<f32> {
    #if CEL_LUT_MAP
        // A strip of n slices of n x n texels (n its height) over encoded colors: blue picks the
        // slice, red runs across it, green up it. Texel centers, and the two slices around blue
        // blended (the last slice has none after it).
        let size = vec2<f32>(textureDimensions(celLutMap, 0));
        let texel = 1.0 / size;
        let n = size.y;
        let c = celToSrgb(base) * (n - 1.0);
        let slice = floor(c.b);
        let within = (c.rg + vec2<f32>(0.5)) * texel;
        let lower = vec2<f32>(within.x + slice * n * texel.x, 1.0 - within.y);
        let upper = lower + vec2<f32>(select(n * texel.x, 0.0, slice >= n - 1.0), 0.0);
        let a = textureSampleLevel(celLutMap, baseMapSampler, lower, 0.0).rgb;
        let b = textureSampleLevel(celLutMap, baseMapSampler, upper, 0.0).rgb;
        return celFromSrgb(mix(a, b, c.b - slice));
    #else
        return celSaturation(base, materialUniform.celShade.y) * materialUniform.celShade.x * celShadeTint();
    #endif
}

// Light of the environment around the point (the scene's sky, blurred). Environment Light adds it
// over the whole surface in the shade color, so it shows most in the shade and cast shadows darken
// it as they darken that color.
fn celEnvironment(N: vec3<f32>) -> vec3<f32> {
    return getReflectionsEnv(N, ORI_VertexVarying.vWorldPos.xyz, 1.0) * materialUniform.envIntensity;
}

// Every light of the cluster but the key light: banded light of its own (a lit side only, no shadow).
fn celOtherLights(N: vec3<f32>, P: vec3<f32>) -> vec3<f32> {
    var sum = vec3<f32>(0.0);
    var keySeen = false;
    let cluster = getCluster();
    let first = i32(max(cluster.start, 0.0));
    let last = first + i32(max(cluster.count, 0.0));
    for (var i = first; i < last; i += 1) {
        let light = getLight(i);
        var L = vec3<f32>(0.0);
        var power = 0.0;
        if (light.lightType == DirectLightType) {
            if (!keySeen) {
                keySeen = true;
                continue;
            }
            L = celUnit(-light.direction, vec3<f32>(0.0, 1.0, 0.0));
            power = light.intensity;
        } else {
            let toLight = light.position - P;
            let dist = length(toLight);
            if (dist >= light.range || dist <= 0.0) {
                continue;
            }
            L = toLight / dist;
            // The engine's falloff for point and spot lights.
            power = (1.0 - smoothstep(0.0, light.range, dist)) / max(light.radius, 0.001) * light.intensity / (4.0 * CEL_PI * CEL_PI * light.range * light.range);
            if (light.lightType == SpotLightType) {
                let angle = acos(clamp(dot(-L, celUnit(light.direction, vec3<f32>(0.0, -1.0, 0.0))), -1.0, 1.0));
                power *= 1.0 - smoothstep(light.innerCutOff, light.outerCutOff, angle);
            }
        }
        // Colored as the engine's lit materials take a light: its color times 2.4 to the power of the
        // light's linear value (the engine's getHDRColor; 0 for directional lights, 8 by default for
        // point and spot lights).
        sum += light.lightColor * pow(2.4, light.linear) * (power * 0.5) * celBand(dot(N, L)).a;
    }
    return sum;
}

// Own Tone Curve: the ACES look as fitted by Stephen Hill: exposure and a little more saturation
// first, then into ACES's working space with its saturation step, the fitted reference and output
// transforms, and back. The two matrices and the fit come from BakingLab's ACES.hlsl
// (https://github.com/TheRealMJP/BakingLab), whose code Stephen Hill wrote, under this license:
//
//   MIT License
//
//   Copyright (c) 2016 MJP
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
fn celFilmic(c: vec3<f32>) -> vec3<f32> {
    let into = mat3x3<f32>(
        vec3<f32>(0.59719, 0.07600, 0.02840),
        vec3<f32>(0.35458, 0.90834, 0.13383),
        vec3<f32>(0.04823, 0.01566, 0.83777));
    let back = mat3x3<f32>(
        vec3<f32>(1.60475, -0.10208, -0.00327),
        vec3<f32>(-0.53108, 1.10813, -0.07276),
        vec3<f32>(-0.07367, -0.00605, 1.07602));
    // Exposure before the curve (3.2), for a key light of intensity 2: light colors near 0.86
    // (linear) come out as painted, darker ones are lifted (0.18 to 0.43, 0.5 to 0.75) and white
    // rolls off to 0.88; a little more saturation (1.2) goes in with it.
    let v = into * celSaturation(c * 3.2, 1.2);
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return clamp(back * (a / b), vec3<f32>(0.0), vec3<f32>(1.0));
}

// The material's output: straight alpha for blending, alpha-weighted for the multiply of overlays,
// display colors with Own Tone Curve. The G-buffer as the engine's unlit materials write it.
fn celWriteOutput(color: vec3<f32>, alpha: f32, N: vec3<f32>, multiply: bool) {
    var c = color;
    #if CEL_TONE
        // A multiply's color is a factor: in display colors, but not through the tone curve.
        c = celToSrgb(select(celFilmic(max(c, vec3<f32>(0.0))), c, multiply));
    #endif
    var out = vec4<f32>(c, 1.0);
    #if CEL_BLEND
        out = vec4<f32>(c, alpha);
    #endif
    #if CEL_A2C
        // Cut-out with alpha to coverage: the sharpened alpha is the coverage (the engine turns it
        // on where the color pass is multisampled; single-sampled, the cut falls at the edge's middle).
        out = vec4<f32>(c, alpha);
    #endif
    if (multiply) {
        out = vec4<f32>(c * alpha, alpha);
    }
    let gBuffer = packNHMDGBuffer(getGBufferDepth(), vec3<f32>(0.0), out.rgb, vec3<f32>(1.0, 0.0, 0.0), N, out.a);
    #if USE_OIT_DEPTH_PEEL
        ORI_FragmentOutput.color = out;
    #else
        ORI_FragmentOutput.gBuffer = gBuffer;
        #if USE_CASTREFLECTION
        #else
            ORI_FragmentOutput.color = out;
        #endif
    #endif
}

// Base color and coverage: the base map (decoded unless the GPU does it) times the material color,
// cut out below the cutoff; with alpha to coverage the alpha is sharpened to about a pixel, which
// multisampling turns into coverage.
fn celBaseColor(uv: vec2<f32>) -> vec4<f32> {
    var c = textureSample(baseMap, baseMapSampler, uv);
    #if USE_SRGB_ALBEDO
    #else
        c = vec4<f32>(celFromSrgb(c.rgb), c.a);
    #endif
    c *= materialUniform.baseColor;
    let cutoff = materialUniform.alphaCutoff;
    #if CEL_A2C
        if (cutoff > 0.0) {
            let w = max(fwidth(c.a), 1e-4);
            c.a = clamp((c.a - cutoff) / w + 0.5, 0.0, 1.0);
        }
    #endif
    return c;
}

// Whether a texel is cut away: below the cutoff; with alpha to coverage, whose sharpened alpha
// already fades over about a pixel, only where nothing of it is left.
fn celCutAway(a: f32) -> bool {
    #if CEL_A2C
        return a <= 0.0;
    #else
        return a < materialUniform.alphaCutoff;
    #endif
}
`;

/** The surface pass. */
const SURFACE_WGSL = /* wgsl */ `
#if ANIME_NORMALMAP
@group(1) @binding(auto) var normalMap: texture_2d<f32>;
#endif
#if ANIME_MASKMAP
@group(1) @binding(auto) var maskMap: texture_2d<f32>;
#endif
#if ANIME_EMISSIVEMAP
@group(1) @binding(auto) var emissiveMap: texture_2d<f32>;
#endif
${mapDecl(['rampMap', 'faceMap', 'shadeLut', 'faceMaskMap', 'specularMap', 'hairMap', 'faceGlowMap', 'matcapMap', 'overlayMap'])}
${COMMON_WGSL}

fn vert(inputData: VertexAttributes) -> VertexOutput {
    ORI_Vert(inputData);
    return ORI_VertexOut;
}

// The surface's frame: the mesh's tangent, or one from screen derivatives (bitangent up the image).
struct CelFrame {
    T: vec3<f32>,
    B: vec3<f32>,
    N: vec3<f32>,
};

fn celSurfaceFrame(N: vec3<f32>, uv: vec2<f32>, front: bool) -> CelFrame {
    #if USE_TANGENT
        let t = ORI_VertexVarying.TANGENT;
        var T = celUnit(t.xyz - N * dot(N, t.xyz), vec3<f32>(1.0, 0.0, 0.0));
        var B = cross(N, T) * select(-1.0, 1.0, t.w >= 0.0);
        if (!front) {
            T = -T;
        }
        return CelFrame(T, B, N);
    #else
        // Screen derivatives; WGSL's y runs down the screen, so both y derivatives turn around.
        let P = ORI_VertexVarying.vWorldPos.xyz;
        let dpx = dpdx(P);
        let dpy = -dpdy(P);
        let dux = dpdx(uv);
        let duy = -dpdy(uv);
        let py = cross(dpy, N);
        let px = cross(N, dpx);
        // On a back face the screen sees the surface mirrored and these come out as the front's:
        // turned around, as the tangent frame above is, so a bump mirrors as a whole.
        let back = select(-1.0, 1.0, front);
        let T0 = (py * dux.x + px * duy.x) * back;
        let B0 = (py * dux.y + px * duy.y) * back;
        // Both scaled by the longer one's length before each is made unit: products of screen
        // derivatives are tiny, and this keeps them clear of celUnit's cutoff at any scale.
        let det = max(dot(T0, T0), dot(B0, B0));
        let scale = select(0.0, inverseSqrt(det), det > 0.0);
        // +v runs down the image, the normal map's green up it.
        return CelFrame(celUnit(T0 * scale, vec3<f32>(1.0, 0.0, 0.0)), celUnit(-B0 * scale, vec3<f32>(0.0, 1.0, 0.0)), N);
    #endif
}

// A tangent-space normal from two channels (z rebuilt).
fn celRebuild(xy: vec2<f32>, strength: f32) -> vec3<f32> {
    let v = (xy * 2.0 - 1.0) * strength;
    return vec3<f32>(v, sqrt(max(1.0 - dot(v, v), 0.0)));
}

fn celToWorld(f: CelFrame, n: vec3<f32>) -> vec3<f32> {
    return celUnit(f.T * n.x + f.B * n.y + f.N * n.z, f.N);
}

// Where a matcap is read on an eye: by the cornea's normal in view space. The cornea is a sphere
// cap over the iris disc (disc: -1 to 1 across it; rise: 0 flat, 1 a half sphere, above 1 a
// smaller cap whose rim falls inside the disc, the rim's normal read beyond it), so its normal
// leans out toward the rim. A matcap is a lit sphere seen from the camera (Sloan et al. 2001,
// "The Lit Sphere"): the image's right shows the screen's right, its top the screen's top. This
// engine's view space has +x toward the screen's left (its projection mirrors x), hence the minus.
fn celCorneaMatcap(f: CelFrame, disc: vec2<f32>, rise: f32) -> vec2<f32> {
    let out = (f.T * disc.x + f.B * disc.y) * rise;
    let n = celUnit(f.N * sqrt(max(1.0 - dot(out, out), 0.0)) + out, f.N);
    let v = (globalUniform.viewMat * vec4<f32>(n, 0.0)).xyz;
    return clamp(vec2<f32>(0.5 - 0.5 * v.x, 0.5 - 0.5 * v.y), vec2<f32>(0.0), vec2<f32>(1.0));
}

// The face's light: how lit a point is from the face shadow map (drawn for light from the face's
// left: each texel holds how far around the head the light may go and still light it, read
// mirrored for light from the right).
fn celFaceLight(L: vec3<f32>, left: vec4<f32>, right: vec4<f32>) -> f32 {
    let across = dot(L, materialUniform.celFaceRight.xyz);
    let ahead = dot(L, materialUniform.celFaceFront.xyz);
    // The light's angle from the face's front as (angle - 36°) / (150° - 36°), held to 0..1 (0.2 and
    // 0.6333 are 36° and 114° over 180°): the threshold the texels' reach is compared with. With the
    // light within 36° of the front every texel whose reach clears the soft edge below (about 0.3,
    // the edge being widest then) is fully lit; past 150° every texel short of the full reach is in
    // shade.
    let around = clamp((abs(atan2(across, ahead)) / CEL_PI - 0.2) / 0.6333, 0.0, 1.0);
    let texel = select(left, right, across > 0.0);
    // Lit while the light is further ahead than the texel's angle. The angle is the mean of red and
    // green: a map may split it over the two for twice an 8-bit channel's steps (green holds the
    // lower half of the range, and stays full where red takes the upper half); a grey map, the same
    // in both, reads as painted.
    let reach = 0.5 * (texel.r + texel.g);
    // A wide, soft edge: Edge Softness plus 0.05, and up to 0.25 more while the light is in front.
    let soft = max(materialUniform.celBand.y, 0.004) + 0.05 + 0.25 * (1.0 - around);
    return smoothstep(around - soft, around + soft, reach);
}

// How near a GGX highlight's center a normal is, by angle, in the highlight's own width: 1 at the
// center, a half at the angle where the distribution falls to half its peak (that angle's cosine
// squared is (1 - √2·a²) / (1 - a²); a right angle once a² passes 1/√2), 0 at twice that angle.
fn celNearPeak(NoH: f32, a: f32) -> f32 {
    let a2 = a * a;
    let c2 = clamp((1.0 - 1.41421356 * a2) / max(1.0 - a2, 1e-6), 0.0, 1.0);
    let halfAngle = max(acos(sqrt(c2)), 1e-3);
    return clamp(1.0 - acos(clamp(NoH, 0.0, 1.0)) / (2.0 * halfAngle), 0.0, 1.0);
}

// Specular GGX with the height-correlated Smith visibility and Schlick's Fresnel.
#if CEL_SPEC_MAP
    // The Highlight Ramp at uv, no closer to its edges than their texels' centers (the shared
    // sampler may repeat, which would blend the far edge in).
    fn celSpecRamp(uv: vec2<f32>) -> vec3<f32> {
        let half = vec2<f32>(0.5) / vec2<f32>(textureDimensions(celSpecMap, 0));
        return textureSampleLevel(celSpecMap, baseMapSampler, clamp(uv, half, vec2<f32>(1.0) - half), 0.0).rgb;
    }
#endif

fn celGGX(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, a: f32, F0: vec3<f32>) -> vec3<f32> {
    let H = celUnit(V + L, N);
    let NoL = clamp(dot(N, L), 0.0, 1.0);
    let NoV = clamp(dot(N, V), 1e-4, 1.0);
    let NoH = clamp(dot(N, H), 0.0, 1.0);
    let VoH = clamp(dot(V, H), 0.0, 1.0);
    let a2 = max(a * a, 1e-6);
    let d = NoH * NoH * (a2 - 1.0) + 1.0;
    let D = a2 / (CEL_PI * d * d);
    let vis = 0.5 / max(NoL * sqrt(NoV * NoV * (1.0 - a2) + a2) + NoV * sqrt(NoL * NoL * (1.0 - a2) + a2), 1e-5);
    let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VoH, 5.0);
    return D * vis * F * NoL;
}

// A hair shift setting (0 to 1) as how far a lobe's strand direction leans out along the normal:
// above 0.5 the lobe moves toward the tips, below it toward the roots; 0.5 leaves it a little
// toward the tips of where the strands' own lean puts it (the -0.09, fitted with the other
// constants: the main ring's place at the setting's middle).
fn celHairShift(setting: f32) -> f32 {
    return (1.0 - 2.0 * setting) * 1.5 - 0.09;
}

// The half-width of a hair ring: the cosine between strand and half vector at which a strand lobe of
// sharpness p (a sine raised to p, Kajiya and Kay 1989) falls to half, so the sharpness settings
// keep their sense.
fn celRingWidth(p: f32) -> f32 {
    return sqrt(max(1.0 - pow(0.5, 2.0 / max(p, 0.5)), 1e-6));
}

// A highlight ring across the strands: full where the strand, leaned out along the normal by the
// shift (Scheuermann 2004), stands square to the half vector, and smoothly gone at twice the
// half-width w of that cosine.
fn celRing(T: vec3<f32>, N: vec3<f32>, H: vec3<f32>, shift: f32, w: f32) -> f32 {
    let Ts = celUnit(T + N * shift, T);
    return 1.0 - smoothstep(0.0, 2.0 * w, abs(dot(Ts, H)));
}

// How far around the head a surface turns from the camera: the angle between the two seen from above
// the head (0 facing the camera, pi facing away).
fn celAroundHead(N: vec3<f32>, V: vec3<f32>, up: vec3<f32>) -> f32 {
    let n = celUnit(N - up * dot(N, up), N);
    let v = celUnit(V - up * dot(V, up), V);
    return acos(clamp(dot(n, v), -1.0, 1.0));
}

// The rings show within a window of that angle: full facing the camera, gone by twice the angle at
// which Hair Facing as a power of the cosine falls to half (so the setting keeps its sense).
fn celRingWindow(around: f32, facing: f32) -> f32 {
    let halfAngle = acos(pow(0.5, 1.0 / max(facing, 0.01)));
    return 1.0 - smoothstep(0.0, 2.0 * halfAngle, around);
}

fn frag() {
    let uv = celUV();
    let base = celBaseColor(uv);
    if (celCutAway(base.a)) {
        discard;
    }
    let geoN = select(-1.0, 1.0, ORI_VertexVarying.face) * normalize(ORI_VertexVarying.vWorldNormal);
    let V = viewDir;
    let P = ORI_VertexVarying.vWorldPos.xyz;

    #if CEL_OVERLAY
        // An overlay darkens what is under it: its color, by its opacity times its mask.
        var cover = base.a;
        #if CEL_OVERLAY_MAP
            cover *= textureSample(celOverlayMap, baseMapSampler, uv).r;
        #endif
        celWriteOutput(base.rgb, cover, geoN, true);
    #else
        celShadeSurface(uv, base, geoN, V, P);
    #endif
}

fn celShadeSurface(uv: vec2<f32>, base: vec4<f32>, geoN: vec3<f32>, V: vec3<f32>, P: vec3<f32>) {
    // ------------------------------------------------ the frame and the normals
    let frame = celSurfaceFrame(geoN, uv, ORI_VertexVarying.face);
    var N = geoN;
    var NHigh = geoN;
    #if ANIME_NORMALMAP
        let nm = textureSample(normalMap, baseMapSampler, uv);
        let strength = materialUniform.normalScale;
        #if CEL_NORMAL_SPLIT
            N = celToWorld(frame, celRebuild(nm.rg, strength));
            NHigh = celToWorld(frame, celRebuild(nm.ba, strength * materialUniform.celGloss.w));
        #else
            #if CEL_NORMAL_AG
                // Packed: x is red times alpha (either channel may hold it), y green.
                N = celToWorld(frame, celRebuild(vec2<f32>(nm.r * nm.a, nm.g), strength));
            #else
                N = celToWorld(frame, celRebuild(nm.rg, strength));
            #endif
            NHigh = N;
        #endif
    #endif

    // ------------------------------------------------ what the mask map says
    var metal = 0.0;
    var rough = 0.7;
    var reflect = materialUniform.celGloss.x;
    var lightMask = 1.0;
    var occlusion = 1.0;
    // On hair: how much the strands run along the mesh's V (hair cards) instead of up the head.
    var alongCards = 0.0;
    #if ANIME_MASKMAP
        let mask = textureSample(maskMap, baseMapSampler, uv);
        #if CEL_MASK_TOON
            // Toon packing: metal (on hair: strands along the cards), reflectance (in place of Reflectance), light mask, smoothness.
            metal = mask.r;
            alongCards = mask.r;
            reflect = mask.g;
            lightMask = mask.b;
            rough = 1.0 - mask.a;
        #else
            // glTF packing: occlusion, roughness, metal.
            occlusion = mask.r;
            rough = mask.g;
            metal = mask.b;
        #endif
    #endif
    // Never under 0.03 (α 0.0009): a mirror-smooth texel would draw its highlight as one blown-out
    // pixel, and GGX's own floor sits near there.
    #if CEL_MASK_TOON
        // The toon mask's smoothness and metal are the surface's own: the material's Roughness and
        // Metallic factors belong to the glTF packing (imported toon materials often carry 0 there,
        // which would make every texel a mirror, or none of them metal).
        rough = clamp(rough, 0.03, 1.0);
    #else
        rough = clamp(rough * materialUniform.roughness, 0.03, 1.0);
        metal = clamp(metal * materialUniform.metallic, 0.0, 1.0);
    #endif

    // ------------------------------------------------ eyes: the iris seen behind the surface
    var albedo = base.rgb;
    var irisInside = 1.0;
    // Where on the iris's disc the point is: -1 to 1 across it, y up the image.
    var irisDisc = vec2<f32>(0.0);
    #if CEL_EYE
        #if CEL_IRIS
            let tileUV = fract(uv) - vec2<f32>(0.5);
            irisDisc = vec2<f32>(tileUV.x, -tileUV.y) * 2.0;
            let radius = length(irisDisc);
            let r = min(radius, 1.0);
            // The circle fills the tile; its edge is softened outward by about a pixel, over what the
            // map has outside it, so the map's own rim stays on the iris.
            irisInside = 1.0 - smoothstep(1.0, 1.0 + max(fwidth(radius), 1e-3), radius);
            // Parallax: the iris sits behind the surface, most in its middle. The view's slant is held
            // under 5 (its cosine at 0.2 or more), so a grazing view cannot throw the iris off its tile.
            let Vt = vec3<f32>(dot(V, frame.T), dot(V, frame.B), max(dot(V, frame.N), 0.2));
            let depth = materialUniform.celIris2.w * (1.0 - r * r) * irisInside;
            let irisUV = uv - Vt.xy / Vt.z * depth * vec2<f32>(1.0, -1.0);
            let irisColor = celBaseColor(irisUV);
            // Outside the circle (catch lights painted in the tile's corners) the Outside Iris Tint
            // brightens the map; wherever the map's alpha is, the Iris Alpha Tint comes in by it.
            albedo = mix(base.rgb * materialUniform.celIris.rgb, irisColor.rgb, irisInside);
            albedo *= mix(vec3<f32>(1.0), materialUniform.celIris2.rgb, mix(base.a, irisColor.a, irisInside));
            // The iris is lit flat, as it sits behind the cornea: Iris Bulge curves only the cornea's
            // reflection (the matcap, below).
        #endif
    #endif
    fragData.N = N;
    ORI_ShadingInput.Normal = N;

    // ------------------------------------------------ the key light
    let key = celKeyLight(true, dpdx(P), dpdy(P));
    let L = key.dir;
    var band = celBand(dot(N, L));
    var lit = band.a;

    var faceMask = vec4<f32>(1.0, 0.0, 1.0, 1.0);
    #if CEL_FACE_MASK_MAP
        faceMask = textureSample(celFaceMaskMap, baseMapSampler, uv);
    #endif
    #if CEL_FACE_MAP
        let faceLeft = textureSample(celFaceMap, baseMapSampler, uv);
        let faceRight = textureSample(celFaceMap, baseMapSampler, vec2<f32>(1.0 - uv.x, uv.y));
        let faceLit = celFaceLight(L, faceLeft, faceRight);
        // Green in the face mask: the normals shade it instead (neck, ears).
        lit = mix(faceLit, lit, faceMask.g);
    #endif

    #if CEL_EYE
        // Eyes are lit as the face in front of them is: by the light turned level with the head,
        // against the face's front (the eye mesh's own curve would shade the iris unevenly; level,
        // a light from above does not darken the eyes).
        let eyeUp = materialUniform.celHeadUp.xyz;
        let faceFront = materialUniform.celFaceFront.xyz;
        band = celBand(dot(celUnit(L - eyeUp * dot(L, eyeUp), faceFront), faceFront));
        lit = band.a;
    #endif

    // Cast shadows (where the face mask lets them fall) and the mask's light mask.
    var castAmount = materialUniform.celBand.z * faceMask.b;
    #if CEL_FACE_MAP
        // Where the face map gives the light, a surface turned from the light takes no cast shadow
        // (fading in over the first 0.4 of the cosine). The shadow map can only find the head itself
        // there: a closed shape hides its own far side from the light. Its shadow would lie over the
        // light the map gives the far cheek and jaw, as a patch the map never drew. Shadows of other
        // things (hair, hands) still fall where the face turns toward the light.
        castAmount *= mix(smoothstep(0.0, 0.4, dot(geoN, L)), 1.0, faceMask.g);
    #endif
    lit *= mix(1.0, key.shadow, castAmount) * lightMask;

    // ------------------------------------------------ light and shade
    // As a painter separates them: the form shadow (the side turned from the light) in the shade
    // color, a little deeper than the shade table or settings give (CEL_SHADING.formShade; cloth's
    // lighter by clothShade), and cast shadows deeper than form shadows (0.8 of it). Shade Darkness
    // then keeps that much of the shade's brightness.
    let facingView = clamp(dot(N, V), 0.0, 1.0);
    let inCast = (1.0 - key.shadow) * castAmount;
    var clothShade = 1.0;
    #if CEL_CLOTH
        clothShade = ${f32(CEL_SHADING.clothShade)};
    #endif
    let formShade = celShadeColor(albedo) * ${f32(CEL_SHADING.formShade)} * clothShade;
    let shade = formShade * mix(1.0, 0.8, inCast);
    var color = mix(shade * materialUniform.celShade.z, albedo, lit);

    #if CEL_SKIN
        // Along the edge between them the ramp's color tints skin (half of it), its brightness kept.
        var edgeColor = band.rgb;
        var edgeK = 0.5;
        #if CEL_FACE_MAP
            // On a face the edge is the face shadow map's, not the normals': it takes the color of
            // the ramp's middle, where a ramp has its edge (the normals' own reading where the face
            // mask's green has them shade), and only a quarter of it, as that edge is wide.
            #if CEL_RAMP_MAP
                edgeColor = mix(celRamp(0.5).rgb, band.rgb, faceMask.g);
            #endif
            edgeK = 0.25;
        #endif
        let edgeTint = edgeColor / max(celLuminance(edgeColor), 1e-3);
        color *= mix(vec3<f32>(1.0), edgeTint, (1.0 - abs(lit * 2.0 - 1.0)) * edgeK);
        // Lit skin up to a third more saturated: a chosen look, so painted skin stays warm in the
        // light rather than pale under the tone curve. As a vibrance control does, the boost fades
        // out over colors already saturated (from 0.6 to 0.9, saturation being (max - min) / max of
        // the linear color; pale skin sits near 0.45). Makeup painted on the skin (around the eyes,
        // blush) keeps its own color instead of turning to a glowing orange line. With Saturate
        // Brights on, as the skin kinds keep it, bright pale skin gets that too: it ends up 1.3
        // times as saturated up to a luminance of 0.35, 1.38 at 0.5 and 1.69 from 0.85.
        let hi = max(color.r, max(color.g, color.b));
        let lo = min(color.r, min(color.g, color.b));
        let sat = select(0.0, (hi - lo) / hi, hi > 1e-5);
        color = mix(color, celSaturation(color, 1.0 + 0.3 * (1.0 - smoothstep(0.6, 0.9, sat))), lit);
    #endif

    #if CEL_SATURATE
        // Saturate Brights: bright lit colors gain saturation (none under a luminance of 0.35, 1.3
        // times from 0.85), as a tone curve's shoulder, ours or the scene's, pales bright colors.
        color = mix(color, celSaturation(color, 1.3), lit * smoothstep(0.35, 0.85, celLuminance(color)));
    #endif

    #if CEL_SKIN
        // Toward the silhouette the lit color turns to the edge color: as much as Edge Tint, where
        // the face mask's red says; where its blue (which also lets cast shadows fall) is off, only
        // Edge Tint Off Mask of it.
        let towardEdge = 1.0 - smoothstep(0.15, 1.0, facingView);
        var edgeAmount = materialUniform.celEdge.w;
        #if CEL_FACE_MASK_MAP
            // Red: where the edge tint goes; where blue is off, only Edge Tint Off Mask of it.
            edgeAmount *= faceMask.r * mix(materialUniform.celGloss.z, 1.0, faceMask.b);
        #endif
        color *= mix(vec3<f32>(1.0), materialUniform.celEdge.rgb, towardEdge * edgeAmount * lit);
    #endif

    let keyColor = select(vec3<f32>(0.0), key.color, key.found);
    var lighted = color * keyColor * celGround(N);

    // The other lights, and the environment as a fill (occlusion from the mask).
    lighted += albedo * celOtherLights(N, P);
    lighted += shade * celEnvironment(N) * materialUniform.celFill.w * occlusion;

    // ------------------------------------------------ highlights
    let H = celUnit(V + L, NHigh);
    // The light the highlights get here: the key light where it reaches, and in the shade the fill
    // that lights the shade color (Shade Darkness).
    let inShade = mix(materialUniform.celShade.z, 1.0, lit);
    #if CEL_CLOTH
        let F0 = mix(vec3<f32>(0.04 * reflect), albedo, metal);
        // Non-metals' highlights crisper than their smoothness says (their α, the roughness
        // squared, at 0.7), so polished leather keeps a sharp sheen along its folds.
        let a = rough * rough * mix(0.7, 1.0, metal);
        // Cloth's highlights come from two lights: the key light (0.5) and a studio light kept by the
        // camera (0.7), set a little above the lens, slightly to its right and a little toward the key
        // light, as a photographer sets a second light between the camera and the key. Polished parts
        // keep a highlight that moves with the view. Both are GGX (celGGX), capped so that a nearly
        // mirror-smooth texel cannot blow out. (This engine's view x runs to the screen's left, so the
        // camera's right is minus its first row.)
        let camRight = -vec3<f32>(globalUniform.viewMat[0].x, globalUniform.viewMat[1].x, globalUniform.viewMat[2].x);
        let camUp = vec3<f32>(globalUniform.viewMat[0].y, globalUniform.viewMat[1].y, globalUniform.viewMat[2].y);
        let Ls = celUnit(V + camUp * 0.35 + camRight * 0.1 + (L - V) * 0.15, V);
        let Hs = celUnit(V + Ls, NHigh);
        var specColor = vec3<f32>(1.0);
        #if CEL_SPEC_MAP
            // Across the Highlight Ramp: how near the nearer highlight's center it is (by angle, in
            // the highlight's width); down: the smoothness (metal at the smooth end).
            let near = max(celNearPeak(clamp(dot(NHigh, H), 0.0, 1.0), a), celNearPeak(clamp(dot(NHigh, Hs), 0.0, 1.0), a));
            specColor = celSpecRamp(vec2<f32>(near, max(1.0 - rough, metal)));
        #endif
        #if CEL_GGX
            let spec = celGGX(NHigh, V, L, a, F0) * 0.5 + celGGX(NHigh, V, Ls, a, F0) * 0.7;
            lighted += min(spec, vec3<f32>(8.0)) * specColor * keyColor * inShade;
        #endif
        #if CEL_TOON_SPEC
            // A spot cut at the highlight's half width (the key light's only), in the surface's own
            // color (a painted highlight rather than a white reflection), as bright as Highlight
            // Strength times the reflectance.
            let spot = smoothstep(0.45, 0.55, celNearPeak(clamp(dot(NHigh, H), 0.0, 1.0), a));
            lighted += spot * materialUniform.celGloss.y * reflect * specColor * albedo * keyColor * inShade;
        #endif
    #endif
    #if CEL_SKIN
        // Skin's sheen: never sharper than α 0.25 (skin is never polished), and only where the key
        // light reaches it (a sheen in the shade reads as oily skin).
        let skinF0 = vec3<f32>(0.04 * reflect);
        lighted += celGGX(NHigh, V, L, max(rough * rough, 0.25), skinF0) * keyColor * lit;
    #endif
    #if CEL_HAIR
        // Strands run up the head along the surface (a ring of light around it), or along the hair
        // cards as much as the mask's red says, leaned toward the head's right by the tilt.
        let headUp = materialUniform.celHeadUp.xyz + materialUniform.celHeadRight.xyz * materialUniform.celStrandMore.z;
        let upAlong = celUnit(headUp - NHigh * dot(headUp, NHigh), frame.B);
        // Hair cards are laid out lengthwise along V: the mesh's bitangent, turned to run up the head.
        let card = frame.B * select(-1.0, 1.0, dot(frame.B, upAlong) >= 0.0);
        let cardAlong = celUnit(card - NHigh * dot(card, NHigh), upAlong);
        let strandDir = celUnit(mix(upAlong, cardAlong, alongCards), upAlong);
        // The rings fade as the hair turns from the camera around the head.
        let ringWindow = celRingWindow(celAroundHead(NHigh, V, materialUniform.celHeadUp.xyz), materialUniform.celHair.w);
        // The lines between strands: the Strand Map's red (bright on a line) or the Strand Comb's
        // stripes, as Strand Mix mixes them. A missing source reads as a flat 0.5, which darkens the
        // band evenly.
        #if CEL_HAIR_MAP
            let strandUV = uv * materialUniform.celStrandMap.xy + materialUniform.celStrandMap.zw;
            let fromMap = textureSample(celHairMap, baseMapSampler, strandUV).r;
        #else
            let fromMap = 0.5;
        #endif
        let comb = materialUniform.celStrandMore.y;
        let stripes = select(0.5, 0.5 - 0.5 * sin(uv.x * comb * 2.0 * CEL_PI), comb > 0.0);
        let lines = mix(stripes, fromMap, materialUniform.celStrandMore.x);
        #if CEL_HAIR_LOBES
            // The main ring (half-width 0.086, fitted with the other constants): as bright as Hair
            // Highlight and the mask's reflectance let it (painted strand by strand where the shine
            // may show).
            let ring = clamp(celRing(strandDir, NHigh, H, celHairShift(materialUniform.celHair.y), 0.086) * reflect * materialUniform.celHair.x * 0.68, 0.0, 1.0);
            #if CEL_SPEC_MAP
                // Its color through the Highlight Ramp: across, its strength; down, how far the hair
                // turns from the camera (the top row faces it).
                let mainColor = celSpecRamp(vec2<f32>(ring, 1.0 - ringWindow));
            #else
                // Without one, the hair's own color, brightened (lifted by 0.08 too, so dark hair
                // still shows a ring).
                let mainColor = (albedo * 1.8 + vec3<f32>(0.08)) * ring;
            #endif
            // The second ring: its own color and width, where the mask says the strands are smooth.
            let second = celRing(strandDir, NHigh, H, celHairShift(materialUniform.celHair.z), celRingWidth(max(materialUniform.celHair2.w, 1.0))) * (1.0 - rough);
            lighted += (mainColor * 0.14 + materialUniform.celHair2.rgb * second * 0.25) * keyColor * ringWindow * inShade;
        #else
            // Without the lobes, one broad soft ring (a strand lobe of sharpness 32) as bright as
            // Highlight Strength.
            let soft = celRing(strandDir, NHigh, H, 0.0, celRingWidth(32.0)) * materialUniform.celGloss.y;
            lighted += vec3<f32>(soft) * albedo * keyColor * ringWindow * inShade;
        #endif
        #if CEL_STRANDS
            // The lines darken the color in a band along the strands, where the mask lets the hair
            // shine, and turn toward Strand Saturation as far as they darken.
            let strandBand = celRing(strandDir, NHigh, H, celHairShift(materialUniform.celStrand.y), celRingWidth(max(materialUniform.celStrand.z, 0.5)));
            let dark = clamp(1.4 * materialUniform.celStrand.x * strandBand * lines * reflect, 0.0, 1.0);
            lighted = celSaturation(lighted * (1.0 - dark), mix(1.0, materialUniform.celStrand.w, dark));
        #endif
    #endif
    #if CEL_EYE
        #if CEL_MATCAP_MAP
            // The matcap is the room seen on the cornea: read by the cornea's normal over the iris
            // (the eye's surface normal where there is no iris circle). Its color scales by Matcap
            // Strength; its alpha brings the Matcap Alpha Color. It is the key light's, like the
            // rest of the surface.
            let cap = textureSample(celMatcapMap, baseMapSampler, celCorneaMatcap(frame, irisDisc, materialUniform.celIris.w));
            lighted += (cap.rgb * materialUniform.celMatcap.w + materialUniform.celMatcap.rgb * cap.a) * irisInside * keyColor * inShade;
        #endif
    #endif

    // ------------------------------------------------ face glow, alpha darkening, emission
    #if CEL_GLOW_MAP
        let turned = dot(V, materialUniform.celFaceRight.xyz) * materialUniform.celGlow.x;
        let glow = textureSample(celGlowMap, baseMapSampler, uv + vec2<f32>(turned, 0.0)).rgb;
        lighted += glow * keyColor * lit;
    #endif
    lighted *= mix(1.0, base.a, materialUniform.celBand.w);
    #if ANIME_EMISSIVEMAP
        var glowMap = textureSample(emissiveMap, baseMapSampler, uv).rgb;
        #if ANIME_EMISSIVE_ENCODED
            glowMap = celFromSrgb(glowMap);
        #endif
        lighted += glowMap * materialUniform.emissiveColor.rgb * materialUniform.emissiveIntensity;
    #endif

    celWriteOutput(lighted, base.a, N, false);
}
`;

/** The outline pass: the back faces pushed out along the outline direction, colored from the base. */
const HULL_WGSL = /* wgsl */ `
${mapDecl(['outlineMap', 'rampMap', 'shadeLut'])}
${COMMON_WGSL}

fn vert(inputData: VertexAttributes) -> VertexOutput {
    ORI_Vert(inputData);
    // The direction to push: the model's own outline normal (in the mesh's frame, or its tangent
    // frame), else the normal.
    var dir = inputData.normal;
    #if USE_OUTLINE_NORMAL
        let own = inputData.outlineNormal.xyz;
        #if CEL_LINE_TANGENT
            #if USE_TANGENT
                let t = inputData.TANGENT;
                let b = cross(inputData.normal, t.xyz) * select(-1.0, 1.0, t.w >= 0.0);
                let fromTangent = t.xyz * own.x + b * own.y + inputData.normal * own.z;
                dir = select(inputData.normal, fromTangent, dot(own, own) > 1e-8);
            #endif
        #else
            dir = select(inputData.normal, own, dot(own, own) > 1e-8);
        #endif
    #endif
    let worldDir = celUnit(ORI_NORMALMATRIX * dir, ORI_VertexOut.varying_WNormal);

    // Width in meters at a meter's distance (CEL_SHADING.lineWidth for 1) and the push from the
    // camera (1 = a tenth of a meter).
    var width = materialUniform.celLine.x * ${f32(CEL_SHADING.lineWidth)};
    var push = materialUniform.celLine.y * 0.1;
    #if CEL_LINE_MAP
        let m = textureSampleLevel(celLineMap, baseMapSampler, inputData.uv, 0.0);
        width *= m.r;
        push *= m.g;
    #endif

    // Pushed away from the camera, then out sideways on the screen.
    var world = ORI_VertexOut.varying_WPos.xyz;
    world += celUnit(world - globalUniform.CameraPos.xyz, vec3<f32>(0.0)) * push;
    var clip = ORI_MATRIX_P * (ORI_MATRIX_V * vec4<f32>(world, 1.0));
    let screenDir = (ORI_MATRIX_P * (ORI_MATRIX_V * vec4<f32>(worldDir, 0.0))).xy;
    let aspect = globalUniform.windowWidth / max(globalUniform.windowHeight, 1.0);
    var d = vec2<f32>(screenDir.x * aspect, screenDir.y);
    let dl = length(d);
    d = select(vec2<f32>(0.0), d / dl, dl > 1e-6);
    // The width in screen units at this depth: it thins slower than perspective farther away (a power
    // of the distance under 1, CEL_SHADING.lineThinning), and the line is never under a quarter of a
    // pixel wide (0.5 over the height, as clip space spans 2 over it).
    var reach = width * ORI_MATRIX_P[1][1] / pow(max(clip.w, 1e-4), ${f32(CEL_SHADING.lineThinning)});
    reach = select(0.0, max(reach, 0.5 / max(globalUniform.windowHeight, 1.0)), width > 0.0);
    clip = vec4<f32>(clip.xy + vec2<f32>(d.x / aspect, d.y) * reach * clip.w, clip.zw);
    ORI_VertexOut.member = clip;
    ORI_VertexOut.varying_Clip = clip;
    return ORI_VertexOut;
}

fn frag() {
    let uv = celUV();
    let base = celBaseColor(uv);
    if (celCutAway(base.a)) {
        discard;
    }
    let N = normalize(ORI_VertexVarying.vWorldNormal);
    fragData.N = N;
    ORI_ShadingInput.Normal = N;
    // The line's color: the base color with its own saturation, drawn darker (CEL_SHADING.lineShare
    // of its brightness).
    var line = celSaturation(base.rgb, materialUniform.celLine.w) * materialUniform.celLine.z * ${f32(CEL_SHADING.lineShare)};
    #if CEL_LINE_LIT
        // Lit as the surface is, without its cast shadows (a line too thin to show them): in the
        // shade the fill level under the shade's tint, less light facing down.
        let key = celKeyLight(false, vec3<f32>(0.0), vec3<f32>(0.0));
        var lit = celBand(dot(N, key.dir)).a;
        let keyColor = select(vec3<f32>(0.0), key.color, key.found);
        line = line * mix(celShadeTint() * materialUniform.celShade.z, vec3<f32>(1.0), lit) * keyColor * celGround(N) + line * celEnvironment(N) * materialUniform.celFill.w;
    #endif
    celWriteOutput(line, base.a, N, false);
}
`;

const REST_HEAD: AnimeHead = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], front: [0, 0, 1], right: [1, 0, 0] };

/** The editor's own cel shading (see the top of this file). */
export function makeCelShading({ resolveAnime, ENGINE_FIELDS, setEngineDefaults }: ShadingDeps): AnimeShading {
    const uniform = ['struct MaterialUniform {', ENGINE_FIELDS, FIELDS, '};'].join('\n');
    let names: { surface: string; outline: string } | null = null;

    const sources = () => {
        // Only the parts of the lit pipeline the shading uses (a pass samples at most 16 textures).
        const head = [
            '#include "Common_vert"',
            '#include "Common_frag"',
            '#include "ClusterLight"',
            '#include "UnLit_frag"',
            '#include "PhysicMaterialUniform_frag"',
            '#include "EnvMap_frag"',
            '#include "ReflectionCG"',
            '#include "ShadowMapping_frag"',
            uniform,
            '@group(1) @binding(auto) var baseMapSampler: sampler;',
            '@group(1) @binding(auto) var baseMap: texture_2d<f32>;',
        ];
        return { surface: [...head, SURFACE_WGSL].join('\n'), outline: [...head, HULL_WGSL].join('\n') };
    };

    const registered = () => {
        if (!names) {
            names = { surface: 'morglay_cel_surface_39', outline: 'morglay_cel_outline_39' };
            const src = sources();
            ShaderLib.register(names.surface, src.surface);
            ShaderLib.register(names.outline, src.outline);
        }
        return names;
    };

    const colorPass = (name: string) => {
        const pass = new RenderShaderPass(name, name);
        pass.setShaderEntry('VertMain', 'FragMain');
        pass.passType = PassType.COLOR;
        return pass;
    };

    const setDefine = (mat: Material, name: string, value: boolean) => {
        if (!!mat.shader.getDefaultColorShader().defineValue?.[name] !== value) mat.setDefine(name, value);
    };

    const setAnimeHead = (mat: Material, head: AnimeHead) => {
        const sh = mat.shader;
        const v = (a: [number, number, number]) => new Vector4(a[0], a[1], a[2], 0);
        sh.setUniformVector4('celHeadRight', v(head.x));
        sh.setUniformVector4('celHeadUp', v(head.y));
        sh.setUniformVector4('celFaceFront', v(head.front));
        sh.setUniformVector4('celFaceRight', v(head.right));
    };

    const applyAnime = (mat: Material, a: AnimeValues, transparent: boolean) => {
        const sh = mat.shader;
        const v4 = (x: number, y: number, z: number, w: number) => new Vector4(x, y, z, w);
        sh.setUniformVector4('celShade', v4(a.shadeBrightness, a.shadeSaturation, a.shadeDarkness, a.shadeBias));
        sh.setUniformVector4('celFill', v4(a.shadeTint[0], a.shadeTint[1], a.shadeTint[2], a.ambient));
        sh.setUniformVector4('celKey', v4(a.lightTint[0], a.lightTint[1], a.lightTint[2], a.light));
        sh.setUniformVector4('celBand', v4(a.step, a.feather, a.shadows, a.alphaDarken));
        sh.setUniformVector4('celEdge', v4(a.edgeColor[0], a.edgeColor[1], a.edgeColor[2], a.edge));
        sh.setUniformVector4('celGloss', v4(a.reflectance, a.specular, a.edgeMasked, a.normalScale2));
        sh.setUniformVector4('celHair', v4(a.hair, a.hairShift, a.hairShift2, a.hairFacing));
        sh.setUniformVector4('celHair2', v4(a.hairColor2[0], a.hairColor2[1], a.hairColor2[2], a.hairPower2));
        sh.setUniformVector4('celStrand', v4(a.hairStrand, a.hairStrandShift, a.hairStrandPower, a.hairStrandSaturation));
        sh.setUniformVector4('celStrandMap', v4(a.hairRepeat[0], a.hairRepeat[1], a.hairOffset[0], a.hairOffset[1]));
        sh.setUniformVector4('celStrandMore', v4(a.hairStrandMix, a.hairComb, a.hairTilt, 0));
        sh.setUniformVector4('celIris', v4(a.irisTint[0], a.irisTint[1], a.irisTint[2], a.irisBulge));
        sh.setUniformVector4('celIris2', v4(a.irisAlphaTint[0], a.irisAlphaTint[1], a.irisAlphaTint[2], a.irisParallax));
        sh.setUniformVector4('celMatcap', v4(a.matcapColor[0], a.matcapColor[1], a.matcapColor[2], a.matcap));
        sh.setUniformVector4('celLine', v4(a.outline > 0 ? a.outline : 0, a.outlineDepth, a.outlineBrightness, a.outlineSaturation));
        sh.setUniformVector4('celGlow', v4(a.faceGlowShift, 0, 0, 0));
        const kind = a.kind;
        const hair = kind === 'hair';
        setDefine(mat, 'CEL_CLOTH', kind === 'cloth');
        setDefine(mat, 'CEL_SKIN', kind === 'skin' || kind === 'face');
        setDefine(mat, 'CEL_HAIR', hair);
        setDefine(mat, 'CEL_EYE', kind === 'eye');
        setDefine(mat, 'CEL_OVERLAY', kind === 'overlay');
        setDefine(mat, 'CEL_HAIR_LOBES', hair && (a.hair > 0 || a.hairColor2.some((c) => c > 0)));
        setDefine(mat, 'CEL_STRANDS', hair && a.hairStrand > 0);
        setDefine(mat, 'CEL_IRIS', kind === 'eye' && a.irisCircle);
        setDefine(mat, 'CEL_GGX', kind === 'cloth' && a.highlight === 'ggx');
        setDefine(mat, 'CEL_TOON_SPEC', kind === 'cloth' && a.highlight === 'toon');
        setDefine(mat, 'CEL_SATURATE', a.saturateLit);
        setDefine(mat, 'CEL_SHADOWS', a.shadows > 0);
        setDefine(mat, 'CEL_TONE', a.toneCurve);
        setDefine(mat, 'CEL_LINE_LIT', a.outlineLit);
        setDefine(mat, 'CEL_BLEND', transparent);
        setDefine(mat, 'CEL_NORMAL_AG', a.normalLayout === 'ag');
        setDefine(mat, 'CEL_NORMAL_SPLIT', a.normalLayout === 'split');
        setDefine(mat, 'CEL_MASK_TOON', a.maskLayout === 'toon');
        setDefine(mat, 'CEL_LINE_TANGENT', a.outlineNormals === 'tangent');
        // Only the outline pass reads the model's outline directions.
        const hull = sh.getSubShaders(PassType.COLOR)[1];
        if (hull && !!hull.defineValue?.['USE_OUTLINE_NORMAL'] !== (a.outlineNormals !== 'mesh')) hull.setDefine('USE_OUTLINE_NORMAL', a.outlineNormals !== 'mesh');
    };

    const createAnimeMaterial = (ctx: any, outline: boolean): Material => {
        const name = registered();
        const res = Engine3D.resFor(ctx);
        const shader = new Shader();
        const surface = colorPass(name.surface);
        shader.addRenderPass(surface);
        const s = surface.shaderState;
        s.acceptShadow = true;
        s.castShadow = true;
        // Both faces cast shadows: open shells (hair cards, a coat's hem) cast from either side.
        s.shadowCullMode = GPUCullMode.none;
        s.receiveEnv = true;
        s.acceptGI = false;
        s.useLight = true;
        if (outline) {
            const hull = colorPass(name.outline);
            shader.addRenderPass(hull);
            const h = hull.shaderState;
            // The back faces only, so the hull shows around the surface, not over it.
            h.cullMode = GPUCullMode.front;
            h.acceptShadow = true;
            h.castShadow = false;
            h.receiveEnv = true;
            h.acceptGI = false;
            h.useLight = true;
            // Not in the depth prepass, which draws the mesh where it is.
            h.useZ = false;
            hull.setDefine('USE_OUTLINE_NORMAL', false);
        }
        shader.setDefine('USE_CUSTOMUNIFORM', true);
        setEngineDefaults(shader, ctx);
        shader.setTexture('emissiveMap', res.blackTexture);
        for (const d of DEFINES) shader.setDefine(d, false);
        shader.setDefine('ANIME_EMISSIVE_ENCODED', false);
        const mat = new Material();
        mat.name = 'Anime';
        mat.shader = shader;
        applyAnime(mat, resolveAnime(null), false);
        setAnimeHead(mat, REST_HEAD);
        return mat;
    };

    const setAnimeCutout = (mat: Material, cutout: boolean) => {
        setDefine(mat, 'CEL_A2C', cutout);
        for (const pass of mat.shader.getSubShaders(PassType.COLOR) ?? []) {
            if (pass.shaderState.alphaToCoverageEnabled === cutout) continue;
            pass.shaderState.alphaToCoverageEnabled = cutout;
            (pass as any)._valueChange = true;
        }
    };

    const inheritModelMaps = (mat: Material, source: Material, ctx: any) => {
        const res = Engine3D.resFor(ctx);
        const from = source.shader;
        const texture = (name: string) => {
            try {
                return from.getTexture(name) ?? null;
            } catch {
                return null;
            }
        };
        const normal = texture('normalMap');
        if (normal && normal !== res.normalTexture) {
            mat.shader.setTexture('normalMap', normal);
            mat.setDefine('ANIME_NORMALMAP', true);
        }
        // The engine's stand-ins are no map (one has 0.5 in green, which would halve the roughness).
        const mask = texture('maskMap');
        if (mask && mask !== res.maskTexture && mask !== res.whiteTexture) {
            mat.shader.setTexture('maskMap', mask);
            mat.setDefine('ANIME_MASKMAP', true);
        }
        const emissive = texture('emissiveMap');
        if (emissive && from.getDefaultColorShader().defineValue?.['USE_EMISSIVEMAP']) {
            mat.shader.setTexture('emissiveMap', emissive);
            mat.setDefine('ANIME_EMISSIVEMAP', true);
            mat.setDefine('ANIME_EMISSIVE_ENCODED', !isSrgbFormat(emissive.format));
        }
    };

    return { name: 'Morglay cel shading', createAnimeMaterial, applyAnime, setAnimeHead, setAnimeCutout, inheritModelMaps, maps: MAPS, defines: DEFINES, sources };
}
