// The character format's shared texture library (editor/CHARACTERS.md, served at /mgl-library/):
// ramps, matcaps, strand patterns and a color table, each made here from a
// formula, so the whole library is ours and goes out as CC0. Every texture is
// checked against the format (ramps rise from the shade side, strands tile, the
// table has the layout the shading reads) and written as a PNG with a
// library.json that lists them by their library: URI.
//
//   node editor/scripts/make-mgl-library.mjs editor/mgl-library
//
// No dependencies (Node 18+): PNGs are written with node:zlib.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- PNG

const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}
/** An 8-bit RGBA PNG of `rgba` (values 0..1, row by row from the top). */
function png(width, height, rgba) {
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + width * 4)] = 0;
        for (let i = 0; i < width * 4; i++) raw[y * (1 + width * 4) + 1 + i] = Math.round(Math.min(1, Math.max(0, rgba[y * width * 4 + i])) * 255);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- math

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const encode = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const decode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** A bump around `at`, 1 there, falling off over `width`. */
const bump = (x, at, width) => Math.exp(-(((x - at) / width) ** 2));
/** A small seeded random generator (mulberry32): the same library every run. */
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------- the textures

/**
 * A ramp (CHARACTERS.md 2.2): 256 across, shade side on the left. RGB the tint near the
 * edge between light and shade (multiplies the light), A how lit.
 */
function ramp(lit, tint) {
    const w = 256;
    const out = new Float32Array(w * 4);
    for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const [r, g, b] = tint(u);
        out.set([r, g, b, lit(u)], x * 4);
    }
    return { width: w, height: 1, data: out };
}
/** A tint that leans toward `color` in a band around the edge. */
const edgeTint = (color, at, width) => (u) => color.map((c) => 1 - (1 - c) * bump(u, at, width));
const white = () => [1, 1, 1];

const RAMPS = {
    soft: { make: () => ramp((u) => smoothstep(0.3, 0.7, u), white), description: 'A soft edge: light fades into shade over a wide band.' },
    hard: { make: () => ramp((u) => smoothstep(0.495, 0.505, u), white), description: 'A hard edge: one step from shade to light.' },
    skin: {
        make: () => ramp((u) => smoothstep(0.42, 0.6, u), edgeTint([1, 0.8, 0.74], 0.5, 0.07)),
        description: 'Skin: a fairly sharp edge with a warm red band along it, like light passing through skin.',
    },
    hair: {
        make: () => ramp((u) => smoothstep(0.45, 0.58, u), edgeTint([0.9, 0.93, 1], 0.5, 0.06)),
        description: 'Hair: a sharp edge (its slightly cool band shows only where a ramp\'s color is used, on skin and faces).',
    },
};

/**
 * A matcap (CHARACTERS.md 2.3, sRGB): what a sphere looks like by its view-space
 * normal, x right and y up across the image; black outside the sphere.
 */
function matcap(shade) {
    const w = 256;
    const out = new Float32Array(w * w * 4);
    for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
            const nx = ((x + 0.5) / w) * 2 - 1;
            const ny = 1 - ((y + 0.5) / w) * 2;
            const r2 = nx * nx + ny * ny;
            // Antialiased edge of the sphere.
            const inside = clamp01((1 - Math.sqrt(r2)) * w * 0.5);
            const c = r2 < 1 ? shade(nx, ny, Math.sqrt(Math.max(0, 1 - r2))) : [0, 0, 0];
            out.set([...c.map((v) => encode(clamp01(v) * inside)), 1], (y * w + x) * 4);
        }
    }
    return { width: w, height: w, data: out };
}
/** A soft round spot: 1 in its middle, 0 past its radius. */
const spot = (nx, ny, cx, cy, radius, soft) => 1 - smoothstep(radius - soft, radius, Math.hypot(nx - cx, ny - cy));

const MATCAPS = {
    'eye-clear': {
        // Added on an iris, which reads a matcap by the cornea's normal (the room seen on the cornea:
        // its upper left shows the matcap's upper left): a bright window reflection above to the
        // left and a faint one below to the right; black adds nothing.
        make: () => matcap((nx, ny) => {
            const k = spot(nx, ny, -0.32, 0.42, 0.16, 0.05) + 0.45 * spot(nx, ny, 0.38, -0.36, 0.07, 0.03);
            return [k, k, k];
        }),
        description: 'For eyes (added): a clear window highlight up left and a small one down right.',
    },
    'metal-soft': {
        // A grey studio: bright above, a horizon band, dark below, the rim darker.
        make: () => matcap((nx, ny, nz) => {
            const sky = mix(0.12, 0.85, smoothstep(-0.25, 0.7, ny));
            const horizon = 0.3 * bump(ny, 0.05, 0.07);
            const rim = 0.55 + 0.45 * nz;
            const k = (sky + horizon) * rim;
            return [k, k, k];
        }),
        description: 'A soft grey studio, bright above with a horizon line (the shading adds matcaps on eyes only: on a cornea it gives a dim, even reflection).',
    },
};

/**
 * A strand pattern (CHARACTERS.md 2.3, R): stripes across u that tile both ways, the
 * hair's strands when u runs across them. Sums of sines of whole periods, so
 * the left edge meets the right and the top the bottom.
 */
function strands(seed, frequencies, alongPeriods) {
    const w = 256;
    const h = 64;
    const rnd = random(seed);
    const waves = frequencies.map((f) => ({ f, amp: (0.5 + rnd()) / frequencies.length, phase: rnd() * Math.PI * 2, drift: Math.round(rnd() * 2 - 1) }));
    const out = new Float32Array(w * h * 4);
    let lo = Infinity;
    let hi = -Infinity;
    const raw = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const v = y / h;
        for (let x = 0; x < w; x++) {
            const u = x / w;
            let s = 0;
            // Each wave leans a little along v (a whole number of periods), so strands are not perfectly straight.
            for (const wv of waves) s += wv.amp * Math.sin(2 * Math.PI * (wv.f * u + wv.drift * alongPeriods * v) + wv.phase);
            raw[y * w + x] = s;
            lo = Math.min(lo, s);
            hi = Math.max(hi, s);
        }
    }
    for (let i = 0; i < w * h; i++) {
        const k = (raw[i] - lo) / (hi - lo);
        out.set([k, k, k, 1], i * 4);
    }
    return { width: w, height: h, data: out };
}

const STRANDS = {
    fine: { make: () => strands(17, [16, 23, 32, 41, 64], 1), description: 'Fine strands: many thin stripes (tile it about 8 times across).' },
    coarse: { make: () => strands(29, [4, 6, 9, 12, 16], 1), description: 'Coarse strands: a few broad locks.' },
};

/**
 * A color table (CHARACTERS.md 2.2, Shade Table): n slices of n x n side by side, blue picking the
 * slice, red across it, green up it; looked up and filled with sRGB-encoded
 * colors. `shade` takes a linear lit color to its linear shade color.
 */
function table(n, shade) {
    const out = new Float32Array(n * n * n * 4);
    for (let b = 0; b < n; b++) {
        for (let y = 0; y < n; y++) {
            const g = n - 1 - y;
            for (let r = 0; r < n; r++) {
                const lin = [r, g, b].map((v) => decode(v / (n - 1)));
                const s = shade(lin).map((v) => encode(clamp01(v)));
                out.set([...s, 1], (y * n * n + b * n + r) * 4);
            }
        }
    }
    return { width: n * n, height: n, data: out };
}
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const LUTS = {
    'skin-warm': {
        // Skin in shade: more saturated and warmer, as the skin kind's shade from its settings (saturation 1.3, a warm tint) but bent toward red where it is light.
        make: () =>
            table(16, (c) => {
                const y = luminance(c);
                const sat = c.map((v) => Math.max(0, mix(y, v, 1.3)));
                const warm = [1.1, 0.84, 0.8];
                return sat.map((v, i) => v * mix(1, warm[i], 0.6 + 0.4 * y));
            }),
        description: 'Skin shade colors: saturated and warm (a slot\'s Shade Table).',
    },
};

// ---------------------------------------------------------------- checks

function check(name, kind, tex) {
    const errors = [];
    const { width: w, height: h, data } = tex;
    const at = (x, y, c) => data[(y * w + x) * 4 + c];
    if (kind === 'ramp') {
        if (w !== 256) errors.push('a ramp is 256 wide');
        for (let y = 0; y < h; y++) {
            for (let x = 1; x < w; x++) if (at(x, y, 3) < at(x - 1, y, 3) - 1e-6) errors.push(`row ${y}: how lit falls at ${x} (a ramp rises from the shade side)`);
            if (at(0, y, 3) > 0.02 || at(w - 1, y, 3) < 0.98) errors.push(`row ${y}: does not go from shade (0) to light (1)`);
        }
    }
    if (kind === 'strand') {
        // Tiling: the step over each edge is no bigger than the largest step inside.
        let inside = 0;
        let across = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 1; x < w; x++) inside = Math.max(inside, Math.abs(at(x, y, 0) - at(x - 1, y, 0)));
            across = Math.max(across, Math.abs(at(0, y, 0) - at(w - 1, y, 0)));
        }
        let insideV = 0;
        let acrossV = 0;
        for (let x = 0; x < w; x++) {
            for (let y = 1; y < h; y++) insideV = Math.max(insideV, Math.abs(at(x, y, 0) - at(x, y - 1, 0)));
            acrossV = Math.max(acrossV, Math.abs(at(x, 0, 0) - at(x, h - 1, 0)));
        }
        if (across > inside * 1.05 + 1e-6) errors.push(`does not tile across (${across.toFixed(3)} at the edge, ${inside.toFixed(3)} inside)`);
        if (acrossV > insideV * 1.05 + 1e-6) errors.push(`does not tile along (${acrossV.toFixed(3)} at the edge, ${insideV.toFixed(3)} inside)`);
    }
    if (kind === 'lut') {
        if (w !== h * h) errors.push('a color table is size² wide and size tall');
        // Black stays black; a grey's shade is no lighter than the grey (by luminance) and warm (red over blue).
        if (at(0, h - 1, 0) > 0.01 || at(0, h - 1, 1) > 0.01) errors.push('black does not stay black');
        const mid = Math.round((h - 1) / 2);
        const grey = [at(mid * h + mid, h - 1 - mid, 0), at(mid * h + mid, h - 1 - mid, 1), at(mid * h + mid, h - 1 - mid, 2)];
        if (!(grey[0] > grey[2])) errors.push('a grey does not turn warm');
        if (luminance(grey.map(decode)) > decode(mid / (h - 1)) + 1e-6) errors.push('a grey\'s shade is lighter than the grey');
    }
    if (kind === 'matcap') {
        if (at(0, 0, 0) + at(0, 0, 1) + at(0, 0, 2) > 1e-6) errors.push('the corner (outside the sphere) is not black');
    }
    return errors.map((e) => `${name}: ${e}`);
}

// ---------------------------------------------------------------- writing

const outs = process.argv.slice(2);
if (!outs.length) {
    console.error('usage: node make-mgl-library.mjs <out dir> [<another out dir> ...]');
    process.exit(2);
}
// Each kind with the slot's map it is made for (rampMap, matcapMap, hairMap, shadeLut).
const groups = [
    ['ramp', RAMPS, 'rampMap', 'linear'],
    ['matcap', MATCAPS, 'matcapMap', 'srgb'],
    ['strand', STRANDS, 'hairMap', 'linear'],
    ['lut', LUTS, 'shadeLut', 'linear'],
];
const items = [];
const errors = [];
const files = new Map();
for (const [kind, list, use, space] of groups) {
    for (const [name, item] of Object.entries(list)) {
        const tex = item.make();
        errors.push(...check(`${kind}/${name}`, kind, tex));
        files.set(`${kind}/${name}.png`, png(tex.width, tex.height, tex.data));
        items.push({ uri: `library:${kind}/${name}`, file: `${kind}/${name}.png`, use, space, size: [tex.width, tex.height], description: item.description });
    }
}
if (errors.length) {
    for (const e of errors) console.error(e);
    process.exit(1);
}
const manifest = {
    name: 'MGL shared texture library',
    specVersion: '1.0-draft',
    license: 'CC0-1.0',
    note: 'Made from formulas by editor/scripts/make-mgl-library.mjs; no image comes from anywhere else.',
    items,
};
for (const dir of outs) {
    for (const [file, bytes] of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), bytes);
    }
    writeFileSync(join(dir, 'library.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${dir}: ${items.length} textures`);
}
