import { describe, expect, it } from 'vitest';
import { encodingForTextures, fileByPath, packagePathOf, unpackModelPackage } from '../../src/core/modelPackage';
import { parsePmx } from '../../src/core/pmx';
import { crc32, listZip, readZip, zipNameEncodings } from '../../src/core/zip';

interface Entry {
    /** The name as stored: a string is written as UTF-8. */
    name: string | Uint8Array;
    data: string | Uint8Array;
    /** General purpose flags (0x0800: the name is UTF-8). */
    flags?: number;
    /** Extra field of the central directory record. */
    extra?: Uint8Array;
}

/** A zip of stored entries, written by hand so names, flags and extra fields are as given. */
function zipOf(entries: Entry[]): Blob {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = typeof e.name === 'string' ? enc.encode(e.name) : e.name;
        const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
        const extra = e.extra ?? new Uint8Array(0);
        const flags = e.flags ?? (typeof e.name === 'string' ? 0x0800 : 0);
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, flags, true);
        lv.setUint32(14, crc32(data), true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, name.length, true);
        local.set(name, 30);
        parts.push(local, data);
        const cd = new Uint8Array(46 + name.length + extra.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, flags, true);
        cv.setUint32(16, crc32(data), true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, extra.length, true);
        cv.setUint32(42, offset, true);
        cd.set(name, 46);
        cd.set(extra, 46 + name.length);
        central.push(cd);
        offset += local.length + data.length;
    }
    const size = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, size, true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end] as BlobPart[]);
}

const bytes = (...b: number[]) => new Uint8Array(b);
const concat = (...a: Uint8Array[]) => {
    const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of a) {
        out.set(x, o);
        o += x.length;
    }
    return out;
};
const ascii = (s: string) => new TextEncoder().encode(s);
// Shift-JIS: モデル (83 82 83 66 83 8B) and 髪 (94 AF).
const SJIS_MODEL = bytes(0x83, 0x82, 0x83, 0x66, 0x83, 0x8b);
const SJIS_HAIR = bytes(0x94, 0xaf);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** An Info-ZIP Unicode Path field for the stored name `raw`. */
function unicodePathField(raw: Uint8Array, name: string): Uint8Array {
    const utf8 = ascii(name);
    const field = new Uint8Array(9 + utf8.length);
    const v = new DataView(field.buffer);
    v.setUint16(0, 0x7075, true);
    v.setUint16(2, 5 + utf8.length, true);
    field[4] = 1;
    v.setUint32(5, crc32(raw), true);
    field.set(utf8, 9);
    return field;
}

/** A tiny PMX 2.0 (one quad, one material) whose one texture is `texture`. */
function tinyPmx(texture: string): Uint8Array {
    const out: number[] = [];
    const u8 = (v: number) => out.push(v & 255);
    const i8 = (v: number) => u8(v < 0 ? 256 + v : v);
    const u16 = (v: number) => { u8(v); u8(v >> 8); };
    const i32 = (v: number) => new Uint8Array(new Int32Array([v]).buffer).forEach((x) => u8(x));
    const f32 = (v: number) => new Uint8Array(new Float32Array([v]).buffer).forEach((x) => u8(x));
    const text = (s: string) => { i32(s.length * 2); for (const ch of s) u16(ch.charCodeAt(0)); };
    [0x50, 0x4d, 0x58, 0x20].forEach(u8);
    f32(2);
    u8(8);
    [0, 0, 1, 1, 1, 1, 1, 1].forEach(u8);
    text('model'); text('model'); text(''); text('');
    const quad = [[-1, 0, 0, 0, 1], [1, 0, 0, 1, 1], [1, 2, 0, 1, 0], [-1, 2, 0, 0, 0]];
    i32(4);
    quad.forEach(([x, y, z, u, v]) => { f32(x); f32(y); f32(z); f32(0); f32(0); f32(-1); f32(u); f32(v); u8(0); i8(0); f32(1); });
    i32(6);
    [0, 1, 2, 0, 2, 3].forEach(u8);
    i32(1); text(texture);
    i32(1);
    text('髪'); text('hair');
    f32(1); f32(1); f32(1); f32(1);
    f32(0); f32(0); f32(0); f32(5);
    f32(0.5); f32(0.5); f32(0.5);
    u8(0x10);
    f32(0); f32(0); f32(0); f32(1); f32(0.6);
    i8(0); i8(-1); u8(0); u8(1); u8(1);
    text('');
    i32(6);
    i32(1);
    text('センター'); text('center'); f32(0); f32(0); f32(0); i8(-1); i32(0); u16(0x0001); i8(1);
    i32(0); i32(0); i32(0); i32(0);
    return new Uint8Array(out);
}

describe('zip names', () => {
    it('reads names marked as UTF-8 as UTF-8', async () => {
        const files = await readZip(zipOf([{ name: 'モデル/髪.png', data: 'x' }]));
        expect([...files.keys()]).toEqual(['モデル/髪.png']);
    });

    it('reads unmarked names in the encoding that reads them all (Shift-JIS)', async () => {
        const name = concat(SJIS_MODEL, ascii('/'), SJIS_HAIR, ascii('_D.png'));
        const zip = zipOf([{ name, data: 'x', flags: 0 }, { name: ascii('readme.txt'), data: 'x', flags: 0 }]);
        expect(zipNameEncodings(await listZip(zip))[0]).toBe('shift_jis');
        expect([...(await readZip(zip)).keys()]).toEqual(['モデル/髪_D.png', 'readme.txt']);
    });

    it('takes a Unicode Path field over the stored name', async () => {
        const raw = concat(SJIS_HAIR, ascii('.png'));
        const files = await readZip(zipOf([{ name: raw, data: 'x', flags: 0, extra: unicodePathField(raw, 'hair.png') }]));
        expect([...files.keys()]).toEqual(['hair.png']);
    });

    it('still reads what createZip-style writers make, stored data intact', async () => {
        const files = await readZip(zipOf([{ name: 'a/b.txt', data: 'hello' }]));
        expect(await files.get('a/b.txt')!.text()).toBe('hello');
    });
});

describe('model packages', () => {
    it('is not a package when the zip is a project (project.json at its root)', async () => {
        expect(await unpackModelPackage(zipOf([{ name: 'project.json', data: '{}' }, { name: 'assets/a.png', data: PNG }]))).toBeNull();
    });

    it('unpacks a PMX with its texture folders, leaving out readme files and what zip tools add', async () => {
        const pkg = (await unpackModelPackage(zipOf([
            { name: 'Pkg/model.pmx', data: tinyPmx('tex\\hair_D.png') },
            { name: 'Pkg/tex/hair_D.png', data: PNG },
            { name: 'Pkg/readme.txt', data: 'terms' },
            { name: '__MACOSX/Pkg/._model.pmx', data: 'x' },
        ])))!;
        expect(pkg.models).toEqual(['Pkg/model.pmx']);
        expect(pkg.files.map((f) => f.name)).toEqual(['model.pmx', 'hair_D.png']);
        expect(pkg.files.map(packagePathOf)).toEqual(['Pkg/model.pmx', 'Pkg/tex/hair_D.png']);
        expect(pkg.skipped.sort()).toEqual(['Pkg/readme.txt', '__MACOSX/Pkg/._model.pmx'].sort());
        expect(new Uint8Array(await pkg.files[0].arrayBuffer())).toEqual(tinyPmx('tex\\hair_D.png'));
    });

    it('reads unmarked names in the encoding that finds the textures the PMX names', async () => {
        const texture = concat(ascii('tex/'), SJIS_HAIR, ascii('_D.png'));
        const zip = zipOf([
            { name: ascii('model.pmx'), data: tinyPmx('tex\\髪_D.png'), flags: 0 },
            { name: texture, data: PNG, flags: 0 },
        ]);
        // Several encodings read these bytes; only one of them gives the name the model asks for.
        const encodings = zipNameEncodings(await listZip(zip));
        expect(encodings.length).toBeGreaterThan(1);
        expect(new TextDecoder(encodings.find((e) => e !== 'shift_jis')!).decode(SJIS_HAIR)).not.toBe('髪');
        const pkg = (await unpackModelPackage(zip))!;
        expect(pkg.encoding).toBe('shift_jis');
        expect(pkg.files.map((f) => f.name)).toContain('髪_D.png');
        expect(parsePmx(tinyPmx('tex\\髪_D.png').buffer as ArrayBuffer).textures).toEqual(['tex\\髪_D.png']);
    });

    it('keeps the order of the encodings when no texture tells them apart', async () => {
        const entries = await listZip(zipOf([{ name: concat(SJIS_HAIR, ascii('.png')), data: PNG, flags: 0 }]));
        expect(encodingForTextures(entries, ['shift_jis', 'gbk'], [])).toBe('shift_jis');
        expect(encodingForTextures(entries, ['shift_jis', 'gbk'], ['other.png'])).toBe('shift_jis');
    });

    it('takes a VRM or GLB without its images (previews), and a glTF with its buffer and images', async () => {
        const vrm = (await unpackModelPackage(zipOf([{ name: 'avatar.vrm', data: 'glTF' }, { name: 'thumbnail.png', data: PNG }])))!;
        expect(vrm.files.map((f) => f.name)).toEqual(['avatar.vrm']);
        expect(vrm.files[0].type).toBe('model/gltf-binary');
        expect(vrm.skipped).toEqual(['thumbnail.png']);
        const gltf = (await unpackModelPackage(zipOf([{ name: 'm/scene.gltf', data: '{}' }, { name: 'm/scene.bin', data: 'b' }, { name: 'm/tex/a.png', data: PNG }])))!;
        expect(gltf.files.map((f) => f.name)).toEqual(['scene.gltf', 'scene.bin', 'a.png']);
    });

    it('holds no model when the zip has none', async () => {
        const pkg = (await unpackModelPackage(zipOf([{ name: 'notes.txt', data: 'x' }])))!;
        expect(pkg.models).toEqual([]);
        expect(pkg.files).toEqual([]);
    });

    it('finds a named file in the folder the path gives when two folders hold one of that name', async () => {
        const pkg = (await unpackModelPackage(zipOf([
            { name: 'Pkg/model.pmx', data: tinyPmx('b\\face.png') },
            { name: 'Pkg/a/face.png', data: 'A' },
            { name: 'Pkg/b/face.png', data: 'B' },
        ])))!;
        expect(await fileByPath(pkg.files, 'b\\face.png')!.text()).toBe('B');
        expect(await fileByPath(pkg.files, './a/FACE.PNG')!.text()).toBe('A');
        // A file picked on its own has no folder: the first of the name.
        expect(fileByPath([new File(['x'], 'face.png')], 'tex/face.png')!.name).toBe('face.png');
    });
});
