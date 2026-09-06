import { marked, type Token, type Tokens } from "marked";
import pc from "picocolors";

type Colors = ReturnType<typeof pc.createColors>;

const ansiPattern = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const oscPattern = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const controlPattern = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function safeText(value: string): string {
  return value.replace(oscPattern, "").replace(ansiPattern, "").replace(controlPattern, "");
}

function visibleWidth(value: string): number {
  const clean = value.replace(ansiPattern, "");
  let width = 0;
  for (const character of clean) {
    const codePoint = character.codePointAt(0) ?? 0;
    width += /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(character)
      ? 2
      : codePoint === 0 || codePoint < 32
        ? 0
        : 1;
  }
  return width;
}

function padCell(value: string, width: number, align: Tokens.TableCell["align"]): string {
  const padding = Math.max(0, width - visibleWidth(value));
  if (align === "right") return `${" ".repeat(padding)}${value}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(padding - left)}`;
  }
  return `${value}${" ".repeat(padding)}`;
}

function renderInline(tokens: Token[] | undefined, colors: Colors): string {
  if (!tokens) return "";
  return tokens.map((token) => {
    switch (token.type) {
      case "strong":
        return colors.bold(renderInline(token.tokens, colors));
      case "em":
        return colors.italic(renderInline(token.tokens, colors));
      case "del":
        return colors.strikethrough(renderInline(token.tokens, colors));
      case "codespan":
        return colors.cyan(` ${safeText(token.text)} `);
      case "link": {
        const label = renderInline(token.tokens, colors);
        const href = safeText(token.href);
        return `${colors.underline(colors.blue(label))}${label === href ? "" : colors.dim(` (${href})`)}`;
      }
      case "image":
        return colors.dim(`[image: ${safeText(token.text)}] (${safeText(token.href)})`);
      case "br":
        return "\n";
      case "html":
        return safeText(token.text.replace(/<[^>]*>/g, ""));
      case "escape":
        return safeText(token.text);
      case "text":
        return token.tokens ? renderInline(token.tokens, colors) : safeText(token.text);
      default:
        return "tokens" in token && token.tokens
          ? renderInline(token.tokens, colors)
          : "text" in token && typeof token.text === "string"
            ? safeText(token.text)
            : "raw" in token && typeof token.raw === "string"
              ? safeText(token.raw)
              : "";
    }
  }).join("");
}

function renderCode(token: Tokens.Code, indent: string, colors: Colors): string {
  const language = token.lang ? ` ${safeText(token.lang)}` : "";
  const lines = safeText(token.text).split("\n");
  return [
    `${indent}${colors.dim(`╭─${language}`)}`,
    ...lines.map((line) => `${indent}${colors.dim("│")} ${colors.cyan(line)}`),
    `${indent}${colors.dim("╰─")}`
  ].join("\n");
}

function renderTable(token: Tokens.Table, indent: string, colors: Colors): string {
  const rows = [token.header, ...token.rows];
  const columns = Math.max(0, ...rows.map((row) => row.length));
  if (columns === 0) return "";
  const cells = rows.map((row, rowIndex) => Array.from({ length: columns }, (_, index) => {
    const cell = row[index];
    if (!cell) return "";
    const text = renderInline(cell.tokens, colors).replace(/\n/g, " ");
    return rowIndex === 0 ? colors.bold(text) : text;
  }));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(1, ...cells.map((row) => visibleWidth(row[index] ?? "")))
  );
  const border = (left: string, middle: string, right: string, fill: string): string =>
    `${indent}${left}${widths.map((width) => fill.repeat(width + 2)).join(middle)}${right}`;
  const renderedRows = cells.map((row) =>
    `${indent}│${widths.map((width, index) => ` ${padCell(row[index] ?? "", width, token.align[index] ?? null)} `).join("│")}│`
  );
  return [
    border("┌", "┬", "┐", "─"),
    renderedRows[0],
    border("├", "┼", "┤", "─"),
    ...renderedRows.slice(1),
    border("└", "┴", "┘", "─")
  ].join("\n");
}

function renderList(token: Tokens.List, indent: string, colors: Colors): string {
  const lines: string[] = [];
  let number = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items) {
    const marker = item.task
      ? `${item.checked ? "[x]" : "[ ]"} `
      : token.ordered
        ? `${number}. `
        : "• ";
    if (token.ordered) number += 1;

    const nested = item.tokens.filter((child): child is Tokens.List => child.type === "list");
    const content = item.tokens
      .filter((child) => child.type !== "list")
      .map((child) => {
        if (child.type === "paragraph") return renderInline(child.tokens, colors);
        if (child.type === "text") return renderInline(child.tokens ?? [child], colors);
        return renderBlocks([child], "", colors).trim();
      })
      .join(" ")
      .trim();
    const contentLines = (content || "").split("\n");
    lines.push(`${indent}${marker}${contentLines[0] ?? ""}`);
    for (const line of contentLines.slice(1)) lines.push(`${indent}  ${line}`);
    for (const child of nested) lines.push(...renderList(child, `${indent}  `, colors).split("\n"));
  }
  return lines.join("\n");
}

function renderBlocks(tokens: Token[], indent: string, colors: Colors): string {
  const output: string[] = [];
  for (const token of tokens) {
    let block = "";
    switch (token.type) {
      case "space":
      case "def":
        continue;
      case "heading": {
        const heading = renderInline(token.tokens, colors);
        block = token.depth === 1
          ? colors.bold(colors.cyan(heading))
          : token.depth === 2
            ? colors.bold(heading)
            : colors.underline(heading);
        break;
      }
      case "paragraph":
        block = renderInline(token.tokens, colors);
        break;
      case "text":
        block = renderInline(token.tokens ?? [token], colors);
        break;
      case "code":
        block = renderCode(token as Tokens.Code, indent, colors);
        break;
      case "blockquote": {
        const quote = renderBlocks((token as Tokens.Blockquote).tokens ?? [], "", colors).trimEnd();
        block = quote.split("\n").map((line) => `${indent}${colors.dim("│")} ${line}`).join("\n");
        break;
      }
      case "list":
        block = renderList(token as Tokens.List, indent, colors);
        break;
      case "table":
        block = renderTable(token as Tokens.Table, indent, colors);
        break;
      case "hr":
        block = colors.dim(`${indent}${"─".repeat(60)}`);
        break;
      case "html":
        block = safeText(token.text.replace(/<[^>]*>/g, "")).trim();
        break;
      default:
        block = "tokens" in token && token.tokens
          ? renderBlocks(token.tokens, indent, colors).trimEnd()
          : "text" in token && typeof token.text === "string"
            ? safeText(token.text)
            : "";
    }
    if (block) output.push(`${indent}${block.replace(new RegExp(`^${indent}`), "")}`);
  }
  return output.join("\n\n");
}

/** Render model Markdown as safe, readable terminal text. */
export function renderMarkdown(markdown: string, colors: Colors = pc): string {
  try {
    return renderBlocks(marked.lexer(markdown, { gfm: true }), "", colors).trimEnd();
  } catch {
    return safeText(markdown).trimEnd();
  }
}
