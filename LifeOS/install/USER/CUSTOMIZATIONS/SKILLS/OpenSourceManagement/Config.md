---
provenance: template
version: 1.1.0
---

# OpenSourceManagement Config

> Read by `skills/OpenSourceManagement/Tools/Fetch.ts` (the `OSS_*` lines) and
> `skills/OpenSourceManagement/Tools/LocalModels.ts` (`loadConfig`). The LocalModels parser
> scans every markdown table row and takes any row whose first cell is a single word as
> `key -> value`. So the settings table below must stay the only table in this file whose
> first column holds bare one-word keys. Notes are written as prose for that reason.
>
> Every value here is an invented example (the `acme-labs` org and its `widget` and
> `gadget` repos). Replace them with your own; until you do, every fetch comes back as a
> hole ("could not fetch") on the `acme-labs` repos.

## GitHub

`OSS_OWNER` is the GitHub user or organization that owns your repos. `OSS_REPOS` is the
comma-separated list of repo names under that owner that the skill triages, in the order
reports list them. `OSS_PRIORITY` (optional) is the repo batch work starts with.

OSS_OWNER: acme-labs
OSS_REPOS: widget, gadget
OSS_PRIORITY: widget

## Source of truth

Name any listed repo whose public copy is generated or synced from another tree, and where
that tree is. The skill ports an accepted change there first and never merges it on the
public repo. A repo not named here is its own source of truth.

- gadget: the public repo is rebuilt from the private `acme-labs/gadget-src` repo by a release
  script; port accepted changes into `gadget-src`, credit the contributor, close the PR.

## Out of scope

Repos the skill must not triage, and where they go instead.

- acme-labs/website: triaged by the web team in their own tracker.

## Local Model Host

| Key | Value |
|-----|-------|
| ssh_host | modelbox |
| ollama_bin | ollama |

## What each key means

ssh_host is the alias (from your `~/.ssh/config`) or `user@host` of the machine where Ollama
is installed. The LocalModels intent connects there to run `ollama list` and read GPU memory
(`nvidia-smi` on an NVIDIA box, unified memory on a Mac) and free disk, to see what is
installed and what fits. Set it to the box you pull models onto.
If Ollama is on this machine, leave the value as is and pass `--local` at run time, or
pass `--host <alias>` to override for one run.

ollama_bin is the path or command name of the Ollama binary on that host. `ollama` works
when it is on the login PATH; use a full path such as `/usr/local/bin/ollama` when a
non-interactive remote shell cannot find it.
