// @ts-check

import { open } from "node:fs/promises";
import minimist from "minimist";
import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Query from "./query.js";
import TSI from "./symbol.js";

const argv = minimist(process.argv.slice(2));
const dbAlias = JSON.parse(argv.db?.alias || "{}");
const query = new Query(dbAlias);

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

/**
 * Create a simple text document manager.
 * @type {Map<import("vscode-languageserver/node.js").URI, import("vscode-languageserver-textdocument").TextDocument>}
 **/
const documents = new Map();

connection.onInitialize((params) => {
  return {
    capabilities: {
      hoverProvider: true,
    },
  };
});

connection.onInitialized(() => {});

const specMarks = {
  _extern_: 1,
  _static_: 2,
  _inline_: 4,
  _const_: 8,
  _volatile_: 16,
};

function markSpecs(specs) {
  /** @type {string[]} */
  const marks = [];
  for (const mark in specMarks) {
    const spec = specMarks[mark];
    if (specs & spec) {
      marks.push(mark);
    }
  }
  return marks;
}

async function getDocument(uri, pathname) {
  let document = documents.get(uri);
  if (!document) {
    const file = await open(pathname);
    const content = await file.readFile({ encoding: "utf8" });
    document = TextDocument.create(uri, "", 0, content);
    documents.set(uri, document);
  }
  return document;
}

/**
 * @typedef {{
 *   doc: import("vscode-languageserver-textdocument").TextDocument,
 *   db: import("sqlite3").Database,
 *   src: number,
 *   pos: import("vscode-languageserver/node.js").Position,
 *   token: import("./query.js").Token,
 *   type?: import("./query.js").Node,
 *   name?: import("./query.js").Node,
 *   res?: any,
 * }} Value
 */

/**
 *
 * @param {import("vscode-languageserver/node.js").HoverParams} param0
 * @returns {Promise<Value>}
 */
async function hoverHandler({ textDocument: { uri }, position: pos }) {
  const pathname = new URL(uri).pathname;
  const doc = await getDocument(uri, pathname);
  const db = query.db(pathname);
  const src = await query.src(db, pathname);
  const token = await query.token(db, src, pos);
  return { doc, db, src, pos, token };
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function tokenHandler(value) {
  if (value.token) {
    const {
      db,
      src,
      token: { symbol, begin_row, begin_col, end_row, end_col },
    } = value;

    let isType = false;
    switch (TSI[symbol]) {
      case "alias_sym_type_identifier":
        isType = true;
      // falls through
      case "sym_identifier": {
        const token = value.doc.getText({
          start: { line: begin_row - 1, character: begin_col - 1 },
          end: { line: end_row - 1, character: end_col - 1 },
        });

        let node = await query.node(
          db,
          src,
          begin_row,
          begin_col,
          token,
          isType
        );

        // The struct typedef is stored as the name other than the type.
        if (!node && isType) {
          node = await query.node(db, src, begin_row, begin_col, token);
        }

        if (isType) {
          value.type = node;
        } else {
          value.name = node;
        }
        break;
      }
    }
  }

  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function typeHandler(value) {
  if (value.type) {
    console.debug(value.type);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function nameHandler(value) {
  if (value.name) {
    const { kind, name, qualified_type, desugared_type, specs } = value.name;
    /** @type {string[]} */
    const marks = markSpecs(specs);
    if (kind === "TypedefDecl") {
      marks.push(`_typedef_`);
    }
    marks.push(`__${name}__:`, `_${qualified_type}_`);
    if (desugared_type && desugared_type !== qualified_type) {
      marks.push(`\`${desugared_type}\``);
    }
    value.res = /** @type {import("vscode-languageserver/node.js").Hover } */ ({
      contents: {
        kind: "markdown",
        value: marks.join(" "),
      },
    });
  }
  return value;
}

connection.onHover(async (param) => {
  let value = /** @type {any} */ (param);
  for (const handler of [hoverHandler, tokenHandler, typeHandler, nameHandler]) {
    value = await handler(value);
  }
  const res = value.res;
  return res?.contents ? res : null;
});

// Listen on the connection
connection.listen();
