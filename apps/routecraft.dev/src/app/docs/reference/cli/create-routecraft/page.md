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

{% code-tab label="deno" language="bash" %}
```bash
deno run -A npm:create-routecraft [project-name] [options]
```
{% /code-tab %}
{% /code-tabs %}

You will then be asked the following prompts:

```text
What is your project named?  my-app
Template:  Minimal (TypeScript) / Empty
Example (optional):  none / hello-world / timer / GitHub URL
Package manager:  npm / pnpm / yarn / bun / deno
Use src directory:  Yes / No
Initialize git:  No / Yes
Install dependencies now:  No / Yes
```

### Options

| Option | Description |
| --- | --- |
| **-v** or **--version** | Print version and exit |
| **-h** or **--help** | Show usage help |
| **--yes** | Use defaults for all prompts |
| **--skip-install** | Scaffold without installing dependencies |
| **--empty** | Generate without example routes |
| **--example <name or repo-url>** | Scaffold from an example template or GitHub repo |
| **--use-npm**, **--use-pnpm**, **--use-yarn**, **--use-bun** | Choose package manager |
| **--no-src-dir** | Place project files at the project root |

### Next steps

Open in your editor and start the dev server:

{% code-tabs %}
{% code-tab label="npm" language="bash" %}
```bash
cd my-app
npm run dev
```
{% /code-tab %}

{% code-tab label="yarn" language="bash" %}
```bash
cd my-app
yarn dev
```
{% /code-tab %}

{% code-tab label="pnpm" language="bash" %}
```bash
cd my-app
pnpm dev
```
{% /code-tab %}

{% code-tab label="bun" language="bash" %}
```bash
cd my-app
bun run dev
```
{% /code-tab %}

{% code-tab label="deno" language="bash" %}
```bash
cd my-app
deno task dev
```
{% /code-tab %}
{% /code-tabs %}