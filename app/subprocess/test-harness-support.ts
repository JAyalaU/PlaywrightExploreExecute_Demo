/** Pure helpers for deterministic, test-only subprocess decisions. */

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function roleLine(line: string, role: string): boolean {
  return new RegExp(`^\\s*-\\s*${role}(?=\\s|:|$)`, 'i').test(line);
}

function rowBlocks(lines: readonly string[]): string[][] {
  const starts = lines.flatMap((line, index) => roleLine(line, 'row') ? [index] : []);
  return starts.map((start, position) => {
    const baseIndent = indentation(lines[start]!);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (roleLine(lines[index]!, 'row') && indentation(lines[index]!) <= baseIndent) {
        end = index;
        break;
      }
    }
    // Restrict each block to its immediate tree interval. A nested row (if
    // present) is not allowed to lend its content or controls to its parent.
    const nextStart = starts[position + 1];
    if (nextStart !== undefined && nextStart < end && indentation(lines[nextStart]!) > baseIndent) {
      end = nextStart;
    }
    return lines.slice(start, end);
  });
}

/**
 * Select an MCP ref only when the current bounded snapshot exposes one exact
 * `edit` link inside the unique row containing the exact `Iuvaret1` token.
 * It intentionally fails closed for missing, malformed, or duplicate rows.
 */
export function editRefInIuvaretRow(snapshot: string): string | undefined {
  const lines = snapshot.split(/\r?\n/);
  const rowToken = /(?<![A-Za-z0-9])Iuvaret1(?![A-Za-z0-9])/;
  const matchingRows = rowBlocks(lines).filter((block) => block.some((line) => rowToken.test(line)));
  if (matchingRows.length !== 1) return undefined;

  const refs = matchingRows[0]!
    .filter((line) => roleLine(line, 'link') && /^\s*-\s*link\s+"edit"(?=\s|\[|:|$)/i.test(line))
    .map((line) => /\[ref=(e[A-Za-z0-9_-]*)\]/i.exec(line)?.[1])
    .filter((ref): ref is string => ref !== undefined);
  return refs.length === 1 ? refs[0] : undefined;
}
