// A human body's masses: how much of the whole each part weighs and where its centre of mass lies along it, and how far
// each joint goes. From measured tables of people (de Leva 1996, his adjustments of
// Zatsiorsky and Seluyanov's; a woman's, rounded to plain numbers within a twentieth), and the usual ranges of joints. The
// whole body weighs 1 here: forces and pushes are told against the body's own weight.

/** A part: its share of the body's mass, and its centre of mass from the near joint as a share of its length. */
export interface Part {
    mass: number;
    com: number;
}

export interface MassTable {
    pelvis: Part;
    /** The trunk above the waist: belly and chest as one. */
    trunk: Part;
    /** Head and neck. */
    head: Part;
    upperArm: Part;
    /** Forearm and hand as one. */
    forearm: Part;
    thigh: Part;
    shank: Part;
    foot: Part;
}

export const HUMAN_MASS: MassTable = {
    pelvis: { mass: 0.125, com: 0.5 },
    trunk: { mass: 0.3, com: 0.55 },
    head: { mass: 0.067, com: 0.6 },
    upperArm: { mass: 0.0255, com: 0.575 },
    forearm: { mass: 0.0194, com: 0.65 },
    thigh: { mass: 0.148, com: 0.36 },
    shank: { mass: 0.048, com: 0.44 },
    foot: { mass: 0.013, com: 0.4 },
};

/**
 * How far the joints go, degrees (the usual ranges of a healthy body). The thigh's way back is as it is seen from the
 * pelvis in a run: a hip alone gives 20 to 30 degrees, the rest is the pelvis tipping forward on the spine, which the
 * model's one-piece pelvis does not show.
 */
export interface JointRanges {
    /** The thigh against the pelvis: forward (bent), back, out to its side, in across the body, turned in or out. */
    hip: { bend: number; back: number; out: number; in: number; turn: number };
    knee: number;
    /** The trunk against the pelvis: bowed forward, arched back, bent to a side, twisted to a side. */
    waist: { bow: number; arch: number; side: number; twist: number };
    neck: { bow: number; arch: number; side: number; twist: number };
    /** The upper arm against the trunk: forward and up, back, out and up. */
    shoulder: { fore: number; back: number; out: number };
    elbow: number;
}

export const HUMAN_RANGES: JointRanges = {
    hip: { bend: 120, back: 50, out: 40, in: 25, turn: 40 },
    knee: 150,
    waist: { bow: 60, arch: 25, side: 30, twist: 40 },
    neck: { bow: 50, arch: 60, side: 40, twist: 75 },
    shoulder: { fore: 170, back: 50, out: 170 },
    elbow: 145,
};

