// Checks on the maps a PMX package brings along with its color textures (core/pmxImport.ts): which
// file is a toon mask, and which eye map has lost its alpha. PNG files are decoded here (the same
// decoder as heightmaps); a file that cannot be read passes no check.

import { decodePngRgba, isPng } from './heightmap';

const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

async function rgba(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array } | null> {
    if (!isPng(bytes)) return null;
    try {
        return await decodePngRgba(bytes);
    } catch {
        return null;
    }
}

/**
 * Whether an image is a mask in the character format's toon layout (R metal, G reflectance,
 * B light mask, A smoothness), as some packages name _M instead of _P: green near full almost
 * everywhere (reflectance), alpha spread over many values (smoothness). Effect masks and other
 * _M files fail it.
 */
export async function isToonMask(bytes: Uint8Array): Promise<boolean> {
    const img = await rgba(bytes);
    if (!img) return false;
    const n = img.width * img.height;
    let green = 0;
    let opaque = 0;
    const alphas = new Set<number>();
    for (let i = 0; i < n; i++) {
        if (img.data[i * 4 + 1] >= 200) green++;
        const a = img.data[i * 4 + 3];
        if (a === 255) opaque++;
        if (alphas.size < 16) alphas.add(a);
    }
    return green >= 0.75 * n && opaque < 0.9 * n && alphas.size >= 16;
}

/**
 * Whether an eye map has no alpha below full inside the circle that fills it, where an iris map
 * keeps its alpha for Iris Alpha Tint. MMD edits often drop it, and the tint then covers the whole
 * iris. A JPEG has no alpha at all.
 */
export async function isOpaqueIris(bytes: Uint8Array): Promise<boolean> {
    if (isJpeg(bytes)) return true;
    const img = await rgba(bytes);
    if (!img) return false;
    const { width: w, height: h, data } = img;
    for (let y = 0; y < h; y++) {
        const dy = ((y + 0.5) / h) * 2 - 1;
        for (let x = 0; x < w; x++) {
            const dx = ((x + 0.5) / w) * 2 - 1;
            if (dx * dx + dy * dy < 1 && data[(y * w + x) * 4 + 3] < 255) return false;
        }
    }
    return true;
}
