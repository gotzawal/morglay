import { Quaternion, Time, Vector3, type AnimatorComponent, type Object3D } from '@orillusion/core';
import type { MotionDoc, SpringGroupDoc } from '../core/model';
import {
    BLINK_SECONDS, blinkCurve, boneMatcher, length, normalize, pushOut, qinv, qmul, rotate, rotationBetween, rotationOf, springRest, springStep, sub,
    type Quat, type SpringState, type V3,
} from '../core/rigMotion';

// A model's motion on top of its clip (NodeDoc.motion): bones that swing as
// springs and a face moved by its bones. It runs inside the animator's
// update, after the clip has posed the skeleton (the animator's solvers),
// so it works the same in the editor's preview and in Play.
//
// The animator writes every bone from the clip (or its rest pose) each
// frame, so what is read here at the start of a frame is the pose to swing
// around and to offset from; nothing has to be undone.

interface Bone {
    name: string;
    obj: Object3D;
    parent: Bone | null;
    /** Rest translation and rotation in the parent, and the rest rotation in the model's own axes. */
    t: V3;
    q: Quat;
    restWorld: Quat;
}

interface Swinging {
    bone: Bone;
    group: SpringGroupDoc;
    /** Where the bone points along itself, in its own space, and how long it is. */
    dir: V3;
    len: number;
    state: SpringState | null;
    /** Colliders it stays out of (the ones it does not already touch at rest). */
    hits: Collider[];
}

interface Collider {
    set: string;
    bone: Bone;
    to: Bone | null;
    /** The ball's center (a capsule's first end) in the bone's own space. */
    local: V3;
    /** A capsule's other end in the bone's own space, when it has no second bone. */
    tail: V3 | null;
    radius: number;
    a: V3;
    b: V3 | null;
}

interface FaceBone {
    bone: Bone;
    /** By expression: how far it moves, in its parent's space. */
    offsets: Map<string, V3>;
}

/** A bone's head must not jump further than this in a frame (a clip that loops back to its start): the springs start over. */
const TELEPORT = 0.5;
/** How fast an expression blends in, per second. */
const BLEND = 10;

const position = (o: Object3D): V3 => {
    const m = o.transform.worldMatrix.rawData;
    return [m[12], m[13], m[14]];
};
const worldRotation = (o: Object3D | null): Quat => (o ? rotationOf(o.transform.worldMatrix.rawData) : [0, 0, 0, 1]);

/** The collider sets a group stays out of (its `hit`: names separated by commas or spaces). */
const hitSetCache = new Map<string, Set<string>>();
function hitSets(g: SpringGroupDoc): Set<string> {
    let s = hitSetCache.get(g.hit);
    if (!s) hitSetCache.set(g.hit, (s = new Set(g.hit.split(/[\s,]+/).filter(Boolean))));
    return s;
}

export class CharacterMotion {
    private bones = new Map<string, Bone>();
    private swinging: Swinging[] = [];
    private colliders: Collider[] = [];
    private face: FaceBone[] = [];
    private weights = new Map<string, number>();
    private structure = '';
    private doc: MotionDoc;
    private lastStep = 0;
    private blinkAt = 1.5;
    private blinkTime = Infinity;
    private readonly tmpQ = new Quaternion();
    private readonly tmpV = new Vector3();

    constructor(private animator: AnimatorComponent, doc: MotionDoc) {
        this.doc = doc;
        this.readSkeleton();
        this.build();
        animator.addIK(this);
    }

    /** New settings: what changed only in what is shown (the expression, blinking, swaying) keeps the springs where they are. */
    update(doc: MotionDoc) {
        this.doc = doc;
        this.build();
    }

    dispose() {
        this.animator.removeIK(this);
        this.swinging = [];
        this.face = [];
    }

    /** How many bones swing, and how many a face moves: for the inspector. */
    get counts(): { springs: number; face: number; colliders: number } {
        return { springs: this.swinging.length, face: this.face.length, colliders: this.colliders.length };
    }

    private readSkeleton() {
        const avatar = this.animator.getAvatar();
        if (!avatar) return;
        const byId = new Map<number, Bone>();
        // The avatar lists parents before their children.
        for (const b of avatar.boneData) {
            const obj = this.animator.getJointObject(b.boneName);
            if (!obj) continue;
            const parent = byId.get(b.parentBoneID) ?? null;
            const q: Quat = [b.q.x, b.q.y, b.q.z, b.q.w];
            const bone: Bone = { name: b.boneName, obj, parent, t: [b.t.x, b.t.y, b.t.z], q, restWorld: parent ? qmul(parent.restWorld, q) : q };
            byId.set(b.boneID, bone);
            this.bones.set(bone.name, bone);
        }
    }

    private build() {
        const d = this.doc;
        const structure = JSON.stringify([d.springs, d.colliders, d.expressions]);
        if (structure === this.structure) return;
        this.structure = structure;

        // ---- colliders
        this.colliders = [];
        for (const c of d.colliders) {
            const bone = this.bones.get(c.bone);
            if (!bone) continue;
            const to = c.to ? (this.bones.get(c.to) ?? null) : null;
            // The offset is given in the model's axes at rest: into the bone's own.
            const local = rotate(qinv(bone.restWorld), c.offset as V3);
            const tail = !to && c.tail && length(c.tail as V3) > 1e-6 ? rotate(qinv(bone.restWorld), c.tail as V3) : null;
            this.colliders.push({ set: c.set, bone, to, local, tail, radius: c.radius, a: [0, 0, 0], b: null });
        }

        // ---- swinging bones: each bone to the first group that names it, parents before children
        const taken = new Set<Bone>();
        const children = new Map<Bone, Bone[]>();
        for (const b of this.bones.values()) if (b.parent) (children.get(b.parent) ?? children.set(b.parent, []).get(b.parent)!).push(b);
        const chainKey = (name: string) => name.replace(/\d+/g, '#');
        this.swinging = [];
        // A group's bones: those its patterns name, and every bone under the chains it starts.
        const groups = d.springs.map((g) => {
            const named = boneMatcher(g.bones);
            const starts = boneMatcher(g.chains ?? '');
            const under = new Set<Bone>();
            const add = (b: Bone) => {
                if (under.has(b)) return;
                under.add(b);
                for (const c of children.get(b) ?? []) add(c);
            };
            if (g.chains) for (const b of this.bones.values()) if (starts(b.name)) add(b);
            return { g, match: (b: Bone) => under.has(b) || named(b.name) };
        });
        for (const bone of this.bones.values()) {
            const found = groups.find((x) => x.match(bone));
            if (!found || taken.has(bone)) continue;
            taken.add(bone);
            // It points at the next bone of its chain; the last one goes on the way it came.
            const kids = (children.get(bone) ?? []).filter((c) => found.match(c));
            const next = kids.find((c) => chainKey(c.name) === chainKey(bone.name)) ?? kids[0];
            let dir: V3;
            let len: number;
            if (next) {
                dir = normalize(next.t);
                len = length(next.t);
            } else {
                const along = rotate(qinv(bone.q), bone.t);
                dir = normalize(along);
                len = Math.min(0.05, length(along) * 0.6);
            }
            if (len < 1e-5) continue;
            this.swinging.push({ bone, group: found.g, dir, len, state: null, hits: this.colliders.filter((c) => hitSets(found.g).has(c.set)) });
        }

        // ---- the face: every bone an expression moves, with its offsets in its parent's space
        const face = new Map<Bone, FaceBone>();
        for (const [name, offsets] of Object.entries(d.expressions)) {
            for (const [boneName, offset] of Object.entries(offsets)) {
                const bone = this.bones.get(boneName);
                if (!bone) continue;
                const entry = face.get(bone) ?? face.set(bone, { bone, offsets: new Map() }).get(bone)!;
                const toParent = bone.parent ? qinv(bone.parent.restWorld) : ([0, 0, 0, 1] as Quat);
                entry.offsets.set(name, rotate(toParent, offset as V3));
            }
        }
        this.face = [...face.values()];
        for (const name of this.weights.keys()) if (!(name in d.expressions)) this.weights.delete(name);
    }

    /** Called by the animator once the clip has posed the bones. */
    solve() {
        const dt = Math.max(0, Time.delta * 0.001);
        this.solveFace(dt);
        if (this.doc.sway && this.swinging.length) this.solveSprings(dt);
        else for (const s of this.swinging) s.state = null;
    }

    private solveFace(dt: number) {
        if (!this.face.length) return;
        const d = this.doc;
        const k = Math.min(1, dt * BLEND);
        for (const name of Object.keys(d.expressions)) {
            if (name === 'blink') continue;
            const now = this.weights.get(name) ?? 0;
            this.weights.set(name, now + ((name === d.expression ? 1 : 0) - now) * k);
        }
        // The blink comes on its own, at uneven intervals.
        let blink = 0;
        if (d.blink && 'blink' in d.expressions) {
            this.blinkAt -= dt;
            if (this.blinkAt <= 0) {
                this.blinkTime = 0;
                this.blinkAt = 2.2 + Math.random() * 3;
            }
            if (this.blinkTime <= BLINK_SECONDS) {
                blink = blinkCurve(this.blinkTime);
                this.blinkTime += dt;
            }
        }
        this.weights.set('blink', d.expression === 'blink' ? 1 : blink);

        for (const f of this.face) {
            let x = f.bone.t[0], y = f.bone.t[1], z = f.bone.t[2];
            for (const [name, o] of f.offsets) {
                const w = this.weights.get(name) ?? 0;
                if (w < 1e-4) continue;
                x += o[0] * w;
                y += o[1] * w;
                z += o[2] * w;
            }
            this.tmpV.set(x, y, z);
            f.bone.obj.transform.localPosition = this.tmpV;
        }
    }

    private solveSprings(dt: number) {
        for (const c of this.colliders) {
            const m = c.bone.obj.transform.worldMatrix.rawData;
            const at = (l: V3): V3 => [m[0] * l[0] + m[4] * l[1] + m[8] * l[2] + m[12], m[1] * l[0] + m[5] * l[1] + m[9] * l[2] + m[13], m[2] * l[0] + m[6] * l[1] + m[10] * l[2] + m[14]];
            c.a = at(c.local);
            c.b = c.to ? position(c.to.obj) : c.tail ? at(c.tail) : null;
        }
        const ratio = this.lastStep > 0 && dt > 0 ? Math.min(2, Math.max(0.5, dt / this.lastStep)) : 1;
        this.lastStep = dt;
        for (const s of this.swinging) {
            const t = s.bone.obj.transform;
            // The pose the clip gave it this frame: what it swings around.
            const pose: Quat = [t.localRotQuat.x, t.localRotQuat.y, t.localRotQuat.z, t.localRotQuat.w];
            const parent = worldRotation((s.bone.parent?.obj ?? (s.bone.obj.parent?.object3D as Object3D)) || null);
            const head = position(s.bone.obj);
            const restDir = normalize(rotate(qmul(parent, pose), s.dir));
            if (!s.state || length(sub(head, s.state.headPrev)) > TELEPORT) {
                s.state = springRest(head, restDir, s.len);
                // What it already touches at rest it is not pushed out of (it would pop).
                const tail = s.state.cur;
                const sets = hitSets(s.group);
                s.hits = this.colliders.filter((c) => sets.has(c.set) && pushOut(tail, c.a, c.b, c.radius + s.group.radius) === tail);
                continue;
            }
            if (dt <= 0) continue;
            const radius = s.group.radius;
            const hits = s.hits;
            const dir = springStep(s.state, head, restDir, s.len, s.group, dt, ratio, hits.length ? (p) => { let out = p; for (const c of hits) out = pushOut(out, c.a, c.b, c.radius + radius); return out; } : undefined);
            // Turn the bone from where its pose points to where it points now, in the parent's space.
            const turn = rotationBetween(restDir, dir);
            const local = qmul(qmul(qmul(qinv(parent), turn), parent), pose);
            this.tmpQ.set(local[0], local[1], local[2], local[3]);
            t.localRotQuat = this.tmpQ;
        }
    }
}
