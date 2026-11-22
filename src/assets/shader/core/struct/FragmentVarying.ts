/**
 * @internal
 */
export let FragmentVarying: string = /*wgsl*/ `
    struct FragmentVarying {
        @location(auto) @interpolate(flat) index: f32,
        @location(auto) fragUV0: vec2<f32>,
        @location(auto) fragUV1: vec2<f32>,
        @location(auto) viewPosition: vec4<f32>,
        @location(auto) fragPosition: vec4<f32>,
        @location(auto) vWorldPos: vec4<f32>,
        @location(auto) vWorldNormal: vec3<f32>,
        @location(auto) vColor: vec4<f32>,

        #if USE_SHADOWMAPING
            @location(auto) vShadowPos: vec4<f32>,
        #endif

        #if USE_TANGENT
            @location(auto) TANGENT: vec4<f32>,
        #endif

        #if USE_TRANSMISSION
            // Matches VertexOutput.varying_ModelScale; consumed by
            // PBRLitShader's transmission ray.
            @location(auto) modelScale: vec3<f32>,
        #endif

        #if USE_CUSTOM_VARYING
            // Matches VertexOutput.varying_Custom0..2.
            @location(auto) vCustom0: vec4<f32>,
            @location(auto) vCustom1: vec4<f32>,
            @location(auto) vCustom2: vec4<f32>,
        #endif

        @builtin(front_facing) face: bool,
        @builtin(position) fragCoord : vec4<f32>
    };
`
