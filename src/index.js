// @ts-check

import { open } from "node:fs/promises";
import minimist from "minimist";
import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Query from "./query.js";

const argv = minimist(process.argv.slice(2));
const dbAlias = JSON.parse(argv.db?.alias || "{}");
const dbExtension = argv.db?.extension || "o";
const query = new Query(dbAlias, dbExtension);

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

/**
 * Create a simple text document manager.
 * @type {Map<import("vscode-languageserver/node.js").URI, import("vscode-languageserver-textdocument").TextDocument>}
 **/
const documents = new Map();

connection.onInitialize(() => {
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
      marks.push(mark, " ");
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
 *   node?: import("./query.js").Node,
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
    value.node = await query.node(value.db, value.token.decl);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function nodeHandler(value) {
  console.debug(value.token, value.node);
  if (value.node) {
    const { number, kind, name, qualified_type, desugared_type, specs } =
      value.node;
    /** @type {string[]} */
    const marks = markSpecs(specs);
    switch (kind) {
      case "TypedefDecl":
        marks.push(`_typedef_ `);
        break;
      case "FieldDecl":
        marks.push(`_field_ `);
        break;
      case "RecordDecl":
        switch (value.node.class) {
          case 1:
            marks.push(`_struct_ `);
            break;
        }
        break;
    }
    marks.push(`__${name}__`);
    if (value.node.class) {
      const children = await query.children(value.db, number);
      if (children.length) marks.push("\n\n---");
      for (const node of children) {
        const { res } = await nodeHandler({ ...value, node });
        marks.push("\n\n", res.contents.value);
      }
    } else {
      marks.push(`: _${qualified_type}_`);
      if (desugared_type && desugared_type !== qualified_type) {
        marks.push(` \`${desugared_type}\``);
      }
    }
    value.res = /** @type {import("vscode-languageserver/node.js").Hover } */ ({
      contents: {
        kind: "markdown",
        value: marks.join(""),
      },
    });
  }
  return value;
}

connection.onHover(async (param) => {
  let value = /** @type {any} */ (param);
  for (const handler of [hoverHandler, tokenHandler, nodeHandler]) {
    value = await handler(value);
  }
  const res = value.res;
  return res?.contents ? res : null;
});

// Listen on the connection
connection.listen();
