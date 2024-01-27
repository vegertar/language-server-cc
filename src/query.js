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
  async byLocation(db, file, { line, character }) {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM ast WHERE (file = $file AND line = $line AND col <= $col AND col + length(name) > $col) OR (begin_file = $file AND begin_line = $line AND begin_col <= $col AND begin_col + length(name) > $col)",
        {
          $file: file,
          $line: line + 1,
          $col: character + 1,
        },
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            if (row) {
              row.$db = db;
              row.$file = file;
            }
            resolve(row);
          }
        }
      );
    });
  }

  /**
   *
   * @param {import("vscode-languageserver/node").URI} uri
   * @param {import("vscode-languageserver/node").Position} pos
   */
  async byPosition(uri, pos) {
    const pathname = new URL(uri).pathname;
    const db = this.getDB(pathname);
    const file = await this.fileNumber(db, pathname);
    return await this.byLocation(db, file, pos);
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
