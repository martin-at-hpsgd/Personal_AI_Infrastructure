# Headshot.ts - AI Headshot Generation CLI

Generate professional headshots of the subject using Nano Banana Pro (Gemini 3 Pro) with reference image support for facial structure matching.

## Setup check

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts check        # config, reference photos, API key
bun ~/.claude/skills/Headshot/Tools/Headshot.ts config       # parsed config as JSON
bun ~/.claude/skills/Headshot/Tools/Headshot.ts references --sentiment positive
```

These read `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Headshot/Config.md` and exit 1 with a pointer to `Setup.md` when it is missing.

## Quick Start

```bash
# Basic headshot with single reference
bun ~/.claude/skills/Headshot/Tools/Headshot.ts \
  --prompt "Professional headshot, studio lighting, neutral background" \
  --reference ~/Pictures/headshot-references/ref1.png \
  --output /tmp/headshot.png
```

## Commands

This is a single-command CLI. All options are passed as flags.

## Required Flags

| Flag | Description |
|------|-------------|
| `--prompt <text>` | Description of the headshot to generate |
| `--reference <path>` | Reference image path (can be used multiple times) |

## Optional Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--size <size>` | `2K` | Image resolution: 1K, 2K, 4K |
| `--aspect-ratio <ratio>` | `1:1` | Aspect ratio (see below) |
| `--output <path>` | `/tmp/headshot.png` | Output file path |
| `--help, -h` | | Show help message |

### Aspect Ratios

| Ratio | Use Case |
|-------|----------|
| `1:1` | Profile pictures, avatars |
| `3:4` | Portrait, headshots |
| `4:3` | Landscape headshot |
| `2:3` | Tall portrait |
| `3:2` | Wide portrait |
| `16:9` | Banner, header |
| `9:16` | Stories, vertical |

## Examples

### Professional Headshot

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts \
  --prompt "Professional headshot of the subject, software engineer, wearing a dark blazer, soft studio lighting, neutral gray background" \
  --reference ~/Pictures/headshot-references/ref1.png \
  --size 2K \
  --aspect-ratio 1:1 \
  --output ~/headshots/professional.png
```

### Casual Portrait

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts \
  --prompt "Casual portrait of the subject, warm natural lighting, outdoor setting, friendly smile" \
  --reference ~/Pictures/headshot-references/ref1.png \
  --reference ~/Pictures/headshot-references/ref2.png \
  --size 4K \
  --aspect-ratio 3:4 \
  --output ~/headshots/casual.png
```

### Conference Speaker

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts \
  --prompt "The subject speaking at a tech conference, professional attire, stage lighting, dynamic pose" \
  --reference ~/Pictures/headshot-references/ref1.png \
  --size 2K \
  --aspect-ratio 16:9 \
  --output ~/headshots/speaker.png
```

### Multiple Reference Images

Using multiple references improves facial accuracy:

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts \
  --prompt "Editorial portrait, dramatic lighting, artistic composition" \
  --reference ~/Pictures/headshot-references/front.png \
  --reference ~/Pictures/headshot-references/side.png \
  --reference ~/Pictures/headshot-references/casual.png \
  --size 4K \
  --output ~/headshots/editorial.png
```

## Prompt Tips

### Good Prompts

- **Specific lighting:** "soft studio lighting", "dramatic side light", "natural window light"
- **Clear background:** "neutral gray background", "blurred office", "pure white"
- **Style descriptors:** "editorial style", "corporate portrait", "candid"
- **Clothing details:** "dark blazer over white shirt", "casual black t-shirt"

### Prompt Structure

```
[Subject context] + [Attire] + [Lighting] + [Background] + [Style]
```

Example:
```
"Professional headshot of the subject, software engineer, wearing a dark blazer, soft studio lighting with subtle rim light, clean gray gradient background, editorial magazine style"
```

## Reference Images

Keep reference images in the directory named in `Config.md` § Reference photos (any folder works; the examples here use `~/Pictures/headshot-references/`):

- Include various angles (front, 3/4, profile)
- Different lighting conditions
- Mix of professional and casual
- High resolution preferred (1K+ pixels on face)

The model uses these to match:
- Facial structure and proportions
- Skin tone and complexion
- Hair style and color
- Distinctive features

## Troubleshooting

### "Missing environment variable: GOOGLE_API_KEY"

Ensure the `.env` file in your config root (`$CLAUDE_CONFIG_DIR`, default `~/.claude`) contains:
```
GOOGLE_API_KEY=your_key_here
```

### "Unsupported image format"

Only PNG, JPEG, and WebP are supported for reference images.

### Poor Likeness

- Add more reference images from different angles
- Use higher resolution reference images
- Be more specific in the prompt about features

### API Errors

- Check your Gemini API quota
- Verify API key is valid
- Try a smaller size (1K instead of 4K)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (invalid args, API error, file error) |

## Related

- Skill documentation: `~/.claude/skills/Headshot/SKILL.md`
- Art skill: `~/.claude/skills/Art/SKILL.md`
- Generate tool: `~/.claude/skills/Art/Tools/Generate.ts`
