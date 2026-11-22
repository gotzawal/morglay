/**
 * The glTF extensions this loader reads. A file that requires any other
 * extension cannot be drawn correctly, so it fails with a message naming
 * them instead of loading wrong.
 *
 * @internal
 * @group Loader
 */
export const SUPPORTED_GLTF_EXTENSIONS: readonly string[] = [
    'EXT_meshopt_compression',
    'EXT_texture_avif',
    'EXT_texture_webp',
    'KHR_draco_mesh_compression',
    'KHR_lights_punctual',
    'KHR_materials_clearcoat',
    'KHR_materials_emissive_strength',
    'KHR_materials_ior',
    'KHR_materials_sheen',
    'KHR_materials_specular',
    'KHR_materials_transmission',
    'KHR_materials_unlit',
    'KHR_materials_variants',
    'KHR_materials_volume',
    'KHR_mesh_quantization',
    'KHR_meshopt_compression',
    'KHR_texture_basisu',
    'KHR_texture_transform',
];

/** The required extensions of a glTF this loader does not read. */
export function unsupportedGltfExtensions(gltf: { extensionsRequired?: unknown }): string[] {
    const required = Array.isArray(gltf?.extensionsRequired) ? gltf.extensionsRequired : [];
    return required.filter((name) => typeof name === 'string' && !SUPPORTED_GLTF_EXTENSIONS.includes(name));
}

/** Throws when the glTF requires an extension this loader does not read. */
export function assertSupportedGltfExtensions(gltf: { extensionsRequired?: unknown }): void {
    const missing = unsupportedGltfExtensions(gltf);
    if (missing.length) throw new Error(`glTF requires unsupported extension${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
}

/**
 * The images a glTF texture can show, best first: KTX2 (KHR_texture_basisu),
 * WebP, AVIF, then its plain source. Loaders fetch the first up front and
 * the others only when the ones before fail.
 */
export function textureSources(texture: { source?: number; extensions?: { [name: string]: any } } | undefined | null): number[] {
    const ext = texture?.extensions;
    const out: number[] = [];
    for (const s of [ext?.KHR_texture_basisu?.source, ext?.EXT_texture_webp?.source, ext?.EXT_texture_avif?.source, texture?.source]) {
        if (typeof s === 'number' && !out.includes(s)) out.push(s);
    }
    return out;
}

/** The images the textures of a glTF prefer: the ones to load up front. */
export function preferredImages(gltf: { textures?: any[] }): Set<number> {
    const out = new Set<number>();
    for (const t of gltf?.textures ?? []) {
        const first = textureSources(t)[0];
        if (first !== undefined) out.add(first);
    }
    return out;
}

/**
 * The images the materials of a glTF read only as colors (base color,
 * emission, sheen and specular color). They hold sRGB-encoded values, so
 * they load in an sRGB format: sampling decodes them before filtering, and
 * their mipmaps are averaged in linear light, as other renderers do. An
 * image a material also reads as data (a normal map, a mask) is not one.
 */
export function colorImages(gltf: { materials?: any[]; textures?: any[] }): Set<number> {
    const color = new Set<number>();
    const data = new Set<number>();
    const images = (info: any): number[] => {
        const texture = typeof info?.index === 'number' ? gltf?.textures?.[info.index] : undefined;
        return texture ? textureSources(texture) : [];
    };
    for (const m of gltf?.materials ?? []) {
        const ext = m?.extensions ?? {};
        const colors = [m?.pbrMetallicRoughness?.baseColorTexture, m?.emissiveTexture, ext.KHR_materials_sheen?.sheenColorTexture, ext.KHR_materials_specular?.specularColorTexture];
        const datas = [
            m?.normalTexture, m?.occlusionTexture, m?.pbrMetallicRoughness?.metallicRoughnessTexture,
            ext.KHR_materials_clearcoat?.clearcoatTexture, ext.KHR_materials_clearcoat?.clearcoatRoughnessTexture, ext.KHR_materials_clearcoat?.clearcoatNormalTexture,
            ext.KHR_materials_transmission?.transmissionTexture, ext.KHR_materials_volume?.thicknessTexture,
            ext.KHR_materials_sheen?.sheenRoughnessTexture, ext.KHR_materials_specular?.specularTexture,
        ];
        for (const info of colors) for (const i of images(info)) color.add(i);
        for (const info of datas) for (const i of images(info)) data.add(i);
    }
    for (const i of data) color.delete(i);
    return color;
}
