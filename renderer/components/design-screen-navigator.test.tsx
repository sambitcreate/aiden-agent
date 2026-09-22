import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  designScreenNavigatorTarget,
  filterDesignScreenNavigatorItems,
  invokeDesignScreenNavigatorSelection,
  type DesignScreenNavigatorItem,
  type DesignScreenNavigatorTarget,
} from "../shared/design-screen-navigator";

const screens: readonly DesignScreenNavigatorItem[] = [
  {
    nodeId: "node:checkout",
    lineageId: "lineage:checkout",
    title: "Checkout",
    activeRevision: {
      mediaId: "design:checkout:3",
      artifactId: "artifact:checkout:3",
      label: "Revision 3",
    },
    previewRevision: {
      mediaId: "design:checkout:1",
      artifactId: "artifact:checkout:1",
      label: "Revision 1",
    },
  },
  {
    nodeId: "node:home",
    lineageId: "lineage:home",
    title: "Home",
    activeRevision: {
      mediaId: "design:home:2",
      artifactId: "artifact:home:2",
      label: "Revision 2",
    },
  },
];

test("Screen navigator targets the exact displayed immutable revision", () => {
  assert.deepEqual(designScreenNavigatorTarget(screens[0]!), {
    nodeId: "node:checkout",
    lineageId: "lineage:checkout",
    mediaId: "design:checkout:1",
    artifactId: "artifact:checkout:1",
    mode: "historical",
  });
  assert.deepEqual(designScreenNavigatorTarget(screens[1]!), {
    nodeId: "node:home",
    lineageId: "lineage:home",
    mediaId: "design:home:2",
    artifactId: "artifact:home:2",
    mode: "current",
  });

  const normalizedCurrent: DesignScreenNavigatorItem = {
    ...screens[1]!,
    previewRevision: { ...screens[1]!.activeRevision },
  };
  assert.equal(designScreenNavigatorTarget(normalizedCurrent).mode, "current");
});

test("Screen navigator invokes the root callback with full node, lineage, media, and artifact identity", () => {
  let selected: DesignScreenNavigatorTarget | undefined;
  invokeDesignScreenNavigatorSelection(screens[0]!, (target) => {
    selected = target;
  });
  assert.deepEqual(selected, designScreenNavigatorTarget(screens[0]!));
});

test("Screen navigator search matches names and current or preview revision labels", () => {
  assert.deepEqual(
    filterDesignScreenNavigatorItems(screens, " check ").map(({ title }) => title),
    ["Checkout"],
  );
  assert.deepEqual(
    filterDesignScreenNavigatorItems(screens, "revision 1").map(({ title }) => title),
    ["Checkout"],
  );
  assert.deepEqual(
    filterDesignScreenNavigatorItems(screens, "revision 2").map(({ title }) => title),
    ["Home"],
  );
  assert.deepEqual(filterDesignScreenNavigatorItems(screens, "missing"), []);
  assert.equal(filterDesignScreenNavigatorItems(screens, "").length, 2);
});

test("Screen navigator renders an accessible named list with explicit current and preview states", () => {
  const source = readFileSync(new URL("./design-screen-navigator.tsx", import.meta.url), "utf8");
  assert.match(source, /<aside[\s\S]*aria-labelledby=\{titleId\}/u);
  assert.match(source, /<nav[\s\S]*aria-label="Saved Screens"/u);
  assert.match(source, /aria-label="Close Screens"/u);
  assert.match(source, /type="search"/u);
  assert.match(source, /placeholder="Search Screens"/u);
  assert.match(source, /aria-current=\{selected \? "true" : undefined\}/u);
  assert.match(source, /data-node-id=\{screen\.nodeId\}/u);
  assert.match(source, /data-lineage-id=\{screen\.lineageId\}/u);
  assert.match(source, /data-media-id=\{target\.mediaId\}/u);
  assert.match(source, /data-artifact-id=\{target\.artifactId\}/u);
  assert.match(source, /Previewing \{previewRevision\.label\}/u);
  assert.match(source, /Current \{screen\.activeRevision\.label\}/u);
  assert.doesNotMatch(source, /artboard/iu);
});

test("Screen navigator empty search state is explicit and recoverable", () => {
  const source = readFileSync(new URL("./design-screen-navigator.tsx", import.meta.url), "utf8");
  assert.match(source, /`\$\{totalVisible\} of \$\{totalScreens\} shown`/u);
  assert.match(source, /Preview unavailable · recovery needed/u);
  assert.match(source, /No Screens found/u);
  assert.match(source, /Try a different Screen name or revision/u);
});

test("Screen navigator keyboard and visual contracts preserve scoped Escape and focus visibility", () => {
  const source = readFileSync(new URL("./design-screen-navigator.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../design-projects.css", import.meta.url), "utf8");

  assert.match(source, /"ArrowDown", "ArrowUp", "Home", "End"/u);
  assert.match(source, /buttonRefs\.current\[nextIndex\]\?\.focus\(\)/u);
  assert.match(source, /event\.stopPropagation\(\)/u);
  assert.match(source, /if \(currentQuery\) \{[\s\S]*updateQuery\(""\)/u);
  assert.match(styles, /\.design-screen-navigator-row:focus-visible/u);
  assert.match(styles, /outline: 2px solid var\(--focus-ring\)/u);
  assert.match(
    styles,
    /\.design-screen-navigator-search:focus-within[\s\S]*var\(--surface-control\)/u,
  );

  const navigatorStyles = styles.slice(styles.indexOf(".design-screen-navigator {"));
  assert.doesNotMatch(navigatorStyles, /#[\da-f]{3,8}\b/iu);
  assert.match(navigatorStyles, /var\(--surface-popover\)/u);
  assert.match(navigatorStyles, /var\(--surface-list-selection\)/u);
  assert.match(navigatorStyles, /var\(--text-primary\)/u);
});
