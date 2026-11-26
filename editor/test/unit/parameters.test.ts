import fs from 'fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';

// The motion code's values, counted from its source: every number written in a style or body table (a table spread into
// another, or named in it, writes none). Each value is the body, physics, or the character's own manner, and a meaning is
// written once (editor/MOTION.md, section 3): the count may go down, never up past the ceiling.

const dir = fileURLToPath(new URL('../../src/core/motionGen/', import.meta.url));

function countValues(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const src = ts.createSourceFile(file, fs.readFileSync(dir + file, 'utf8'), ts.ScriptTarget.Latest, true);
        src.forEachChild((node) => {
            if (!ts.isVariableStatement(node)) return;
            for (const d of node.declarationList.declarations) {
                const name = d.name.getText();
                if (!(/STYLE$/.test(name) || /^HUMAN_/.test(name)) || !d.initializer) continue;
                let n = 0;
                const walk = (x: ts.Node) => { if (ts.isNumericLiteral(x)) n++; x.forEachChild(walk); };
                walk(d.initializer);
                counts.set(name, n);
            }
        });
    }
    return counts;
}

describe('the motion values', () => {
    it('are no more than the plan allows', () => {
        const counts = countValues();
        const total = [...counts.values()].reduce((s, n) => s + n, 0);
        // (Stage by stage: 1,093 at the start, 2026-11-25; 566 once a rule is the same to both sides, 497 without what the editor never plays, 285 with the path walk alone, 2026-11-26.)
        expect(total).toBeLessThanOrEqual(285);
    });
});
