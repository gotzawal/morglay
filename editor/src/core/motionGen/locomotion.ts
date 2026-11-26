// Walking a path: where the capsule is over the floor at a time, its pace changing, coming to rest and setting off
// again (carry.ts walkAlong), and turning on the spot where it rests to set off another way (turn.ts, its facing by
// the chain: chain.ts). No motion is stored and none is picked.
//
// The formula and which value to change for which look: editor/MOTION.md.

import { add, dot, qmul, rotate, scale, sub, type Quat, type V3 } from '../rigMotion';
import type { Body } from './body';
import { ALONG_STYLE, STOP_STYLE, walkAlong, type AlongStyle } from './carry';
import { GAIT_STYLE, type GaitFrame, type GaitStyle } from './gait';
import { CHAIN_STYLE, wrapLeft, type ChainStyle } from './chain';
import { axisAngle, clamp, DEG, minJerk } from './tools';
import { TURN_STYLE, turnFor, turnFrames, type TurnStyle } from './turn';

/** The turn on the spot a path walk takes where it rests, and the chain its body follows the turn by. */
export interface LocoStyle {
    turn: TurnStyle;
    chain: ChainStyle;
}


export const LOCO_STYLE: LocoStyle = { turn: TURN_STYLE, chain: CHAIN_STYLE };


/**
 * A path walked by the rules: where the capsule is over the floor at a time (model space), over `seconds`, its pace
 * changing, coming to rest and setting off again. Where it moves, the walk along it (carry.ts walkAlong: the walk of each
 * pace, a start from standing that turns to its way as it sets off, a stop to standing). Where it rests for at least `rest`
 * seconds and then sets off more than `onTheSpot` degrees another way, the body turns on the spot to that way meanwhile
 * (turn.ts, its facing by the chain),
 * and stands on for `settle` seconds while its pelvis, chest and head come round.
 * If the turn takes longer than the rest, the body is late by so much from then on. A leg after a rest sets off from
 * where the body stands (which is not quite where the path came to rest: a foot of the walk lands ahead of the body),
 * and comes back onto the path over its first `rejoin` metres. With `startHeading` (radians, as the way's headings
 * are counted) it stands facing that way at first, and sets off turning to its way (or, further round than
 * `onTheSpot`, turns on the spot first); without, it stands facing its way. With `endHeading` it turns on the spot
 * to face that way after its last stop. The frames travel.
 */
export function locoPath(
    body: Body, path: (t: number) => V3, seconds: number,
    style: LocoStyle = LOCO_STYLE, along: AlongStyle = ALONG_STYLE, gaitStyle: GaitStyle = GAIT_STYLE, fps = 60,
    rest = 1.4, least = 15, rejoin = 1.5, settle = 1.2, onTheSpot = 135, endHeading?: number, startHeading?: number,
): GaitFrame[] {
    const { up, fwd, left } = body;
    const flat = (p: V3): V3 => sub(p, scale(up, dot(p, up)));
    const origin = flat(body.ref.hips), floorAt = add(origin, scale(up, body.floor));
    const headingOf = (d: V3) => Math.atan2(dot(d, left), dot(d, fwd));
    const length = (v: V3) => Math.hypot(v[0], v[1], v[2]);
    const snap = (t: number) => Math.round(t * fps) / fps;
    // The stretches where it moves (rests shorter than `rest` are the walk's own stops), and the way each sets off and ends.
    const h = 1 / 240, n = Math.ceil(seconds / h);
    const stretches: { a: number; b: number; off: number; on: number }[] = [];
    let k = 0;
    while (k < n) {
        while (k < n && length(sub(flat(path((k + 1) * h)), flat(path(k * h)))) < 1e-3 * h) k++;
        if (k >= n) break;
        const a = k * h;
        let still = 0;
        while (k < n) {
            const moves = length(sub(flat(path((k + 1) * h)), flat(path(k * h)))) >= 1e-3 * h;
            still = moves ? 0 : still + h;
            k++;
            if (still >= rest) break;
        }
        const b = k * h - still;
        stretches.push({ a, b, off: headingOf(sub(flat(path(a + 0.05)), flat(path(a)))), on: headingOf(sub(flat(path(b)), flat(path(b - 0.05)))) });
    }
    // How far along the path it has gone at a time.
    const gone: number[] = [0];
    for (let i = 1; i <= n; i++) gone.push(gone[i - 1] + length(sub(flat(path(i * h)), flat(path((i - 1) * h)))));
    const goneAt = (t: number) => { const u = clamp(t / h, 0, n), i = Math.min(n - 1, Math.floor(u)); return gone[i] + (gone[i + 1] - gone[i]) * (u - i); };
    const pieces: { from: number; frames: GaitFrame[] }[] = [];
    /** Frames moved and turned: `turn` about the up through `about`, then moved by `by`. */
    const moved = (frames: GaitFrame[], by: V3, turn = 0, about: V3 = floorAt): GaitFrame[] => {
        const q = axisAngle(up, turn);
        const at = (p: V3): V3 => add(add(about, rotate(q, sub(p, about))), by);
        return frames.map((fr) => {
            const world: Record<string, Quat> = {};
            for (const r of Object.keys(fr.world)) world[r] = qmul(q, fr.world[r] as Quat);
            return { ...fr, hips: at(fr.hips as V3), ankles: [at(fr.ankles[0] as V3), at(fr.ankles[1] as V3)], pivots: fr.pivots.map((p) => (p ? at(p as V3) : null)) as [V3 | null, V3 | null], world };
        });
    };
    let cursor = 0, late = 0;
    // (Standing at first where the path begins, facing `startHeading`; without, as its way sets off.)
    let stand: { pivot: V3; heading: number; stand?: GaitFrame } | undefined = startHeading === undefined ? undefined : { pivot: add(flat(path(0)), scale(up, body.floor)), heading: startHeading };
    if (!stretches.length) stretches.push({ a: seconds, b: seconds, off: 0, on: 0 });
    /** Turns on the spot where it stands, by `angle`, and stands on while its pelvis, chest and head come round. */
    const turnOnTheSpot = (where: { pivot: V3; heading: number }, angle: number) => {
        const turnStyle = style.turn;
        const turn = turnFor(body, angle, turnStyle, angle > 0);
        const frames = turnFrames(body, { ...turn, seconds: turn.seconds + settle }, turnStyle, fps, style.chain);
        pieces.push({ from: cursor, frames: moved(frames, sub(where.pivot, floorAt), where.heading) });
        cursor = snap(cursor + turn.seconds + settle);
        return { pivot: where.pivot, heading: where.heading + angle };
    };
    // (Setting off further round than `onTheSpot` from the way it stands at first, it turns on the spot first.)
    if (stand && stretches[0].a < seconds) {
        const angle = wrapLeft(stretches[0].off - stand.heading);
        if (Math.abs(angle) > Math.max(least, onTheSpot) * DEG) {
            stand = turnOnTheSpot(stand, angle);
            if (cursor > stretches[0].a - 0.1) late = cursor - (stretches[0].a - 0.1);
        }
    }
    stretches.forEach((st, i) => {
        const last = i === stretches.length - 1;
        const begins = snap(cursor), fromPath = begins - late;
        const ends = last ? snap(seconds + late) : snap(st.b + late + Math.min(rest - 0.2, STOP_STYLE.close + along.settleTime));
        // (Where the body stands, against where the path is: that much off at first, nothing once it has gone `rejoin` metres.)
        const off = stand ? sub(flat(stand.pivot), flat(path(fromPath))) : ([0, 0, 0] as V3);
        const legPath = (t: number) => add(path(fromPath + t), scale(off, 1 - minJerk((goneAt(fromPath + t) - goneAt(fromPath)) / rejoin)));
        const base = flat(legPath(0));
        const by = sub(base, origin);
        const walked = walkAlong(body, legPath, ends - begins, along, gaitStyle, style.turn, fps,
            stand ? { pivot: sub(stand.pivot, by), heading: stand.heading, stand: stand.stand } : undefined);
        pieces.push({ from: begins, frames: moved(walked.frames, by) });
        cursor = ends;
        stand = walked.end ? { pivot: add(walked.end.pivot, by), heading: walked.end.heading } : stand;
        if (last) return;
        const next = stretches[i + 1];
        const angle = stand ? wrapLeft(next.off - stand.heading) : 0;
        // (Up to `onTheSpot` degrees it turns as it sets off, in the walk; further round it turns on the spot first.)
        if (stand && Math.abs(angle) > Math.max(least, onTheSpot) * DEG) stand = turnOnTheSpot(stand, angle);
        // (It sets off once it stands ready: if the path moves on sooner, the body is late from here on.)
        if (cursor > next.a + late - 0.1) late = cursor - (next.a - 0.1);
    });
    // At the end: round to the way it is to face, on the spot.
    if (endHeading !== undefined && stand) {
        const angle = wrapLeft(endHeading - stand.heading);
        if (Math.abs(angle) > least * DEG) turnOnTheSpot(stand, angle);
    }
    const total = Math.round(cursor * fps);
    const out: GaitFrame[] = [];
    let piece = 0;
    for (let i = 0; i <= total; i++) {
        const t = i / fps;
        while (piece + 1 < pieces.length && t >= pieces[piece + 1].from - 1e-9) piece++;
        const p = pieces[piece];
        const fr = p.frames[Math.min(p.frames.length - 1, Math.max(0, Math.round((t - p.from) * fps)))];
        out.push({ ...fr, time: t });
    }
    return out;
}
