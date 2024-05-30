// @ts-check

import { open } from "node:fs/promises";
import {
  createConnection,
  ProposedFeatures,
  DidChangeConfigurationNotification,
  SymbolKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Query from "./query.js";
import * as mark from "./mark.js";

const query = new Query();

/**
 *
 * @param {string} uri
 */
async function getUriInfo(uri) {
  const { document: doc, pathname } = await getDocument(uri);
  const src = await query.src(pathname);
  return { doc, src };
}

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

const symbolKinds = Object.assign(
  SymbolKind,
  /** @type {const} */ ({
    Union: 100,
    TypeAlias: 101,
  })
);

/**
 *
 * @param {number} specs
 * @returns
 */
function markSpecs(specs) {
  /** @type {mark.Mark[]} */
  const marks = [];
  for (const spec in specMarks) {
    if (specs & parseInt(spec)) {
      marks.push(specMarks[spec], mark.space);
    }
  }
  return marks;
}

/**
 *
 * @param {string} uri
 * @returns
 */
async function getDocument(uri) {
  const pathname = new URL(uri).pathname;
  let document = documents.get(uri);
  if (!document) {
    const file = await open(pathname);
    const content = await file.readFile({ encoding: "utf8" });
    await file.close();
    document = TextDocument.create(uri, "", 0, content);
    documents.set(uri, document);
  }
  return { document, pathname };
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
 *   src: number,
 *   pos: import("vscode-languageserver/node.js").Position,
 *   loc: import("vscode-languageserver/node.js").Position | null,
 *   token: import("./query.js").Token,
 *   node?: import("./query.js").Node,
 *   link?: import("./query.js").Node[],
 *   mark?: mark.Mark,
 * }} Value
 */

/**
 *
 * @param {import("vscode-languageserver/node.js").TextDocumentPositionParams} param0
 * @returns {Promise<Value>}
 */
async function positionHandler({ textDocument: { uri }, position }) {
  const info = await getUriInfo(uri);
  const pos = getTokenHead(info.doc, position);
  const loc = await query.loc(info.src, pos);
  const token = await query.token(info.src, loc || pos);
  return { ...info, pos, loc, token };
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function tokenHandler(value) {
  if (value.token) {
    value.node = await query.node(value.token.decl);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function hoverHandler(value) {
  const { node } = value;

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
            (await query.node(node.parent_number))?.name || "Never"
          )
        );
        node.sqname && marks.push(new mark.Strong(node.sqname));
        break;
      case "ExpansionDecl":
        if (node.ref_ptr) {
          const v = await hoverHandler({
            ...value,
            node: await query.node(node.ref_ptr),
          });
          if (v.mark) {
            marks.push(v.mark, mark.newLine);
            const nodes = await query.range(node.number, node.final_number);
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
        const children = await query.children(node.number);
        if (children.length) marks.push(mark.newLine, mark.thematicBreak);
        for (const node of children) {
          const v = await hoverHandler({ ...value, node });
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
 * @returns {Promise<Value>}
 */
async function definitionHandler(value) {
  const { node } = value;

  if (node) {
    value.link = [];
    if (node.ref_ptr) {
      const decl = await query.node(node.ref_ptr);
      if (decl) value.link.push(decl);
    } else value.link.push(node);
  }

  return value;
}

/**
 *
 * @param {import("./query.js").Node} node
 * @param {import("vscode-languageserver-textdocument").TextDocument} doc
 * @returns
 */
function getRanges(node, doc) {
  const endOffset =
    doc.offsetAt({
      line: node.end_row - 1,
      character: node.end_col - 1,
    }) + 1;

  const endNameOffset =
    node.row > 0
      ? doc.offsetAt({
          line: node.row - 1,
          character: node.col - 1,
        }) + (node.name ? node.name.length : 1)
      : endOffset;

  const range = {
    start: {
      line: node.begin_row - 1,
      character: node.begin_col - 1,
    },
    end: doc.positionAt(Math.max(endOffset, endNameOffset)),
  };

  const selectionRange = {
    start:
      node.row > 0
        ? {
            line: node.row - 1,
            character: node.col - 1,
          }
        : range.start,
    end: doc.positionAt(endNameOffset),
  };

  return { range, selectionRange };
}

/**
 *
 * @param {Value} value
 * @returns {Promise<import("vscode-languageserver/node.js").LocationLink[] | null>}
 */
async function linkHandler(value) {
  if (value.link) {
    /** @type {import("vscode-languageserver/node.js").LocationLink[]} */
    const links = [];

    for (const node of value.link) {
      const uri = await query.uri(node.begin_src);
      const { document: doc } = await getDocument(uri);

      const result = getRanges(node, doc);
      links.push({
        targetUri: uri,
        targetRange: result.range,
        targetSelectionRange: result.selectionRange,
      });
    }
    return links;
  }
  return null;
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
      declarationProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      documentSymbolProvider: true,
    },
  };
});

connection.onInitialized(async () => {});

connection.onDidChangeConfiguration(async ({ settings }) => {
  if (Array.isArray(settings)) {
    for (let i = 0, n = settings.length; i < n; i += 2)
      switch (settings[i]) {
        case "languageServerCC.tu":
          query.tu = settings[i + 1];
          break;
      }
  }
});

connection.onDocumentSymbol(async ({ textDocument }) => {
  if (!query.tu) return null;

  const { doc, src } = await getUriInfo(textDocument.uri);
  const nodes = await query.symbols(src);
  /** @type {import("vscode-languageserver/node.js").DocumentSymbol[]} */
  const symbols = [];

  for (const node of nodes) {
    if (!node.name) continue;

    let kind = 0;
    switch (node.kind) {
      case "FunctionDecl":
        kind = symbolKinds.Function;
        break;

      case "RecordDecl":
        if (node.class === 1) kind = symbolKinds.Struct;
        else if (node.class === 2) kind = symbolKinds.Union;
        else if (node.class === 3) kind = symbolKinds.Enum;
        break;

      case "VarDecl":
        kind = symbolKinds.Variable;
        break;

      case "TypedefDecl":
        kind = symbolKinds.TypeAlias;
        break;
    }

    if (!kind || node.row == 0) continue;

    const ranges = getRanges(node, doc);
    symbols.push({
      name: node.name,
      kind: /** @type {any} */ (kind),
      ...ranges,
    });
  }

  return symbols;
});

connection.onDefinition(async (param) => {
  if (!query.tu) return null;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    linkHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onHover(async (param) => {
  if (!query.tu) return null;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    hoverHandler,
    markHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

// Listen on the connection
connection.listen();
