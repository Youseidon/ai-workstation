import Script from "next/script";
import {
  DEFAULT_EFFECTS,
  DEFAULT_THEME,
  EFFECTS,
  EFFECTS_STORAGE_KEY,
  THEMES,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

/**
 * Stamps `data-theme` / `data-effects` onto <html> before the first paint.
 *
 * This has to be a blocking inline script rather than an effect: React runs
 * after the browser has already painted, which would show one frame of the
 * default theme before switching. The keys and allowed values are interpolated
 * from `lib/theme.ts` so the two can never disagree about a name.
 *
 * `next/script` with `beforeInteractive` is the App Router way to get this into
 * <head> ahead of any framework code — a hand-written <head> in a root layout
 * is discouraged, and an inline script needs an `id` for Next to track it.
 */
export function ThemeScript() {
  const source = `(function(){try{
var d=document.documentElement;
var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
d.dataset.theme=${JSON.stringify(THEMES)}.indexOf(t)>-1?t:${JSON.stringify(DEFAULT_THEME)};
var e=localStorage.getItem(${JSON.stringify(EFFECTS_STORAGE_KEY)});
d.dataset.effects=${JSON.stringify(EFFECTS)}.indexOf(e)>-1?e:${JSON.stringify(DEFAULT_EFFECTS)};
}catch(_){
document.documentElement.dataset.theme=${JSON.stringify(DEFAULT_THEME)};
document.documentElement.dataset.effects=${JSON.stringify(DEFAULT_EFFECTS)};
}})();`;

  return (
    // The App Router docs specify beforeInteractive scripts go in the root
    // layout; this lint rule only knows about the pages router's _document.
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document
    <Script id="agent-console-theme" strategy="beforeInteractive">
      {source}
    </Script>
  );
}
