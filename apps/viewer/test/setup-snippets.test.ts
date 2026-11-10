import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, SETUPS, SOURCES, languagesFor, sourcesFor } from '../src/components/SetupSnippet';

const ROOT = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const snippets = LANGUAGES.flatMap((l) =>
  Object.entries(SETUPS[l.id]).map(([source, setup]) => ({
    name: `${l.id}/${source}`, language: l.id,
    text: `${setup!.install}\n${setup!.code('ida_test_key', 'https://api.example')}\n${setup!.example ?? ''}`,
  })),
);

describe('setup snippets', () => {
  it('every language and every source has something to show', () => {
    for (const l of LANGUAGES) expect(sourcesFor(l.id).length, l.id).toBeGreaterThan(0);
    for (const s of SOURCES) expect(languagesFor(s.id).length, s.id).toBeGreaterThan(0);
  });

  it('fill in the project key and the endpoint', () => {
    for (const s of snippets) {
      expect(s.text, s.name).toContain('https://api.example');
      expect(s.text, s.name).toMatch(/ida_test_key|IDA_PROJECT_KEY/);
    }
  });

  it('only import what the JavaScript packages export, and install every package they import', () => {
    for (const s of snippets.filter((x) => x.language !== 'python')) {
      for (const [, names, pkg] of s.text.matchAll(/import \{ ([^}]+) \} from '@ida-dev\/([\w-]+)'/g)) {
        expect(s.text.split('\n')[0], `${s.name} installs @ida-dev/${pkg}`).toContain(`@ida-dev/${pkg}`);
        // The package's entry: cloud has one per platform (both export the same API).
        const source = read(`packages/${pkg}/src/${pkg === 'cloud' ? (s.language === 'browser' ? 'browser' : 'node') : 'index'}.ts`);
        for (const name of names!.split(',').map((n) => n.trim())) {
          expect(source, `${s.name}: @ida-dev/${pkg} exports ${name}`).toMatch(new RegExp(`export (async )?(function|const|class) ${name}\\b|export \\{[^}]*\\b${name}\\b`));
        }
      }
    }
  });

  it('only call what the Python SDK defines', () => {
    for (const s of snippets.filter((x) => x.language === 'python')) {
      for (const [, module, fn] of s.text.matchAll(/ida\.adapters\.(\w+)\.(\w+)\(/g)) {
        expect(read(`python/src/ida/adapters/${module}.py`), `${s.name}: ${module}.${fn}`).toMatch(new RegExp(`^def ${fn}\\(`, 'm'));
      }
      for (const [, fn] of s.text.matchAll(/ida\.cloud\.(\w+)\(/g)) expect(read('python/src/ida/cloud/__init__.py')).toMatch(new RegExp(`^def ${fn}\\(`, 'm'));
      for (const [, name] of s.text.matchAll(/\bida\.(enable|Emitter|connect_recorder)\b/g)) expect(read('python/src/ida/__init__.py')).toContain(`"${name}"`);
      for (const [, extra] of s.text.matchAll(/ida-sdk\[(\w+)\]/g)) expect(read('python/pyproject.toml')).toMatch(new RegExp(`^${extra} = `, 'm'));
    }
  });
});
