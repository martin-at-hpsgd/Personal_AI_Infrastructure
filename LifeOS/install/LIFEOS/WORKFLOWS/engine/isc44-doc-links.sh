cd "$(dirname "$0")/../../.." || exit 2
PAT="${1:-DOCUMENTATION/Arbol|ArbolSystem\.md}"
test -s LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md || { echo "FAIL: doc missing"; exit 1; }
test ! -e LIFEOS/DOCUMENTATION/Arbol || { echo "FAIL: LIFEOS/DOCUMENTATION/Arbol still exists"; exit 1; }
a=$(git ls-files | rg -v '^LIFEOS/(MEMORY|USER)$' | tr '\n' '\0' | xargs -0 rg -l -i "$PAT" 2>/dev/null | rg -v '^(LIFEOS/WORKFLOWS/(ISA\.md|engine/isc44-doc-links\.sh|engine/name-sweep(\.test)?\.ts)|skills/LifeOS/install/RETIREMENTS\.json)$')
USER_DIR="${LIFEOS_USER_DIR:-$(cd LIFEOS/USER 2>/dev/null && pwd -P)}"
[ -n "$USER_DIR" ] && [ -d "$USER_DIR" ] || { echo "FAIL: user data dir unresolved (set LIFEOS_USER_DIR or link LIFEOS/USER)"; exit 2; }
b=$(cd "$USER_DIR" && git ls-files | rg -v '^(MEMORY|ERRATA)/' | tr '\n' '\0' | xargs -0 rg -l -i "LIFEOS/$PAT" 2>/dev/null)
if [ -n "$a$b" ]; then echo "FAIL: live links:"; echo "$a"; echo "$b"; exit 1; fi
echo PASS
