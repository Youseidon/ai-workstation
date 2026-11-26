import Script from "next/script";
import {
  DEFAULT_EFFECTS,
  DEFAULT_THEME,
  EFFECTS,
  EFFECTS_STORAGE_KEY,
  THEMES,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

export function ThemeScript() {
  const source = `(function(){try{
var s=localStorage,o="agent-console.",k,i;
for(i=s.length-1;i>=0;i--){k=s.key(i);if(k&&k.indexOf(o)===0){var n="hydra."+k.slice(o.length);if(s.getItem(n)===null)s.setItem(n,s.getItem(k));s.removeItem(k);}}
}catch(_){}})();
(function(){try{
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
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document
    <Script id="hydra-theme" strategy="beforeInteractive">
      {source}
    </Script>
  );
}
