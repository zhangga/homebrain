# Third-Party Notices

HomeAgent is licensed under Apache License 2.0. A release bundle must include this file and the
license files shipped by every redistributed executable. The build must fail if an executable is
added without a pinned version, source URL, checksum, and license entry.

## Bun standalone runtime

- Project: Bun
- Source: https://github.com/oven-sh/bun
- License inventory: https://github.com/oven-sh/bun/blob/main/LICENSE.md
- Use in HomeAgent: separately bundled runtime executing HomeAgent's JavaScript bundle

Bun itself is MIT licensed. Its executable statically links JavaScriptCore/WebKit under LGPL-2 and
includes additional components under MIT, BSD, Apache-2.0, zlib, LGPL and other terms listed in
Bun's license inventory. HomeAgent keeps its application JavaScript separate from that executable.
Binary publication is blocked until the release process packages the corresponding Bun version's
complete notices plus the source/relink offer required by its license inventory. A link alone is not
a substitute for required release artifacts.

## Hono

- Project: Hono
- Source: https://github.com/honojs/hono
- License: MIT
- Copyright: 2021-present Yusuke Wada and Hono contributors
- Use in HomeAgent: embedded application dependency

The Hono MIT license text is available at https://github.com/honojs/hono/blob/main/LICENSE and must
be copied into the final application's notices directory.

## Lark CLI

- Project: Lark CLI
- Source: https://github.com/larksuite/cli
- License: MIT
- Copyright: 2026 Lark Technologies Pte. Ltd.
- Use in HomeAgent: separately bundled, unmodified Feishu/Lark command-line executable

The exact bundled release version and SHA-256 must be recorded by the build. Its MIT license text is
available at https://github.com/larksuite/cli/blob/main/LICENSE and must be copied into the final
application's notices directory.

## Codex CLI (downloaded by the user, not redistributed)

- Project: OpenAI Codex CLI
- Source: https://github.com/openai/codex
- License: Apache License 2.0
- Distribution policy: not included in `HomeAgent.app` or its DMG

HomeAgent may offer an explicit-consent installer that downloads an official Codex release directly
for the current user and verifies its checksum. The installer must retain the downloaded release's
license and provenance alongside the executable.

## macOS system frameworks

HomeAgent's attachment helper links Apple Vision and PDFKit system frameworks. These frameworks are
provided by macOS and are not redistributed in the HomeAgent release.
