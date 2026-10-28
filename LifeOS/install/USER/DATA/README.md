---
provenance: template
version: 1.0.0
---

# DATA — datasets your skills keep locally

Each subdirectory is one dataset a skill maintains on disk, with its own README describing the files, the source it is refreshed from, and the tool that refreshes it. The skill checks the directory exists and then reads its files directly, so seed a dataset before running its update tool for the first time.

No dataset ships here.

Add a directory per new dataset and give it the same kind of README: what the files are, where they come from, which tool writes them. Raw data you did not generate yourself stays out of git if it is large; the directory README is enough for the skill to know where to look.
