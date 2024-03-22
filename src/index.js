// @ts-check

import { open } from "node:fs/promises";
import minimist from "minimist";
import {
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Query from "./query.js";
import * as mark from "./mark.js";

const argv = minimist(process.argv.slice(2));
const dbAlias = JSON.parse(argv.db?.alias || "{}");
const dbExtension = argv.db?.extension || "db";
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
      codeLensProvider: {
        resolveProvider: true,
      },
    },
  };
});

connection.onInitialized(() => {});

/**
 *
 * @param {string} uri
 */
async function getUriInfo(uri) {
  const pathname = new URL(uri).pathname;
  const doc = await getDocument(uri, pathname);
  const db = query.db(pathname);
  const src = await query.src(db, pathname);
  return { doc, db, src };
}

/**
 *
 * @param {string} text
 * @returns
 */
function getIdentifier(text) {
  let i = 0;
  while (i < text.length && isPartOfIdentifier(text.charCodeAt(i))) {
    ++i;
  }
  return text.substring(0, i);
}

connection.onCodeLens(async ({ textDocument: { uri } }) => {
  const { doc, db, src } = await getUriInfo(uri);
  const ranges = await query.expansions(db, src);
  return ranges.map((x) => {
    const range = {
      start: { line: x.begin_row - 1, character: x.begin_col - 1 },
      end: { line: x.end_row - 1, character: x.end_col - 1 },
    };

    const text = doc.getText(range);
    return { range, data: getIdentifier(text) };
  });
});

connection.onCodeLensResolve(async (codeLens) => {
  return {
    range: codeLens.range,
    command: {
      title: codeLens.data,
      command: "expands-macros",
    },
  };
});

const specMarks = {
  1: new mark.Emphasis("extern"),
  2: new mark.Emphasis("static"),
  4: new mark.Emphasis("inline"),
  8: new mark.Emphasis("const"),
  16: new mark.Emphasis("volatile"),
};

/**
 *
 * @param {number} specs
 * @returns
 */
function markSpecs(specs) {
  /** @type {mark.Mark[]} */
  const marks = [];
  for (const spec in specMarks) {
    // const spec = specMarks[mark];
    if (specs & parseInt(spec)) {
      marks.push(specMarks[spec], mark.space);
    }
  }
  return marks;
}

/**
 *
 * @param {string} uri
 * @param {string} pathname
 * @returns
 */
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
 *
 * @param {number} ch
 */
function isPartOfIdentifier(ch) {
  return (
    (48 <= ch && ch <= 57) /* [0-9] */ ||
    (65 <= ch && ch <= 90) /* [A-Z] */ ||
    ch == 95 /* _ */ ||
    (97 <= ch && ch <= 122) /* [a-z] */
  );
}

/**
 *
 * @param {TextDocument} doc
 * @param {import("vscode-languageserver-textdocument").Position} start
 * @returns {import("vscode-languageserver-textdocument").Position}
 */
function getTokenHead(doc, start) {
  let offset = doc.offsetAt(start);
  let end = doc.positionAt(offset + 1);

  if (!isPartOfIdentifier(doc.getText({ start, end }).charCodeAt(0)))
    return start;

  do {
    end = start;
    start = doc.positionAt(--offset);
    if (!isPartOfIdentifier(doc.getText({ start, end }).charCodeAt(0))) break;
  } while (offset >= 0);

  return end;
}

/**
 * @typedef {{
 *   doc: import("vscode-languageserver-textdocument").TextDocument,
 *   db: import("sqlite3").Database,
 *   src: number,
 *   pos: import("vscode-languageserver/node.js").Position,
 *   token: import("./query.js").Token,
 *   node?: import("./query.js").Node,
 *   mark?: mark.Mark,
 * }} Value
 */

/**
 *
 * @param {import("vscode-languageserver/node.js").HoverParams} param0
 * @returns {Promise<Value>}
 */
async function hoverHandler({ textDocument: { uri }, position: pos }) {
  const info = await getUriInfo(uri);
  pos = getTokenHead(info.doc, pos);
  const token = await query.token(info.db, info.src, pos);
  return { ...info, pos, token };
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
    const marks = markSpecs(value.node.specs);
    switch (value.node.kind) {
      case "TypedefDecl":
        marks.push(new mark.Emphasis("typedef"), mark.space);
        break;
      case "FieldDecl":
        marks.push(new mark.Emphasis("field"), mark.space);
        break;
      case "RecordDecl":
        switch (value.node.class) {
          case 1:
            marks.push(new mark.Emphasis("struct"), mark.space);
            break;
        }
        break;
    }
    marks.push(new mark.Strong(value.node.name));
    if (value.node.class) {
      const children = await query.children(value.db, value.node.number);
      if (children.length)
        marks.push(mark.lineEnding, mark.lineEnding, mark.thematicBreak);
      for (const node of children) {
        const v = await nodeHandler({ ...value, node });
        if (v.mark) marks.push(mark.lineEnding, mark.lineEnding, v.mark);
      }
    } else {
      const { qualified_type, desugared_type } = value.node;
      marks.push(mark.colon, mark.space, new mark.Emphasis(qualified_type));
      if (desugared_type && desugared_type !== qualified_type) {
        marks.push(mark.space, new mark.Code(desugared_type));
      }
    }
    value.mark = new mark.Mark(marks);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {import("vscode-languageserver/node.js").Hover | null}
 */
function markHandler(value) {
  if (value.mark) {
    return {
      contents: {
        kind: "markdown",
        value: value.mark.toText(),
      },
    };
  }
  return null;
}

connection.onHover(async (param) => {
  let value = /** @type {any} */ (param);
  for (const handler of [
    hoverHandler,
    tokenHandler,
    nodeHandler,
    markHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

// Listen on the connection
connection.listen();
