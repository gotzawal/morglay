// The body's facing as a chain: the angle between where the body looks and the line its legs walk on, shared out
// over the pelvis, the chest and the head (and the feet), each within its reach; and how the chain follows a look that
// moves: each part by a spring of its own, the head quickest, the pelvis slowest.
//
// The formula and its values: editor/MOTION.md (section 1).

import { DEG } from './tools';

/** How the look's angle is shared out along the body. */
export interface ChainStyle {
    /** The shares of the pelvis and of the chest; the head takes this share of the rest (what it leaves is short of the look). */
    share: [number, number];
    reach: number;
    /** The most each turns: the pelvis against the line (walking forward, walking backward), the chest against the pelvis, the head against the chest, degrees. */
    most: [number, number, number, number];
    /**
     * The feet turn toward the look: the share of the angle for the foot on the look's side and for the other, where it
     * looks to the left and where to the right, walking forward and backing away; and the most each turns, degrees.
     */
    feet: { forward: [number, number, number, number]; backward: [number, number, number, number]; most: [number, number] };
    /** Beyond this angle behind (degrees) the body backs away rather than walking on looking back, where it is asked to choose. */
    back: number;
    /** How quickly each part follows a look that moves: the half-lives of the pelvis', the chest's and the head's springs, seconds. */
    time: [number, number, number];
}

/** The look's angle off the line (radians, to the left above zero) shared out along the body, for a posture and a way of walking. */
export interface ChainPose {
    /** The pelvis against the line, the chest against the pelvis, the head against the chest; what is left short of the look; radians. */
    pelvis: number;
    chest: number;
    head: number;
    short: number;
    /** The left foot and the right against the line, radians. */
    feet: [number, number];
}

/** What turns the chain before it shares out the look: the posture's own turn and the field's, and the posture's own feet. */
export interface ChainGiven {
    pelvis: number;
    chest: number;
    toes: [number, number];
    /** Where the look is to the right, the pelvis and the chest take shares this much larger. */
    rightShare?: [number, number];
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
/** An angle in (−π, π]: straight behind counts as to the left. */
export const wrapLeft = (a: number) => { const w = wrap(a); return w <= -Math.PI + 1e-9 ? Math.PI : w; };

/**
 * Shares out the angle between the look and the line: the pelvis and the chest by their shares over what the
 * posture and the field already turn them, the head a share of the rest. A part at its most keeps its most and what
 * it could not take goes to the others by their shares; what none can take is left short.
 */
export function chainOf(chain: ChainStyle, look: number, given: ChainGiven, backward: boolean): ChainPose {
    const most = [chain.most[backward ? 1 : 0] * DEG, chain.most[2] * DEG, chain.most[3] * DEG];
    const base = [given.pelvis, given.chest, 0];
    const rest = look - given.pelvis - given.chest;
    const right = look < 0 && given.rightShare ? given.rightShare : [0, 0];
    const w = [chain.share[0] + right[0], chain.share[1] + right[1], 1 - chain.share[0] - chain.share[1] - right[0] - right[1]];
    const x = [w[0] * rest, w[1] * rest, w[2] * rest * chain.reach];
    const free = [true, true, true];
    // Water-filling: whatever a part cannot take passes to the parts still free, by their shares.
    for (let pass = 0; pass < 3; pass++) {
        let over = 0;
        for (let i = 0; i < 3; i++) {
            if (!free[i]) continue;
            const total = base[i] + x[i];
            if (Math.abs(total) > most[i]) {
                const kept = Math.sign(total) * most[i] - base[i];
                over += x[i] - kept;
                x[i] = kept;
                free[i] = false;
            }
        }
        if (Math.abs(over) < 1e-12) break;
        const weight = w.reduce((s, wi, i) => s + (free[i] ? wi : 0), 0);
        if (weight <= 0) break;
        for (let i = 0; i < 3; i++) if (free[i]) x[i] += (over * w[i]) / weight;
    }
    const pelvis = base[0] + x[0], chest = base[1] + x[1], head = base[2] + x[2];
    // The feet: the one on the look's side turns more (each within its most).
    const nearFoot = look >= 0 ? 0 : 1, size = Math.abs(look), sign = Math.sign(look) || 1;
    const shares = backward ? chain.feet.backward : chain.feet.forward;
    const turnOf = (foot: number) => {
        const near = foot === nearFoot;
        const share = shares[(look >= 0 ? 0 : 2) + (near ? 0 : 1)];
        return sign * Math.min(share * size, chain.feet.most[near ? 0 : 1] * DEG);
    };
    return { pelvis, chest, head, short: look - pelvis - chest - head, feet: [given.toes[0] + turnOf(0), given.toes[1] + turnOf(1)] };
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
