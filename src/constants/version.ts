declare const __APP_VERSION__: string | undefined;

// App version — Vite injects `__APP_VERSION__` and `import.meta.env.PACKAGE_VERSION`
// from `package.json` at build/dev time; the fallback keeps non-Vite test runners
// aligned without an obsolete version literal.
export const APP_VERSION: string =
    (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '')
    || (import.meta as { env?: { PACKAGE_VERSION?: string } }).env?.PACKAGE_VERSION
    || '1.8.0';
export const APP_NAME = 'August Trading';
