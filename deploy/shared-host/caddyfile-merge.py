#!/usr/bin/env python3
"""Merge the BitriPay site blocks into an existing Caddyfile.

Usage: caddyfile-merge.py <Caddyfile> <snippet>
Removes every top-level site block whose address mentions bitripay.com (old ports, old container names, an earlier
copy of the snippet) and any previous BitriPay marker section, then appends the snippet between markers. Everything
else in the file is left byte for byte. Prints what was removed. Exit 0 on success.
"""
import re
import sys

BEGIN = "# >>> BitriPay (managed by deploy/shared-host/apply-edge.sh) >>>"
END = "# <<< BitriPay <<<"


def strip_markers(text: str) -> str:
    return re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S)


def _brace_delta(line: str) -> int:
    """Net brace count of a line, ignoring comments and quoted strings."""
    depth = 0
    quote = None
    i = 0
    while i < len(line):
        c = line[i]
        if quote:
            if c == "\\":
                i += 1
            elif c == quote:
                quote = None
        elif c in ('"', "'", "`"):
            quote = c
        elif c == "#":
            break
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return depth


def remove_bitripay_blocks(text: str):
    """Drop top-level blocks whose site address line names bitripay.com. Returns (text, removed_addresses).

    Line-based: a block starts on the line that takes the depth from 0 to more (its address is the text before the
    first brace) and ends on the line that brings it back to 0; loose lines between blocks are kept as they are.
    """
    kept, removed = [], []
    block, address, depth = [], None, 0
    for line in text.splitlines(keepends=True):
        if depth == 0:
            delta = _brace_delta(line)
            if delta <= 0 and "{" not in line.split("#", 1)[0]:
                kept.append(line)
                continue
            block, address = [line], line.split("{", 1)[0].strip()
            depth = delta
            if depth <= 0:  # one-line block
                (removed if "bitripay.com" in address else kept).append(address if "bitripay.com" in address else line)
                block, address, depth = [], None, 0
            continue
        block.append(line)
        depth += _brace_delta(line)
        if depth <= 0:
            if "bitripay.com" in address:
                removed.append(address)
            else:
                kept.extend(block)
            block, address, depth = [], None, 0
    if block:  # unbalanced file: keep what was read rather than losing it
        kept.extend(block)
    return "".join(kept), removed


def main():
    path, snippet_path = sys.argv[1], sys.argv[2]
    original = open(path, encoding="utf-8").read()
    snippet = open(snippet_path, encoding="utf-8").read().rstrip("\n") + "\n"
    text = strip_markers(original)
    text, removed = remove_bitripay_blocks(text)
    text = text.rstrip("\n") + "\n\n" + BEGIN + "\n" + snippet + END + "\n"
    open(path, "w", encoding="utf-8").write(text)
    for r in removed:
        print(f"removed previous block: {r}")
    print("appended BitriPay blocks: bitripay.com (redirect), www.bitripay.com, admin.bitripay.com, api.bitripay.com")


if __name__ == "__main__":
    main()
