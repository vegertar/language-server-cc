// @ts-check

import { open } from "node:fs/promises";
import * as fs from "fs";
import * as path from "path";
import {
  createConnection,
  ProposedFeatures,
  SymbolKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Query, { SEMANTIC_EXPANSION, SEMANTIC_INACTIVE } from "./query.js";
import * as mark from "./mark.js";

const query = new Query();

/**
 *
 * @param {string} uri
 */
async function getUriInfo(uri) {
  const url = new URL(uri);
  const doc = await getDocument(uri);
  const src = await query.src(url.pathname);
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
 * @param {import("./query.js").Node} node
 * @returns {number}
 */
function getSymbolKind(node) {
  switch (node.kind) {
    case "FunctionDecl":
      return symbolKinds.Function;

    case "RecordDecl":
      if (node.class === 1) return symbolKinds.Struct;
      else if (node.class === 2) return symbolKinds.Union;
      else if (node.class === 3) return symbolKinds.Enum;
      else break;

    case "VarDecl":
      return symbolKinds.Variable;

    case "TypedefDecl":
      return symbolKinds.TypeAlias;
  }

  return 0;
}

/**
 * Semantic Tokens
 */
const tokenTypes = ["macro", "comment"];
const tokenModifiers = [];

const tokenTypesMap = Object.fromEntries(tokenTypes.map((v, i) => [v, i]));

/**
 *
 * @param {import("./query.js").Semantics} semantics
 */
function getTokenSemantics(semantics) {
  switch (semantics) {
    case SEMANTIC_EXPANSION:
      return [tokenTypesMap["macro"], 0];
    case SEMANTIC_INACTIVE:
      return [tokenTypesMap["comment"], 0];
  }
}

/**
 *
 * @param {number} specs
 * @param {mark.Mark[]} [marks]
 * @returns
 */
function getSpecsMarks(specs, marks = []) {
  for (const spec in specMarks) {
    if (specs & parseInt(spec)) {
      marks.push(specMarks[spec], mark.space);
    }
  }
  return marks;
}

/**
 *
 * @param {string | URL} uri
 * @returns
 */
async function getDocument(uri) {
  const key = typeof uri === "string" ? uri : uri.toString();
  let document = documents.get(key);
  if (!document) {
    const url = typeof uri === "string" ? new URL(uri) : uri;
    const file = await open(url.pathname);
    const content = await file.readFile({ encoding: "utf8" });
    await file.close();
    document = TextDocument.create(key, "", 0, content);
    documents.set(key, document);
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
  let end;

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
 *   decl?: (import("./query.js").Node | undefined)[],
 *   link?: (import("./query.js").Node[] | undefined)[],
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
    value.decl = [await query.node(value.token.decl)];
  } else {
    // Sometimes Clang does not generate tokens, e.g., in macro expansions within conditional preprocessors.
    // In such cases, we query the AST node by position.
    value.decl = await query.decl(value.src, value.pos);
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function hoverHandler(value) {
  for (const decl of value.decl || []) {
    if (!decl) continue;

    // TODO: add implicit label to implicitly declared functions
    // TODO: add hover info for those macros, e.g. __has_attribute,  are implicitly registered by compiler
    const marks = getSpecsMarks(decl.specs);

    switch (decl.kind) {
      case "TypedefDecl":
        marks.push(new mark.Emphasis("typedef"), mark.space);
        break;
      case "FieldDecl":
        marks.push(new mark.Emphasis("field"), mark.space);
        break;
      case "RecordDecl":
        switch (decl.class) {
          case 1:
            marks.push(new mark.Emphasis("struct"), mark.space);
            break;
        }
        break;
      case "MacroDecl":
        marks.push(new mark.Emphasis("#define"), mark.space);
        break;
      case "ExpansionDecl":
        if (decl.ref_ptr) {
          const ref = await query.node(decl.ref_ptr);
          if (!ref) break;

          const v = await hoverHandler({ ...value, decl: [ref] });
          if (v.mark) {
            marks.push(v.mark, mark.newLine, mark.thematicBreak, mark.newLine);
            const nodes = await query.range(decl.number, decl.final_number);
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

    if (decl.kind !== "ExpansionDecl") {
      if (decl.name) {
        marks.push(new mark.Strong(decl.name));
      }

      if (decl.class) {
        const children = await hoverHandler({
          ...value,
          decl: await query.children(decl.number),
        });
        if (children.mark)
          marks.push(
            mark.newLine,
            mark.thematicBreak,
            mark.newLine,
            children.mark
          );
      } else {
        const { qualified_type, desugared_type } = decl;
        if (qualified_type)
          marks.push(mark.space, new mark.Emphasis(qualified_type));
        if (desugared_type && desugared_type !== qualified_type)
          marks.push(mark.space, new mark.Code(desugared_type));
      }
    }

    if (decl.begin_src != -1 && decl.begin_src != value.src) {
      const filename = await query.filename(decl.begin_src);
      if (filename) marks.push(new mark.Provider(filename));
    }

    if (value.mark) {
      value.mark = new mark.Mark([
        value.mark,
        mark.newLine,
        new mark.Mark(marks),
      ]);
    } else {
      value.mark = new mark.Mark(marks);
    }
  }
  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function declarationHandler(value) {
  if (value.link) {
    for (const link of value.link) {
      if (link) {
        const definition = link[0];
        const declarations = await query.decl(definition);
        link.push(...declarations);
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
async function definitionHandler(value) {
  if (value.decl) {
    value.link = [];
    for (const decl of value.decl) {
      const def = decl && (await query.def(decl));
      value.link.push(def && [def]);
    }
  }

  return value;
}

/**
 *
 * @param {Value} value
 * @returns {Promise<Value>}
 */
async function typeDefinitionHandler(value) {
  if (value.decl) {
    value.link = [];
    for (const decl of value.decl) {
      switch (decl?.kind) {
        case "VarDecl":
        case "ParmVarDecl":
        case "FunctionDecl":
        case "FieldDecl":
          if (decl.type_ptr) {
            const type = await query.node(decl.type_ptr);
            value.link.push(type && [type]);
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
 */
function documentHighlightHandler(value) {
  if (value.link) {
    /** @type {import("vscode-languageserver/node.js").DocumentHighlight[]} */
    const result = [];
    for (const link of value.link) {
      if (!link) continue;

      const node = link[0];
      if (node.begin_src === value.src) {
        result.push({
          range: getRanges(node, value.doc).selectionRange,
        });
      }
    }
    return result;
  }
}

/**
 * @param {import("vscode-languageserver/node.js").ReferenceContext & {
 *  scoped?: boolean
 * }} context
 */
function referencesHandler(context) {
  /**
   *
   * @param {Value} value
   * @returns {Promise<Value>}
   */
  return async (value) => {
    if (value.link) {
      for (let i = 0, n = value.link.length; i < n; ++i) {
        const link = value.link[i];
        if (!link) continue;

        const def = link[0];
        const refs = await query.refs(
          link.map((node) => node.ptr),
          {
            member: def.kind === "FieldDecl",
            src: context.scoped ? value.src : undefined,
          }
        );

        if (context.includeDeclaration) link.push(...refs);
        else value.link[i] = refs;
      }
    }

    return value;
  };
}

/**
 *
 * @param {import("./query.js").Node} node
 * @param {import("vscode-languageserver-textdocument").TextDocument} doc
 * @returns
 */
function getRanges(node, doc) {
  const namePosition =
    node.row > 0
      ? {
          line: node.row - 1,
          character: node.col - 1,
        }
      : node.kind === "MemberExpr"
        ? {
            line: node.end_row - 1,
            character: node.end_col - 1,
          }
        : {
            line: node.begin_row - 1,
            character: node.begin_col - 1,
          };

  const nameEndOffset =
    doc.offsetAt(namePosition) + (node.name ? node.name.length : 1);

  const range = {
    start: {
      line: node.begin_row - 1,
      character: node.begin_col - 1,
    },
    end: doc.positionAt(
      Math.max(
        doc.offsetAt({
          line: node.end_row - 1,
          character: node.end_col - 1,
        }) + 1,
        nameEndOffset
      )
    ),
  };

  const selectionRange = {
    start: namePosition,
    end: doc.positionAt(nameEndOffset),
  };

  return { range, selectionRange };
}

/**
 *
 * @param {import("./query.js").Node} node
 * @returns
 */
async function getUri(node) {
  const filename = await query.filename(node.begin_src);
  // Skip the builtin files
  if (!filename || filename.startsWith("<")) return;

  return "file://" + filename;
}

/**
 *
 * @param {import("./query.js").Node} node
 * @returns
 */
async function getLink(node) {
  const uri = await getUri(node);
  if (!uri) return;

  const doc = await getDocument(uri);
  const result = getRanges(node, doc);
  return { doc, uri, ...result };
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

    for (const items of value.link) {
      if (!items) continue;

      for (const node of items) {
        const link = await getLink(node);
        if (link)
          links.push({
            targetUri: link.uri,
            targetRange: link.range,
            targetSelectionRange: link.selectionRange,
          });
      }
    }
    return links;
  }
  return null;
}

/**
 *
 * @param {import("vscode-languageserver/node.js").LocationLink[] | null} links
 * @returns {import("vscode-languageserver/node.js").Location[] | null}
 */
function locationHandler(links) {
  return links
    ? links.map((link) => ({
        uri: link.targetUri,
        range: link.targetSelectionRange,
      }))
    : null;
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

/**
 *
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
export function readDir(dirPath) {
  return new Promise((resolve) => {
    fs.readdir(dirPath, (error, list) => {
      if (error) {
        resolve([]);
      } else {
        resolve(list);
      }
    });
  });
}

/**
 *
 * @param {string} filePath
 * @returns {Promise<fs.Stats | undefined>}
 */
function getLStat(filePath) {
  return new Promise((resolve) => {
    fs.lstat(filePath, (_err, stats) => {
      if (stats) {
        resolve(stats);
      } else {
        resolve(undefined);
      }
    });
  });
}

/**
 *
 * @param {string} dir
 * @param {RegExp} regex
 * @param {string[]} files
 * @param {string[]} result
 * @returns
 */
async function recGetAllFilePaths(dir, regex, files, result) {
  for (const item of files) {
    const file = path.join(dir, item);
    try {
      const status = await getLStat(file);
      if (status) {
        if (status.isDirectory() && !status.isSymbolicLink()) {
          result = await recGetAllFilePaths(
            file,
            regex,
            await readDir(file),
            result
          );
        } else if (status.isFile() && regex.test(file)) {
          result.push(file);
        }
      }
    } catch (error) {
      continue;
    }
  }
  return result;
}

connection.onInitialize(async ({ workspaceFolders, initializationOptions }) => {
  /** @type {string[] | undefined} */
  let translationUnits;

  const uri = workspaceFolders?.[0].uri;
  if (uri) {
    const path = new URL(uri).pathname;
    translationUnits = await recGetAllFilePaths(
      path,
      /\.o$/,
      await readDir(path),
      []
    );
  }

  /** @type {string | undefined} */
  const translationUnit = initializationOptions?.translationUnit;
  if (translationUnit) query.tu = translationUnit;

  return {
    capabilities: {
      hoverProvider: true,
      declarationProvider: true,
      definitionProvider: true,
      typeDefinitionProvider: true,
      implementationProvider: true,
      documentHighlightProvider: true,
      referencesProvider: true,
      callHierarchyProvider: true,
      documentSymbolProvider: true,
      documentLinkProvider: { resolveProvider: true },
      semanticTokensProvider: {
        legend: { tokenTypes, tokenModifiers },
        range: true,
        full: { delta: true },
      },
      experimental: { translationUnits },
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

connection.onDocumentLinks(async ({ textDocument }) => {
  await query.tuPromise;

  const { src } = await getUriInfo(textDocument.uri);
  const nodes = await query.links(src);
  /** @type {import("vscode-languageserver/node.js").DocumentLink[]} */
  const links = [];

  for (const node of nodes) {
    if (!node.name || !node.desugared_type) continue;

    links.push({
      range: {
        start: {
          line: node.row - 1,
          character: node.col - 1,
        },
        end: {
          line: node.row,
          character: 0,
        },
      },
      target: "file://" + node.desugared_type,
      tooltip: new mark.Mark([
        new mark.Emphasis("#" + node.name),
        mark.space,
        new mark.Strong(node.desugared_type),
      ]).toText(),
    });
  }

  return links;
});

connection.onDocumentSymbol(async ({ textDocument }) => {
  await query.tuPromise;

  const { doc, src } = await getUriInfo(textDocument.uri);
  const nodes = await query.symbols(src);
  /** @type {import("vscode-languageserver/node.js").DocumentSymbol[]} */
  const symbols = [];

  for (const node of nodes) {
    /** @type {any} */
    const kind = getSymbolKind(node);
    if (!kind || !node.name || !node.row) continue;

    const ranges = getRanges(node, doc);
    symbols.push({ name: node.name, kind, ...ranges });
  }

  return symbols;
});

connection.onDefinition(async (param) => {
  await query.tuPromise;

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

connection.onDeclaration(async (param) => {
  await query.tuPromise;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    declarationHandler,
    linkHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onTypeDefinition(async (param) => {
  await query.tuPromise;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    typeDefinitionHandler,
    linkHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onReferences(async ({ context, ...param }) => {
  await query.tuPromise;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    declarationHandler,
    referencesHandler(context),
    linkHandler,
    locationHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

connection.onHover(async (param) => {
  await query.tuPromise;

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

connection.onDocumentHighlight(async (param) => {
  await query.tuPromise;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    declarationHandler,
    referencesHandler({ includeDeclaration: true, scoped: true }),
    documentHighlightHandler,
  ]) {
    value = await handler(value);
  }
  return value;
});

/**
 * @param {import("vscode-languageserver/node.js").SemanticTokensParams & {range?: import("vscode-languageserver/node.js").Range}} param0
 * @returns {Promise<import("vscode-languageserver/node.js").SemanticTokens | null>}
 */
async function onTextDocumentSemanticTokens({ textDocument, range }) {
  await query.tuPromise;

  const { doc, src } = await getUriInfo(textDocument.uri);
  const semanticRanges = await query.semantics(src, range);

  /**
   * @typedef {{
   *   line: number,
   *   character: number,
   *   length: number,
   *   tokenType: number,
   *   tokenModifier: number,
   * }} SemanticTokenItem
   */

  /** @typedef {SemanticTokenItem[]} */
  const items = [];

  for (const value of semanticRanges) {
    let { begin_row, begin_col, end_row, end_col, semantics } = value;
    const [tokenType, tokenModifier] = getTokenSemantics(semantics);
    let offset = 0;

    do {
      /** @type {SemanticTokenItem} */
      const item = {
        tokenType,
        tokenModifier,
        line: begin_row - 1,
        character: begin_col - 1,
        length: 0,
      };

      items.push(item);

      if (begin_row == end_row) {
        item.length = end_col - begin_col;
      } else {
        // There are multiple lines
        const nextLine = { line: begin_row, character: 0 };
        const nextOffset = doc.offsetAt(nextLine);
        item.length = nextOffset - (offset || doc.offsetAt(item));
        offset = nextOffset;
      }

      begin_row += 1;
      begin_col = 1;
    } while (begin_row <= end_row);
  }

  return {
    data: items
      .sort((a, b) => {
        const d = a.line - b.line;
        return d == 0 ? a.character - b.character : d;
      })
      .flatMap((item, i, items) => {
        if (i == 0)
          return [
            item.line,
            item.character,
            item.length,
            item.tokenType,
            item.tokenModifier,
          ];

        if (item.line == items[i - 1].line) {
          return [
            0,
            item.character - items[i - 1].character,
            item.length,
            item.tokenType,
            item.tokenModifier,
          ];
        }

        return [
          item.line - items[i - 1].line,
          item.character,
          item.length,
          item.tokenType,
          item.tokenModifier,
        ];
      }),
  };
}

connection.onRequest(
  "textDocument/semanticTokens/full",
  onTextDocumentSemanticTokens
);

connection.onRequest(
  "textDocument/semanticTokens/range",
  onTextDocumentSemanticTokens
);

/**
 *
 * @param {import("vscode-languageserver/node.js").CallHierarchyPrepareParams} param0
 */
function prepareCallHierarchyHandler({ textDocument }) {
  /**
   *
   * @param {Value} value
   * @returns {import("vscode-languageserver/node.js").CallHierarchyItem[] | null}
   */
  return ({ doc, link, decl }) => {
    if (!link || !decl) return null;

    /** @type {import("vscode-languageserver/node.js").CallHierarchyItem[]} */
    const items = [];

    for (let i = 0, n = decl.length; i < n; ++i) {
      const node = decl[i];
      if (!link[i] || !node?.name) continue;

      /** @type {any} */
      const kind = getSymbolKind(node);
      if (!kind) continue;

      items.push({
        kind,
        name: node.name,
        detail: node.qualified_type,
        uri: textDocument.uri,
        data: link[i],
        ...getRanges(node, doc),
      });
    }

    return items;
  };
}

/**
 *
 * @param {import("vscode-languageserver/node.js").CallHierarchyPrepareParams} param
 * @returns {Promise<import("vscode-languageserver/node.js").CallHierarchyItem[] | null>}
 */
async function onPrepareCallHierarchy(param) {
  await query.tuPromise;

  let value = /** @type {any} */ (param);
  for (const handler of [
    positionHandler,
    tokenHandler,
    definitionHandler,
    declarationHandler,
    prepareCallHierarchyHandler(param),
  ]) {
    value = await handler(value);
  }
  return value;
}

/**
 *
 * @param {import("vscode-languageserver/node.js").CallHierarchyIncomingCallsParams} param0
 * @returns {Promise<import("vscode-languageserver/node.js").CallHierarchyIncomingCall[] | null>}
 */
async function onIncomingCalls({ item }) {
  await query.tuPromise;

  if (!item.data) return null;

  /** @type {import("./query.js").Node[]} */
  const declarations = item.data;
  const refs = await query.refs(declarations.map((x) => x.ptr));

  /** @type {Record<string, import("./query.js").Node[]>} */
  const group = {};
  for (const node of refs) {
    const from = await query.caller(node.number);
    if (!from) continue;

    const ptr = from.ptr;
    if (!group[ptr]) group[ptr] = [from];

    group[ptr].push(node);
  }

  /** @type {import("vscode-languageserver/node.js").CallHierarchyIncomingCall[]} */
  const result = [];
  for (const key in group) {
    const [from, ...nodes] = group[key];
    const link = await getLink(from);
    if (!link) continue;

    /** @type {any} */
    const kind = getSymbolKind(from);
    if (!kind || !from.name) continue;

    /** @type {import("vscode-languageserver/node.js").Range[]} */
    const fromRanges = [];
    for (const node of nodes) {
      if (node.exp_row) {
        const range = await query.exp(node);
        if (range)
          fromRanges.push({
            start: {
              line: range.begin_row - 1,
              character: range.begin_col - 1,
            },
            end: { line: range.end_row - 1, character: range.end_col - 1 },
          });
      } else {
        fromRanges.push(getRanges(node, link.doc).selectionRange);
      }
    }

    result.push({
      from: {
        kind,
        name: from.name,
        detail: from.qualified_type,
        uri: link.uri,
        range: link.range,
        selectionRange: link.selectionRange,
        data: [from, ...(await query.decl(from))],
      },
      fromRanges,
    });
  }

  return result;
}

/**
 *
 * @param {import("vscode-languageserver/node.js").CallHierarchyOutgoingCallsParams} param0
 * @returns {Promise<import("vscode-languageserver/node.js").CallHierarchyOutgoingCall[] | null>}
 */
async function onOutgoingCalls({ item }) {
  await query.tuPromise;

  if (!item.data) return null;

  /** @type {import("./query.js").Node} */
  const definition = item.data[0];
  const uri = await getUri(definition);
  if (!uri) return null;

  const doc = await getDocument(uri);
  const callees = await query.callees(definition);

  /** @type {Record<string, [import("./query.js").Node, ...import("vscode-languageserver/node.js").Range[]]>} */
  const group = {};
  for (const node of callees) {
    const to = await query.def(node);
    if (!to) continue;

    const ptr = to.ptr;
    if (!group[ptr]) group[ptr] = [to];

    const fromRanges = group[ptr];
    if (node.exp_row) {
      const range = await query.exp(node);
      if (range)
        fromRanges.push({
          start: { line: range.begin_row - 1, character: range.begin_col - 1 },
          end: { line: range.end_row - 1, character: range.end_col - 1 },
        });
    } else {
      fromRanges.push(getRanges(node, doc).selectionRange);
    }
  }

  /** @type {import("vscode-languageserver/node.js").CallHierarchyOutgoingCall[]} */
  const result = [];
  for (const key in group) {
    const [to, ...fromRanges] = group[key];
    const link = await getLink(to);
    if (!link) continue;

    /** @type {any} */
    const kind = getSymbolKind(to);
    if (!kind || !to.name) continue;

    result.push({
      to: {
        kind,
        name: to.name,
        detail: to.qualified_type,
        uri: link.uri,
        range: link.range,
        selectionRange: link.selectionRange,
        data: [to],
      },
      fromRanges,
    });
  }

  return result;
}

connection.onRequest(
  "textDocument/prepareCallHierarchy",
  onPrepareCallHierarchy
);

connection.onRequest("callHierarchy/incomingCalls", onIncomingCalls);

connection.onRequest("callHierarchy/outgoingCalls", onOutgoingCalls);

// Listen on the connection
connection.listen();
