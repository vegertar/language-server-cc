// @ts-check

import sqlite3 from "sqlite3";

/**
 * @typedef {undefined | {
 *   decl: number,
 *   src: number,
 *   begin_row: number,
 *   begin_col: number,
 *   offset: number,
 * }} Token
 */

/**
 * @typedef {{
 *   begin_row: number,
 *   begin_col: number,
 *   end_row: number,
 *   end_col: number,
 * }} Range
 */

/**
 * @typedef {{
 *   number: number,
 *   parent_number: number,
 *   final_number: number,
 *   kind: string,
 *   name: string | null | undefined,
 *   sqname: string | null | undefined,
 *   qualified_type: string,
 *   desugared_type: string,
 *   specs: number,
 *   class: number,
 *   ptr: string,
 *   prev: string | null | undefined,
 *   ref_ptr: string | null | undefined,
 *   begin_src: number,
 *   begin_row: number,
 *   begin_col: number,
 *   end_src: number,
 *   end_row: number,
 *   end_col: number,
 *   src: number,
 *   row: number,
 *   col: number,
 * }} Node
 */

export default class Query {
  /** @type {string} */
  #tu;

  /** @type {Map<string, import("sqlite3").Database>} */
  #allDatabases = new Map();

  /** @type {import("sqlite3").Database} */
  db;

  /**
   * @param {string} path
   */
  set tu(path) {
    if (path !== this.#tu) {
      let db = this.#allDatabases.get(path);
      if (!db) {
        db = new sqlite3.Database(path);
        this.#allDatabases.set(path, db);
      }

      this.db = db;
      this.#tu = path;
    }
  }

  get tu() {
    return this.#tu;
  }

  /**
   *
   * @param {string} file
   * @returns {Promise<number>}
   */
  src(file) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT number FROM src WHERE filename = $file",
        { $file: file },
        (err, row) => {
          if (err) {
            reject(err);
          } else if (!row) {
            reject(new Error(`src: not found file: ${file}`));
          } else {
            resolve(row.number);
          }
        }
      );
    });
  }

  /**
   *
   * @param {number} src
   * @returns {Promise<string>}
   */
  async uri(src) {
    const filename = await new Promise((resolve, reject) => {
      this.db.get(
        "SELECT filename FROM src WHERE number = $src",
        { $src: src },
        (err, row) => {
          if (err) {
            reject(err);
          } else if (!row) {
            reject(new Error(`src: not found src: ${src}`));
          } else {
            resolve(row.filename);
          }
        }
      );
    });
    return "file://" + filename;
  }

  /**
   * Get the correct token location if the given position is within a macro expansion.
   * @param {number} src
   * @param {import("vscode-languageserver/node").Position} pos
   * @returns {Promise<import("vscode-languageserver/node").Position | null>}
   */
  async loc(src, pos) {
    /**
     * @type {Range | undefined}
     */
    const range = await new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM loc WHERE begin_src = $src AND end_src = $src AND ((begin_row = $row AND begin_col <= $col) OR (begin_row < $row)) AND ((end_row = $row AND end_col > $col) OR (end_row > $row))",
        { $src: src, $row: pos.line + 1, $col: pos.character + 1 },
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
    return range
      ? { line: range.begin_row - 1, character: range.begin_col - 1 }
      : null;
  }

  /**
   *
   * @param {number} src
   * @param {import("vscode-languageserver/node").Position} pos
   * @returns {Promise<Token>}
   */
  token(src, pos) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM tok WHERE src = $src AND begin_row = $row AND begin_col = $col",
        { $src: src, $row: pos.line + 1, $col: pos.character + 1 },
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  /**
   *
   * @param {number} src
   * @returns {Promise<Range[]>}
   */
  expansions(src) {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM loc WHERE begin_src = $src AND end_src = $src",
        { $src: src },
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  /**
   *
   * @param {number | string} numberOrPtr
   * @returns {Promise<Node | undefined>}
   */
  node(numberOrPtr) {
    return new Promise((resolve, reject) => {
      this.db.get(
        typeof numberOrPtr === "string"
          ? "SELECT * FROM ast WHERE ptr = $v"
          : "SELECT * FROM ast WHERE number = $v",
        { $v: numberOrPtr },
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  /**
   *
   * @param {string} ptr
   * @returns {Promise<Node | undefined>}
   */
  next(ptr) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT * FROM ast WHERE prev = $ptr",
        { $ptr: ptr },
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  /**
   * @param {string[]} ptrs
   * @returns {Promise<Node[]>}
   */
  refs(ptrs) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM ast WHERE kind = 'DeclRefExpr' AND ref_ptr IN (${Array(ptrs.length).fill("?")})`,
        ptrs,
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  /**
   *
   * @param {number} number
   * @returns {Promise<Node[]>}
   */
  children(number) {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM ast WHERE parent_number = $number",
        { $number: number },
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  /**
   *
   * @param {number} first
   * @param {number} last
   * @returns {Promise<Node[]>}
   */
  range(first, last) {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM ast WHERE number >= $first AND number <= $last",
        { $first: first, $last: last },
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  /**
   * @param {number} src
   * @returns {Promise<Node[]>}
   */
  symbols(src) {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM ast WHERE parent_number = 0 AND begin_src = $src",
        { $src: src },
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  /**
   * @param {number} src
   * @returns {Promise<Node[]>}
   */
  links(src) {
    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM ast WHERE kind = 'InclusionDirective' AND src = $src",
        { $src: src },
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }
}
