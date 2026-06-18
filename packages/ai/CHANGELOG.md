# @routecraft/ai

## 1.0.0

### Minor Changes

- [#419](https://github.com/routecraftjs/routecraft/pull/419) [`9d9d7f0`](https://github.com/routecraftjs/routecraft/commit/9d9d7f0e4d61717d12760c0aff50ae4341ac5ab0) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Declare core as a peer dependency with a real semver range (plus a workspace devDependency for development) instead of duplicating it as a regular dependency.

### Patch Changes

- [#434](https://github.com/routecraftjs/routecraft/pull/434) [`828e7c9`](https://github.com/routecraftjs/routecraft/commit/828e7c957637c896aca35073768fd0ec72ce13b8) Thanks [@ex0b1t](https://github.com/ex0b1t)! - Forward a configured `baseURL` to the Anthropic and Gemini LLM providers (previously only OpenAI honoured it, so explicit config lost to the ambient `ANTHROPIC_BASE_URL` environment variable), and load the `yaml` front-matter parser for `agents()` / `skills()` through `loadOptionalPeer` so a missing package surfaces as RC5017 with an install hint instead of a misleading front-matter parse error.

- Updated dependencies [[`9d9d7f0`](https://github.com/routecraftjs/routecraft/commit/9d9d7f0e4d61717d12760c0aff50ae4341ac5ab0), [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98), [`6722d4a`](https://github.com/routecraftjs/routecraft/commit/6722d4a75de6c7d08ec438d97c1bc07ce780df98), [`f1896a5`](https://github.com/routecraftjs/routecraft/commit/f1896a542ae1a3bc4de76f5650ef0ab728ba6908), [`828e7c9`](https://github.com/routecraftjs/routecraft/commit/828e7c957637c896aca35073768fd0ec72ce13b8)]:
  - @routecraft/routecraft@1.0.0
