import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {Button, Badge, Text} from './ui';
const source=(p:string)=>readFileSync(new URL(p,import.meta.url),'utf8');
test('badge glyphs express caller meaning independently of tone',()=>{
 assert.doesNotMatch(renderToStaticMarkup(<Badge color="green">Tools</Badge>),/<svg|aria-hidden/u);
 assert.match(renderToStaticMarkup(<Badge color="blue" icon={<svg/>}>Preparing</Badge>),/aria-hidden="true"/u);
 assert.match(renderToStaticMarkup(<Badge color="green">Tools</Badge>),/bg-status-green-surface/u);
});
test('routine buttons stay static and optional press feedback honors reduced motion',()=>{
 assert.doesNotMatch(renderToStaticMarkup(<Button>Copy</Button>),/button-press-feedback|active:scale/u);
 assert.match(renderToStaticMarkup(<Button pressFeedback>Continue</Button>),/button-press-feedback/u);
 const css=source('../styles.css');
 assert.match(css,/\.button-press-feedback:active:not\(:disabled\) \{ scale: 0\.96;/u);
 assert.match(css,/:root\[data-reduce-motion="true"\] \.button-press-feedback \{ scale: none !important;/u);
 assert.match(css,/@media \(prefers-reduced-motion: reduce\) \{\s*\.button-press-feedback \{ scale: none !important;/u);
});
test('tinted error text renders one explicit foreground utility',()=>{
 const markup=renderToStaticMarkup(<Text color="status-red">Error</Text>);
 assert.match(markup,/text-status-red/u);
 assert.doesNotMatch(markup,/class="[^"]*\btext-red\b/u);
});
test('polish contracts preserve focus, targets, numeric stability, and text scaling',()=>{
 const composer=source('./composer.tsx'),css=source('../styles.css');
 assert.ok(css.includes('[tabindex]:not([tabindex="-1"]):not(input):not(textarea)'), 'all non-text keyboard targets receive neutral focus');
 assert.ok(css.includes('outline-offset: var(--keyboard-focus-offset, 2px) !important;'));
 assert.doesNotMatch(composer,/group-data-\[open=true\]\/access:opacity-0/u);
 assert.match(composer,/event.detail > 0 && \(value !== "full" \|\| value === permission\)/u);
 assert.match(composer,/aria-label=\{`Remove \$\{a.name\}`\}[\s\S]{0,100}size-10/u);
 assert.doesNotMatch(source('./settings/dictation-shortcut-settings.tsx'),/rounded-control border border-field/u);
 for(const p of ['./subagent-detail.tsx','./settings/remote-access-settings.tsx']) assert.match(source(p),/tabular-nums/u);
 assert.match(css,/\.model-pad-browser-count \{[^}]*font-size: var\(--text-mini\)/u);
 assert.match(css,/\.appearance-color-control > input \{[^}]*font-size: var\(--text-small\)/u);
 assert.doesNotMatch(source('./activity-feed.tsx'),/key=\{newest.id\}/u);
 assert.match(source('./settings/appearance-settings.tsx'),/previewStyle\(config\[scheme\], scheme\)/u);
});

test('theme preview geometry exists at rest independently of keyboard focus', () => {
 const css = source('../styles.css');
 const base = css.match(/^\.appearance-mode-preview \{([^}]+)\}/mu)?.[1];
 assert.ok(base, 'standalone base preview selector must exist');
 assert.match(base, /display: flex/u);
 assert.match(base, /aspect-ratio: 1\.52/u);
 assert.match(base, /position: relative/u);
 assert.match(css, /^\.appearance-mode-option\[aria-checked="true"\] \.appearance-mode-option-label \{[^}]*background: var\(--surface-list-selection\)/mu);
});
