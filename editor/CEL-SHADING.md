# Tuning the cel shading

How the constants of the editor's cel shading (`src/engine/celShading.ts`) were fitted to reference
renders, and which term to change, in which direction, for a given look. A slot's settings (CHARACTERS.md, section 2)
change one material; the constants here change every character, so change them only to move the
whole look.

## 1. Fitting it to reference renders

1. **Fix everything but the shading.** Use the same model, camera, light direction and resolution on
   both sides. Turn swing springs and blinking off. Turn the slots' Own Tone Curve on and set the
   scene's tone mapping to Display.
2. **Measure; don't judge by eye.** Compare the frames numerically:
   - **8-px cells:** average each color channel over 8×8 cells, keeping cells where either frame has
     the model, then take the mean of the channels' absolute differences. A strand or an outline a
     pixel off barely moves it.
   - **Color, not only luminance:** a luminance-only score once picked red streaks in hair that matched
     in brightness but not in hue.
   - **One feature's pixels:** for a single feature, score only its pixels. Use skin-colored pixels for
     the face shadow, and per-material masks (from a temporary debug output) for metal or glossy cloth.
3. **Read the shape of the error before turning knobs.** Split a feature's signed difference by the
   reference's brightness:
   - **The same sign everywhere:** the term's strength is off (a scale or an offset).
   - **Too bright where the reference is dark, too dark where it is bright:** placement or shape is
     off. The term peaks in the wrong place, and no strength fixes it.

   If sweeping every knob leaves the error flat, the form is wrong, not the values.
4. **Sweep, then bake.** Open the constants as temporary vec4 uniforms. Sweep them by coordinate
   descent, keeping the current value among the candidates. Write the best values back as constants.
   Pipelines are cached by shader name, so bump `morglay_cel_surface_N` whenever the WGSL changes.
5. **Check wide.** Score the main views, a sweep of light angles around the face (−120° to 120°) and
   close-ups of the clothes, and look at magnified crops before deciding. Keep a value that costs a
   little score if zero would switch a feature off.

## 2. What to change for which look

### Overall

| Look | Term | Change |
|---|---|---|
| Brighter or darker overall (Own Tone Curve) | exposure `3.2` in `celFilmic` | raise / lower |
| More or less color going into the curve | saturation `1.2` in `celFilmic` | raise / lower |
| Downward-facing surfaces darker (sky kept from them) | `occlude` 0.45 (skin 0.3) in `celGround` | raise |

Point and spot lights have no constant of their own: `celOtherLights` takes them as the engine's lit
materials do (color × 2.4 to the light's linear value, the engine's falloff), at the key light's
`0.5`. Change the light, not the shading.

### Light and shade

| Look | Term | Change |
|---|---|---|
| Deeper form shadow | `formShade` 0.75 on the shade color (`CEL_SHADING` in `src/core/anime.ts`, which the VRM conversion reads too) | lower |
| Deeper cast shadows | `0.8` in `mix(1, 0.8, inCast)` | lower |
| Cloth's shade lighter than skin's | `clothShade` 1.1 (`CEL_SHADING`) | raise |
| Skin keeps more light where it turns down | skin's `occlude` 0.3 in `celGround` | lower |
| The shade keeps less of the base color's hue | the `0.5` in `celShadeTint` (how much of Shade Light Tint the shade, and a lit outline in shade, take) | raise |
| Bright lit colors less washed out | Saturate Brights: `1.3` over `smoothstep(0.35, 0.85, luminance)` | raise 1.3, or lower the window |
| Skin's light/shade edge more colored by the ramp | `edgeK` 0.5 (0.25 with a face map, where the edge takes the ramp's middle color) | raise |
| Lit skin warmer, less pale | the `0.3` in `1.0 + 0.3 * (1.0 - smoothstep(0.6, 0.9, sat))` (skin only) | raise |
| Makeup painted on the skin (around the eyes, blush) less vivid next to it | the window `0.6`–`0.9` where that boost fades out by the color's own saturation (`(max - min) / max`, linear; pale skin is near 0.45) | lower both |
| Skin's silhouette tint closer to the edge | `1.0` in `smoothstep(0.15, 1.0, facing)` | lower |
| Skin's sheen softer | its α floor `0.25` in the skin GGX (the sheen shows only where the key light reaches) | raise |

Lit skin takes both saturation steps: its own (1.3 on pale skin), and Saturate Brights on top (the
skin kinds keep it on). Together, fully lit pale skin is 1.3 times as saturated up to a luminance of
0.35, 1.38 at 0.5, 1.5 at 0.6, 1.61 at 0.7 and 1.69 from 0.85. Turn Saturate Brights off on a skin
slot to keep only the first.

The first fades out on colors that are already saturated, as a vibrance control does. A flat 1.3
turned the makeup painted above the lashes into a vivid orange band under the double-eyelid line,
and the band read as a second line. Pale skin scored the same with and without the fade.

### Face shadow

| Look | Term | Change |
|---|---|---|
| The face stays fully lit longer as the light turns | window start 36° (`0.2` in `celFaceLight`) | raise |
| The face is fully shaded sooner | window end 150° (`0.2 + 0.6333`) | lower 0.6333 |
| Softer edge | `0.05 + 0.25 · (1 − around)` | raise; the second part softens it while the light is in front |
| Cast shadows reach less of the face's far side (where the face map gives the light, the head's own shadow is left out) | cast shadows fade in over `smoothstep(0.0, 0.4, N·L)` of the mesh normal (`celShadeSurface`) | raise 0.4 to let them in later; the face mask's green parts (neck, ears) are not gated |

The gate exists because the shadow map cannot tell the head's own shadow from anything else's. On a
surface turned from the light it only ever finds the head itself, since a closed shape hides its
far side from the light. Without the gate, that shadow fell on the far cheek and jaw as a patch the
face map never drew, whenever the map lit them. The gate covers both the light and the deeper cast
shade.

### Cloth and metal highlight

| Look | Term | Change |
|---|---|---|
| Highlights follow the view more (chrome-like metal) | the studio light's weight `0.7` (the key light's `0.5`) | raise the studio light's |
| The studio highlight sits higher, to one side, or nearer the key light's | `0.35` (above the lens), `0.1` (to its right), `0.15` (toward the key light) in `Ls` | raise / lower; all 0 put the light on the lens |
| Brighter highlights | the `0.5` and `0.7` weights | raise (it brightens light and dark metals alike) |
| Crisper sheen on leather and other polished non-metals | `0.7` on non-metals' roughness (`mix(0.7, 1, metal)`) | lower |
| The Highlight Ramp's bright end over more of the highlight | the `2.0` in `celNearPeak` (the ramp's left end at twice the half width) | raise |
| Tiny mirror-smooth spots blow out | cap `8` | lower |

### Eye

| Look | Term | Change |
|---|---|---|
| Reflections spread wider over the iris | Iris Bulge (the cornea's rise, a setting) | raise |
| Brighter reflections | Matcap Strength (a setting), or a brighter matcap | raise |

### Hair

| Look | Term | Change |
|---|---|---|
| Stronger main ring | `0.14` (and `0.68` on the ring before the ramp) | raise |
| Narrower main ring | half-width `0.086` (a cosine) | lower |
| Narrower second ring, strand band | Hair Second Sharpness, Strand Power (settings; `celRingWidth` turns them into half-widths) | raise |
| Rings fade sooner around the head | Hair Facing (a setting; the window is twice the angle at which a cosine to that power falls to half) | raise |
| Stronger second ring | `0.25` | raise |
| Darker strand lines | `1.4` in `dark` | raise |
| A shift setting moves the rings further | `1.5` in `celHairShift` | raise |
| Shift settings of 0.5 put the rings where the strands' own lean does | `-0.09` in `celHairShift` (fitted: a little toward the tips) | 0 |
| Without a Highlight Ramp, a brighter main ring | `1.8` and the `0.08` lift on the hair's color (the lift keeps a ring on dark hair) | raise |
| Without lobes, a narrower soft ring | sharpness `32` in `celRingWidth(32.0)` | raise |

### Outline

| Look | Term | Change |
|---|---|---|
| Thicker | `lineWidth` 0.00125 m per unit of Outline at a meter (`CEL_SHADING`; the VRM conversion's widths follow it) | raise |
| Thins more slowly with distance | `lineThinning`, the power 0.75 on the distance (`CEL_SHADING`) | lower |
| Darker | `lineShare` 0.35 × Outline Brightness (`CEL_SHADING`) | lower |
| Never thinner than | a quarter of a pixel | the `0.5` (in clip space, where the screen's height spans 2) |

## 3. What did not work

- **Environment reflections on metal:** every variant scored worse. Cel-shaded metal reads as metal
  from a highlight that follows the view and from its ramp colors, not from reflected surroundings.
- **Taking the diffuse light away from metal (physically right):** metal turned much too dark. Keep
  the diffuse.
- **The key light's GGX alone on cloth:** the highlights came out small and dark and vanished on the
  side away from the light. The studio light by the camera fixes that without bending the key
  light's highlight.
- **Light bounced from the ground into the shade:** the fit kept it at 0 for this look; it stays an
  option for a softer style.
- **Brighter or more studio-weighted highlights on leather:** stronger non-metal reflectance or a
  larger share for the studio light turned the leather into satin. A glossy finish layer did not help
  either. Crisper non-metal highlights (a lower roughness) did.
- **Highlights in the shade dimmed as much as the base color is there** (the shaded color's share of
  the lit one, instead of the fill level): leather in the shade came out too dark. **Leaving the
  studio light out of the key light's shade** (it sits by the camera): clothes on the side away
  from the light came out too bright under a side light. Both scored worse than dimming every
  highlight to the fill level.
- **A Blinn sheen leaned toward the view on cloth:** thin, plastic-looking streaks.
- **The toon mask's smoothness multiplied by the material's Roughness factor:** imported materials
  often carry 0 there, which made every texel a mirror. The toon layout uses the mask as it is.
- **Raising a metal's glint for its brightest parts:** light and grey metals share the term, so
  brighter silver parts came with over-bright grey parts. Matching both would need a term that tells
  them apart.
- **Gating only the face's light, not the deeper cast shade, on the face's far side:** half of the
  gain was lost. That shade then stays a fifth darker wherever the face map shades the far side.
  The start of the gate (0 to 0.2, −0.1 to 0.1, 0 to 0.4) hardly mattered.
- **A power falloff for the skin's saturation boost** (`1 + a · (1 − sat)^p`): with `p` 1 the band
  of painted makeup stayed too vivid. With `p` 2 the skin scored worse: skin that is darker or warmer,
  and so more saturated, lost its boost. A window over the saturation leaves pale and warm skin
  alone.
