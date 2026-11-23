// How a foot rolls on its sole. Seen from the side a sole is a convex chain of
// points (core/motionGen/mesh.ts reads it off the mesh; without one it is flat
// between its two ends). As the foot pitches, one point after another is the
// one on the floor: the foot turns on it, and the next point meets the floor
// one edge further on. Nothing slips: where a point meets the floor is the
// length of sole rolled out to it.

import type { Body } from './body';
import { underside } from './mesh';
import { clamp } from './tools';

/** A point of the sole a foot turns on while it is the one on the floor. */
export interface Pivot {
    /** In the foot: along it from the ankle, and over the floor with the foot flat. */
    x: number;
    z: number;
    /** Where it meets the floor: along the foot, from under the ankle as it stands flat. */
    at: number;
    /** The pitch (radians, as a size) from which and up to which it is the point on the floor. */
    from: number;
    to: number;
    /** The ankle from it: how far, and how steeply over the floor (with the foot flat), seen from the side the ankle is on. */
    len: number;
    rise: number;
}

export interface SoleRoll {
    /** The sole's points, heel to front: [along the foot from the ankle, over the floor with the foot flat]. */
    points: [number, number][];
    /** The points the foot turns on in turn as its toes rise (back onto the heel), and as its heel rises (onto the front). */
    heel: Pivot[];
    front: Pivot[];
}

/** The sole of a body as something to roll on. Toes that bend are no part of it: it ends at the ball. */
export function soleRoll(body: Body): SoleRoll {
    const h = body.ankleHeight;
    const { heel, ball, tip, outline } = body.sole;
    let points: [number, number][];
    if (outline && outline.length >= 2) {
        points = outline.map((p): [number, number] => [p[0], p[1]]);
        if (!body.stiffToes) points = [...points.filter((p) => p[0] < ball), [ball, 0]];
        points = underside(points, 0);
    } else points = [[heel, 0], [body.stiffToes ? tip : ball, 0]];
    const lowest = Math.min(...points.map((p) => p[1]));
    points = points.map((p): [number, number] => [p[0], p[1] - lowest]);
    // Where it stands flat: from the first to the last point on the floor.
    const flat = 1e-4 * body.hipHeight;
    const a = points.findIndex((p) => p[1] <= flat);
    let b = a;
    for (let i = points.length - 1; i > a; i--) if (points[i][1] <= flat) { b = i; break; }
    const gap = (i: number, j: number) => Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]);
    const slope = (i: number, j: number) => Math.atan2(points[j][1] - points[i][1], Math.abs(points[j][0] - points[i][0]));

    const front: Pivot[] = [];
    for (let k = b, at = points[b][0]; k < points.length; k++) {
        if (k > b) at += gap(k - 1, k);
        const [x, z] = points[k];
        front.push({ x, z, at, from: k === b ? 0 : slope(k - 1, k), to: k === points.length - 1 ? Infinity : slope(k, k + 1), len: Math.hypot(x, h - z), rise: Math.atan2(h - z, x) });
    }
    const back: Pivot[] = [];
    for (let k = a, at = points[a][0]; k >= 0; k--) {
        if (k < a) at -= gap(k, k + 1);
        const [x, z] = points[k];
        back.push({ x, z, at, from: k === a ? 0 : slope(k + 1, k), to: k === 0 ? Infinity : slope(k, k - 1), len: Math.hypot(x, h - z), rise: Math.atan2(h - z, -x) });
    }
    return { points, heel: back, front };
}

/**
 * A foot pitched by `pitch` (toes up; radians) rolling on its sole: its ankle from where it
 * stands flat (along the foot, and up), and where on the floor it then stands (along the
 * foot from under the flat ankle; null: flat).
 */
export function rolled(sole: SoleRoll, ankleHeight: number, pitch: number): { along: number; up: number; on: number | null } {
    if (pitch === 0) return { along: 0, up: 0, on: null };
    const list = pitch > 0 ? sole.heel : sole.front, size = Math.abs(pitch);
    let k = list[list.length - 1];
    for (const p of list) if (size <= p.to) { k = p; break; }
    const zr = k.z - ankleHeight, c = Math.cos(pitch), s = Math.sin(pitch);
    return { along: k.at - k.x * c + zr * s, up: -k.x * s - zr * c - ankleHeight, on: k.at };
}

/**
 * How far a foot pitches, rolling over the points of `list`, for its ankle to be `want` from
 * the hip. The hip is `x` along the foot from the flat ankle, `over` the floor, and `side2`
 * (squared) to the side; `front`: the heel rises (else the toes). The ankle's arm from the
 * point it turns on stays `least` short of pointing at the hip. Returns the pitch (a size),
 * the hip-to-ankle distance it leaves, and whether it could not pitch enough.
 */
export function rollTo(list: Pivot[], front: boolean, x: number, over: number, side2: number, want: number, least: number): { rise: number; far: number; tight: boolean } {
    for (let i = 0; i < list.length; i++) {
        const k = list[i], last = i === list.length - 1;
        const px = front ? k.at - x : x - k.at;
        const m = Math.hypot(px, over), toward = Math.atan2(over, px);
        // Hip to ankle with the foot pitched by `pitch` on this point.
        const far = (pitch: number) => Math.sqrt(Math.max(0, m * m + side2 + k.len * k.len - 2 * k.len * m * Math.cos(toward - k.rise - pitch)));
        // The leg already spans it flat: the foot stays flat.
        if (i === 0 && want >= far(k.from)) return { rise: k.from, far: far(k.from), tight: false };
        // This point's share of the roll, cut where the arm would come too near to pointing at the hip.
        const most = least > 0 ? toward - k.rise - least : Infinity;
        const end = Math.max(k.from, Math.min(last ? Math.PI / 2 : k.to, most));
        // (Pitching it turns the arm toward the hip, then past: the distance is least where the arm points at the hip. If
        // that lies within this point's share, the leg reaches by then, on the way there.)
        if (want >= far(Math.min(end, Math.max(k.from, toward - k.rise)))) {
            const open = Math.acos(clamp((m * m + side2 + k.len * k.len - want * want) / (2 * k.len * m), -1, 1));
            let rise = toward - k.rise - open;
            if (rise < k.from - 1e-9 || rise > end + 1e-9) rise = toward - k.rise + open;
            rise = clamp(rise, k.from, end);
            return { rise, far: far(rise), tight: false };
        }
        // Still too far at the end of this point's share: the next point takes over, unless the foot can pitch no more.
        if (last || most < k.to) return { rise: end, far: far(end), tight: true };
    }
    return { rise: 0, far: 0, tight: false };
}
