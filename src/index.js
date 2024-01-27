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
  async function refHandler(res) {
    if (res?.kind === "DeclRefExpr") {
      res = await query.byId(res.$db, res.ref);
    }
    return res;
  },
  function declHandler(res) {
    if (res?.kind?.endsWith("Decl")) {
      /** @type {string[]} */
      const marks = markSpecs(res.specs);
      marks.push(`__${res.name}__:`, `_${res.type}_`);

      return /** @type {import("vscode-languageserver/node.js").Hover } */ ({
        contents: {
          kind: "markdown",
          value: marks.join(" "),
        },
        range: {
          start: { line: res.line - 1, character: res.col - 1 },
          end: {
            line: res.line - 1,
            character: res.col - 1 + res.name.length,
          },
        },
      });
    }
    return null;
  },
];

connection.onHover(async ({ textDocument: { uri }, position }) => {
  let res = await query.byPosition(uri, position);
  for (const handler of handlerChains) {
    res = await handler(res);
  }
  return res;
});

// Listen on the connection
connection.listen();
