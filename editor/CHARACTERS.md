# Characters: cel shading and the character file

How to make an imported character look hand-drawn with the **Anime** shading of model slots, and how
to keep it in a character file (MGL) that carries the look, the rig's roles, the motion settings and
the license with it.

## 1. Bring the model in

Drop a model into the viewport: glTF / GLB, VRM 1.0, PMX (with its texture folder), or a character
file (MGL, `.glb`). A PMX or VRM comes in with every slot set to Anime already, guessed from the
material names; a plain glTF keeps its own materials until you switch them.

- **PMX:** drop the `.pmx` together with its textures.
  - A color texture named `…_D` brings the maps named like it along (names some model packages use):
    `…_N` (normal), `…_HN` (a hair's two normals, used before `…_N`, read as RG + BA), `…_P` (mask, read
    in the toon layout; a `…_M` stands in when there is no `…_P` and it is packed like one), `…_E`
    (emission).
  - MMD's edge size scales the kind's usual Outline. The hair's second layer over the eyes starts half
    see-through. Expression decals that MMD keeps hidden until a morph shows them are left out.
  - An iris map with no alpha (MMD edits often drop it) is reported: with Iris Circle on, its Iris Alpha
    Tint would cover the whole iris.
  - The kinds are guessed from the material names: check them.
  - Clip GLBs dropped with it are retargeted onto its bones.
- **VRM 1.0:** MToon materials become Anime slots by approximation (VRM 0.x shows as a plain model).
- **MGL:** everything comes back as it was written (section 4), except that additive blending comes back
  as blend.

## 2. Set up the slots

Select the model, open a material slot in the Inspector and set **Shading** to **Anime**. Then:

### 2.1 Kind

**Kind** says what the surface is, and gives the values of every setting you leave alone:

| Kind | Use it for | What it adds |
|---|---|---|
| Cloth | clothes, props, anything else | a GGX or toon highlight (**Highlight**) |
| Skin | body skin | an edge tint toward the silhouette, a soft skin highlight; lit skin keeps a little more of its own color |
| Face | the face | skin shading whose light/shade line comes from a **Face Shadow Map** that turns with the head |
| Hair | hair | two highlight lobes along the strands, optional strand breakup |
| Eye | irises, eye whites, lashes and brows drawn as eyes | lit level with the head, the iris set back behind the surface, a matcap on the cornea; no outline |
| Overlay | shadow cards painted onto skin or eyes | unlit; darkens what is under it (use the Multiply alpha mode) |

Start from the kind's values and change only what your art asks for.

### 2.2 Light and shade

- The key light is the scene's first directional light (the editor's daylight has intensity 2). The
  lit and the shaded side both take its color and intensity; surfaces facing down take less of it
  (up to 45% less, 30% on skin), as if the ground held some back. Every other light (more suns, point
  and spot lights) adds its own banded light on the lit side.
- How lit a point is comes from how much it faces the light: half-Lambert of its cosine plus **Shade
  Bias** (in cosine units). With a **Ramp** (a 256×1 texture, shade on the left, light on the right)
  that value is read through it: its alpha is how lit the surface is, and on skin its colors tint the
  edge between light and shade (brightness kept; on a face with a Face Shadow Map, the map's edge
  takes the color of the ramp's middle). Without one, **Shade Edge** and **Edge Softness** place and
  soften the line.
- The shade color is made from the base color: **Shade Brightness**, **Shade Saturation** and half
  of **Shade Light Tint** (warm on skin; half, so the shade keeps some of the base color's own hue),
  then **Shade Darkness**. Lit outlines take the same light in the shade. A **Shade Table** (a color lookup
  texture) gives it instead, when shade colors need more control. The shade is drawn a little deeper
  than that, and deeper again inside cast shadows (cast shadows read darker than the shade of a form).
- **Shade Bias** above 0 lights more of the surface, below 0 less.
- **Light Color** and **Light Tint** color the key light on this material only (warmer on skin).
- **Environment Light** (0 by default): how much the scene's sky (blurred) adds to the shade color.
- **Cast Shadows**: how much the key light's shadows of other objects turn it to shade.
- **Saturate Brights** keeps bright lit colors from washing out under a tone curve (none under a
  luminance of 0.35, 1.3 times the saturation from 0.85). Skin and faces keep it on top of their own
  lit saturation, so bright lit skin ends up about 1.7 times as saturated as painted.

### 2.3 Highlights

- **Cloth:** **Highlight** GGX or Toon; cloth's shade is a tenth lighter.
  - **GGX:** highlights from the mask's smoothness and **Reflectance** (metal takes the base color),
    from two lights: the key light, and a studio light kept by the camera (a little above the lens,
    slightly to one side and a little toward the key light), so polished parts keep a highlight that
    moves with the view. Non-metals' highlights are a little crisper than their smoothness says. A
    **Highlight Ramp** colors them: across, how near the nearer highlight's center a point is (by
    angle: the right end at the center, the middle at the highlight's half width, the left end at
    twice that); down, the smoothness (rough at the top, smooth and metal parts at the bottom).
  - **Toon:** a spot of **Highlight Strength**, cut at the highlight's half width.
  - With the toon mask layout the mask's smoothness is used as it is: the slot's Roughness factor
    applies to the glTF layout only.
- **Hair:** two rings of light run across the strands, each a smooth band where the strands turn the
  key light toward the camera. The main one is as strong as **Hair Highlight** and the mask's
  reflectance (green in the toon layout, painted strand by strand where the shine may show) let it;
  with a **Highlight Ramp** its color comes from the ramp (across: that strength; down: how far the
  hair turns from the camera, the top row facing it), else from the hair's own color. The second,
  **Hair Second Color/Sharpness** (sharper: narrower), shows where the mask says the strands are
  smooth (alpha). **Hair Highlight Shift** and **Hair Second Shift** move them along the strands
  (above 0.5 toward the tips, below toward the roots). The rings show within a window around the
  head facing the camera; **Hair Facing** narrows it (higher: they fade sooner as the hair turns
  away). **Hair Tilt** leans the strands toward the head's right. Strands run up the head along the surface; the
  toon mask's red makes them run along the hair cards instead (the mesh's V: lay cards out with their
  length along V). A **Strand Map** (bright on the lines between strands) or a **Strand Comb**
  darkens those lines where the hair shines.
- **Eye:** **Iris Circle** and **Iris Depth** set the iris back behind the surface, deepest in its
  middle, so it slides against the view; it is lit flat, as it sits behind the cornea. **Outside Iris
  Tint** brightens the tile outside the circle (catch lights painted in its
  corners), and **Iris Alpha Tint** multiplies in as far as the base map's alpha goes (all of it at
  alpha 1). The **Matcap** is the room seen on the cornea: it is added over the iris, read by the
  normal of the cornea (a sphere cap over the iris, as high as **Iris Bulge**), so the iris's upper
  part shows the matcap's upper half and its right part the right half (the image as a lit sphere
  seen from the camera, top up; a matcap stored with its v axis running up reads upside down, so
  flip it). **Matcap Strength** scales its color and **Matcap Alpha Color** is the color its alpha
  brings.

### 2.4 Faces

- The **Face Shadow Map** holds, per texel, how far around the head the light may go and still light
  that texel, painted for a light from the face's left; light from the right reads it mirrored. The
  value is the mean of red and green: a map may split it over the two for twice an 8-bit channel's
  steps (green holds the lower half of the range and stays full where red takes the upper half),
  and a grey map, the same in both, reads as painted. It is compared with the light's angle from the face's front, counted from 36° to
  150° (0 within 36° of the front, where every texel whose value clears the soft edge, about 0.3, is
  lit; 1 past 150°), in a wide soft
  step (**Edge Softness** plus 0.05, and up to 0.25 more while the light is in front). Paint it in the
  face's own UVs.
- **Face Mask** (red: where the edge tint goes, green: use the normals instead of the face map, for
  the neck and ears; blue: where the face takes cast shadows and which Edge Tint applies) and **Face
  Glow** (a soft glow that slides with the view: **Face Glow Shift** is how far along +u the map is
  read as the camera moves to the face's right). The edge tint grows toward the silhouette. **Alpha Darkens** darkens the surface where the base map's alpha is low.
- Face, hair and eye slots turn with the head bone. **Front Axis**, **Up Axis** and **Face Front Tilt**
  tell the material which way the head faces in the mesh's own space (glTF and VRM 1.0: +Z front,
  +Y up; meshes built Z-up: −Y or +Y front, +Z up). If the face shadow does not follow the light,
  these are the first thing to check.

### 2.5 Outlines

**Outline** (width: 1.25 mm per unit at a meter's distance, thinning slower than the view farther
away, never under a quarter of a pixel), **Outline Depth** (pushes the line back so the surface wins where
both meet), **Outline Brightness** and **Outline Saturation** (its color is the base color, much
darker: 35% of Outline Brightness, and more saturated), **Lit Outline** (shaded like the surface). **Outline Normals**: Mesh (the
mesh's normals; lines split at hard edges), Baked (smoothed directions the model brings; PMX
import and the character file make them), Tangent (directions stored in the tangent frame). An **Outline Map** paints
width (red) and depth (green) per vertex. Thin outlines look stepped without anti-aliasing: use
**View > Viewport Quality > Ultra** while you judge them.

### 2.6 Maps and their channels

| Map | Channels |
|---|---|
| Base color (the model's) | RGB color; A: opacity (and on irises, where the Iris Alpha Tint comes in) |
| Normal (the model's) | **Normal Map Layout**: RGB (RG used, z rebuilt), AG (packed: x = R × A, y = G), or RG + BA (a second normal for highlights) |
| Mask (the model's metallic-roughness) | **Mask Map Layout**: glTF (R occlusion, G roughness, B metal) or toon (R metal, G reflectance, B light mask, A smoothness; on hair, R runs the strands along the cards, G and A place the two highlights). In the glTF layout Metallic and Roughness scale the mask's metal and roughness; a toon mask is the surface's own and leaves both aside. Without a mask nothing is metal (a factor alone never turns a whole slot to metal) and the roughness is 0.7 (times Roughness) |
| Emission (the model's) | RGB; strength from the slot's Emission |
| Ramp, Highlight Ramp, Shade Table, Face Shadow Map, Face Mask, Strand Map, Overlay Mask, Outline Map | read as data (linear) |
| Matcap | color |
| Face Glow | read as data (linear), added as light |

The editor's shared library (**From the shared library** next to a map) has ramps, matcaps, strand
maps and a skin shade table made from formulas (CC0, `scripts/make-mgl-library.mjs`), to start from.

### 2.7 Layers: eyes through hair, shadow cards

A layered character draws in an order with stencil marks, so eyes and brows show through the
bangs and shadow cards darken only what they should. The character file names these as layers:

| Layer | For |
|---|---|
| body | face, skin, clothes (default) |
| eye | irises, eye whites, brows drawn over hair |
| hair | hair; it does not draw over eyes, so they show through |
| afterHair | parts drawn after the hair, over it (masks, accessories) |
| overlay | multiply shadow cards; a target says what they may darken (body, eye, hair or a mix) |
| hairOver | a see-through second hair layer over the eyes (a copy of the hair mesh, blended; PMX import starts it at half opacity) |
| transparent | see-through parts |

PMX import sets these from the material names, and a character file keeps them. The Inspector has no
row for a slot's layer yet: on other models, ask the assistant to set the slot's pass (its material
tool takes draw orders and stencil tests), or bring the model in as MGL. Layers need the scene's
**Stencil Buffer** (Environment), which takes effect after the editor or game starts again.

### 2.8 Own Tone Curve

**Own Tone Curve** makes the material map its colors to the display itself (a filmic curve around
Stephen Hill's fit of the ACES transforms, worked in ACES's wide gamut; it takes much of the
saturation out of bright colors, which Saturate Brights and skin's own step give back in part); the
scene's tone mapping is set to Display for it. Use it when the character should look the same whatever the scene's tone mapping is.

### 2.9 How it is drawn, and a shading of your own

The editor's cel shading is `src/engine/celShading.ts` (half-Lambert banding through a ramp, a face
shadow map, GGX highlights, hair highlights along shifted strand tangents, parallax for the iris, a
matcap, an inverted-hull outline, its own tone curve). Another shading can stand in for it on your machine: a JavaScript module outside the
repository that exports `makeShading(deps)` (the interface is `src/engine/animeShadingApi.ts`),
named by the file `editor/.shading-pack` (git ignores it) or by `MORGLAY_SHADING_PACK`. Open the
editor with `?shading=own` to compare the two. Only the dev server loads a pack: every build (the
editor's and the player's) uses the editor's own shading. The dev server listens on the network
(`host` in `vite.config.js`), so while a pack is named, devices on the same network can load it too.

To change the look of every character at once (the constants that weigh the terms), see
`CEL-SHADING.md`: how they were fitted to reference renders, and which one to change for which look.

## 3. Tuning against your art

1. Light the character with one directional light (the key light) and look from the front.
2. Set the ramp and shade values until the shade color matches your concept art; then turn the light
   to the side and check the face shadow line on the cheeks and nose.
3. Set highlights, then outlines (at the distance the character is usually seen), then layers.
4. Check from 30° and from the side: hair over eyes, outlines at the jaw and hair tips.

## 4. The character file (MGL)

A character file is one glTF 2.0 binary (`.glb`) with:

| Part | Carries |
|---|---|
| `MGL_character` | license data (authors, terms, what others may do), humanoid bone roles (VRM 1.0 names), expressions, look-at, face tilt |
| `MGL_materials_toon` | each material's Anime settings (only those that differ from its kind), its maps as textures, its layer |
| `MGL_springs` | swing chains and colliders |
| `_OUTLINE` vertex attribute | outline directions: VEC4 float, xyz the direction (in the mesh's space, or in the tangent frame where Outline Direction says so), w a reserved 1 that readers ignore |

- **Kind values:** the values of the kinds (`src/core/anime.ts`, `ANIME_KIND_PRESETS`) belong to the
  format (1.0-draft). A file is read with the values of the editor reading it.
- **PBR fallback:** every material also keeps one, so any glTF viewer opens the file. Overlays (multiply)
  are written as black at the alpha that darkens as much in a viewer that only blends; the editor reads
  them back as their multiply.
- **Textures:** they are inside the file.

- **Write:** select the character, **Inspector > Character File**, choose MGL (`.glb`) or VRM
  (`.vrm`, VRM 1.0 next to the same data). The file is checked as it is written; errors and warnings
  go to the console (for example a missing license URL).
- **Read:** drop the `.glb` or `.vrm` into the viewport.
- What is written: the slots' Anime settings and maps, a slot's own color texture, the model's
  normal, mask and emission maps, alpha modes, the parts you hid are left out, the motion
  settings (springs, expressions, blink).

**License data.** Fill in **Character File** (authors, license URL, what is allowed) before you
share a file. A model converted from somewhere else keeps its original terms in Source Terms; follow
them. Never put models or textures you are not allowed to share into a project you publish.
