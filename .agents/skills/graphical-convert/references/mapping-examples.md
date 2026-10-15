# Mapping an existing interface

Use the receiving project’s actual names and definitions. The examples below describe decisions, not universal equivalences between values.

| Existing treatment | Inspect first | Conversion decision |
| --- | --- | --- |
| `padding: 20px` on several cards | Is this the shared content-inset role? What does the target card use? | Replace it with the verified spacing token for that role, even if the target resolves to a different number. |
| `text-gray-500` on metadata | Does the utility already map to Graphical? Which foreground/background pair is intended? | Preserve a valid alias; otherwise use the app’s established muted-text role and verify it in supported modes. |
| A red delete action | Its action meaning and all states | Use the target’s destructive component treatment, preserving accessible text and behavior. Do not treat any similar red as equivalent. |
| A page heading with separate size/leading/weight overrides | Existing heading role and target typography | Map its font role, weight, size, line height, and letter spacing together. |
| A styled select from another primitive library | Form contract, keyboard behavior, state selectors, styling hooks, portal container | Adapt the shared wrapper using supported hooks, or identify a deliberate replacement migration. Similar token names alone are insufficient. |
| A static provider nested in a feature | Whether this is intentional theme isolation | Reuse the active scope if accidental; preserve deliberate independently themed regions. |
| `max-width: 72rem` or a two-column grid | Whether it is structure or an internal component measurement | Preserve structural constraints unless the conversion requires a layout change. |
| Five category colors in a chart | Stable category meaning, existing mappings, target palette capacity | Preserve meaning and use verified available colors; report a palette gap if the distinctions cannot be retained. |

## Mapping record

For a substantial conversion, keep a concise table with current role/source, target token/component, affected scope, and status. Status is **mapped**, **intentional exception**, or **needs a decision**. Include evidence for shared changes and name the states/modes they affect. A small conversion can express the same information in a few sentences.

When a component cannot be adapted faithfully, state what its API prevents and what would need to change. Continue independent mappings. Do not make a theme change or package upgrade an unstated workaround.
