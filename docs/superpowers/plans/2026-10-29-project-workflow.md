# Projects, Telegram files and GitHub implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans. The user explicitly requested immediate implementation without further approvals.

**Goal:** Persist a user-selected project order, browse PC project files in Telegram, and import GitHub repositories using gh.

**Architecture:** Extend the existing settings/IPC and authenticated Telegram RPC. Keep file access in a shared, root-restricted module. Delegate GitHub authentication and credentials to the installed GitHub CLI; imported repositories become ordinary local projects.

**Tech Stack:** Electron, Node.js, Preact, existing esbuild; no new runtime dependencies.

**Spec:** User request and clarification: view files in Telegram; use gh and implement all three immediately.

## Global Constraints

- Preserve existing projects, chats and folders; order must survive activity and restart.
- Use existing Telegram owner authentication; reject paths and symlinks outside authorized roots.
- Preview text as text, never execute HTML or scripts; stream downloads as attachments.
- Keep GitHub tokens out of settings, renderer and repository URLs.
- Work in the prepared cloud checkout on branch work. Do not publish a release.

## Review Focus

- Saved ordering must include the no-project group and tolerate deleted/new projects.
- Files with non-ASCII names, large content, binary bytes and symlinks must behave predictably.
- Downloads require valid authentication and must not execute active content.
- gh absent, signed out, missing repository access, and occupied destinations need useful errors.
- New UI must handle async failures and not close dialogs on background clicks.

### Task 1: Persistent project order

**Files:** src/projects.js, main.js, preload.js, renderer/src/app.jsx, renderer/styles.css, tests/projects.test.js.
**Interfaces:** projects.reorder(settings, keys), duo.reorderProjects(keys); settings.projectOrder stores group keys.

- [x] Write and run tests for reordered projects, partial/stale lists and persistence round trip.
- [x] Implement backend order updates and settings broadcast.
- [x] Sort groups by the saved order, add drag/drop and accessible up/down buttons, surface errors.
- [x] Run node --test tests/projects.test.js and npm run build.

### Task 2: Telegram project files

**Files:** src/projectFiles.js, src/remote.js, main.js, renderer/remote/shim.js, renderer/remote/files.jsx, renderer/remote/main.jsx, renderer/remote.css, renderer/src/attachments.jsx, tests/projectFiles.test.js, tests/remoteFiles.test.js.
**Interfaces:** FileAccess(getRoots).resolve(cwd,file), .list(dir), .read(cwd,file); RPC fileRoots(roomId), listFiles(dir), readFile(cwd,file); authenticated GET /api/file.

- [x] Write and run file-access and authenticated-download tests against temporary real files.
- [x] Implement canonical root validation, directory navigation, bounded text/image previews and binary metadata.
- [x] Add authenticated streamed downloads with safe headers.
- [x] Add mobile file browser and connect chat links/attachments to preview.
- [x] Run the Node suite and npm run build.

### Task 3: GitHub CLI projects

**Files:** src/github.js, main.js, preload.js, renderer/src/github.jsx, renderer/src/app.jsx, renderer/styles.css, README.md, tests/github.test.js.
**Interfaces:** GitHub.status(), .repositories(page), .clone(fullName,parent); duo.github.status/login/repositories/clone.

- [x] Write and run tests for missing CLI, invalid repository input, occupied paths and clone success/failure using a CLI boundary double and real temporary directories.
- [x] Implement gh account discovery, browser login through existing console launcher, paginated repositories and clone-to-project.
- [x] Add GitHub settings/import UI with search, destination selection and errors; document usage.
- [x] Run node --test, npm run build, syntax and diff checks, then exercise Electron through the prepared debug launcher.
- [x] Review the full change and fix material findings before reporting results.

## Verification record

- 13 Node tests pass; both frontend bundles build; syntax and whitespace checks pass.
- Real Electron IPC/UI checks cover arrow ordering, drag/drop, activity stability and a full application restart.
- A mobile browser running the actual bundle against signed Telegram fixture requests verifies directory browsing, inert HTML/SVG source, raster images, binary fallback and authenticated downloading.
- A real Preact component harness reproduced both reviewer findings before fixes: focus cleared cloning state and an unmounted panel invoked its parent. Both checks pass after the fixes.
- The final reviewer reported no other material findings. Concurrent hostile filesystem replacement was outside the static symlink threat model assessed here; canonical path validation covers ordinary traversal and symlinks.
- The cloud HTTP policy blocks api.github.com. GitHub operations are verified at the CLI boundary with local filesystem side effects; real account login and remote cloning need a local end-to-end check.
