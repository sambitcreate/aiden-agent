# Untitled

Generated from the current project, including edits awaiting autosave. Return to the [theme index](../themes.md). Font names and weights are references only: license, download, and configure your own fonts.

## Foundations

```json
{
  "name": "Untitled",
  "text": {
    "xxs": {
      "size": 10,
      "lineHeight": 14,
      "letterSpacing": 0
    },
    "xs": {
      "size": 12,
      "lineHeight": 16,
      "letterSpacing": 0
    },
    "s": {
      "size": 14,
      "lineHeight": 20,
      "letterSpacing": 0
    },
    "m": {
      "size": 16,
      "lineHeight": 24,
      "letterSpacing": 0
    },
    "l": {
      "size": 24,
      "lineHeight": 32,
      "letterSpacing": 0
    },
    "xl": {
      "size": 36,
      "lineHeight": 40,
      "letterSpacing": 0
    },
    "xxl": {
      "size": 48,
      "lineHeight": 52,
      "letterSpacing": 0
    }
  },
  "fonts": {
    "ui": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    },
    "brand": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    },
    "editorial": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    },
    "data": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": {
        "regular": 400,
        "medium": 500,
        "heavy": 600
      }
    }
  },
  "border": {
    "none": 0,
    "s": 0,
    "m": 0,
    "l": 0
  },
  "radius": {
    "l": 19,
    "m": 12,
    "s": 8,
    "xl": 29,
    "xs": 3,
    "full": 9999,
    "zero": 0
  },
  "shadows": {
    "l": {
      "x": 0,
      "y": 16,
      "blur": 48,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    },
    "m": {
      "x": 0,
      "y": 8,
      "blur": 24,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 12
    },
    "s": {
      "x": 0,
      "y": 2,
      "blur": 4,
      "color": {
        "dark": "neutral-1",
        "light": "neutral-10"
      },
      "spread": 0,
      "opacity": 0
    }
  },
  "spacing": {
    "l": 25,
    "m": 16,
    "s": 12,
    "xl": 33,
    "xs": 8,
    "xxl": 49,
    "xxs": 4,
    "zero": 0
  },
  "animation": {
    "large": {
      "easing": [
        0.22,
        1,
        0.36,
        1
      ],
      "duration": 360
    },
    "easing": [
      0.16,
      1,
      0.3,
      1
    ],
    "duration": 200,
    "popupScale": 0.96,
    "pressDistance": 1
  },
  "iconStyle": "outlined",
  "iconFamily": "Lucide",
  "neutralTone": "warm",
  "buttonRadius": "s",
  "colorEmphasis": 53.66536458333333,
  "primaryForeground": {
    "dark": "neutral-9",
    "light": "neutral-2"
  },
  "primaryActionColor": "color-1"
}
```

## light CSS variables

Define these in the app’s existing theme scope for this mode. Keep component styles linked to the variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | Untitled |
| `--theme-icon-family` | Lucide |
| `--theme-icon-style` | outlined |
| `--toolbar-divider-bleed` | 0 |
| `--focus-ring-outline` | initial |
| `--icon-stroke-width` | 2 |
| `--icon-light-display` | none |
| `--icon-regular-display` | inline |
| `--icon-bold-display` | none |
| `--motion-duration` | 200ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.2 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 360ms |
| `--motion-large-easing` | cubic-bezier(0.22, 1, 0.36, 1) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.36 |
| `--motion-large-bounce` | 0.2 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.96 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | #085e55 |
| `--option-badge-foreground` | #fbfbfa |
| `--navigation-active-foreground` | #fbfbfa |
| `--emphasis-chart-fill` | #085e5533 |
| `--emphasis-balance-background` | #d3cdc0 |
| `--emphasis-rewards-background` | #f5f4f1 |
| `--emphasis-icon-background` | #f5f4f1 |
| `--emphasis-icon-foreground` | #000000 |
| `--emphasis-type-background` | #f5f4f1 |
| `--emphasis-type-foreground` | #000000 |
| `--navigation-active-background` | #085e55 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 4px |
| `--space-xs` | 8px |
| `--space-s` | 12px |
| `--space-m` | 16px |
| `--space-l` | 25px |
| `--space-xl` | 33px |
| `--space-xxl` | 49px |
| `--size-xxs` | 10px |
| `--line-xxs` | 14px |
| `--letter-spacing-xxs` | 0em |
| `--size-xs` | 12px |
| `--line-xs` | 16px |
| `--letter-spacing-xs` | 0em |
| `--size-s` | 14px |
| `--line-s` | 20px |
| `--letter-spacing-s` | 0em |
| `--size-m` | 16px |
| `--line-m` | 24px |
| `--letter-spacing-m` | 0em |
| `--size-l` | 24px |
| `--line-l` | 32px |
| `--letter-spacing-l` | 0em |
| `--size-xl` | 36px |
| `--line-xl` | 40px |
| `--letter-spacing-xl` | 0em |
| `--size-xxl` | 48px |
| `--line-xxl` | 52px |
| `--letter-spacing-xxl` | 0em |
| `--radius-zero` | 0px |
| `--radius-xs` | 3px |
| `--radius-s` | 8px |
| `--radius-m` | 12px |
| `--radius-l` | 19px |
| `--radius-xl` | 29px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 0px |
| `--border-m` | 0px |
| `--border-l` | 0px |
| `--border-default-color` | #eae7e133 |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 0 transparent |
| `--border-shadow-m` | 0 0 0 0 transparent |
| `--border-shadow-l` | 0 0 0 0 transparent |
| `--font-ui` | "Timeless Grotesk", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 600 |
| `--font-brand` | "Timeless Grotesk", sans-serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 600 |
| `--font-editorial` | "Timeless Grotesk", sans-serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 600 |
| `--font-data` | "Timeless Grotesk", sans-serif |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 600 |
| `--color-none` | transparent |
| `--color-1` | #085e55 |
| `--color-1-transparent` | #085e5533 |
| `--color-2` | #ff5a00 |
| `--color-2-transparent` | #ff5a0033 |
| `--color-3` | #b6ebd8 |
| `--color-3-transparent` | #b6ebd833 |
| `--color-4` | #ffed9b |
| `--color-4-transparent` | #ffed9b33 |
| `--neutral-1` | #ffffff |
| `--neutral-1-transparent` | #ffffff33 |
| `--neutral-2` | #fbfbfa |
| `--neutral-2-transparent` | #fbfbfa33 |
| `--neutral-3` | #f5f4f1 |
| `--neutral-3-transparent` | #f5f4f133 |
| `--neutral-4` | #eae7e1 |
| `--neutral-4-transparent` | #eae7e133 |
| `--neutral-5` | #d3cdc0 |
| `--neutral-5-transparent` | #d3cdc033 |
| `--neutral-6` | #a6a195 |
| `--neutral-6-transparent` | #a6a19533 |
| `--neutral-7` | #827d71 |
| `--neutral-7-transparent` | #827d7133 |
| `--neutral-8` | #5a554a |
| `--neutral-8-transparent` | #5a554a33 |
| `--neutral-9` | #373329 |
| `--neutral-9-transparent` | #37332933 |
| `--neutral-10` | #000000 |
| `--neutral-10-transparent` | #00000033 |
| `--success` | #00906c |
| `--success-transparent` | #00906c33 |
| `--warning` | #ffea00 |
| `--warning-transparent` | #ffea0033 |
| `--error` | #fc032d |
| `--error-transparent` | #fc032d33 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 2px 4px 0px #00000000 |
| `--shadow-m` | 0px 2px 6px 0px #0000000d, 0px 8px 24px 0px #00000013 |
| `--shadow-l` | 0px 16px 48px 0px #00000000 |
| `--cte-canvas` | #ffffff |
| `--cte-surface` | #fbfbfa |
| `--cte-surface-muted` | #f5f4f1 |
| `--cte-text` | #000000 |
| `--cte-text-muted` | #827d71 |
| `--cte-border` | #eae7e133 |
| `--cte-accent` | #085e55 |
| `--cte-accent-text` | #fbfbfa |
| `--cte-danger` | #fc032d |
| `--cte-focus` | #085e55 |
| `--cte-font` | "Timeless Grotesk", sans-serif |
| `--cte-font-size` | 14px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 20px |
| `--cte-letter-spacing` | 0em |
| `--cte-detail-font-size` | 12px |
| `--cte-detail-line-height` | 16px |
| `--cte-detail-letter-spacing` | 0em |

## dark CSS variables

Define these in the app’s existing theme scope for this mode. Keep component styles linked to the variables.

| Variable | Value |
| --- | --- |
| `--theme-name` | Untitled |
| `--theme-icon-family` | Lucide |
| `--theme-icon-style` | outlined |
| `--toolbar-divider-bleed` | 0 |
| `--focus-ring-outline` | initial |
| `--icon-stroke-width` | 2 |
| `--icon-light-display` | none |
| `--icon-regular-display` | inline |
| `--icon-bold-display` | none |
| `--motion-duration` | 200ms |
| `--motion-easing` | cubic-bezier(0.16, 1, 0.3, 1) |
| `--motion-type` | easing |
| `--motion-visual-duration` | 0.2 |
| `--motion-bounce` | 0.2 |
| `--motion-enabled` | 1 |
| `--motion-small-iterations` | infinite |
| `--motion-large-duration` | 360ms |
| `--motion-large-easing` | cubic-bezier(0.22, 1, 0.36, 1) |
| `--motion-large-type` | easing |
| `--motion-large-visual-duration` | 0.36 |
| `--motion-large-bounce` | 0.2 |
| `--motion-large-iterations` | infinite |
| `--motion-popup-scale` | 0.96 |
| `--motion-press-distance` | 1px |
| `--option-badge-background` | #085e55 |
| `--option-badge-foreground` | #fbfbfa |
| `--navigation-active-foreground` | #fbfbfa |
| `--emphasis-chart-fill` | #085e5533 |
| `--emphasis-balance-background` | #5b564b |
| `--emphasis-rewards-background` | #2f2b21 |
| `--emphasis-icon-background` | #2f2b21 |
| `--emphasis-icon-foreground` | #ffffff |
| `--emphasis-type-background` | #2f2b21 |
| `--emphasis-type-foreground` | #ffffff |
| `--navigation-active-background` | #085e55 |
| `--surface-raised-image` | none |
| `--surface-raised-shadow` | 0 0 0 0 transparent |
| `--surface-recessed-image` | none |
| `--surface-recessed-shadow` | 0 0 0 0 transparent |
| `--space-zero` | 0px |
| `--space-xxs` | 4px |
| `--space-xs` | 8px |
| `--space-s` | 12px |
| `--space-m` | 16px |
| `--space-l` | 25px |
| `--space-xl` | 33px |
| `--space-xxl` | 49px |
| `--size-xxs` | 10px |
| `--line-xxs` | 14px |
| `--letter-spacing-xxs` | 0em |
| `--size-xs` | 12px |
| `--line-xs` | 16px |
| `--letter-spacing-xs` | 0em |
| `--size-s` | 14px |
| `--line-s` | 20px |
| `--letter-spacing-s` | 0em |
| `--size-m` | 16px |
| `--line-m` | 24px |
| `--letter-spacing-m` | 0em |
| `--size-l` | 24px |
| `--line-l` | 32px |
| `--letter-spacing-l` | 0em |
| `--size-xl` | 36px |
| `--line-xl` | 40px |
| `--letter-spacing-xl` | 0em |
| `--size-xxl` | 48px |
| `--line-xxl` | 52px |
| `--letter-spacing-xxl` | 0em |
| `--radius-zero` | 0px |
| `--radius-xs` | 3px |
| `--radius-s` | 8px |
| `--radius-m` | 12px |
| `--radius-l` | 19px |
| `--radius-xl` | 29px |
| `--radius-full` | 9999px |
| `--border-none` | 0px |
| `--border-s` | 0px |
| `--border-m` | 0px |
| `--border-l` | 0px |
| `--border-default-color` | #413d3333 |
| `--border-shadow-none` | 0 0 0 0 transparent |
| `--border-shadow-s` | 0 0 0 0 transparent |
| `--border-shadow-m` | 0 0 0 0 transparent |
| `--border-shadow-l` | 0 0 0 0 transparent |
| `--font-ui` | "Timeless Grotesk", sans-serif |
| `--weight-ui-regular` | 400 |
| `--weight-ui-medium` | 500 |
| `--weight-ui-heavy` | 600 |
| `--font-brand` | "Timeless Grotesk", sans-serif |
| `--weight-brand-regular` | 400 |
| `--weight-brand-medium` | 500 |
| `--weight-brand-heavy` | 600 |
| `--font-editorial` | "Timeless Grotesk", sans-serif |
| `--weight-editorial-regular` | 400 |
| `--weight-editorial-medium` | 500 |
| `--weight-editorial-heavy` | 600 |
| `--font-data` | "Timeless Grotesk", sans-serif |
| `--weight-data-regular` | 400 |
| `--weight-data-medium` | 500 |
| `--weight-data-heavy` | 600 |
| `--color-none` | transparent |
| `--color-1` | #085e55 |
| `--color-1-transparent` | #085e5533 |
| `--color-2` | #ff5a00 |
| `--color-2-transparent` | #ff5a0033 |
| `--color-3` | #b6ebd8 |
| `--color-3-transparent` | #b6ebd833 |
| `--color-4` | #ffed9b |
| `--color-4-transparent` | #ffed9b33 |
| `--neutral-1` | #000000 |
| `--neutral-1-transparent` | #00000033 |
| `--neutral-2` | #242016 |
| `--neutral-2-transparent` | #24201633 |
| `--neutral-3` | #2f2b21 |
| `--neutral-3-transparent` | #2f2b2133 |
| `--neutral-4` | #413d33 |
| `--neutral-4-transparent` | #413d3333 |
| `--neutral-5` | #5b564b |
| `--neutral-5-transparent` | #5b564b33 |
| `--neutral-6` | #888377 |
| `--neutral-6-transparent` | #88837733 |
| `--neutral-7` | #b0ab9f |
| `--neutral-7-transparent` | #b0ab9f33 |
| `--neutral-8` | #d4cfc3 |
| `--neutral-8-transparent` | #d4cfc333 |
| `--neutral-9` | #f5f4f1 |
| `--neutral-9-transparent` | #f5f4f133 |
| `--neutral-10` | #ffffff |
| `--neutral-10-transparent` | #ffffff33 |
| `--success` | #00906c |
| `--success-transparent` | #00906c33 |
| `--warning` | #ffea00 |
| `--warning-transparent` | #ffea0033 |
| `--error` | #fc032d |
| `--error-transparent` | #fc032d33 |
| `--shadow-none` | none |
| `--shadow-s` | 0px 2px 4px 0px #00000000 |
| `--shadow-m` | 0px 2px 6px 0px #0000000d, 0px 8px 24px 0px #00000013 |
| `--shadow-l` | 0px 16px 48px 0px #00000000 |
| `--cte-canvas` | #000000 |
| `--cte-surface` | #242016 |
| `--cte-surface-muted` | #2f2b21 |
| `--cte-text` | #ffffff |
| `--cte-text-muted` | #b0ab9f |
| `--cte-border` | #413d3333 |
| `--cte-accent` | #085e55 |
| `--cte-accent-text` | #f5f4f1 |
| `--cte-danger` | #fc032d |
| `--cte-focus` | #085e55 |
| `--cte-font` | "Timeless Grotesk", sans-serif |
| `--cte-font-size` | 14px |
| `--cte-font-weight` | 400 |
| `--cte-line-height` | 20px |
| `--cte-letter-spacing` | 0em |
| `--cte-detail-font-size` | 12px |
| `--cte-detail-line-height` | 16px |
| `--cte-detail-letter-spacing` | 0em |

## Authored component assignments

These are project edits. The [component reference](untitled-components.md) includes the effective assignments with defaults and shared parts resolved.

```json
{
  "componentTokens": {
    "button:ghost:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:danger:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "input:default:rest": {
      "paddingX": "m",
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:outline:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:primary:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "select:default:rest": {
      "paddingX": "m",
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "button:secondary:rest": {
      "paddingX": "l",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "combobox:default:rest": {
      "paddingX": "m",
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s"
    },
    "menu:default:part:option:rest": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "slider:default:part:thumb:rest": {
      "controlSize": "l"
    },
    "slider:default:part:track:rest": {
      "controlSize": "xl"
    },
    "switch:default:part:control:rest": {
      "controlSize": "xl"
    },
    "combobox:default:part:option:rest": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "menu:default:part:option:selected": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "otp-field:default:part:input:rest": {
      "paddingX": "s",
      "paddingTop": "xs",
      "paddingLeft": "s",
      "paddingRight": "s",
      "paddingBottom": "xs"
    },
    "checkbox:default:part:control:rest": {
      "controlSize": "l"
    },
    "autocomplete:default:part:input:rest": {
      "paddingX": "s",
      "paddingTop": "s",
      "paddingLeft": "s",
      "paddingRight": "s",
      "paddingBottom": "s"
    },
    "autocomplete:default:part:option:rest": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "combobox:default:part:option:selected": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    },
    "autocomplete:default:part:popover:rest": {
      "radius": "s"
    },
    "autocomplete:default:part:option:selected": {
      "paddingX": "xs",
      "paddingTop": "xs",
      "paddingLeft": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs"
    }
  },
  "componentVariants": {}
}
```
