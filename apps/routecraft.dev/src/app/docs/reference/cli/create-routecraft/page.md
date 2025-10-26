---
title: Create RouteCraft App
---

Create a new RouteCraft project using the official initializer. {% .lead %}

## Usage

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
npm create routecraft@latest [project-name] [options]
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
yarn create routecraft [project-name] [options]
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
pnpm create routecraft@latest [project-name] [options]
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
bunx create-routecraft [project-name] [options]
```
{% /code-tab %}

{% /code-tabs %}

You will then be asked the following prompts:

```text
What is your project named?  my-app
Example (optional):  none / hello-world / GitHub URL
Package manager:  npm / pnpm / yarn / bun
Use src directory:  No / Yes
Initialize git:  Yes / No
Install dependencies now:  Yes / No
```

### Options

| Option | Description |
| --- | --- |
| **-h** or **--help** | Show usage help |
| **-y** or **--yes** | Skip interactive prompts and use defaults |
| **-f** or **--force** | Overwrite existing directory |
| **--skip-install** | Skip installing dependencies |
| **-e** or **--example <name or url>** | Example to include (none, hello-world) or GitHub URL |
| **--use-npm**, **--use-pnpm**, **--use-yarn**, **--use-bun** | Choose package manager |
| **--no-src-dir** | Place project files at root instead of src/ |
| **--no-git** | Skip git initialization |

### Next steps

Build and start your RouteCraft project:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
cd my-app
npm run build
npm run start
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
cd my-app
yarn build
yarn start
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
cd my-app
pnpm build
pnpm start
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
cd my-app
bun run build
bun run start
```
{% /code-tab %}

{% /code-tabs %}

{% callout type="note" %}
A `dev` command with hot-reload capabilities is coming soon in a future release.
{% /callout %}

### Examples

```bash
# Create a new project with interactive prompts
npm create routecraft@latest my-app

# Create with hello-world example using pnpm
npm create routecraft@latest my-app --example hello-world --use-pnpm

# Create with defaults (no prompts)
npm create routecraft@latest my-app --yes --example hello-world

# Force overwrite existing directory
npx create-routecraft my-app --force

# Create from a GitHub repository
npm create routecraft@latest my-app --example https://github.com/user/repo

# Create from a specific path in a GitHub repository
npm create routecraft@latest my-app --example https://github.com/user/repo/tree/main/examples/api
```