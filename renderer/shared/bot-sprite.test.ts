import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "./bots";
import {
  BOT_SPRITE_BODIES,
  BOT_SPRITE_GRID_SIZE,
  BOT_SPRITE_SMALL_GLINT_HEX,
  BOT_SPRITE_SMALL_MAX_PX,
  BOT_SPRITE_TONES,
  BOT_SPRITE_VIEWBOX,
  botAvatarEndsQuietly,
  botAvatarTarget,
  botSpriteGrid,
  botSpriteIsSmall,
  botSpriteRows,
  createBotAvatarSettler,
  type BotAvatarSettlerTimers,
  type BotAvatarState,
} from "./bot-sprite";

/** The shared sprite contract every client draws from (iOS and Android read the same file). */
const fixture = JSON.parse(
  readFileSync(
    new URL("../../protocol/aiden-remote/v1/fixtures/contract.json", import.meta.url),
    "utf8",
  ),
).botAvatarSprite as {
  gridSize: number;
  viewBox: number;
  smallMaxPx: number;
  smallGlintHex: string;
  bodies: Record<string, string>;
  tones: Record<string, Record<string, string>>;
  grids: Record<string, { full: string[]; small: string[] }>;
};

describe("bot sprite parity with the shared contract", () => {
  test("geometry constants match", () => {
    assert.equal(BOT_SPRITE_GRID_SIZE, fixture.gridSize);
    assert.equal(BOT_SPRITE_VIEWBOX, fixture.viewBox);
    assert.equal(BOT_SPRITE_SMALL_MAX_PX, fixture.smallMaxPx);
    assert.equal(BOT_SPRITE_SMALL_GLINT_HEX.toUpperCase(), fixture.smallGlintHex.toUpperCase());
  });

  test("every shape's body bits and every colour's tones match", () => {
    assert.deepEqual(Object.keys(fixture.bodies).sort(), [...BOT_AVATAR_SHAPES].sort());
    for (const shape of BOT_AVATAR_SHAPES)
      assert.equal(BOT_SPRITE_BODIES[shape], fixture.bodies[shape], shape);
    assert.deepEqual(Object.keys(fixture.tones).sort(), [...BOT_AVATAR_COLORS].sort());
    for (const color of BOT_AVATAR_COLORS) {
      const expected = Object.fromEntries(
        Object.entries(fixture.tones[color]).map(([key, hex]) => [key, hex.toUpperCase()]),
      );
      const actual = Object.fromEntries(
        Object.entries(BOT_SPRITE_TONES[color]).map(([key, hex]) => [key, hex.toUpperCase()]),
      );
      assert.deepEqual(actual, expected, color);
    }
  });

  test("the expanded full and small grids match cell for cell", () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      assert.deepEqual(botSpriteGrid(shape, false), fixture.grids[shape].full, `${shape} full`);
      assert.deepEqual(botSpriteGrid(shape, true), fixture.grids[shape].small, `${shape} small`);
    }
  });

  test("the small cut drops highlight cells and starts at the contract's threshold", () => {
    assert.equal(botSpriteIsSmall(fixture.smallMaxPx), true);
    assert.equal(botSpriteIsSmall(fixture.smallMaxPx + 1), false);
    for (const shape of BOT_AVATAR_SHAPES) {
      assert.ok(botSpriteGrid(shape, false).join("").includes("h"), `${shape} full has highlights`);
      assert.ok(!botSpriteGrid(shape, true).join("").includes("h"), `${shape} small has none`);
    }
  });

  test("merged rectangles cover exactly the grid's filled cells", () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      const grid = botSpriteGrid(shape, false);
      const cell = BOT_SPRITE_VIEWBOX / BOT_SPRITE_GRID_SIZE;
      const painted = grid.map((row) => [...row].map(() => "."));
      for (const row of botSpriteRows(grid)) {
        for (const run of row.runs) {
          for (let y = run.y; y < run.y + run.height; y += cell) {
            for (let x = run.x; x < run.x + run.width; x += cell) {
              const [gx, gy] = [Math.round(x / cell), Math.round(y / cell)];
              assert.equal(painted[gy][gx], ".", `${shape} cell ${gx},${gy} painted twice`);
              painted[gy][gx] = run.cell;
            }
          }
        }
      }
      assert.deepEqual(
        painted.map((row) => row.join("")),
        grid,
        shape,
      );
    }
  });
});

describe("botAvatarTarget", () => {
  test("a running turn acts out its live phase", () => {
    assert.equal(botAvatarTarget({ session: "running", phase: "thinking" }), "thinking");
    assert.equal(botAvatarTarget({ session: "running", phase: "searching" }), "reading");
    assert.equal(botAvatarTarget({ session: "running", phase: "command" }), "tool");
    assert.equal(botAvatarTarget({ session: "running", phase: "editing" }), "editing");
    assert.equal(botAvatarTarget({ session: "running", phase: "writing" }), "writing");
    assert.equal(botAvatarTarget({ session: "running", phase: "routine" }), "tool");
    assert.equal(botAvatarTarget({ session: "running", phase: "tidying" }), "thinking");
  });

  test("a running turn without a known phase reads as thinking", () => {
    assert.equal(botAvatarTarget({ session: "running" }), "thinking");
    assert.equal(botAvatarTarget({ session: "running", phase: null }), "thinking");
  });

  test("getting ready for a turn reads as thinking", () => {
    assert.equal(botAvatarTarget({ session: "running", phase: "preparing" }), "thinking");
  });

  test("anything waiting on the person wins over the turn's phase", () => {
    assert.equal(
      botAvatarTarget({ session: "running", phase: "command", awaitingPerson: true }),
      "waiting",
    );
    assert.equal(botAvatarTarget({ session: "idle", awaitingPerson: true }), "waiting");
    assert.equal(botAvatarTarget({ session: "model_error", awaitingPerson: true }), "waiting");
  });

  test("failed sessions point at error and resting ones at idle", () => {
    assert.equal(botAvatarTarget({ session: "model_error" }), "error");
    assert.equal(botAvatarTarget({ session: "interrupted" }), "error");
    assert.equal(botAvatarTarget({ session: "needs_model" }), "error");
    assert.equal(botAvatarTarget({ session: "idle" }), "idle");
    assert.equal(botAvatarTarget({ session: "paused" }), "idle");
    assert.equal(botAvatarTarget({}), "idle");
  });

  test("a turn that failed points at error once the session rests, but a new turn wins", () => {
    assert.equal(botAvatarTarget({ session: "idle", failed: true }), "error");
    assert.equal(
      botAvatarTarget({ session: "running", phase: "writing", failed: true }),
      "writing",
    );
  });
});

describe("botAvatarEndsQuietly", () => {
  test("a turn the person stopped, or a paused Bot, ends quietly", () => {
    assert.equal(botAvatarEndsQuietly({ session: "idle", stopped: true }), true);
    assert.equal(botAvatarEndsQuietly({ session: "paused" }), true);
  });

  test("a turn that simply finished or failed does not", () => {
    assert.equal(botAvatarEndsQuietly({ session: "idle" }), false);
    assert.equal(botAvatarEndsQuietly({ session: "idle", failed: true }), false);
    assert.equal(botAvatarEndsQuietly({}), false);
  });

  test("a session that failed after a Stop still shows its error", () => {
    for (const session of ["interrupted", "model_error", "needs_model"]) {
      const input = { session, stopped: true };
      assert.equal(botAvatarEndsQuietly(input), false, session);
      const { settler, shown, advance } = settlerHarness();
      settler.update("writing");
      advance(300);
      settler.update(botAvatarTarget(input), botAvatarEndsQuietly(input));
      assert.equal(settler.current(), "error", session);
      advance(2000);
      assert.deepEqual(shown, ["writing", "error", "idle"], session);
    }
  });
});

/** A manual clock: timers fire only when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: BotAvatarSettlerTimers = {
    setTimeout(callback, ms) {
      const id = ++nextId;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = until;
  };
  return { timers, advance };
}

function settlerHarness(initial?: BotAvatarState) {
  const clock = fakeClock();
  const shown: BotAvatarState[] = [];
  const settler = createBotAvatarSettler({
    timers: clock.timers,
    onChange: (state) => shown.push(state),
    initial,
  });
  return { settler, shown, advance: clock.advance };
}

describe("createBotAvatarSettler", () => {
  test("a working state appears only after the debounce", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    advance(200);
    assert.equal(settler.current(), "idle");
    advance(60);
    assert.equal(settler.current(), "thinking");
    assert.deepEqual(shown, ["thinking"]);
  });

  test("a quick burst of phases shows only the one that lasts", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    advance(300);
    settler.update("tool");
    advance(100);
    settler.update("reading");
    advance(100);
    settler.update("writing");
    advance(300);
    assert.deepEqual(shown, ["thinking", "writing"]);
  });

  test("finished work shows done at once, then rests", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("writing");
    advance(300);
    settler.update("idle");
    assert.equal(settler.current(), "done");
    advance(1400);
    assert.equal(settler.current(), "done");
    advance(200);
    assert.deepEqual(shown, ["writing", "done", "idle"]);
  });

  test("a failed turn shows error, then rests", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("tool");
    advance(300);
    settler.update("error");
    advance(2000);
    assert.deepEqual(shown, ["tool", "error", "idle"]);
  });

  test("a stopped or paused turn rests at once, with no done moment", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("writing");
    advance(300);
    settler.update("idle", true);
    assert.equal(settler.current(), "idle");
    advance(2000);
    assert.deepEqual(shown, ["writing", "idle"]);
  });

  test("a stop that lands during the done moment cuts it short", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    advance(300);
    settler.update("idle");
    advance(200);
    settler.update("idle", true);
    assert.equal(settler.current(), "idle");
    advance(2000);
    assert.deepEqual(shown, ["thinking", "done", "idle"]);
  });

  test("a quiet end before the debounce shows nothing", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    advance(100);
    settler.update("idle", true);
    advance(2000);
    assert.deepEqual(shown, []);
  });

  test("a failure reported just after the turn ended turns the done moment into error", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("tool");
    advance(300);
    settler.update("idle");
    advance(100);
    settler.update("error");
    assert.equal(settler.current(), "error");
    advance(1400);
    assert.equal(settler.current(), "error");
    advance(200);
    assert.deepEqual(shown, ["tool", "done", "error", "idle"]);
  });

  test("work too short to show leaves the face idle", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    advance(100);
    settler.update("idle");
    advance(2000);
    assert.deepEqual(shown, []);
  });

  test("a Bot that opens already failed stays idle", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("error");
    advance(2000);
    assert.deepEqual(shown, []);
    assert.equal(settler.current(), "idle");
  });

  test("a short turn started during the done moment still returns to idle", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    advance(300);
    settler.update("idle");
    advance(500);
    settler.update("thinking");
    advance(100);
    settler.update("idle");
    advance(2000);
    assert.deepEqual(shown, ["thinking", "done", "idle"]);
  });

  test("an avatar mounted mid-turn shows the turn without waiting", () => {
    const { settler, shown, advance } = settlerHarness("reading");
    assert.equal(settler.current(), "reading");
    settler.update("reading");
    advance(500);
    assert.deepEqual(shown, []);
  });

  test("dispose cancels a pending change", () => {
    const { settler, shown, advance } = settlerHarness();
    settler.update("thinking");
    settler.dispose();
    advance(1000);
    assert.deepEqual(shown, []);
  });
});
