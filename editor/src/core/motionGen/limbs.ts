// The limbs every motion formula poses the same way: a leg from its hip socket
// to its ankle (two bones, and a knee that bends the way the leg faces), a foot
// turned to its heading and pitched, an arm from the way its upper arm points
// and how far its elbow bends, a chain of bones leaned to reach a place.
// World turns are from the reference pose (body.ts), as everywhere here.

import { add, cross, dot, normalize, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import { axisAngle, basisRotation, clamp } from './tools';

/** How far apart hip and ankle are with the knee bent by `flex` (radians; 0: straight). */
export const legSpan = (body: Body, flex: number) => Math.sqrt(body.thigh * body.thigh + body.shin * body.shin + 2 * body.thigh * body.shin * Math.cos(flex));

/** The knee's bend (radians; 0: straight) with hip and ankle `span` apart. */
export const kneeFor = (body: Body, span: number) => Math.acos(clamp((span * span - body.thigh * body.thigh - body.shin * body.shin) / (2 * body.thigh * body.shin), -1, 1));

export interface LegPose {
    /** World turns of the thigh and of the shin. */
    upper: Quat;
    lower: Quat;
    /** Where the ankle is: where it was wanted, or as near as the leg reaches. */
    ankle: V3;
    /** The knee's bend, radians (0: straight). */
    knee: number;
    /** How far the ankle fell short of where it was wanted. */
    short: number;
}

/**
 * A leg from its hip socket to where its ankle should be (two-bone IK). The knee lies in the
 * plane of the hip-ankle line and the way the leg faces (`facing`), on that side of the line.
 * `most`: the furthest the ankle may be from the socket (a knee kept a little bent).
 */
export function legPose(body: Body, socket: V3, want: V3, facing: V3, most: number = body.leg + 1e-6): LegPose {
    const { left, up, fwd } = body;
    const frame: [V3, V3, V3] = [left, up, fwd];
    const to = sub(want, socket);
    const far = Math.hypot(to[0], to[1], to[2]);
    const d = clamp(far, Math.abs(body.thigh - body.shin) + 1e-5, most);
    const u = normalize(to);
    const ankle = add(socket, scale(u, d));
    const along = (body.thigh * body.thigh - body.shin * body.shin + d * d) / (2 * d);
    const out = Math.sqrt(Math.max(0, body.thigh * body.thigh - along * along));
    const bend = normalize(sub(facing, scale(u, dot(facing, u))), fwd);
    const knee = add(add(socket, scale(u, along)), scale(bend, out));
    const hinge = normalize(cross(bend, u), left);
    const thighUp = normalize(sub(socket, knee)), shinUp = normalize(sub(knee, ankle));
    return {
        upper: basisRotation(frame, [hinge, thighUp, cross(hinge, thighUp)]),
        lower: basisRotation(frame, [hinge, shinUp, cross(hinge, shinUp)]),
        ankle,
        knee: kneeFor(body, d),
        short: far - d > 0 ? far - d : 0,
    };
}

/**
 * A foot's world turn: turned from where it rests to its heading (`yaw`: about the upright
 * from the body's forward, positive toward the left), then pitched about its own side axis
 * (`pitch`: toes up, radians).
 */
export function footTurn(body: Body, foot: number, yaw: number, pitch: number): Quat {
    const { left, up, fwd } = body;
    const sideAxis = add(scale(left, Math.cos(yaw)), scale(fwd, -Math.sin(yaw)));
    const turned = axisAngle(up, yaw - body.footYaw[foot]);
    return qmul(axisAngle(sideAxis, -pitch), turned);
}

/**
 * An arm from the way its upper arm points: the world turns of the upper arm and of the
 * forearm, and the elbow's axis along the forearm. `side`: 1 the left arm, -1 the right.
 * `upper`: the unit vector from the shoulder to the elbow. `axis`: the axis the arm swings
 * forward about (the elbow bends about what is left of it across the upper arm). `elbow`:
 * the bend, radians. In the reference pose the arm lies out to its side and bends forward
 * about the vertical.
 */
export function armBones(body: Body, side: number, upper: V3, axis: V3, elbow: number): { upper: Quat; fore: Quat; hinge: V3 } {
    const { left, up } = body;
    const out = scale(left, side), bendAxis = scale(up, -side);
    const refFrame: [V3, V3, V3] = [out, bendAxis, cross(out, bendAxis)];
    const hinge = normalize(sub(axis, scale(upper, dot(axis, upper))));
    const fore = rotate(axisAngle(hinge, elbow), upper);
    const hingeFore = normalize(sub(hinge, scale(fore, dot(hinge, fore))));
    return {
        upper: basisRotation(refFrame, [upper, hinge, cross(upper, hinge)]),
        fore: basisRotation(refFrame, [fore, hingeFore, cross(fore, hingeFore)]),
        hinge: hingeFore,
    };
}

/**
 * Leans a chain of bones sideways so that its far end comes to a place. Each bone is turned
 * about the way forward (left side up above zero, which carries its top to the right), with
 * the least bending at the joints between them and at both ends: what the chain stands on
 * and what it carries keep their own turns. That is 2·lean[j] − lean[j−1] − lean[j+1] =
 * λ·rise[j], with λ set by how far the end has to go. `start`: where the first joint is;
 * `joints`: the chain's joints by role, one more than its bones; `want`: where the last
 * joint is to be, to the left of the line (null: left as it is). Returns where the last
 * joint ends up.
 */
export function leanToJoin(body: Body, world: Record<string, Quat>, start: V3, joints: readonly string[], want: number | null): V3 {
    const { left, up, fwd } = body;
    const bones = joints.slice(0, -1);
    const reach = () => bones.map((r, j) => rotate(world[r], sub(body.ref[joints[j + 1]], body.ref[r])));
    let parts = reach();
    if (want !== null && bones.length) {
        const at = dot(start, left) + parts.reduce((sum, v) => sum + dot(v, left), 0);
        const rise = parts.map((v) => dot(v, up));
        // The three-term rows solved for `rise` (forward sweep, back substitution), then scaled to the distance.
        const c: number[] = [], y: number[] = [];
        rise.forEach((r, j) => {
            const pivot = 2 - (j ? c[j - 1] : 0);
            c.push(1 / pivot);
            y.push((r + (j ? y[j - 1] : 0)) / pivot);
        });
        for (let j = rise.length - 2; j >= 0; j--) y[j] += c[j] * y[j + 1];
        const span = rise.reduce((sum, r, j) => sum + r * y[j], 0);
        if (span > 1e-9) {
            bones.forEach((r, j) => (world[r] = qmul(axisAngle(fwd, ((at - want) / span) * y[j]), world[r])));
            parts = reach();
        }
    }
    return parts.reduce((sum, v) => add(sum, v), start);
}
