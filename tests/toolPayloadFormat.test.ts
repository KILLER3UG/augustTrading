import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolPayload, parseCodeFenceLanguage } from '../src/utils/toolPayloadFormat.ts';

describe('formatToolPayload', () => {
    it('pretty-prints valid JSON objects and marks language as JSON', () => {
        const res = formatToolPayload('{"symbol":"BTCUSDT","mark":98420.5,"levels":[97500,99200]}');
        assert.equal(res.language, 'JSON');
        assert.equal(res.truncated, false);
        assert.match(res.text, /^\{\n {2}"symbol": "BTCUSDT",/);
        assert.equal(res.preview, res.text);
        assert.ok(res.lineCount >= 6);
    });

    it('pretty-prints valid JSON arrays', () => {
        const res = formatToolPayload('[{"price":100},{"price":101}]');
        assert.equal(res.language, 'JSON');
        assert.match(res.text, /^\[\n {2}\{/);
    });

    it('falls back cleanly to plain text when JSON is malformed or clipped', () => {
        const res = formatToolPayload('{"symbol":"BTCUSDT","truncated":');
        assert.equal(res.language, 'text');
        assert.equal(res.text, '{"symbol":"BTCUSDT","truncated":');
        assert.equal(res.truncated, false);
    });

    it('truncates long outputs at maxLines while preserving full text', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n');
        const res = formatToolPayload(lines, 10);
        assert.equal(res.language, 'text');
        assert.equal(res.lineCount, 30);
        assert.equal(res.truncated, true);
        assert.equal(res.preview.split('\n').length, 10);
        assert.equal(res.text.split('\n').length, 30);
    });

    it('handles empty or whitespace-only strings safely', () => {
        const res = formatToolPayload('   \n  ');
        assert.equal(res.language, 'text');
        assert.equal(res.text, '');
        assert.equal(res.lineCount, 0);
        assert.equal(res.truncated, false);
    });
});

describe('parseCodeFenceLanguage', () => {
    it('extracts lowercase language tags from react-markdown classes', () => {
        assert.equal(parseCodeFenceLanguage('language-bash'), 'bash');
        assert.equal(parseCodeFenceLanguage('hljs language-TypeScript'), 'typescript');
        assert.equal(parseCodeFenceLanguage('language-c++'), 'c++');
    });

    it('returns null when no language class is present', () => {
        assert.equal(parseCodeFenceLanguage(undefined), null);
        assert.equal(parseCodeFenceLanguage(''), null);
        assert.equal(parseCodeFenceLanguage('font-mono text-zinc-300'), null);
    });
});
