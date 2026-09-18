import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(name) {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

describe('desktop viewport scroll contract', () => {
  it('keeps the workspace inside the app viewport and scrolls the side rails independently', () => {
    const styles = source('./viewport-scroll.css');
    const main = source('./main.tsx');

    expect(main).toContain("import './viewport-scroll.css';");
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*height:\s*100%/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.workspace\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.left-rail,\s*\.right-rail\s*\{[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/\.left-rail,\s*\.right-rail\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(styles).toMatch(/\.left-rail,\s*\.right-rail\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  });
});
