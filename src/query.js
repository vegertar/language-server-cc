// @ts-check

import sqlite3 from "sqlite3";

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
   *
   * @param {string} pathname
   */
  db(pathname) {
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
  getDB(pathname) {
    let db = this.dbCaches.get(pathname);
    if (!db) {
      db = this.db(pathname);
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
  fileNumber(db, file) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT number FROM source WHERE filename = $file",
        {
          $file: file,
        },
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
   * @param {number} file
   * @param {import("vscode-languageserver/node").Position} pos
   */
  byLocation(db, file, pos) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM ast WHERE file = $file AND line = $line AND col <= $col AND col + length(name) >= $col",
        {
          $file: file,
          $line: pos.line + 1,
          $col: pos.character + 1,
        },
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
   * @param {number} file
   * @param {import("vscode-languageserver/node").Position} pos
   */
  byRange(db, file, pos) {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM ast WHERE begin_file = $file AND begin_line = $line AND begin_col <= $col AND end_file = $file AND end_line = $line AND end_col >= $col",
        {
          $file: file,
          $line: pos.line + 1,
          $col: pos.character + 1,
        },
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
   * @param {string} id
   * @returns
   */
  byId(db, id) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM ast WHERE id = $id",
        {
          $id: id,
        },
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
   * @param {string} type
   */
  byType(db, type) {
    let i = type.length;
    while (i > 0 && isPunctuation(type.charCodeAt(i - 1))) {
      --i;
    }
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM ast WHERE name = $type",
        {
          $type: type.substring(0, i),
        },
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

  byFunctionDecl(pathname, decl) {
    return new Promise((resolve, reject) => {
      const db = this.getDB(pathname);
      db.all(
        "SELECT * FROM ast WHERE id IN (SELECT id FROM hierarchy WHERE parent = $parent)",
        {
          $parent: decl.id,
        },
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

/**
 *
 * @param {number} code
 */
function isPunctuation(code) {
  return code === 32 /* ' ' */ || code === 42 /* '*' */;
}
