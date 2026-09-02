# Third-party notices

## thinking-orbs

Copyright (c) 2026 Jakub Antalik

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Ghostty / libghostty-vt

Aiden's in-app terminal uses a WebAssembly build of Ghostty's `libghostty-vt`
(`renderer/lib/ghostty-terminal/vendor/ghostty-vt.wasm`) plus a 112-byte PTY
callback trampoline. The browser host is adapted from T3 Code's MIT-licensed
`libghostty-vt` adapter.

Ghostty: Copyright (c) 2024-2026 Mitchell Hashimoto and Ghostty contributors  
T3 Code adapter: Copyright (c) 2026 T3 Tools Inc.

MIT License. See `renderer/lib/ghostty-terminal/GHOSTTY-LICENSE` and
https://github.com/pingdotgg/t3code/blob/main/LICENSE

## Symbols Nerd Font Mono

Vendored as `renderer/lib/ghostty-terminal/fonts/SymbolsNerdFontMono-Regular.woff2`
for terminal prompt glyphs.

Copyright (c) 2014 Ryan L McIntyre

MIT License. See `renderer/lib/ghostty-terminal/fonts/LICENSE`


## Chart.js

Chart.js is vendored into `resources/generative-ui` for sandboxed Generative UI artifacts.

Copyright (c) 2014-2026 Chart.js Contributors

MIT License. See https://github.com/chartjs/Chart.js/blob/master/LICENSE.md

## Plotly.js

`plotly.js-dist-min` is vendored into `resources/generative-ui` for sandboxed Generative UI artifacts.

Copyright (c) 2016-2026 Plotly, Inc.

MIT License. See https://github.com/plotly/plotly.js/blob/master/LICENSE

## KaTeX

KaTeX (JavaScript, CSS, and fonts) is used in Aiden Markdown and a separate copy is vendored into `resources/generative-ui` for sandboxed Generative UI artifacts.

Copyright (c) 2013-2026 Khan Academy and other contributors

MIT License. See https://github.com/KaTeX/KaTeX/blob/main/LICENSE.txt

## rpiv extensions

Aiden's native extensions adapt interaction and state-management ideas from
`@juicesharp/rpiv-todo`, `@juicesharp/rpiv-advisor`, and `@juicesharp/rpiv-btw`.

Copyright (c) 2026 juicesharp

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
