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

connection.onCodeLens(async ({ textDocument }) => {
  const { doc, db, src } = await getUriInfo(textDocument.uri);
  const ranges = await query.expansions(db, src);
  return ranges.map((x) => {
    const range = {
      start: { line: x.begin_row - 1, character: x.begin_col - 1 },
      end: { line: x.end_row - 1, character: x.end_col - 1 },
    };
    const text = doc.getText(range);

    return {
      range,
      command: {
        title: getIdentifier(text),
        command: "languageServerCC.showExpansions",
        arguments: [textDocument, range],
      },
    };
  });
});

const specMarks = {
  1: new mark.Emphasis("extern"),
  2: new mark.Emphasis("static"),
  4: new mark.Emphasis("inline"),
  8: new mark.Emphasis("const"),
  16: new mark.Emphasis("volatile"),
};

const specs = {
  hasLeadingSpace: 32,
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
    await file.close();
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
 *   loc: import("vscode-languageserver/node.js").Position | null,
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
async function hoverHandler({ textDocument: { uri }, position }) {
  const info = await getUriInfo(uri);
  const pos = getTokenHead(info.doc, position);
  const loc = await query.loc(info.db, info.src, pos);
  const token = await query.token(info.db, info.src, loc || pos);
  return { ...info, pos, loc, token };
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
  const { db, token, node } = value;
  console.debug(token, node);

  if (node) {
    const marks = markSpecs(node.specs);

    switch (node.kind) {
      case "TypedefDecl":
        marks.push(new mark.Emphasis("typedef"), mark.space);
        break;
      case "FieldDecl":
        marks.push(new mark.Emphasis("field"), mark.space);
        break;
      case "RecordDecl":
        switch (node.class) {
          case 1:
            marks.push(new mark.Emphasis("struct"), mark.space);
            break;
        }
        break;
      case "MacroDecl":
        marks.push(
          new mark.Emphasis("#define"),
          mark.space,
          new mark.Strong(
            (await query.node(db, node.parent_number))?.name || "Never"
          )
        );
        node.sqname && marks.push(new mark.Strong(node.sqname));
        break;
      case "ExpansionDecl":
        if (node.ref_ptr) {
          const v = await nodeHandler({
            ...value,
            node: await query.node(db, node.ref_ptr),
          });
          if (v.mark) {
            marks.push(v.mark, mark.newLine);
            const nodes = await query.range(db, node.number, node.final_number);
            /** @type {Map<number, number>} */
            const indents = new Map();
            indents.set(nodes[0].number, 0);
            for (let i = 1, n = nodes.length; i < n; ++i) {
              const parentIndent = indents.get(nodes[i].parent_number);
              indents.set(
                nodes[i].number,
                parentIndent == undefined ? 0 : parentIndent + 2
              );
            }

            for (let i = 0, n = nodes.length; i < n; ) {
              marks.push(
                new mark.Indent(indents.get(nodes[i].number) || 0),
                new mark.BulletListItem(nodes[i].name || "Never"),
                mark.newLine
              );

              while (++i < n && nodes[i].kind === "Token") {
                const indent = indents.get(nodes[i].number) || 0;
                const codes = [nodes[i].name || "Never"];
                while (
                  ++i < n &&
                  nodes[i].kind === "Token" &&
                  indents.get(nodes[i].number) == indent
                ) {
                  const node = nodes[i];
                  if (node.specs & specs.hasLeadingSpace) codes.push(" ");
                  codes.push(node.name || "Never");
                }

                marks.push(new mark.CodeBlock(codes, indent, "c"));
                --i;
              }
            }
          }
        }
        break;
    }

    if (node.kind !== "ExpansionDecl") {
      node.name && marks.push(new mark.Strong(node.name));

      if (node.class) {
        const children = await query.children(db, node.number);
        if (children.length) marks.push(mark.newLine, mark.thematicBreak);
        for (const node of children) {
          const v = await nodeHandler({ ...value, node });
          if (v.mark) marks.push(mark.lineEnding, mark.lineEnding, v.mark);
        }
      } else {
        const { qualified_type, desugared_type } = node;
        if (qualified_type)
          marks.push(mark.colon, mark.space, new mark.Emphasis(qualified_type));
        if (desugared_type && desugared_type !== qualified_type)
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
