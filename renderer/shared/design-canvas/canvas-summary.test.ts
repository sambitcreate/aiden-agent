import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_STATUS_SECTION,
  canvasPromptLine,
  canvasReadCursorPage,
  canvasReadFramesKey,
  canvasReadPageKey,
  canvasView,
  CANVAS_READ_FRAME_LIMIT,
  describeCanvas,
  parseCanvasReadCursor,
  withCanvasStatusNote,
  type CanvasReadAnswer,
  type CanvasView,
} from "./canvas-summary.js";
import { emptyDesignCanvas, type DesignCanvas, type DesignFrame } from "./schema.js";

function note(id: string, x: number, y: number, extra: Partial<DesignFrame> = {}): DesignFrame {
  return { id, kind: "note", title: id, text: `about ${id}`, x, y, w: 240, h: 160, pageId: "page-1", createdBy: "aiden", ...extra };
}

function canvas(frames: DesignFrame[], extra: Partial<DesignCanvas> = {}): DesignCanvas {
  return { ...emptyDesignCanvas(), frames, ...extra };
}

test("the view is what a panned and zoomed canvas shows, in canvas units", () => {
  // Panned so canvas point (500, 250) sits at the top-left, zoomed out to half size.
  const doc = canvas([], { pages: [{ id: "page-1", name: "Page 1", viewport: { x: -250, y: -125, zoom: 0.5 } }] });
  assert.deepEqual(canvasView(doc, { w: 1200, h: 800 }), { x: 500, y: 250, w: 2400, h: 1600 });
  // Zoomed in, the same screen covers less of the canvas.
  assert.deepEqual(canvasView(canvas([], { pages: [{ id: "page-1", name: "Page 1", viewport: { x: 0, y: 0, zoom: 2 } }] }), { w: 1200, h: 800 }), { x: 0, y: 0, w: 600, h: 400 });
});

test("a frame partly in view is listed; one just past the edge is counted as outside", () => {
  const view = { x: 0, y: 0, w: 1000, h: 1000 };
  const doc = canvas([note("edge", 900, 900), note("past", 1000, 0), note("loose", 5000, 5000)]);
  const answer = describeCanvas(doc, { view });
  assert.deepEqual(answer.inView.map((frame) => frame.id), ["edge"]);
  assert.deepEqual(answer.outsideView, [{ groupId: "ungrouped", title: "Not in a group", frames: 2 }]);
  assert.equal(answer.frameCount, 3);
  assert.equal(answer.inView[0]!.text, "about edge");
});

test("a crowded view lists the first frames and says how many it left out", () => {
  const frames = Array.from({ length: CANVAS_READ_FRAME_LIMIT + 5 }, (_, index) => note(`n${index}`, index, index));
  const answer = describeCanvas(canvas(frames), { view: { x: 0, y: 0, w: 2000, h: 2000 } });
  assert.equal(answer.inView.length, CANVAS_READ_FRAME_LIMIT);
  assert.equal(answer.omitted, 5);
  assert.equal(answer.frameCount, CANVAS_READ_FRAME_LIMIT + 5);
  assert.deepEqual(
    parseCanvasReadCursor(answer.nextCursor!),
    {
      page: canvasReadPageKey("page-1"),
      offset: CANVAS_READ_FRAME_LIMIT,
      frames: canvasReadFramesKey(canvas(frames), "page-1", { x: 0, y: 0, w: 2000, h: 2000 }),
      view: { x: 0, y: 0, w: 2000, h: 2000 },
    },
    "the cursor names the page, where the next answer starts, the page's frames and the view",
  );
  assert.match(answer.more!, new RegExp(`frames 1–${CANVAS_READ_FRAME_LIMIT} of ${CANVAS_READ_FRAME_LIMIT + 5}.*Pass nextCursor as cursor`, "u"));
});

/** Every answer of a paged read, following each nextCursor, with the view the person has before each one. */
function readAll(doc: DesignCanvas, views: CanvasView[]): CanvasReadAnswer[] {
  const answers: CanvasReadAnswer[] = [];
  let next: string | undefined;
  do {
    const cursor = next === undefined ? undefined : parseCanvasReadCursor(next);
    assert.notEqual(cursor, null, "an answer's nextCursor reads back");
    if (cursor) assert.deepEqual(canvasReadCursorPage(doc, cursor), { pageId: "page-1" }, "a cursor on an unchanged page is taken");
    const view = views[Math.min(answers.length, views.length - 1)]!;
    const answer = describeCanvas(doc, { view, ...(cursor ? { cursor } : {}) });
    answers.push(answer);
    next = answer.nextCursor;
  } while (next !== undefined && answers.length < 10);
  return answers;
}

function listed(answers: CanvasReadAnswer[]): string[] {
  return answers.flatMap((answer) => [...answer.inView, ...answer.outsideFrames].map((frame) => frame.id));
}

test("a cursor reads the frames after an earlier answer's, those in view first, until every frame was listed once", () => {
  const view = { x: 0, y: 0, w: 2000, h: 2000 };
  const inView = Array.from({ length: CANVAS_READ_FRAME_LIMIT + 10 }, (_, index) => note(`v${index}`, index, index));
  const outside = Array.from({ length: 30 }, (_, index) => note(`o${index}`, 9000 + index * 300, 9000));
  const doc = canvas([...outside, ...inView], {
    comments: [{ id: "c1", frameId: "v0", x: 1, y: 1, note: "tighten", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" }],
  });
  const answers = readAll(doc, [view]);
  assert.equal(answers.length, 2);
  for (const answer of answers) assert.ok(answer.inView.length + answer.outsideFrames.length <= CANVAS_READ_FRAME_LIMIT);
  assert.deepEqual(answers.map((answer) => answer.comments !== undefined), [true, false], "comments come with the first answer only");
  assert.deepEqual(listed(answers), [...inView, ...outside].map((frame) => frame.id), "each frame once, in view first");
  const last = answers[1]!;
  assert.equal("offset" in last, false, "the answer carries no offset; the cursor is the only way on");
  assert.equal(last.nextCursor, undefined);
  assert.equal(last.inView.length, 10, "the frames in view past the first answer");
  assert.equal(last.viewMoved, undefined, "the view did not move");
  assert.match(last.more!, new RegExp(`frames ${CANVAS_READ_FRAME_LIMIT + 1}–${CANVAS_READ_FRAME_LIMIT + 40} of ${CANVAS_READ_FRAME_LIMIT + 40}`, "u"));
  assert.doesNotMatch(last.more!, /Pass nextCursor/u);
  assert.equal(describeCanvas(doc, { view, cursor: { page: canvasReadPageKey("page-1"), offset: 9_999, frames: canvasReadFramesKey(doc, "page-1", view), view } }).inView.length, 0, "a cursor past the end lists nothing");
  const small = describeCanvas(canvas([note("a", 0, 0)]), { view });
  assert.equal(small.more, undefined, "a page listed in full says nothing about paging");
  assert.equal(small.nextCursor, undefined);
});

test("a person panning between paged reads neither repeats nor drops a frame", () => {
  // 150 frames at the left and 150 far to the right; the person pans from one to the other between answers.
  const grid = (prefix: string, left: number) =>
    Array.from({ length: 150 }, (_, index) => note(`${prefix}${index}`, left + (index % 10) * 250, Math.floor(index / 10) * 170));
  const doc = canvas([...grid("a", 0), ...grid("b", 20_000)]);
  const left = { x: 0, y: 0, w: 3000, h: 3000 };
  const right = { x: 20_000, y: 0, w: 3000, h: 3000 };
  for (const views of [[left, right], [right, left]]) {
    const answers = readAll(doc, views);
    const ids = listed(answers);
    assert.equal(ids.length, doc.frames.length, "as many listed as there are frames");
    assert.equal(new Set(ids).size, doc.frames.length, "each frame exactly once");
    assert.deepEqual(answers[0]!.inView.map((frame) => frame.id), grid(views[0] === left ? "a" : "b", views[0]!.x).map((frame) => frame.id), "the first answer starts with what is in view");
    assert.deepEqual(answers[1]!.view, views[0], "the later answer keeps the first answer's view");
    assert.match(answers[1]!.viewMoved!, /view has moved since the earlier answer.*without a cursor/u);
  }
});

test("a cursor is refused once the page's frames change between reads, and taken while they don't", () => {
  const view = { x: 0, y: 0, w: 3000, h: 3000 };
  const frames = [
    ...Array.from({ length: CANVAS_READ_FRAME_LIMIT + 20 }, (_, index) => note(`v${index}`, index, 0)),
    note("far", 9000, 9000),
  ];
  const doc = canvas(frames);
  const cursor = parseCanvasReadCursor(describeCanvas(doc, { view }).nextCursor!)!;
  const moved = (id: string, x: number, y: number) => canvas(frames.map((frame) => (frame.id === id ? { ...frame, x, y } : frame)));
  for (const [label, changed] of [
    ["a frame added", canvas([note("new", 0, 0), ...frames])],
    ["a frame removed", canvas(frames.filter((frame) => frame.id !== "v3"))],
    ["frames reordered", canvas([frames[1]!, frames[0]!, ...frames.slice(2)])],
    ["a frame moved out of the view", moved("v5", 9000, 0)],
    ["a frame moved into the view", moved("far", 100, 100)],
  ] as const) {
    const read = canvasReadCursorPage(changed, cursor);
    assert.ok("error" in read, label);
    assert.match(read.error, /frames on that page changed.*Call canvas_read without a cursor/u, label);
  }
  for (const [label, same] of [
    ["nothing changed", doc],
    ["a frame moved within the view", moved("v5", 400, 400)],
    ["a frame moved outside the view", moved("far", 12_000, 9000)],
    ["a frame on another page added", canvas([...frames, note("other", 0, 0, { pageId: "page-2" })])],
  ] as const) {
    assert.deepEqual(canvasReadCursorPage(same, cursor), { pageId: "page-1" }, label);
  }
});

test("a cursor is only what an answer gave", () => {
  assert.deepEqual(parseCanvasReadCursor("0a1b2c3d:200:9f8e7d6c@-120,40,1200,800"), {
    page: "0a1b2c3d",
    offset: 200,
    frames: "9f8e7d6c",
    view: { x: -120, y: 40, w: 1200, h: 800 },
  });
  assert.deepEqual(parseCanvasReadCursor("0a1b2c3d:0:00000000@0,0,1,1")?.offset, 0);
  for (const text of [
    "200",
    "",
    "200@-120,40,1200,800", // the first cursor, without a page
    "0a1b2c3d:200@-120,40,1200,800", // the second, without the page's frames
    "0a1b2c3d:x:9f8e7d6c@0,0,1,1",
    "0a1b2c3d:200:9f8e7d6c@0,0,0,800",
    "0a1b2c3d:-1:9f8e7d6c@0,0,1,1",
    "0a1b2c3d:200:9f8e7d6c@0,0,1.5,1",
    "0a1b2c3d:200:9f8e7d6c@0,0,1,1,1",
    "0a1b2c3d:0200:9f8e7d6c@0,0,1,1", // leading zeros
    "0a1b2c3d:200:9f8e7d6c@01,0,1,1",
    "0a1b2c3d:200:9f8e7d6c@-0,0,1,1",
    " 0a1b2c3d:200:9f8e7d6c@0,0,1,1", // surrounding whitespace
    "0a1b2c3d:200:9f8e7d6c@0,0,1,1\n",
    "0A1B2C3D:200:9f8e7d6c@0,0,1,1",
    "0a1b2c3d:200:9F8E7D6C@0,0,1,1",
    "a1b2c3d:200:9f8e7d6c@0,0,1,1",
    "0a1b2c3d:200:f8e7d6c@0,0,1,1",
  ]) {
    assert.equal(parseCanvasReadCursor(text), null, text);
  }
});

test("comments on removed frames and resolved comments do not count against a frame", () => {
  const doc = canvas([note("a", 0, 0)], {
    comments: [
      { id: "c1", frameId: "a", x: 1, y: 1, note: "one", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c2", frameId: "a", x: 1, y: 1, note: "two", state: "resolved", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" },
      { id: "c3", x: 1, y: 1, note: "loose", state: "open", pageId: "page-1", anchorState: "lost", createdAt: "2026-11-05T00:00:00Z" },
    ],
  });
  const answer = describeCanvas(doc, { view: { x: 0, y: 0, w: 1000, h: 1000 } });
  assert.equal(answer.inView[0]!.openComments, 1);
  assert.equal(answer.openComments, 2, "the total counts every open comment, anchored or not");
});

test("the prompt line names frames, pages and open comments in plain words", () => {
  assert.equal(canvasPromptLine(canvas([])), "The canvas is empty.");
  assert.equal(canvasPromptLine(canvas([note("a", 0, 0)])), "The canvas has 1 frame, 0 open comments.");
  const page: DesignFrame = { id: "p", kind: "file", title: "Home", path: "design/home.html", x: 0, y: 0, w: 640, h: 436, designWidth: 1280, pageId: "page-1", createdBy: "aiden" };
  const doc = canvas([page, note("a", 0, 0)], {
    comments: [{ id: "c1", frameId: "p", x: 1, y: 1, note: "one", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" }],
  });
  assert.equal(canvasPromptLine(doc), "The canvas has 2 frames, 1 HTML file, 1 open comment.");
});

test("the canvas status goes to the conversation only on turns where it changed", () => {
  const start: { messages: unknown[] } = { messages: [{ role: "user", content: "make a landing page" }] };
  const first = withCanvasStatusNote(start, canvasPromptLine(canvas([])), 1);
  assert.equal(first.messages.length, 2, "the first design turn tells Aiden what the canvas holds");
  assert.deepEqual(first.messages[1], { role: "system", content: "", sections: { [CANVAS_STATUS_SECTION]: "Design canvas when this was noted: The canvas is empty." }, timestamp: 1 });

  const sameCounts = { messages: [...first.messages, { role: "assistant", content: "done" }, { role: "user", content: "again" }] };
  assert.equal(withCanvasStatusNote(sameCounts, canvasPromptLine(canvas([])), 2), sameCounts, "unchanged counts add nothing");

  const changed = withCanvasStatusNote(sameCounts, canvasPromptLine(canvas([note("a", 0, 0)])), 3);
  assert.equal(changed.messages.length, sameCounts.messages.length + 1);
  assert.deepEqual((changed.messages[changed.messages.length - 1] as { sections: unknown }).sections, { [CANVAS_STATUS_SECTION]: "Design canvas when this was noted: The canvas has 1 frame, 0 open comments." });
  // The latest note is what counts: going back to an empty canvas is a change again.
  assert.equal(withCanvasStatusNote(changed, canvasPromptLine(canvas([])), 4).messages.length, changed.messages.length + 1);
});

test("a canvas with pages describes one page at a time and lists them all", () => {
  const doc = canvas([note("home", 0, 0), note("pricing", 0, 0, { pageId: "p2" }), note("faq", 9000, 9000, { pageId: "p2" })], {
    pages: [
      { id: "page-1", name: "Home", viewport: { x: 0, y: 0, zoom: 1 } },
      { id: "p2", name: "Pricing", viewport: { x: 0, y: 0, zoom: 1 } },
    ],
    activePageId: "p2",
    comments: [{ id: "c", frameId: "home", x: 0, y: 0, note: "", state: "open", pageId: "page-1", anchorState: "anchored", createdAt: "t" }],
  });
  const onScreen = describeCanvas(doc);
  assert.deepEqual(onScreen.page, { id: "p2", name: "Pricing" });
  assert.deepEqual(onScreen.inView.map((frame) => frame.id), ["pricing"]);
  assert.equal(onScreen.frameCount, 2);
  assert.equal(onScreen.openComments, 0, "comments on other pages are not counted");
  assert.deepEqual(onScreen.pages, [
    { id: "page-1", name: "Home", frames: 1, onScreen: false },
    { id: "p2", name: "Pricing", frames: 2, onScreen: true },
  ]);
  const home = describeCanvas(doc, { pageId: "page-1" });
  assert.deepEqual(home.inView.map((frame) => frame.id), ["home"]);
  assert.equal(home.openComments, 1);
  assert.equal(
    canvasPromptLine(doc),
    'The canvas has 3 frames, 1 open comment. It has 2 pages; the person is looking at "Pricing".',
  );
});

test("Aiden reads which pages the person shows dark or tweaked, and which items they hid", () => {
  const view = { x: 0, y: 0, w: 2000, h: 2000 };
  const page = note("page", 0, 0, { kind: "file", path: "design/a.html", text: undefined, dark: true, tweaks: { "--accent": "#ff0055" } });
  const answer = describeCanvas(canvas([page, note("gone", 300, 0, { hidden: true }), note("plain", 600, 0)]), { view });
  const byId = new Map(answer.inView.map((frame) => [frame.id, frame]));
  assert.equal(byId.get("page")!.dark, true);
  assert.deepEqual(byId.get("page")!.tweaks, { "--accent": "#ff0055" });
  assert.equal(byId.get("gone")!.hidden, true);
  assert.deepEqual([byId.get("plain")!.dark, byId.get("plain")!.tweaks, byId.get("plain")!.hidden], [undefined, undefined, undefined]);
});

test("frames outside the view are listed one by one with their boxes, within the shared frame budget", () => {
  const view = { x: 0, y: 0, w: 1000, h: 1000 };
  const locked = note("far", 9000, 0, { locked: true, groupId: "g", text: "x".repeat(500) });
  const board: DesignFrame = { id: "g", kind: "frame", title: "Board", x: 8800, y: -100, w: 1000, h: 800, radius: 12, guide: "grid-8", pageId: "page-1", createdBy: "person" };
  const answer = describeCanvas(canvas([note("near", 0, 0), board, locked]), { view });
  assert.deepEqual(
    answer.outsideFrames.map((frame) => [frame.id, frame.box, frame.groupId]),
    [
      ["g", { x: 8800, y: -100, w: 1000, h: 800 }, undefined],
      ["far", { x: 9000, y: 0, w: 240, h: 160 }, "g"],
    ],
  );
  const [boardSummary, farSummary] = answer.outsideFrames;
  assert.deepEqual([boardSummary!.radius, boardSummary!.guide], [12, "grid-8"]);
  assert.equal(farSummary!.locked, true);
  assert.ok(farSummary!.text!.length < 200, "long words outside the view are cut short");
  assert.equal(answer.outsideOmitted, 0);

  const crowded = Array.from({ length: CANVAS_READ_FRAME_LIMIT + 3 }, (_, index) => note(`o${index}`, 5000 + index * 300, 5000));
  const full = describeCanvas(canvas([note("near", 0, 0), ...crowded]), { view });
  assert.equal(full.inView.length + full.outsideFrames.length, CANVAS_READ_FRAME_LIMIT);
  assert.equal(full.outsideOmitted, 4);
});
