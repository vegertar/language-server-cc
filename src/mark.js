export class Mark {
  /**
   *
   * @param {string | Mark | Mark[]} content
   */
  constructor(content) {
    this.content = content;
  }

  toText() {
    if (typeof this.content == "string") return this.content;
    if (Array.isArray(this.content))
      return this.content.map((x) => x.toText()).join("");
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
    return `_${this.content}_`;
  }
}

export class Strong extends Emphasis {
  toText() {
    return `__${this.content}__`;
  }
}

export const space = new Mark(" ");

export const colon = new Mark(":");

export const lineEnding = new Mark("\n");

export const thematicBreak = new Mark("---");
