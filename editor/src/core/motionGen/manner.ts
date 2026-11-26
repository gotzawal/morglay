// What every motion of the body shares: the body's own measures (body.ts: its bones, its soles; mass.ts: its masses and
// its joints' ranges), physics (gravity, and what follows from it for this body: how fast it falls over its feet, how
// long a leg or an arm swings), and the character's manner (how it holds and moves itself): ratios, each written here
// once, that the tables of each motion name instead of a number of their own.

import { GRAVITY } from './tools';

export interface Manner {
    /** A knee points between where its foot points and where the pelvis faces: the share of the way to the pelvis. */
    kneeFollow: number;
    /** A leg at work (pushing off, bearing the body) keeps its knee bent at least this much, degrees: it is never locked straight. */
    kneeLeast: number;
    /** The neck turns this share of the way from the chest's turn to the head's. */
    neck: number;
    /** How long the body takes to answer what it did not foresee (a push, a change of way), seconds. */
    react: number;
    /**
     * The hardest the body takes a bend: a sideways pull of this many g at the most, well within the floor's grip (people
     * keep to a few tenths of a g). A way that bends harder for its pace is taken leaning no further.
     */
    turnMost: number;
}

export const HUMAN_MANNER: Manner = {
    kneeFollow: 0.5,
    kneeLeast: 16,
    neck: 0.5,
    react: 0.08,
    turnMost: 0.3,
};

/**
 * The sideways pull a body going round a bend feels, in g: its speed times how fast its way turns, over gravity; and no
 * more than the hardest it takes a bend with (`turnMost`).
 */
export const sidePull = (speed: number, turnRate: number, manner: Manner = HUMAN_MANNER): number => Math.min(manner.turnMost, Math.abs(speed * turnRate) / GRAVITY);
