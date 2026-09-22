# Generative UI host libraries

Aiden vendors Chart.js, Plotly, and KaTeX here for sandboxed HTML artifacts.

Do not edit these files by hand. Run `node scripts/vendor-generative-ui-libs.mjs` (also invoked from `postinstall`) after installing npm dependencies. Packaged builds copy this directory as `process.resourcesPath/generative-ui`.
