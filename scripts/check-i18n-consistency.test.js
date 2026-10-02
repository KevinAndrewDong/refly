import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import I18nConsistencyChecker from './check-i18n-consistency';

const fixtures = [];
function extract(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refly-i18n-test-'));
  fixtures.push(directory);
  const file = path.join(directory, 'translations.ts');
  fs.writeFileSync(file, source);
  const checker = new I18nConsistencyChecker();
  return { keys: checker.extractTranslationKeys(file), checker };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) fs.rmSync(directory, { recursive: true });
  globalThis.PWNED = undefined;
});

describe('static translation extraction', () => {
  it('extracts keys without executing translation values', () => {
    const { keys, checker } = extract(`
      const translations = {
        safe: 'value',
        malicious: (() => { globalThis.PWNED = true; return 'x'; })(),
      };
      export default translations;
    `);
    expect(globalThis.PWNED).toBeUndefined();
    expect(Object.keys(keys)).toEqual(['safe', 'malicious']);
    expect(keys.safe).toBe('value');
    expect(checker.errors).toEqual([]);
  });

  it('handles static names, nesting, empty objects, comments and dynamic leaves', () => {
    const { keys, checker } = extract(
      [
        'const translations = {',
        "  save: 'Save', // trailing comment",
        "  'image.api.error': 'Image error',",
        "  nested: { delete: 'Delete', },",
        '  steps: {},',
        '  template: `plain text`,',
        "  literal: 'credit(s)',",
        "  call: t('value', { returnObjects: true }),",
        '  interpolation: `text ${(() => { globalThis.PWNED = true; return 1; })()}`,',
        '}; export default translations;',
      ].join('\n'),
    );
    expect(Object.keys(keys)).toEqual([
      'save',
      'image.api.error',
      'nested.delete',
      'template',
      'literal',
      'call',
      'interpolation',
    ]);
    expect(keys.template).toBe('plain text');
    expect(keys.literal).toBe('credit(s)');
    expect(globalThis.PWNED).toBeUndefined();
    expect(checker.errors).toEqual([]);
  });

  it('keeps the empty and untranslated literal-value warnings', () => {
    const { keys, checker } = extract(
      [
        'const translations = {',
        "empty: '', nil: null, absent: undefined, same: 'English text',",
        'call: missingFunction(), interpolation: `text ${missingFunction()}`,',
        '}; export default translations;',
      ].join('\n'),
    );
    checker.compareTranslations({ same: 'English text' }, keys, 'fixture.ts');
    expect(checker.errors).toEqual([]);
    expect(checker.warnings.map(({ type, keys }) => ({ type, keys }))).toEqual([
      { type: 'extra_translations', keys: ['empty', 'nil', 'absent', 'call', 'interpolation'] },
      { type: 'empty_translations', keys: ['empty', 'nil', 'absent'] },
      { type: 'untranslated_text', keys: ['same'] },
    ]);
  });

  it('uses the last duplicate property without executing overwritten values', () => {
    const { keys } = extract(`
      const translations = {
        nested: { stale: 'old' }, nested: { current: 'new' },
        value: (() => { globalThis.PWNED = true; })(), value: 'final',
      }; export default translations;
    `);
    expect(Object.keys(keys)).toEqual(['nested.current', 'value']);
    expect(keys.value).toBe('final');
    expect(globalThis.PWNED).toBeUndefined();
  });

  it('keeps arrays as leaf keys without executing their elements', () => {
    const { keys, checker } = extract(`const translations = {
      items: ['text', (() => { globalThis.PWNED = true; return 'x'; })()],
      empty: [],
    }; export default translations;`);
    expect(Object.keys(keys)).toEqual(['items', 'empty']);
    checker.compareTranslations({ items: 'base', empty: 'base' }, keys, 'fixture.ts');
    expect(checker.warnings).toEqual([]);
    expect(checker.errors).toEqual([]);
    expect(globalThis.PWNED).toBeUndefined();
  });

  it('collects prototype-related keys as own properties', () => {
    const { keys } = extract(`const translations = {
      '__proto__': 'literal', constructor: { prototype: 'literal' },
    }; export default translations;`);
    expect(Object.hasOwn(keys, '__proto__')).toBe(true);
    expect(keys.__proto__).toBe('literal');
    expect(Object.hasOwn(keys, 'constructor.prototype')).toBe(true);
    expect(Object.getPrototypeOf(keys)).toBe(Object.prototype);
  });

  it.each([
    'const other = {};',
    'let translations = {};',
    'const translations = missingFunction();',
    "const translations = 'PRIVATE_SENTINEL';",
    'const translations = { PRIVATE_SENTINEL: ; };',
    'const translations = {}; const translations = {};',
    'const translations = { [(() => { globalThis.PWNED = true; })()]: 1 };',
    'const translations = { ...(() => { globalThis.PWNED = true; })() };',
    'const translations = { get secret() { globalThis.PWNED = true; return 1; } };',
    'const translations = { PRIVATE_SENTINEL };',
    "const translations = { key?: 'value' };",
    "const translations = { key!: 'value' };",
    "const translations = { readonly key: 'value' };",
  ])('reports parse_error for malformed or non-static object structure: %s', (source) => {
    const { keys, checker } = extract(`${source}\nexport default translations;`);
    expect(keys).toEqual({});
    expect(checker.errors).toHaveLength(1);
    expect(checker.errors[0].type).toBe('parse_error');
    expect(checker.errors[0].message).toBe('failed to parse translation object');
    expect(JSON.stringify(checker.errors)).not.toContain('PRIVATE_SENTINEL');
    expect(globalThis.PWNED).toBeUndefined();
  });

  it.each(['', 'export default {};', 'export default other;', 'export = translations;'])(
    'reports parse_error when translations is not the direct default export: %s',
    (exportStatement) => {
      const { keys, checker } = extract(
        `const translations = { unused: 'value' }; ${exportStatement}`,
      );
      expect(keys).toEqual({});
      expect(checker.errors[0]).toMatchObject({
        type: 'parse_error',
        message: 'failed to parse translation object',
      });
    },
  );

  it('normalizes decoding/parser failures without including source or exceptions', () => {
    const { keys, checker } = extract(
      Buffer.from('const translations = { PRIVATE_SENTINEL: 1 };', 'utf16le'),
    );
    expect(keys).toEqual({});
    expect(checker.errors[0]).toMatchObject({
      type: 'parse_error',
      message: 'failed to parse translation object',
    });
    expect(JSON.stringify(checker.errors)).not.toContain('PRIVATE_SENTINEL');
  });

  it.each([null, undefined, 123, {}, Buffer.from('PRIVATE_SENTINEL')])(
    'reports parse_error for wrong path types without invoking conversion: %s',
    (input) => {
      const checker = new I18nConsistencyChecker();
      expect(checker.extractTranslationKeys(input)).toEqual({});
      expect(checker.errors[0]).toMatchObject({
        type: 'parse_error',
        message: 'failed to parse translation object',
      });
    },
  );

  it('does not invoke input conversion hooks', () => {
    const checker = new I18nConsistencyChecker();
    expect(
      checker.extractTranslationKeys({
        toString() {
          globalThis.PWNED = true;
          return 'path';
        },
      }),
    ).toEqual({});
    expect(globalThis.PWNED).toBeUndefined();
    expect(checker.errors[0].type).toBe('parse_error');
  });

  it('handles long scalar and numeric value tokens without evaluating values', () => {
    const value = 'x'.repeat(100000);
    const { keys, checker } = extract(
      `const translations = { text: '${value}', number: ${'9'.repeat(10000)} }; export default translations;`,
    );
    expect(Object.keys(keys)).toEqual(['text', 'number']);
    expect(keys.text).toBe(value);
    expect(checker.errors).toEqual([]);
  });

  it('normalizes parser recursion limits into the stable parse_error', () => {
    const { keys, checker } = extract(
      `const translations = ${'{ nested: '.repeat(3000)}'PRIVATE_SENTINEL'${'}'.repeat(3000)}; export default translations;`,
    );
    expect(keys).toEqual({});
    expect(checker.errors[0]).toMatchObject({
      type: 'parse_error',
      message: 'failed to parse translation object',
    });
    expect(JSON.stringify(checker.errors)).not.toContain('PRIVATE_SENTINEL');
  });

  for (const language of ['en-US', 'zh-Hans']) {
    it.each(['ui.ts', 'skill.ts', 'skill-log.ts'])(`parses real ${language}/%s`, (file) => {
      const checker = new I18nConsistencyChecker();
      const keys = checker.extractTranslationKeys(
        path.resolve('packages/i18n/src', language, file),
      );
      expect(Object.keys(keys).length).toBeGreaterThan(0);
      expect(checker.errors).toEqual([]);
    });
  }
});
