---
version: alpha
name: Fixture Broken Reference
colors:
  primary: "#1A1C1E"
  surface: "#FFFFFF"
  ghost: "{colors.nope}"
typography:
  body:
    fontFamily: Inter
    fontSize: 16px
components:
  button-primary:
    backgroundColor: "{colors.missing}"
    textColor: "{colors.surface}"
---

## Overview

A file with a reference that doesn't resolve.

## Colors

Ghost points at a colour that isn't there.
