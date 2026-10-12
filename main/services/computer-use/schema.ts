import { Type, type Static } from "@earendil-works/pi-ai";

const Action = Type.Union([
  Type.Literal("capture"),
  Type.Literal("click"),
  Type.Literal("double_click"),
  Type.Literal("right_click"),
  Type.Literal("middle_click"),
  Type.Literal("drag"),
  Type.Literal("scroll"),
  Type.Literal("type"),
  Type.Literal("key"),
  Type.Literal("set_value"),
  Type.Literal("wait"),
  Type.Literal("list_apps"),
  Type.Literal("list_windows"),
  Type.Literal("focus_app"),
  Type.Literal("verify"),
  Type.Literal("menu"),
  Type.Literal("set_window_frame"),
]);
// Some OpenAI-compatible providers reject draft-07 tuple schemas because their
// `items` value is an array. Keep tuple typing for Aiden while publishing the
// equivalent homogeneous, fixed-length schema those providers accept.
const Coordinate = Type.Unsafe<[number, number]>(
  Type.Array(Type.Number({ minimum: 0 }), { minItems: 2, maxItems: 2 }),
);
const Modifier = Type.Union(
  [
    "cmd",
    "command",
    "shift",
    "option",
    "alt",
    "ctrl",
    "control",
    "fn",
    "win",
    "windows",
    "super",
    "meta",
  ].map((modifier) => Type.Literal(modifier)),
);

/** One verify_state predicate: exactly one of element or window (cua-driver 0.34.1). */
const VerifyPredicate = Type.Object(
  {
    element: Type.Optional(
      Type.Object(
        {
          role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          label_contains: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          value_equals: Type.Optional(Type.String({ maxLength: 1_000 })),
          enabled: Type.Optional(Type.Boolean()),
          selected: Type.Optional(Type.Boolean()),
        },
        {
          additionalProperties: false,
          description:
            "A trusted accessibility element matching role and/or label_contains exists, optionally with this value/enabled/selected state. Absence cannot be proven.",
        },
      ),
    ),
    window: Type.Optional(
      Type.Object(
        {
          exists: Type.Optional(Type.Boolean()),
          bounds: Type.Optional(
            Type.Object(
              {
                x: Type.Number(),
                y: Type.Number(),
                width: Type.Number({ exclusiveMinimum: 0 }),
                height: Type.Number({ exclusiveMinimum: 0 }),
                tolerance_px: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Hermes-compatible public surface over Aiden's pinned cua-driver contract.
 * Action-specific combinations are checked again in safety.ts before approval.
 */
export const ComputerUseParameters = Type.Object(
  {
    action: Action,
    mode: Type.Optional(
      Type.Union([Type.Literal("som"), Type.Literal("vision"), Type.Literal("ax")], {
        description:
          "Capture mode. som returns a screenshot plus zero-based indexed AX elements, vision returns pixels only, and ax returns the accessibility data without a screenshot.",
      }),
    ),
    app: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        description:
          "App name or bundle id for capture/focus_app, or screen/desktop for a desktop capture. Capture otherwise requires exact pid and window_id together.",
      }),
    ),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    window_id: Type.Optional(Type.Integer({ minimum: 1 })),
    max_elements: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100 })),
    max_image_dimension: Type.Optional(
      Type.Integer({
        minimum: 256,
        maximum: 4096,
        description: "Capture only: cap the screenshot's long edge in pixels for a cheaper image.",
      }),
    ),
    element: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Zero-based element_index from the latest capture of the active window.",
      }),
    ),
    coordinate: Type.Optional(Coordinate),
    button: Type.Optional(
      Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]),
    ),
    modifiers: Type.Optional(Type.Array(Modifier, { maxItems: 4, uniqueItems: true })),
    from_element: Type.Optional(Type.Integer({ minimum: 0 })),
    to_element: Type.Optional(Type.Integer({ minimum: 0 })),
    from_coordinate: Type.Optional(Coordinate),
    to_coordinate: Type.Optional(Coordinate),
    direction: Type.Optional(
      Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ]),
    ),
    amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 3 })),
    value: Type.Optional(Type.String({ maxLength: 4_000 })),
    text: Type.Optional(Type.String({ maxLength: 4_000 })),
    keys: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 30, default: 1 })),
    raise_window: Type.Optional(
      Type.Boolean({
        description: "For focus_app only. Visibly bring the selected window to the front.",
      }),
    ),
    delivery_mode: Type.Optional(
      Type.Union([Type.Literal("background"), Type.Literal("foreground")], {
        description:
          "Background is non-intrusive. Foreground may visibly change focus and receives a distinct approval. drag and clicks with modifiers are foreground-only on macOS and default to it.",
      }),
    ),
    bring_to_front: Type.Optional(
      Type.Boolean({
        description:
          "With foreground delivery, keep the target frontmost by explicitly activating it before the action.",
      }),
    ),
    capture_after: Type.Optional(
      Type.Boolean({
        description: "Capture the exact target again after a successful action.",
      }),
    ),
    expect: Type.Optional(
      Type.Array(VerifyPredicate, {
        minItems: 1,
        maxItems: 8,
        description:
          "verify only: one to eight predicates, all of which must hold on the active window.",
      }),
    ),
    stable_samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10_000,
        description: "verify only: bounded wait.",
      }),
    ),
    include_screenshot: Type.Optional(
      Type.Boolean({
        description: "verify only: also return the final screenshot.",
      }),
    ),
    menu_path: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        minItems: 1,
        maxItems: 16,
        description: 'menu only: menu-bar path for the active app, e.g. ["File", "Save As…"].',
      }),
    ),
    x: Type.Optional(Type.Integer({ minimum: -100_000, maximum: 100_000 })),
    y: Type.Optional(Type.Integer({ minimum: -100_000, maximum: 100_000 })),
    width: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    height: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

export type ComputerUseArgs = Static<typeof ComputerUseParameters>;
export type ComputerUseAction = ComputerUseArgs["action"];
export type ComputerUseMode = NonNullable<ComputerUseArgs["mode"]>;
