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
 * @typedef {undefined | {
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
 *   ref_ptr: string | null | undefined,
 * }} Node
 */

export default class Query {
  /**
   * @type {Map<string, import("sqlite3").Database> }
   */
  dbCaches = new Map();

  /**
   *
   * @param {Record<string, string>} dbAlias
   * @param {string} dbExtension
   */
  constructor(dbAlias, dbExtension) {
    this.dbAlias = dbAlias;
    this.dbExtension = dbExtension;
  }

  /**
   * @private
   * @param {string} pathname
   */
  openDB(pathname) {
    for (const key in this.dbAlias) {
      if (pathname.search(key) !== -1) {
        pathname = pathname.replace(key, this.dbAlias[key]);
        break;
      }
    }

    return new sqlite3.Database(
      pathnameWithoutExt(pathname) + "." + this.dbExtension
    );
  }

  /**
   *
   * @param {string} pathname
   */
  db(pathname) {
    let db = this.dbCaches.get(pathname);
    if (!db) {
      db = this.openDB(pathname);
      this.dbCaches.set(pathname, db);
    }
    return db;
  }

  /**
   *
   * @param {import("sqlite3").Database} db
   * @param {string} file
   * @returns {Promise<number>}
   */
  src(db, file) {
    return new Promise((resolve, reject) => {
      db.get(
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
   * Get the correct token location if the given position is within a macro expansion.
   * @param {import("sqlite3").Database} db
   * @param {number} src
   * @param {import("vscode-languageserver/node").Position} pos
   * @returns {Promise<import("vscode-languageserver/node").Position | null>}
   */
  async loc(db, src, pos) {
    /**
     * @type {Range | undefined}
     */
    const range = await new Promise((resolve, reject) => {
      db.get(
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
   * @param {import("sqlite3").Database} db
   * @param {number} src
   * @param {import("vscode-languageserver/node").Position} pos
   * @returns {Promise<Token>}
   */
  token(db, src, pos) {
    return new Promise((resolve, reject) => {
      db.get(
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
   * @param {import("sqlite3").Database} db
   * @param {number} src
   * @returns {Promise<Range[]>}
   */
  expansions(db, src) {
    return new Promise((resolve, reject) => {
      db.all(
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
   * @param {import("sqlite3").Database} db
   * @param {number | string} numberOrPtr
   * @returns {Promise<Node>}
   */
  node(db, numberOrPtr) {
    return new Promise((resolve, reject) => {
      db.get(
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
   * @param {import("sqlite3").Database} db
   * @param {number} number
   * @returns {Promise<NonNullable<Node>[]>}
   */
  children(db, number) {
    return new Promise((resolve, reject) => {
      db.all(
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
   * @param {import("sqlite3").Database} db
   * @param {number} first
   * @param {number} last
   * @returns {Promise<NonNullable<Node>[]>}
   */
  range(db, first, last) {
    return new Promise((resolve, reject) => {
      db.all(
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
}

/**
 *
 * @param {string} string
 */
function pathnameWithoutExt(string) {
  const dot = string.lastIndexOf(".");
  return dot !== -1 ? string.substring(0, dot) : string;
}
