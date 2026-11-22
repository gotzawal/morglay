// Vertex data a cel-shaded character needs that model files often lack:
// tangents (for normal maps and hair highlights) and the smoothed normals its
// outline goes out along (they do not split at hard edges or UV seams, so the
// outline stays closed). Plain triangle lists, glTF conventions: +Y up, UV v
// down the image.

/** The angle of a triangle's corner at a. */
function cornerAngle(P: ArrayLike<number>, a: number, b: number, c: number): number {
    const ax = P[b * 3] - P[a * 3], ay = P[b * 3 + 1] - P[a * 3 + 1], az = P[b * 3 + 2] - P[a * 3 + 2];
    const bx = P[c * 3] - P[a * 3], by = P[c * 3 + 1] - P[a * 3 + 1], bz = P[c * 3 + 2] - P[a * 3 + 2];
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
    if (la < 1e-12 || lb < 1e-12) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb))));
}

/**
 * Tangents (x, y, z, w per vertex): +U, the bitangent cross(normal, tangent) * w
 * pointing up the image (toward smaller v), as glTF normal maps with green up
 * expect. Each triangle's UV direction, weighted by the corner's angle, summed
 * per vertex and made square to the normal; a vertex with no UV direction gets
 * any direction square to its normal.
 */
export function computeTangents(P: ArrayLike<number>, N: ArrayLike<number>, UV: ArrayLike<number>, I: ArrayLike<number>): Float32Array {
    const count = P.length / 3;
    const T = new Float64Array(count * 3);
    const B = new Float64Array(count * 3);
    for (let f = 0; f + 2 < I.length; f += 3) {
        const i0 = I[f], i1 = I[f + 1], i2 = I[f + 2];
        const e1x = P[i1 * 3] - P[i0 * 3], e1y = P[i1 * 3 + 1] - P[i0 * 3 + 1], e1z = P[i1 * 3 + 2] - P[i0 * 3 + 2];
        const e2x = P[i2 * 3] - P[i0 * 3], e2y = P[i2 * 3 + 1] - P[i0 * 3 + 1], e2z = P[i2 * 3 + 2] - P[i0 * 3 + 2];
        // v runs down the image: up is -v.
        const du1 = UV[i1 * 2] - UV[i0 * 2], dv1 = UV[i0 * 2 + 1] - UV[i1 * 2 + 1];
        const du2 = UV[i2 * 2] - UV[i0 * 2], dv2 = UV[i0 * 2 + 1] - UV[i2 * 2 + 1];
        const det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) < 1e-20) continue;
        const r = 1 / det;
        const sx = (e1x * dv2 - e2x * dv1) * r, sy = (e1y * dv2 - e2y * dv1) * r, sz = (e1z * dv2 - e2z * dv1) * r;
        const tx = (e2x * du1 - e1x * du2) * r, ty = (e2y * du1 - e1y * du2) * r, tz = (e2z * du1 - e1z * du2) * r;
        const ls = Math.hypot(sx, sy, sz), lt = Math.hypot(tx, ty, tz);
        if (ls < 1e-20 || lt < 1e-20) continue;
        const corners = [i0, i1, i2];
        const angles = [cornerAngle(P, i0, i1, i2), cornerAngle(P, i1, i2, i0), cornerAngle(P, i2, i0, i1)];
        for (let k = 0; k < 3; k++) {
            const v = corners[k], w = angles[k];
            T[v * 3] += (sx / ls) * w; T[v * 3 + 1] += (sy / ls) * w; T[v * 3 + 2] += (sz / ls) * w;
            B[v * 3] += (tx / lt) * w; B[v * 3 + 1] += (ty / lt) * w; B[v * 3 + 2] += (tz / lt) * w;
        }
    }
    const out = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) {
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
        let tx = T[v * 3], ty = T[v * 3 + 1], tz = T[v * 3 + 2];
        const d = nx * tx + ny * ty + nz * tz;
        tx -= nx * d; ty -= ny * d; tz -= nz * d;
        let l = Math.hypot(tx, ty, tz);
        if (l < 1e-12) {
            const [rx, ry, rz] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            tx = ry * nz - rz * ny; ty = rz * nx - rx * nz; tz = rx * ny - ry * nx;
            l = Math.hypot(tx, ty, tz) || 1;
        }
        tx /= l; ty /= l; tz /= l;
        const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
        out[v * 4] = tx; out[v * 4 + 1] = ty; out[v * 4 + 2] = tz;
        out[v * 4 + 3] = cx * B[v * 3] + cy * B[v * 3 + 1] + cz * B[v * 3 + 2] < 0 ? -1 : 1;
    }
    return out;
}

/**
 * Normals for the outline (x, y, z per vertex, in the mesh's own space): the
 * vertices at one place (within `weld`) share one, the normals of every
 * triangle touching that place weighted by the corner's angle. Seams and hard
 * edges do not split it, so the outline's hull stays closed there. A place no
 * triangle covers keeps the vertex's own normal.
 */
export function computeOutlineNormals(P: ArrayLike<number>, I: ArrayLike<number>, N: ArrayLike<number>, weld = 1e-5): Float32Array {
    const count = P.length / 3;
    const key = (v: number) => `${Math.round(P[v * 3] / weld)},${Math.round(P[v * 3 + 1] / weld)},${Math.round(P[v * 3 + 2] / weld)}`;
    const groupOf = new Int32Array(count);
    const groups = new Map<string, number>();
    for (let v = 0; v < count; v++) {
        const k = key(v);
        let g = groups.get(k);
        if (g === undefined) groups.set(k, (g = groups.size));
        groupOf[v] = g;
    }
    const sum = new Float64Array(groups.size * 3);
    for (let f = 0; f + 2 < I.length; f += 3) {
        const i0 = I[f], i1 = I[f + 1], i2 = I[f + 2];
        const e1x = P[i1 * 3] - P[i0 * 3], e1y = P[i1 * 3 + 1] - P[i0 * 3 + 1], e1z = P[i1 * 3 + 2] - P[i0 * 3 + 2];
        const e2x = P[i2 * 3] - P[i0 * 3], e2y = P[i2 * 3 + 1] - P[i0 * 3 + 1], e2z = P[i2 * 3 + 2] - P[i0 * 3 + 2];
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-20) continue;
        nx /= l; ny /= l; nz /= l;
        const corners = [i0, i1, i2];
        const angles = [cornerAngle(P, i0, i1, i2), cornerAngle(P, i1, i2, i0), cornerAngle(P, i2, i0, i1)];
        for (let k = 0; k < 3; k++) {
            const g = groupOf[corners[k]], w = angles[k];
            sum[g * 3] += nx * w; sum[g * 3 + 1] += ny * w; sum[g * 3 + 2] += nz * w;
        }
    }
    const out = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
        const g = groupOf[v];
        let x = sum[g * 3], y = sum[g * 3 + 1], z = sum[g * 3 + 2];
        let l = Math.hypot(x, y, z);
        if (l < 1e-12) { x = N[v * 3]; y = N[v * 3 + 1]; z = N[v * 3 + 2]; l = Math.hypot(x, y, z) || 1; }
        out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l;
    }
    return out;
}
