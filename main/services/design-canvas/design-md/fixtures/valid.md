---
version: alpha
name: Fixture Daylight
description: A small, complete design system used by Aiden's tests.
colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
  surface: "#FFFFFF"
  on-surface: "#1A1C1E"
typography:
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  headline:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
rounded:
  sm: 4px
  md: 8px
spacing:
  sm: 8px
  md: 16px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: 12px
---

## Overview

Calm and legible, with one strong accent.

## Colors

Primary is near-black; surfaces are white.

## Typography

Inter throughout.

## Layout

An 8px grid.

## Elevation & Depth

Flat, with hairline separators.

## Shapes

Small, soft corners.

## Components

Buttons use the primary colour.

## Do's and Don'ts

Do keep one accent per screen.
