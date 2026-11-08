/**
 * NativeStatusBar — configures the native status bar on Capacitor builds.
 *
 * On web, all calls are no-ops (the import is tree-shaken out by Vite because
 * `@capacitor/core`'s `Capacitor.isNativePlatform()` returns false).
 *
 * On native (Android/iOS), this:
 *   - Sets the background color to match the app's dark theme
 *   - Switches to light content (white icons) so the status bar is legible
 *     against the dark header
 *   - Overlays the WebView so `env(safe-area-inset-top)` padding applies
 *
 * Without this, the header sits under the status bar / camera cutout
 * on notched Android devices.
 */

const APP_BG_COLOR = '#0d0c0b'; // zinc-950, matches index.css / manifest.json

export const initNativeStatusBar = async (): Promise<void> => {
    try {
        // Dynamic import so web builds don't pull in the native plugin at
        // parse time. The guard inside also protects against the plugin
        // being absent (e.g. a web-only checkout without native deps).
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;

        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setStyle({ style: Style.Light });
        await StatusBar.setBackgroundColor({ color: APP_BG_COLOR });
        // Overlay=true so the WebView extends under the status bar and our
        // env(safe-area-inset-top) padding on #root/Header positions content
        // below the cutout. On iOS this is the default; on Android we set it.
        await StatusBar.setOverlaysWebView({ overlay: true });
        console.log('[NativeStatusBar] Configured for native platform');
    } catch (err) {
        // Non-fatal: web builds and platforms without the plugin continue.
        console.warn('[NativeStatusBar] Not configured:', err);
    }
};
