/**
 * @internal
 */
export enum VertexAttributeName {
    position = 'position',
    normal = 'normal',
    uv = 'uv',
    TANGENT = 'TANGENT',
    TEXCOORD_1 = 'TEXCOORD_1',
    TEXCOORD_2 = 'TEXCOORD_2',
    TEXCOORD_3 = 'TEXCOORD_3',
    TEXCOORD_4 = 'TEXCOORD_4',
    TEXCOORD_5 = 'TEXCOORD_5',
    TEXCOORD_6 = 'TEXCOORD_6',
    TEXCOORD_7 = 'TEXCOORD_7',
    color = 'color',
    /**
     * A second normal per vertex, for hulls drawn around the mesh (outlines):
     * xyz is the direction the hull goes out in the mesh's own space, the same
     * at every vertex of a hard edge so the hull does not split there. A pass
     * reads it only with the `USE_OUTLINE_NORMAL` define. glTF: `_OUTLINE_NORMAL`.
     */
    outlineNormal = 'outlineNormal',
    joints0 = 'joints0',
    joints1 = 'joints1',
    weights0 = 'weights0',
    weights1 = 'weights1',
    weight = 'weight',
    indices = `indices`,
    vIndex = 'vIndex',
    a_morphPositions_0 = 'a_morphPositions_0',


    all = 'all',
}
