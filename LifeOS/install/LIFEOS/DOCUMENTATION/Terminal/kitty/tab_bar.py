# Custom tab bar: on the TOP edge, tabs share the full window width evenly —
# few tabs = long titles, many tabs = shorter, recomputed on every redraw
# (window resize, tab open/close). Any other edge falls through to the stock
# powerline drawing.
# Loaded because kitty.conf sets tab_bar_style custom (kitty >= 0.48).
#
# Sizing is boundary-targeted, not share-estimated: tab i pads its title so the
# bar reaches column i*width/n, using the `before` offset kitty passes to
# self-correct any drift from separators or double-width emoji. The last tab
# always pads to the window edge, so the bar spans the full width exactly.

from kitty.fast_data_types import Screen, get_boss, get_options, wcswidth
from kitty.tab_bar import (
    DrawData,
    ExtraData,
    TabBarData,
    draw_tab_with_powerline,
)

# tab_bar_edge option codes: left=1, top=2, right=4, bottom=8
HORIZONTAL_EDGES = (2, 8)
SEPARATOR_CELLS = 2  # powerline separator allowance per tab; drift self-corrects
MIN_TITLE = 3


def _num_tabs(fallback: int) -> int:
    try:
        tm = get_boss().active_tab_manager
        if tm is not None:
            return max(1, len(tm.tabs))
    except Exception:
        pass
    return fallback


def _fit(s: str, width: int) -> str:
    """Trim s to at most `width` display cells (emoji are 2) with a trailing
    ellipsis when truncated, then pad to exactly `width`."""
    if wcswidth(s) > width:
        out = ""
        for ch in s:
            if wcswidth(out + ch) > width - 1:
                break
            out += ch
        s = out + "…"
    return s + " " * (width - wcswidth(s))


def draw_tab(
    draw_data: DrawData,
    screen: Screen,
    tab: TabBarData,
    before: int,
    max_tab_length: int,
    index: int,
    is_last: bool,
    extra_data: ExtraData,
) -> int:
    try:
        if get_options().tab_bar_edge in HORIZONTAL_EDGES:
            n = max(_num_tabs(index), index)
            cols = screen.columns
            # This tab should end exactly at its boundary (last tab: window edge).
            target_end = cols if is_last else (cols * index) // n
            avail = max(MIN_TITLE + SEPARATOR_CELLS, target_end - before)
            budget = avail - SEPARATOR_CELLS
            tab = tab._replace(title=_fit(tab.title, budget))
            max_tab_length = avail
    except Exception:
        pass  # fall through to stock powerline drawing
    return draw_tab_with_powerline(
        draw_data, screen, tab, before, max_tab_length, index, is_last, extra_data
    )
