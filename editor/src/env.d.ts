/// <reference types="vite/client" />

/** Build metadata injected by editor/vite.config.js. */
declare const __EDITOR_BUILD__: { sha: string; ref: string; repo: string; time: string };

/** A local cel shading pack (vite.config.js shadingPack): its factory, or undefined when none is given. */
declare module 'virtual:morglay-shading-pack' {
    export const makeShading:
        | ((deps: import('./engine/animeShadingApi').ShadingDeps) => import('./engine/animeShadingApi').AnimeShading)
        | undefined;
}
