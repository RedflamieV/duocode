# Model Providers Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. User requested execution without another approval round.

**Goal:** Select GLM and other Anthropic-compatible models in the Claude Code slot.
**Architecture:** A shared provider catalog supplies model lists and validation. The main process owns credentials and produces per-run Claude Code overrides; rooms retain only provider IDs and response metadata.
**Tech Stack:** Node.js, Electron safeStorage, Preact, node:test, esbuild; no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-06-model-providers-design.md

## Global Constraints

- Retain native Claude behavior and existing chats when provider ID is empty.
- Do not modify global Claude Code settings or expose stored keys through IPC/chat exports.
- No network request or real model usage is required by automated tests.
- Missing profiles/keys fail explicitly, never fall back to Anthropic.

## Review Focus

- Conflicting user/project Claude settings must not override the selected provider.
- Switching provider during an active or delegated run must not mix sessions.
- Renaming/editing/deleting a profile must preserve keys or produce a clear missing-profile error.
- Native subscription budget must not block a GLM turn or count it as Claude spending.
- New-chat defaults, existing-chat selection, and response model badges must agree.

### Task 1: Provider configuration and credential boundaries

**Files:** src/providers.js, tests/providers.test.js, main.js.
**Interfaces:** profile `{id,name,baseUrl,apiKey,authType,models,defaultModel,supportsEffort}`; `mergeProviders(next, previous)`, `publicProviders(list)`, `saveProviders(list, seal)`, `loadProviders(list, open)`, `claudeOptions(settings, roomSettings)`.

- [x] Write tests for profile validation, key preservation/redaction/encryption, native defaults and isolated runtime overrides; run them RED.
- [x] Implement shared pure functions and main-process settings persistence; run tests GREEN.

### Task 2: Agent execution, sessions and accounting

**Files:** src/agents/claude.js, src/rooms.js, main.js, tests/providers.test.js, tests/providerRooms.test.js.
**Interfaces:** `claudeOptions` returns provider metadata, model, effort, env, settings overrides, session identity; room setting `claudeProvider` is an ID.

- [x] Add tests using a local executable fixture for run settings and Rooms for switching, missing keys, active runs and subscription budget; run RED.
- [x] Wire per-turn settings, metadata, session transitions, subscription accounting and commit message generation; run GREEN.

### Task 3: Profile editor and model selection

**Files:** renderer/src/providers.jsx, renderer/src/app.jsx, renderer/src/messages.jsx, renderer/styles.css, README.md.
**Interfaces:** public profiles contain `hasApiKey` and never the key. The editor submits only a replacement key; omitted key preserves it, empty key removes it.

- [x] Add the profile editor with GLM/custom templates and validation errors.
- [x] Share provider/model selector between chat header, new chat and defaults. Show provider in responses and explain custom API budget.
- [x] Run `npm test`, `npm run build`, syntax checks and local browser interaction checks. Expected: all pass.
- [x] Request one independent code review, address important findings, re-run affected checks.

## Validation notes

Real Claude Code 2.1.318 answered through a local Anthropic Messages fixture without a Claude login, using the selected key and model despite conflicting user settings. Browser checks cover creating and editing a profile, preserving its hidden key, defaults reaching the new-chat selector, suppressing the Claude-login banner, and hiding unsupported effort levels. A live GLM response still requires the user's provider key.

Independent review found two issues, both corrected with RED→GREEN regressions: preserving ciphertext while the keyring is locked, and continuing a batch of default updates after a busy chat rejects its update.
