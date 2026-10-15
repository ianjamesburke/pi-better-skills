# Pi Better Skills

Better Skills replaces the awkward `/skill:name` discovery flow with an in-pane fuzzy picker.

Run `/skills`, type to filter, use the arrow keys to choose a skill, and add the task to run. An empty picker learns from use: most recently used skills come first, then the most frequently used. Once you type, the best fuzzy text match comes first.

## Install

From npm (recommended):

```sh
pi install npm:pi-better-skills
```

Or install the tagged Git release without npm:

```sh
pi install git:github.com/ianjamesburke/pi-better-skills@v0.1.1
```

For local development:

```sh
pi install /absolute/path/to/pi-better-skills
```

Restart Pi (or run `/reload`), then run `/skills`.

For a single clean skill entry point, turn off Pi's native skill-command discovery in Settings, or add this to `~/.pi/agent/settings.json`:

```json
{ "enableSkillCommands": false }
```

This hides `/skill:name` from the slash menu while preserving explicit invocation, which Better Skills uses after selection.

## Design

Pi's native `/skill:name` command and `@` file mention are useful primitives, but neither makes skill discovery pleasant. Better Skills supplies a compact, keyboard-first picker in the same editor region Pi uses for model selection.

Usage history is stored locally in `~/.pi/agent/skills-usage.json`. It contains only skill names, usage counts, and last-used timestamps.

## Planned

- Skill profiles for focused project/workflow sets.
- A profile manager that updates Pi package resource filters and reloads cleanly.

Profiles will initially scope the Better Skills picker. Fully unloading native Pi skill commands and their startup context needs core Pi support.
