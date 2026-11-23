// Writes the walk maker into a project as a script: the motion formulas (src/core/motionGen) bundled into one readable JS
// file, with the few lines that find the objects it is attached to and make their walks. The project then makes the walk
// itself when it opens, and again when a model is replaced; the editor only shows the project (it gives scripts
// `project`, the document and the files, see src/play/compiler.ts). Edit the script in the project's Code panel.
//
//   node editor/scripts/make-walk-script.mjs examples/edelweiss-walk/project.json Edelweiss
//
// The second argument is the name of the object the script is attached to; its trail is the project's asset
// "walk-trail.json" (a Trail: core/motionGen/pathWalk.ts), the clip it makes "Walk Path".
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
// esbuild comes with vite (pnpm keeps it beside the other packages).
const pnpm = path.join(root, 'node_modules', '.pnpm');
const found = fs.existsSync(pnpm) ? fs.readdirSync(pnpm).find((d) => d.startsWith('esbuild@')) : undefined;
const require = createRequire(found ? path.join(pnpm, found, 'node_modules', 'esbuild', 'package.json') : path.join(root, 'package.json'));
const esbuild = require(found ? path.join(pnpm, found, 'node_modules', 'esbuild') : 'esbuild');

const [projectFile = 'examples/edelweiss-walk/project.json', objectName = 'Edelweiss'] = process.argv.slice(2);
const motion = path.join(root, 'editor', 'src', 'core', 'motionGen');

const entry = `
export { walkOnModel, trailRibbon } from ${JSON.stringify(path.join(motion, 'pathWalk.ts').replace(/\\/g, '/'))};
export { readGlbClips } from ${JSON.stringify(path.join(root, 'editor', 'src', 'core', 'retarget.ts').replace(/\\/g, '/'))};
`;
const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'walk-maker-entry.ts', loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'WalkLib', platform: 'browser', target: 'es2020', legalComments: 'none',
    logLevel: 'error',
});
const library = built.outputFiles[0].text.replace(/^"use strict";\n/, '');

const code = `// Walk Maker: makes the walk of the objects this script is attached to, from a trail the project holds.
//
// For each such object it walks the trail (the project's asset named by \`trail\`: where the body goes over time, as
// [left, ahead] metres 240 times a second) on the object's own model with the motion formulas below, writes the clip
// named \`clip\` into a copy of the model's file, and points the object at it. It does so when the project opens and again
// when the model is replaced, so the walk fits whatever body is shown. It also draws the trail on the floor, once.
//
// Everything is here: change the formulas, the trail or the rules below and the project follows (a script that is
// compiled again runs again; replace a model to make its walk again). The formulas are the bundle of editor/src/core/motionGen
// (editor/MOTION.md says what each term does); this script was written by editor/scripts/make-walk-script.mjs.
import { Script, project } from 'morglay';

${library}
export default class WalkMaker extends Script {
    /** The project's asset (by file name) that holds the trail. */
    trail = 'walk-trail.json';
    /** The clip to make; an object whose model has it already is left alone. */
    clip = 'Walk Path';
}

const defaults = new WalkMaker();
const made = new Set();
let busy = false;
let again = false;

async function makeWalks() {
    if (busy) { again = true; return; }
    busy = true;
    try {
        for (const node of project.doc.nodes) {
            const ref = (node.scripts || []).find((r) => r.script === project.script.id && r.enabled);
            if (!ref || !node.model) continue;
            const trailName = ref.props.trail ?? defaults.trail, clip = ref.props.clip ?? defaults.clip;
            const key = node.model.asset + ':' + trailName + ':' + clip;
            if (made.has(key)) continue;
            made.add(key);
            const model = project.doc.assets.find((a) => a.id === node.model.asset);
            const trailAsset = project.doc.assets.find((a) => a.name === trailName);
            const bytes = model ? await project.readAsset(model.id) : null;
            const trailBytes = trailAsset ? await project.readAsset(trailAsset.id) : null;
            if (!bytes || !trailBytes) { console.warn('Walk Maker: no model or no trail "' + trailName + '" for ' + node.name); continue; }
            if (WalkLib.readGlbClips(bytes)?.clips.some((c) => c.name === clip)) continue;
            try {
                const trail = JSON.parse(new TextDecoder().decode(trailBytes));
                const walk = WalkLib.walkOnModel(bytes, trail, clip);
                const id = await project.addAsset(model.name, walk.glb, 'model', 'model/gltf-binary');
                project.commit('Make walk', (doc) => {
                    const n = doc.nodes.find((x) => x.id === node.id);
                    if (!n || !n.model) return;
                    n.model.asset = id;
                    n.animation = { speed: 1, fade: 0.25, preview: true, idle: '', walk: '', run: '', jump: '', fall: '', ...n.animation, clip };
                    // The model without the walk goes where nothing else shows it.
                    if (!doc.nodes.some((x) => x.model && x.model.asset === model.id)) doc.assets = doc.assets.filter((a) => a.id !== model.id);
                });
                const line = node.name + ' Path';
                if (!project.doc.nodes.some((x) => x.name === line)) {
                    const ribbon = await project.addAsset('walk-path.glb', WalkLib.trailRibbon(trail), 'model', 'model/gltf-binary');
                    const drawn = project.newNode(line);
                    drawn.model = { asset: ribbon };
                    project.commit('Draw path', (doc) => void doc.nodes.push(drawn));
                }
            } catch (e) {
                console.error('Walk Maker: no walk for ' + node.name, e);
            }
        }
    } finally {
        busy = false;
    }
    if (again) { again = false; void makeWalks(); }
}

project.onChange(() => void makeWalks());
void makeWalks();
`;

const file = path.resolve(root, 'editor', projectFile);
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const scene = manifest.scene;
const id = 's_walkmaker';
scene.scripts = scene.scripts.filter((s) => s.id !== id);
scene.scripts.push({ id, name: 'WalkMaker.js', code });
const node = scene.nodes.find((n) => n.name === objectName);
if (!node) throw new Error(`no object called ${objectName}`);
node.scripts = [{ script: id, enabled: true, props: {} }];
if (node.animation) delete node.animation.trail;
fs.writeFileSync(file, JSON.stringify(manifest));
console.log(`script ${(code.length / 1024).toFixed(0)} KB (library ${(library.length / 1024).toFixed(0)} KB) -> ${projectFile}, attached to ${objectName}`);
