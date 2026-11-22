import { describe, expect, it } from 'vitest';
import { encodePngRgba } from '../../src/core/heightmap';
import { isOpaqueIris, isToonMask } from '../../src/core/pmxMaps';

/** A w x h RGBA image from a function of the pixel. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number, number]): Uint8Array {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(at(x, y), (y * w + x) * 4);
    return data;
}

describe('PMX package maps', () => {
    it('takes a mask packed in the toon layout and leaves other masks alone', async () => {
        // Reflectance (green) near full, smoothness (alpha) spread: a toon mask.
        const toon = await encodePngRgba(32, 32, image(32, 32, (x, y) => [x < 8 ? 255 : 0, 255, 128, (x * 8 + y) & 255]));
        expect(await isToonMask(toon)).toBe(true);
        // A grey effect mask with no alpha, and one with green low: not.
        const grey = await encodePngRgba(32, 32, image(32, 32, (x) => [x * 8, x * 8, x * 8, 255]));
        expect(await isToonMask(grey)).toBe(false);
        const dark = await encodePngRgba(32, 32, image(32, 32, (x, y) => [0, 40, 128, (x * 8 + y) & 255]));
        expect(await isToonMask(dark)).toBe(false);
        expect(await isToonMask(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    });

    it('finds iris maps whose alpha is full inside the circle', async () => {
        const opaque = await encodePngRgba(16, 16, image(16, 16, () => [90, 120, 200, 255]));
        expect(await isOpaqueIris(opaque)).toBe(true);
        // An iris map that keeps its alpha: 0 over the iris (Iris Alpha Tint only where it is painted in).
        const kept = await encodePngRgba(16, 16, image(16, 16, (x, y) => [90, 120, 200, (x - 7.5) ** 2 + (y - 7.5) ** 2 < 16 ? 0 : 255]));
        expect(await isOpaqueIris(kept)).toBe(false);
        // Only the circle counts: transparent corners leave it opaque.
        const corners = await encodePngRgba(16, 16, image(16, 16, (x, y) => [90, 120, 200, (x - 7.5) ** 2 + (y - 7.5) ** 2 < 64 ? 255 : 0]));
        expect(await isOpaqueIris(corners)).toBe(true);
        // A JPEG has no alpha.
        expect(await isOpaqueIris(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    });
});
