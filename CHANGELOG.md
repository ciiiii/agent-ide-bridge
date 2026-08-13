# Changelog

## [0.2.0](https://github.com/ciiiii/agent-ide-bridge/compare/v0.1.1...v0.2.0) (2026-08-13)


### Features

* add herdr plugin to run the CLI in a pane ([926dc21](https://github.com/ciiiii/agent-ide-bridge/commit/926dc212d226eee3f2769c16725e107f5477d2b2))
* add terminal CLI frontend ([fe77ec7](https://github.com/ciiiii/agent-ide-bridge/commit/fe77ec7211f0d991bcfb80309c9a7f66d48c5c24))
* **herdr:** one-step start, auto open/close, per-workspace ports, prebuilt install ([641255e](https://github.com/ciiiii/agent-ide-bridge/commit/641255eb67fc288c8cd97a64ddf8107955c7bdb0))


### Bug Fixes

* **cli:** color the handled/closed result labels ([113fa5c](https://github.com/ciiiii/agent-ide-bridge/commit/113fa5cae7705f55563bbc17225a9feb117162a2))
* **cli:** distinguish '· closed' (disconnect) from '· handled'; short labels ([473ee88](https://github.com/ciiiii/agent-ide-bridge/commit/473ee889080e510841640386326dba5bf2e503e1))
* **cli:** print a disconnect cue when claude quits with no diff open ([3abd7ba](https://github.com/ciiiii/agent-ide-bridge/commit/3abd7ba68f07fffaf0fbf9fd5aba337a104721c1))
* **cli:** resolve open diffs on reject/cancel/disconnect; render unified via delta ([b012f88](https://github.com/ciiiii/agent-ide-bridge/commit/b012f88c81718d6571fe7209f71d7d05e5525f9c))
* **cli:** show 'handled in claude' for claude-side diff resolution ([81a7660](https://github.com/ciiiii/agent-ide-bridge/commit/81a7660b112aaaf94b33eba71159da9feac84e81))
* **cli:** treat close_tab as accept unless a cancel (reject) arrives ([51a54a7](https://github.com/ciiiii/agent-ide-bridge/commit/51a54a7ab9b1f1e98431664180c504ca1e4abd3a))

## [0.1.1](https://github.com/ciiiii/agent-ide-bridge/compare/v0.1.0...v0.1.1) (2026-08-13)


### Bug Fixes

* build the extension before packaging the vsix ([96b848f](https://github.com/ciiiii/agent-ide-bridge/commit/96b848f03c186e46b08cb8cfcdc1ce0e64f8aa77))

## 0.1.0 (2026-08-13)


### Bug Fixes

* diff against an empty left side for new files ([d515ad4](https://github.com/ciiiii/agent-ide-bridge/commit/d515ad43a54edfc7a7ea71e8cb5f2d1a37fc7757))


### Miscellaneous Chores

* set first release to 0.1.0 ([061b019](https://github.com/ciiiii/agent-ide-bridge/commit/061b019e7954b7ee32b51d555ec2c5dcbd0e2926))
