import { describe, expect, it } from 'vitest';
import { bezier, bezierSlope, isPathAsset, parsePath, type P2 } from '../../src/core/motionPath';
import { pathOnBody } from '../../src/core/motionGen/pathWalk';

/** A path file of these points (and, without keys of its own, a timing that walks it at 1 m/s from 0 to 1 m). */
const file = (points: unknown[], keys: unknown[] = [{ t: 0, s: 0 }, { t: 1, s: 1 }], closed = false) => ({ format: 'morglay-path', version: 1, closed, points, timing: { keys } });
const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('path curves', () => {
    it('starts and ends at its anchors and leaves and arrives along their handles', () => {
        const c: [P2, P2, P2, P2] = [[0, 0], [1, 2], [3, 3], [4, 1]];
        expect(bezier(c, 0)).toEqual([0, 0]);
        expect(bezier(c, 1)).toEqual([4, 1]);
        // The slope at each end is three times its handle.
        expect(bezierSlope(c, 0)).toEqual([3, 6]);
        expect(bezierSlope(c, 1)).toEqual([3, -6]);
        const path = parsePath(file([{ at: [0, 0], out: [1, 2] }, { at: [4, 1], in: [3, 3] }]));
        expect(near(path.at(0), [0, 0])).toBeLessThan(1e-12);
        expect(near(path.at(path.length), [4, 1])).toBeLessThan(1e-9);
        expect(near(path.direction(0), [1 / Math.sqrt(5), 2 / Math.sqrt(5)])).toBeLessThan(1e-9);
        expect(near(path.direction(path.length), [1 / Math.sqrt(5), -2 / Math.sqrt(5)])).toBeLessThan(1e-6);
    });

    it('measures its length within a millimetre, and finds a point by its distance along it', () => {
        // A cubic through (0,0), (1/3,0), (2/3,1/3), (1,1) is the parabola z = x² from 0 to 1 (a quadratic
        // Bezier raised to a cubic), here ten times as large: its length is known exactly.
        const k = 10;
        const path = parsePath(file([{ at: [0, 0], out: [k / 3, 0] }, { at: [k, k], in: [(2 * k) / 3, k / 3] }]));
        const arc = (x: number) => (x * Math.sqrt(1 + 4 * x * x)) / 2 + Math.asinh(2 * x) / 4;
        expect(Math.abs(path.length - k * arc(1))).toBeLessThan(0.001);
        // The point halfway along: where the parabola's own arc length is half of it.
        let lo = 0, hi = 1;
        for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (k * arc(mid) < path.length / 2) lo = mid;
            else hi = mid;
        }
        expect(near(path.at(path.length / 2), [k * lo, k * lo * lo])).toBeLessThan(0.001);
        // Every point the table gives lies on the parabola.
        for (let s = 0; s <= path.length; s += 0.37) {
            const [x, z] = path.at(s);
            expect(Math.abs(z - (x * x) / k)).toBeLessThan(1e-6);
        }
    });

    it('goes round again when closed, and stops at its ends when open', () => {
        const square = [{ at: [0, 0] }, { at: [2, 0] }, { at: [2, 2] }, { at: [0, 2] }];
        const loop = parsePath(file(square, undefined, true));
        expect(loop.length).toBeCloseTo(8, 9);
        expect(near(loop.at(9), [1, 0])).toBeLessThan(1e-9);
        expect(near(loop.at(-1), [0, 1])).toBeLessThan(1e-9);
        const open = parsePath(file(square));
        expect(open.length).toBeCloseTo(6, 9);
        expect(near(open.at(9), [0, 2])).toBeLessThan(1e-9);
        expect(near(open.at(-1), [0, 0])).toBeLessThan(1e-9);
    });
});

describe('path timing', () => {
    // Stands for a second, eases off to 1.2 m/s, brakes into a stop of two seconds at 4 m, goes on at an even
    // pace (keys without handles) and brakes to a stop at 7 m.
    const keys = [
        { t: 0, s: 0 },
        { t: 1, s: 0, out: [0.6, 0] },
        { t: 2.5, s: 0.9, in: [-0.4, -0.48], out: [0.5, 0.6] },
        { t: 4.6, s: 4, in: [-0.7, 0] },
        { t: 6.6, s: 4 },
        { t: 8, s: 6 },
        { t: 9, s: 7, in: [-0.4, 0] },
        { t: 10, s: 7 },
    ];
    const path = parsePath(file([{ at: [0, 0] }, { at: [0, 10] }], keys));

    it('lasts until its last key and passes through every key', () => {
        expect(path.duration).toBe(10);
        for (const k of keys) expect(path.distance(k.t as number)).toBeCloseTo(k.s as number, 9);
        expect(path.distance(-1)).toBe(0);
        expect(path.distance(12)).toBe(7);
        expect(near(path.sample(12), [0, 7])).toBeLessThan(1e-9);
    });

    it('never goes back, stands still between keys at one distance, and eases into and out of a stop', () => {
        let last = -Infinity;
        for (let t = 0; t <= 10; t += 0.001) {
            const s = path.distance(t);
            expect(s).toBeGreaterThanOrEqual(last - 1e-12);
            last = s;
            if (t > 4.6 && t < 6.6) expect(s).toBe(4);
        }
        const before = (t: number) => (path.distance(t) - path.distance(t - 1e-6)) / 1e-6;
        const after = (t: number) => (path.distance(t + 1e-6) - path.distance(t)) / 1e-6;
        // A level handle at a key: no speed there, picking up (or dying) smoothly.
        expect(after(1)).toBeLessThan(0.001);
        expect(after(1.05)).toBeLessThan(0.05);
        expect(before(4.6)).toBeLessThan(0.001);
        expect(before(9)).toBeLessThan(0.001);
        // At a key with handles of one slope, the pace runs through it: 1.2 m/s each side.
        expect(before(2.5)).toBeCloseTo(1.2, 4);
        expect(after(2.5)).toBeCloseTo(1.2, 4);
        // Keys without handles join with a straight line: an even pace.
        for (const t of [6.7, 7.3, 7.9]) expect(after(t)).toBeCloseTo(2 / 1.4, 4);
    });
});

describe('path files', () => {
    const ok = file([{ at: [0, 0] }, { at: [0, 2] }]);
    const bad: [string, unknown, RegExp][] = [
        ['not JSON', '{"format": "morglay-path",', /not JSON/],
        ['another format', { ...ok, format: 'morglay-trail' }, /not a path file/],
        ['a later version', { ...ok, version: 2 }, /not a path file/],
        ['one point', file([{ at: [0, 0] }]), /not a path file/],
        ['a point that is not two numbers', file([{ at: [0, 'x'] }, { at: [0, 2] }]), /not a path file/],
        ['a field misspelt', file([{ at: [0, 0], Out: [0, 1] }, { at: [0, 2] }]), /not a path file/],
        ['one key', file([{ at: [0, 0] }, { at: [0, 2] }], [{ t: 0, s: 0 }]), /not a path file/],
        ['a key at a time not after the one before', file([{ at: [0, 0] }, { at: [0, 2] }], [{ t: 0, s: 0 }, { t: 1, s: 1 }, { t: 1, s: 2 }]), /not after/],
        ['a distance that goes back', file([{ at: [0, 0] }, { at: [0, 2] }], [{ t: 0, s: 1 }, { t: 1, s: 0.5 }]), /goes back/],
        ['handles that make the distance go back', file([{ at: [0, 0] }, { at: [0, 2] }], [{ t: 0, s: 0, out: [0.3, 1.5] }, { t: 1, s: 1 }]), /make s go back/],
        ['handles that reach past each other in time', file([{ at: [0, 0] }, { at: [0, 2] }], [{ t: 0, s: 0, out: [1.5, 0.2] }, { t: 1, s: 1 }]), /reach past each other/],
        ['a negative time', file([{ at: [0, 0] }, { at: [0, 2] }], [{ t: -1, s: 0 }, { t: 1, s: 1 }]), /not a path file/],
    ];
    it.each(bad)('refuses %s', (_, input, message) => {
        expect(() => parsePath(input)).toThrow(message);
    });

    it('reads its own text, and is known by its name among the assets', () => {
        expect(parsePath(JSON.stringify({ ...ok, note: 'a path for the tests' })).length).toBeCloseTo(2, 9);
        expect(isPathAsset({ kind: 'data', name: 'loop.path.json' })).toBe(true);
        expect(isPathAsset({ kind: 'data', name: 'heights.json' })).toBe(false);
        expect(isPathAsset({ kind: 'model', name: 'loop.path.json' })).toBe(false);
    });
});

describe('the way a body takes along a path', () => {
    // A walk that turns a square corner: 3 m ahead, then 3 m to the left.
    const corner = parsePath({
        format: 'morglay-path', version: 1, closed: false,
        points: [{ at: [0, 0] }, { at: [0, 3] }, { at: [3, 3] }],
        timing: { keys: [{ t: 0, s: 0 }, { t: 5, s: 6 }] },
    });
    const body = { left: [1, 0, 0] as [number, number, number], fwd: [0, 0, 1] as [number, number, number], leg: 0.85 };

    it('takes a drawn corner over about a step, turning smoothly, and keeps to the path elsewhere and at its ends', () => {
        const way = pathOnBody(corner, body);
        const headings: number[] = [];
        for (let k = 1; k <= 1200; k++) {
            const a = way((k - 1) / 240), b = way(k / 240);
            if (Math.hypot(b[0] - a[0], b[2] - a[2]) > 1e-6) headings.push(Math.atan2(b[0] - a[0], b[2] - a[2]));
        }
        // No kink: from one sample to the next (5 mm) the way turns a degree at most (a mean of a few points of the path
        // made a polygon of 5.6° kinks).
        for (let k = 1; k < headings.length; k++) expect(Math.abs(headings[k] - headings[k - 1])).toBeLessThan(Math.PI / 180);
        // It turns the whole right angle, over less than two legs' length of the way.
        expect(headings[headings.length - 1] - headings[0]).toBeCloseTo(Math.PI / 2, 2);
        const turning = headings.filter((h, k) => k > 0 && Math.abs(h - headings[k - 1]) > 1e-4).length * (6 / 5 / 240);
        expect(turning).toBeLessThan(2 * body.leg);
        // A leg's length or more from the corner, and at both ends, it is the path itself.
        for (const t of [0, 1, 4, 5]) { const w = way(t), p = corner.sample(t); expect(Math.hypot(w[0] - p[0], w[2] - p[1])).toBeLessThan(1e-3); }
        // Where the body comes to rest at the corner (two keys at the same distance), it is not walked through: the way is
        // the drawn path into the corner and out of it.
        const resting = parsePath({ ...corner.file, timing: { keys: [{ t: 0, s: 0 }, { t: 2.5, s: 3 }, { t: 4, s: 3 }, { t: 6.5, s: 6 }] } });
        expect(resting.rests).toEqual([0, 3]);
        const kept = pathOnBody(resting, body);
        for (const t of [2, 2.4, 3, 4.1, 4.5]) { const w = kept(t), p = resting.sample(t); expect(Math.hypot(w[0] - p[0], w[2] - p[1])).toBeLessThan(1e-3); }
    });
});
