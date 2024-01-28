// @ts-check

import minimist from "minimist";
import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node.js";
import Query from "./query.js";

const argv = minimist(process.argv.slice(2));
const dbAlias = JSON.parse(argv.db?.alias || "{}");
const query = new Query(dbAlias);

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

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

const handlerChains = [
  // async function refHandler(res, db) {
  //   if (res?.kind === "DeclRefExpr") {
  //     res = await query.byId(db, res.ref);
  //   }
  //   return res;
  // },
  // function rangeHandler(res) {
  //   if (res?.$pos) {
  //     const file = res.$file;
  //     const line = res.$pos.line + 1;
  //     const col = res.$pos.character + 1;

  //     if (
  //       res.file === file &&
  //       res.line === line &&
  //       res.col <= col &&
  //       col <= res.col + res.name.length
  //     ) {
  //       res.$start = { line: line - 1, character: col - 1 };
  //       res.$end = { line: line - 1, character: col - 1 + res.name.length };
  //     } else {
  //       res.$start = { line: res.begin_line - 1, character: res.begin_col - 1 };
  //       res.$end = {
  //         line: res.begin_line - 1,
  //         character: res.begin_col - 1 + res.name.length,
  //       };
  //     }
  //   }
  //   return res;
  // },
  function locHandler(res, { db, file, position }) {
    return res || query.byLocation(db, file, position);
  },
  function rangeHandler(res, { db, file, position }) {
    return res || query.byRange(db, file, position);
  },
  function typeHandler(res, { db }) {
    if (Array.isArray(res) && res.at(-1)?.type) {
      res = query.byType(db, res.at(-1).type);
    }
    return res;
  },
  function nameHandler(res) {
    if (res?.kind?.endsWith("Decl")) {
      /** @type {string[]} */
      const marks = markSpecs(res.specs);
      
      if (res.kind === "TypedefDecl") {
        marks.push(`_typedef_`);
      }
      marks.push(`__${res.name}__:`, `_${res.type}_`);

      return /** @type {import("vscode-languageserver/node.js").Hover } */ ({
        contents: {
          kind: "markdown",
          value: marks.join(" "),
        },
      });
    }
    return res;
  },
];

connection.onHover(async ({ textDocument: { uri }, position }) => {
  const pathname = new URL(uri).pathname;
  const db = query.getDB(pathname);
  const file = await query.fileNumber(db, pathname);
  const opts = { db, file, position };

  let res = null;
  for (const handler of handlerChains) {
    res = await handler(res, opts);
  }
  return res?.contents ? res : null;
});

// Listen on the connection
connection.listen();
