export class Mark {
  /**
   *
   * @param {string | Mark | (string | Mark)[]} content
   */
  constructor(content) {
    this.content = content;
    this.list = false;
  }

  /**
   *
   * @param  {string | Mark | (string | Mark)[]} mark
   */
  appendList(mark) {
    if (!this.list) {
      this.content = [new BulletListItem(this.content)];
      this.list = true;
    }

    this.content.push(
      newLine,
      mark instanceof BulletListItem ? mark : new BulletListItem(mark)
    );

    return this;
  }

  /**
   *
   * @param {string | Mark | (string | Mark)[]} s
   * @returns {string}
   */
  static toText(s) {
    if (typeof s === "string") return s;
    if (Array.isArray(s)) return s.map((x) => Mark.toText(x)).join("");
    return s.toText();
  }

  /**
   *
   * @returns {string}
   */
  toText() {
    if (typeof this.content === "string") return this.content;
    if (Array.isArray(this.content))
      return this.content.map((x) => Mark.toText(x)).join("");
    return this.content.toText();
  }
}

export class Inline extends Mark {}

export class Code extends Inline {
  toText() {
    return `\`${this.content}\``;
  }
}

export class Emphasis extends Inline {
  toText() {
    return `*${this.content.replace(/[_*]/g, "\\$&")}*`;
  }
}

export class Strong extends Emphasis {
  toText() {
    return `**${this.content.replace(/[_*]/g, "\\$&")}**`;
  }
}

export class Indent extends Mark {
  /**
   *
   * @param {number} n
   */
  constructor(n) {
    super("".padEnd(n));
  }
}

export class CodeInline extends Inline {
  toText() {
    return `\`${this.content}\``;
  }
}

export class CodeBlock extends Mark {
  /**
   *
   * @param {string | Mark | (string | Mark)[]} content
   * @param {number} [indent]
   * @param {string} [lang]
   */
  constructor(content, indent = 0, lang = "") {
    super([
      // Head
      new Indent(indent),
      "```",
      lang,
      lineEnding,

      // Body
      new Indent(indent),
      content,
      lineEnding,

      // Tail
      new Indent(indent),
      "```",
      newLine,
    ]);
  }
}

export class BulletListItem extends Mark {
  /**
   *
   * @param {string | Mark | (string | Mark)[]} content
   */
  constructor(content) {
    super(BulletListItem.escape(content));
  }

  /**
   *
   * @param {string | Mark | (string | Mark)[]} content
   */
  static escape(content) {
    const s = Mark.toText(content);
    return [
      "- ",
      BulletListItem.isMarker(s.charAt(0)) &&
      BulletListItem.isWhite(s.charAt(1))
        ? "\\"
        : "",
      s,
    ];
  }

  /**
   *
   * @param {string} s
   */
  static isMarker(s) {
    return s === "-" || s === "+" || s === "*";
  }

  /**
   *
   * @param {string} s
   */
  static isWhite(s) {
    return s === " " || s === "\t" || s === "\n";
  }
}

export class Provider extends Mark {
  constructor(provider) {
    super([
      newLine,
      thematicBreak,
      newLine,
      new CodeInline(provider),
      space,
      new Emphasis("provided"),
    ]);

    this.provider = provider;
  }
}

export const space = new Mark(" ");

export const colon = new Mark(":");

export const lineEnding = new Mark("\n");

export const newLine = new Mark("\n\n");

export const thematicBreak = new Mark("---");
