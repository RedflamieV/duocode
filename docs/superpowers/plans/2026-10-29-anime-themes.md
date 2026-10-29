# Anime Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add all eight approved anime themes to DuoCode's existing appearance settings.

**Architecture:** Share theme metadata between Electron and Preact; apply complete palettes through CSS variables and render local illustrated scene backgrounds. Keep persistence in the existing settings IPC.

**Tech Stack:** Electron, Preact, CSS, local SVG; no new dependencies.

**Spec:** docs/superpowers/specs/2026-10-29-anime-themes-design.md

## Global Constraints

- Implement all eight named themes and preserve the seven existing choices.
- Work offline and use existing asset packaging.
- Respect full/subtle/off motion and prefers-reduced-motion.
- Preserve existing settings persistence and native title-bar synchronization.

## Review Focus

- Switching back to a built-in theme must clear every inline palette variable.
- All new themes must override the system light/dark palette completely.
- Decorations must not intercept pointer input or obscure chat text.
- Long Russian theme names and keyboard focus must fit the settings dialog.
- Assets must load from the packaged renderer file URL.

### Task 1: Catalog and integration

**Files:** Create src/themes.js and renderer/src/themes.jsx; modify main.js, renderer/src/prefs.js, renderer/src/app.jsx.

**Interfaces:** Export BUILTIN_THEMES, ANIME_THEMES, getTheme(id) from the shared CommonJS catalog. Export ThemePicker and ThemeBackdrop from the renderer component.

- [x] Add complete theme metadata and palettes; use the catalog for native window colors.
- [x] Apply and clear palette overrides in applyPrefs, render the new picker and decorative scene.
- [x] Verify both bundles with npm run build.

### Task 2: Illustration and presentation

**Files:** Create assets/themes/*.svg; modify renderer/styles.css.

**Interfaces:** Scene asset basename matches each new theme ID; the root data-scene attribute scopes new styling.

- [x] Create eight distinct local illustrations and matching previews.
- [x] Add scene layering, readable surfaces, focus styles and restrained motion.
- [x] Check SVG validity and run npm run build.

### Task 3: Runtime verification

- [x] Launch the actual Electron app and exercise every theme through settings.
- [x] Verify persistence, native theme, switching back, keyboard access and reduced/off motion.
- [x] Capture and inspect representative light/dark themes and the collection.
- [x] Review the diff, run the build and git diff --check.

## Execution notes

Implement directly in the task's managed /workspace/duocode checkout on branch work; no additional worktree needed for this reversible visual change. Use runtime browser checks rather than adding tests that duplicate palette declarations. This follows the session's instructions for low-impact visual changes.


## Verification results

- `npm run build`: desktop and Telegram bundles pass.
- `node --check main.js`, `node --check src/themes.js`, `git diff --check`: pass.
- Eight SVG files parse successfully and load from local file URLs in Electron.
- Actual Electron/CDP checks: all 15 choices present; eight themes selectable with persistence, complete palettes, matching native window backgrounds and nativeTheme sources; all seven built-in choices clear the scene and inline overrides.
- Keyboard Space selection, input hit testing, 16px text layout, and light/dark system preference checks pass.
- Full motion animates; subtle/off and system reduced motion stop decorative animation.
- Actual app shutdown/restart restores winter-cafe and its local illustration.
- Measured main text, muted preview copy and primary-button text contrast exceed 4.5:1 in all eight themes.
- Independent code review found no important defects. Its avatar contrast finding was fixed using palette-aware foregrounds, and verified in the running app. Settings tabs were also prevented from shrinking when the collection scrolls.
- Screenshots inspected for the light train, dark shrine, and theme picker. Runtime screenshots and check scripts are temporary artifacts under /tmp/duocode-anime-checks and /tmp/check-duocode-*.cjs.
