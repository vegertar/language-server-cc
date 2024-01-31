// @ts-check

import sqlite3 from "sqlite3";
import TSI from "./symbol.js";

/**
 * @typedef {undefined | {
 *   symbol: number,
 *   begin_row: number,
 *   begin_col: number,
 *   end_row: number,
 *   end_col: number,
 * }} Token
 */

/**
 * @typedef {undefined | {
 *   kind: string,
 *   name: string,
 *   qualified_type: string,
 *   desugared_type: string,
 *   specs: number,
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
   */
  constructor(dbAlias) {
    this.dbAlias = dbAlias;
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

    return new sqlite3.Database(pathnameWithoutExt(pathname) + ".ast.db");
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
            reject(new Error(`Not found file: ${file}`));
          } else {
            resolve(row.number);
          }
        }
      );
    });
  }

  /**
   *
   * @param {import("sqlite3").Database} db
   * @param {number} src
   * @param {import("vscode-languageserver/node").Position} pos
   */
  // byLocation(db, src, pos) {
  //   return new Promise((resolve, reject) => {
  //     db.get(
  //       "SELECT * FROM ast WHERE src = $src AND row = $row AND col <= $col AND col + length(name) >= $col",
  //       {
  //         $src: src,
  //         $row: pos.line + 1,
  //         $col: pos.character + 1,
  //       },
  //       (err, row) => {
  //         if (err) {
  //           reject(err);
  //         } else {
  //           resolve(row);
  //         }
  //       }
  //     );
  //   });
  // }

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
        "SELECT * FROM cst WHERE src = $src AND ((begin_row = $row AND begin_col <= $col) OR (begin_row < $row)) AND ((end_row = $row AND end_col > $col) OR (end_row > $row))",
        { $src: src, $row: pos.line + 1, $col: pos.character + 1 },
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
   * @param {string} ptr
   * @returns
   */
  // byPtr(db, ptr) {
  //   return new Promise((resolve, reject) => {
  //     db.get(
  //       "SELECT * FROM ast WHERE ptr = $ptr",
  //       {
  //         $ptr: ptr,
  //       },
  //       (err, row) => {
  //         if (err) {
  //           reject(err);
  //         } else {
  //           resolve(row);
  //         }
  //       }
  //     );
  //   });
  // }

  /**
   *
   * @param {import("sqlite3").Database} db
   * @param {number} src
   * @param {number} row
   * @param {number} col
   * @param {string} token
   * @param {boolean} [isType]
   */
  node(db, src, row, col, token, isType) {
    const sql = isType
      ? "SELECT * FROM ast WHERE begin_src = $src AND begin_row = $row AND begin_col = $col AND qualified_type = $token"
      : "SELECT * FROM ast WHERE ((src = -1 AND begin_src = $src AND begin_row = $row AND begin_col = $col) OR (src = $src AND row = $row AND col = $col)) AND name = $token";

    return new Promise((resolve, reject) => {
      db.get(
        sql,
        { $src: src, $row: row, $col: col, $token: token },
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
   * @param {string} type
   */
  // byType(db, type) {
  //   let i = type.length;
  //   while (i > 0 && isPunctuation(type.charCodeAt(i - 1))) {
  //     --i;
  //   }
  //   return new Promise((resolve, reject) => {
  //     db.get(
  //       "SELECT * FROM ast WHERE name = $type",
  //       {
  //         $type: type.substring(0, i),
  //       },
  //       (err, rows) => {
  //         if (err) {
  //           reject(err);
  //         } else {
  //           resolve(rows);
  //         }
  //       }
  //     );
  //   });
  // }
}

/**
 *
 * @param {string} string
 */
function pathnameWithoutExt(string) {
  const dot = string.lastIndexOf(".");
  return dot !== -1 ? string.substring(0, dot) : string;
}

/**
 *
 * @param {number} code
 */
function isPunctuation(code) {
  return code === 32 /* ' ' */ || code === 42 /* '*' */;
}
