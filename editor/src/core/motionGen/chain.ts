// The body's facing as a chain: the angle between where the body looks and the line its legs stand on, shared out
// over the pelvis, the chest and the head, each within its reach; and how the chain follows a look that moves: each
// part by a spring of its own, the head quickest, the pelvis slowest.
//
// The formula and its values: editor/MOTION.md (section 1).

import { DEG } from './tools';

/** How the look's angle is shared out along the body. */
export interface ChainStyle {
    /** The shares of the pelvis and of the chest; the head takes this share of the rest (what it leaves is short of the look). */
    share: [number, number];
    /** The most each turns: the pelvis against the line, the chest against the pelvis, the head against the chest, degrees. */
    most: [number, number, number];
    /** How quickly each part follows a look that moves: the half-lives of the pelvis', the chest's and the head's springs, seconds. */
    time: [number, number, number];
}

/** The chain the body turns by on the spot. */
export const CHAIN_STYLE: ChainStyle = { share: [0.17, 0.15], most: [35, 23, 55], time: [0.8, 0.6, 0.18] };

/** The look's angle off the line (radians, to the left above zero) shared out along the body. */
export interface ChainPose {
    /** The pelvis against the line, the chest against the pelvis, the head against the chest; radians (what is left over, the look does not reach). */
    pelvis: number;
    chest: number;
    head: number;
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
/** An angle in (−π, π]: straight behind counts as to the left. */
export const wrapLeft = (a: number) => { const w = wrap(a); return w <= -Math.PI + 1e-9 ? Math.PI : w; };

/**
 * Shares out the angle between the look and the line: the pelvis and the chest by their shares, the head a share of
 * the rest. A part at its most keeps its most and what it could not take goes to the others by their shares; what none
 * can take is left short.
 */
export function chainOf(chain: ChainStyle, look: number): ChainPose {
    const most = chain.most.map((m) => m * DEG);
    const w = [chain.share[0], chain.share[1], 1 - chain.share[0] - chain.share[1]];
    const x = [w[0] * look, w[1] * look, w[2] * look];
    const free = [true, true, true];
    // Water-filling: whatever a part cannot take passes to the parts still free, by their shares.
    for (let pass = 0; pass < 3; pass++) {
        let over = 0;
        for (let i = 0; i < 3; i++) {
            if (!free[i] || Math.abs(x[i]) <= most[i]) continue;
            const kept = Math.sign(x[i]) * most[i];
            over += x[i] - kept;
            x[i] = kept;
            free[i] = false;
        }
        if (Math.abs(over) < 1e-12) break;
        const weight = w.reduce((s, wi, i) => s + (free[i] ? wi : 0), 0);
        if (weight <= 0) break;
        for (let i = 0; i < 3; i++) if (free[i]) x[i] += (over * w[i]) / weight;
    }
    return { pelvis: x[0], chest: x[1], head: x[2] };
}

/**
 * The chain following a look that moves, from where it is at time 0 (all three at nothing against the line, still):
 * each part a critically damped spring toward its share, with its own half-life. Worked out in small steps over
 * [0, `seconds`] and read between them; before 0 it is where it began, after `seconds` where it ended.
 */
export function chainFollow(chain: ChainStyle, target: (t: number) => ChainPose, seconds: number, step = 1 / 240): (t: number) => { pelvis: number; chest: number; head: number } {
    const n = Math.max(1, Math.ceil(seconds / step));
    const dt = seconds / n;
    const rate = chain.time.map((h) => (2 * Math.LN2) / Math.max(1e-3, h));
    const x = [0, 0, 0], v = [0, 0, 0];
    const out = new Float64Array((n + 1) * 3);
    for (let k = 0; k <= n; k++) {
        out.set(x, k * 3);
        if (k === n) break;
        const goal = target((k + 0.5) * dt);
        const g = [goal.pelvis, goal.chest, goal.head];
        for (let i = 0; i < 3; i++) {
            const y = rate[i], j0 = v[i] + y * (x[i] - g[i]), e = Math.exp(-y * dt);
            x[i] = g[i] + (x[i] - g[i] + j0 * dt) * e;
            v[i] = (v[i] - j0 * y * dt) * e;
        }
    }
    return (t: number) => {
        const u = Math.min(n, Math.max(0, t / dt)), k = Math.min(n - 1, Math.floor(u)), f = u - k;
        const at = (i: number) => out[k * 3 + i] + (out[(k + 1) * 3 + i] - out[k * 3 + i]) * f;
        return { pelvis: at(0), chest: at(1), head: at(2) };
    };
}
